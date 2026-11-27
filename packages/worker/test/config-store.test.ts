import { describe, expect, it, vi } from "vitest";
import { parseFacetYaml, type FacetConfig } from "@facet/core";
import {
  createCachedConfigLoader,
  createFacetWorker,
  createKvConfigStore,
  type EnrichmentCacheStore,
} from "../src/index.js";
import { createWasmRewriterFactory } from "./helpers/wasm-rewriter.js";

const YAML_V1 = `version: 1
experiences:
  - id: hero-v1
    name: "Hero v1"
    priority: 10
    match:
      path: "/"
    changes:
      - selector: "h1"
        text: "Hero From KV v1"
`;

const YAML_V2 = `version: 1
experiences:
  - id: hero-v2
    name: "Hero v2"
    priority: 20
    match:
      path: "/"
    changes:
      - selector: "h1"
        text: "Hero From KV v2"
`;

const FALLBACK_YAML = `version: 1
experiences:
  - id: fallback-exp
    name: "Fallback Experience"
    priority: 5
    match:
      path: "/"
    changes:
      - selector: "h1"
        text: "Fallback Headline"
`;

const INVALID_YAML = `version: 99
experiences: "broken"
`;

interface MockKv extends EnrichmentCacheStore {
  data: Map<string, string>;
  getCalls: string[];
  deletedKeys: string[];
  delete(key: string): Promise<void>;
}

function createMockKv(
  withDelete = true,
): MockKv | (EnrichmentCacheStore & { data: Map<string, string>; getCalls: string[] }) {
  const data = new Map<string, string>();
  const getCalls: string[] = [];
  const deletedKeys: string[] = [];

  const base = {
    data,
    getCalls,
    async get(key: string): Promise<string | null> {
      getCalls.push(key);
      return data.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      data.set(key, value);
    },
  };

  if (!withDelete) {
    return base;
  }

  return {
    ...base,
    deletedKeys,
    async delete(key: string): Promise<void> {
      deletedKeys.push(key);
      data.delete(key);
    },
  };
}

function parseValidConfig(yaml: string): FacetConfig {
  const parsed = parseFacetYaml(yaml);
  if (!parsed.ok) {
    throw new Error("Expected valid YAML fixture");
  }
  return parsed.config;
}

describe("createKvConfigStore", () => {
  it("supports draft save/read, publish, snapshot history truncation, and 1-click rollback", async () => {
    const kv = createMockKv(true) as MockKv;
    let now = 1_700_000_000_000;
    const store = createKvConfigStore(kv, {
      keyPrefix: "mysite:facet",
      maxSnapshots: 2,
      now: () => now,
    });

    expect(await store.getLive()).toBeNull();
    expect(await store.getDraft()).toBeNull();
    expect(await store.listSnapshots()).toEqual([]);

    // Reject invalid draft YAML.
    const badDraft = await store.saveDraft(INVALID_YAML);
    expect(badDraft.ok).toBe(false);
    expect(await store.getDraft()).toBeNull();

    // Save valid draft.
    expect(await store.saveDraft(YAML_V1)).toEqual({ ok: true });
    expect(await store.getDraft()).toBe(YAML_V1);
    expect(kv.data.get("mysite:facet:draft")).toBe(YAML_V1);

    // Reject invalid publish YAML.
    const badPublish = await store.publish(INVALID_YAML);
    expect(badPublish.ok).toBe(false);
    expect(await store.getLive()).toBeNull();

    // Publish v1, v2, v3 -> maxSnapshots = 2 evicts v1.
    const pub1 = await store.publish(YAML_V1, { author: "alice", note: "v1" });
    expect(await store.getDraft()).toBeNull();
    expect(kv.deletedKeys).toContain("mysite:facet:draft");
    now += 1000;
    const pub2 = await store.publish(YAML_V2, { author: "bob", note: "v2" });
    now += 1000;
    const pub3 = await store.publish(FALLBACK_YAML, { author: "carol", note: "v3" });
    if (!pub1.ok || !pub2.ok || !pub3.ok) {
      throw new Error("Expected all publishes to succeed");
    }

    const history = await store.listSnapshots();
    expect(history.map((s) => s.id)).toEqual([pub3.snapshot.id, pub2.snapshot.id]);
    expect(kv.deletedKeys).toContain(`mysite:facet:snap:${pub1.snapshot.id}`);
    expect(await store.getSnapshot(pub1.snapshot.id)).toBeNull();
    expect((await store.getSnapshot(pub2.snapshot.id))?.yaml).toBe(YAML_V2);

    // Save a draft before rollback and verify rollback clears it too.
    expect(await store.saveDraft(FALLBACK_YAML)).toEqual({ ok: true });
    expect(await store.getDraft()).toBe(FALLBACK_YAML);

    // Rollback to v2 creates a new snapshot and restores YAML_V2 as live.
    now += 1000;
    const rolled = await store.rollback(pub2.snapshot.id, { author: "dave" });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) throw new Error("Rollback failed");
    expect(await store.getDraft()).toBeNull();

    expect(rolled.snapshot.yaml).toBe(YAML_V2);
    expect(rolled.snapshot.note).toBe(`Rollback to ${pub2.snapshot.id}`);
    expect((await store.getLive())?.id).toBe(rolled.snapshot.id);
    expect((await store.getLive())?.yaml).toBe(YAML_V2);

    // Rollback of unknown/evicted snapshot returns error.
    const missing = await store.rollback(pub1.snapshot.id);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors[0]?.code).toBe("snapshot_not_found");
    }
  });

  it("works with minimal EnrichmentCacheStore without a delete method", async () => {
    const kv = createMockKv(false);
    const store = createKvConfigStore(kv, { maxSnapshots: 2 });

    expect(await store.saveDraft(YAML_V1)).toEqual({ ok: true });
    expect(await store.getDraft()).toBe(YAML_V1);

    const pub1 = await store.publish(YAML_V1);
    expect(pub1.ok).toBe(true);
    expect(await store.getDraft()).toBeNull();

    const pub2 = await store.publish(YAML_V2);
    expect(pub2.ok).toBe(true);
    if (!pub1.ok || !pub2.ok) throw new Error("Publishes failed");

    expect(await store.saveDraft(YAML_V2)).toEqual({ ok: true });
    const rolled = await store.rollback(pub1.snapshot.id);
    expect(rolled.ok).toBe(true);
    expect(await store.getDraft()).toBeNull();

    const history = await store.listSnapshots();
    expect(history).toHaveLength(2);
    expect((await store.getLive())?.yaml).toBe(YAML_V1);
  });

  it("rejects rollback if stored snapshot YAML was externally corrupted in KV", async () => {
    const kv = createMockKv(true) as MockKv;
    const store = createKvConfigStore(kv);

    const pub = await store.publish(YAML_V1);
    if (!pub.ok) throw new Error("Publish failed");

    // Externally tamper with stored snapshot YAML in KV.
    kv.data.set(
      `facet:config:snap:${pub.snapshot.id}`,
      JSON.stringify({ ...pub.snapshot, yaml: INVALID_YAML }),
    );

    const rollbackResult = await store.rollback(pub.snapshot.id);
    expect(rollbackResult.ok).toBe(false);
    // Live config must stay valid v1.
    expect((await store.getLive())?.yaml).toBe(YAML_V1);
  });

  it("recovers gracefully when KV history JSON is corrupt", async () => {
    const kv = createMockKv(true) as MockKv;
    kv.data.set("facet:config:history", "{{{corrupt-json");
    const store = createKvConfigStore(kv);

    expect(await store.listSnapshots()).toEqual([]);
    const pub = await store.publish(YAML_V1);
    expect(pub.ok).toBe(true);
    expect(await store.listSnapshots()).toHaveLength(1);
  });
});

describe("createCachedConfigLoader", () => {
  it("caches within TTL and performs stale-while-revalidate refresh after expiry", async () => {
    const kv = createMockKv(true) as MockKv;
    const store = createKvConfigStore(kv);
    await store.publish(YAML_V1);

    let now = 10_000;
    const pendingWaitUntil: Promise<unknown>[] = [];
    const loader = createCachedConfigLoader(store, {
      ttlMs: 5_000,
      now: () => now,
      waitUntil: (p) => {
        pendingWaitUntil.push(p);
      },
    });

    const req = new Request("https://example.com/");

    // Cold load hits KV once.
    const cfg1 = await loader(req);
    expect(typeof cfg1).toBe("object");
    expect((cfg1 as FacetConfig).experiences[0]?.id).toBe("hero-v1");
    const callsAfterCold = kv.getCalls.length;

    // Warm hit within TTL does not call KV again.
    now = 12_000;
    const cfg2 = await loader(req);
    expect((cfg2 as FacetConfig).experiences[0]?.id).toBe("hero-v1");
    expect(kv.getCalls.length).toBe(callsAfterCold);

    // Publish v2 into KV; after TTL expires, loader returns stale v1 immediately and refreshes in background.
    await store.publish(YAML_V2);
    const callsBeforeStale = kv.getCalls.length;
    now = 16_000;

    const staleCfg = await loader(req);
    expect((staleCfg as FacetConfig).experiences[0]?.id).toBe("hero-v1");
    expect(pendingWaitUntil).toHaveLength(1);

    // Wait for background SWR refresh to finish.
    await Promise.all(pendingWaitUntil);
    expect(kv.getCalls.length).toBeGreaterThan(callsBeforeStale);

    // Next request serves fresh v2 from cache.
    const freshCfg = await loader(req);
    expect((freshCfg as FacetConfig).experiences[0]?.id).toBe("hero-v2");
  });

  it("fails open to fallback on cold corrupt KV and preserves last-known-good on warm corrupt KV", async () => {
    const kv = createMockKv(true) as MockKv;
    kv.data.set("facet:config:live", "{{{not-json");
    const store = createKvConfigStore(kv);

    const errors: unknown[] = [];
    let now = 1_000;
    const pending: Promise<unknown>[] = [];

    const loader = createCachedConfigLoader(store, {
      ttlMs: 1_000,
      fallback: FALLBACK_YAML,
      now: () => now,
      waitUntil: (p) => pending.push(p),
      onError: (err) => errors.push(err),
    });

    const req = new Request("https://example.com/");

    // Cold start with corrupt KV JSON falls back to FALLBACK_YAML.
    const coldFallback = await loader(req);
    expect((coldFallback as FacetConfig).experiences[0]?.id).toBe("fallback-exp");
    expect(errors.length).toBeGreaterThanOrEqual(1);

    // Publish valid v1 -> next request recovers (fallback was not cached as live).
    await store.publish(YAML_V1);
    const liveCfg = await loader(req);
    expect((liveCfg as FacetConfig).experiences[0]?.id).toBe("hero-v1");

    // Corrupt KV live snapshot with invalid YAML after warm cache exists.
    const liveRaw = kv.data.get("facet:config:live");
    const parsedLive = JSON.parse(liveRaw!) as Record<string, unknown>;
    kv.data.set("facet:config:live", JSON.stringify({ ...parsedLive, yaml: INVALID_YAML }));

    now = 5_000; // expire TTL
    const staleCfg = await loader(req);
    expect((staleCfg as FacetConfig).experiences[0]?.id).toBe("hero-v1");
    await Promise.all(pending);

    // Last-known-good v1 is still preserved after failed SWR validation!
    const stillGood = await loader(req);
    expect((stillGood as FacetConfig).experiences[0]?.id).toBe("hero-v1");
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("supports custom async function source and fails open to empty config when no fallback is given", async () => {
    const onError = vi.fn();
    const loader = createCachedConfigLoader(
      async () => {
        throw new Error("KV unavailable");
      },
      { onError },
    );

    const cfg = (await loader(new Request("https://example.com/"))) as FacetConfig;
    expect(cfg.version).toBe(1);
    expect(cfg.experiences).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("integrates seamlessly with createFacetWorker as a FacetConfigSource", async () => {
    const kv = createMockKv(true) as MockKv;
    const store = createKvConfigStore(kv);
    await store.publish(YAML_V1);

    const fallbackConfig = parseValidConfig(FALLBACK_YAML);
    const configLoader = createCachedConfigLoader(store, {
      ttlMs: 10_000,
      fallback: fallbackConfig,
    });

    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: configLoader,
      createRewriter: createWasmRewriterFactory(),
      fetchFn: async () =>
        new Response("<html><body><h1>Original Heading</h1></body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });

    const res = await worker.fetch(new Request("https://site.example.com/"));
    const html = await res.text();
    expect(html).toContain("Hero From KV v1");
  });
});
