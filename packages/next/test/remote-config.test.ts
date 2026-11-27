import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server.js";
import { describe, expect, it, vi } from "vitest";
import { createMemoryConfigStore, parseFacetYaml, type FacetConfig } from "@facet/core";
import {
  FACET_STATE_HEADER,
  createFacetMiddleware,
  createRemoteConfigLoader,
  deserializeFacetState,
} from "../src/index.js";

const YAML_V1 = `version: 1
experiences:
  - id: hero-v1
    name: "Hero v1"
    priority: 10
    match:
      path: "/"
    changes:
      - selector: "hero-title"
        text: "Remote Headline v1"
`;

const YAML_V2 = `version: 1
experiences:
  - id: hero-v2
    name: "Hero v2"
    priority: 20
    match:
      path: "/"
    changes:
      - selector: "hero-title"
        text: "Remote Headline v2"
`;

const FALLBACK_YAML = `version: 1
experiences:
  - id: fallback-exp
    name: "Fallback Experience"
    priority: 5
    match:
      path: "/"
    changes:
      - selector: "hero-title"
        text: "Fallback Headline"
`;

const INVALID_YAML = `version: 99
experiences: "invalid"
`;

function parseValid(yaml: string): FacetConfig {
  const res = parseFacetYaml(yaml);
  if (!res.ok) throw new Error("Invalid test fixture");
  return res.config;
}

describe("createRemoteConfigLoader", () => {
  it("loads YAML from remote URL with custom headers and caches within TTL", async () => {
    let now = 10_000;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(YAML_V1, {
        status: 200,
        headers: { "content-type": "text/yaml; charset=utf-8" },
      });
    });

    const loader = createRemoteConfigLoader({
      url: "https://config.example.com/facet.yaml",
      headers: { Authorization: "Bearer secret-token" },
      ttlMs: 5_000,
      fetchFn: fetchMock,
      now: () => now,
    });

    const cfg1 = await loader();
    expect(cfg1.experiences[0]?.id).toBe("hero-v1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const firstCallInit = fetchMock.mock.calls[0]?.[1];
    const sentHeaders = new Headers(firstCallInit?.headers);
    expect(sentHeaders.get("authorization")).toBe("Bearer secret-token");

    // Warm cache hit within TTL does not fetch again.
    now = 14_000;
    const cfg2 = await loader();
    expect(cfg2.experiences[0]?.id).toBe("hero-v1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports JSON FacetConfig and JSON ConfigSnapshot URL payloads", async () => {
    const validObj = parseValid(YAML_V1);

    const jsonConfigLoader = createRemoteConfigLoader({
      url: "https://config.example.com/config.json",
      fetchFn: async () =>
        new Response(JSON.stringify(validObj), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    expect((await jsonConfigLoader()).experiences[0]?.id).toBe("hero-v1");

    const snapshotJsonLoader = createRemoteConfigLoader({
      url: "https://config.example.com/live.json",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            id: "snap_1",
            publishedAt: "2026-01-01T00:00:00.000Z",
            hash: "abc",
            experienceCount: 1,
            yaml: YAML_V2,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });
    expect((await snapshotJsonLoader()).experiences[0]?.id).toBe("hero-v2");
  });

  it("supports ConfigStore and custom fetcher sources with instant warm SWR refresh", async () => {
    let now = 1_000;
    const store = createMemoryConfigStore(YAML_V1);
    const getLiveSpy = vi.spyOn(store, "getLive");

    const loader = createRemoteConfigLoader({
      store,
      ttlMs: 2_000,
      now: () => now,
    });

    const first = await loader();
    expect(first.experiences[0]?.id).toBe("hero-v1");
    expect(getLiveSpy).toHaveBeenCalledTimes(1);

    // Publish v2 into store and advance clock past TTL.
    await store.publish(YAML_V2);
    now = 5_000;

    // Warm stale return is immediate (returns v1) and triggers background SWR refresh.
    const stale = await loader();
    expect(stale.experiences[0]?.id).toBe("hero-v1");

    // Allow microtasks/background refresh to settle.
    await new Promise((resolveFn) => setTimeout(resolveFn, 20));

    // Next request serves refreshed v2 from cache.
    const refreshed = await loader();
    expect(refreshed.experiences[0]?.id).toBe("hero-v2");
  });

  it("enforces hard timeout on cold load and fails open to fallback", async () => {
    const errors: unknown[] = [];
    let aborted = false;

    const slowFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });

    const loader = createRemoteConfigLoader({
      url: "https://slow.example.com/facet.yaml",
      timeoutMs: 30,
      fallback: FALLBACK_YAML,
      fetchFn: slowFetch,
      onError: (err) => errors.push(err),
    });

    const started = Date.now();
    const cfg = await loader();
    const elapsed = Date.now() - started;

    expect(cfg.experiences[0]?.id).toBe("fallback-exp");
    expect(aborted).toBe(true);
    expect(elapsed).toBeLessThan(500);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(String(errors[0])).toContain("timed out");
  });

  it("preserves last-known-good cached config when subsequent SWR fetch fails or returns invalid YAML", async () => {
    let now = 1_000;
    let mode: "v1" | "invalid" | "error" = "v1";
    const errors: unknown[] = [];

    const loader = createRemoteConfigLoader({
      fetcher: async () => {
        if (mode === "v1") return YAML_V1;
        if (mode === "invalid") return INVALID_YAML;
        throw new Error("Upstream 503");
      },
      ttlMs: 1_000,
      fallback: FALLBACK_YAML,
      now: () => now,
      onError: (err) => errors.push(err),
    });

    // Cold load succeeds with v1.
    expect((await loader()).experiences[0]?.id).toBe("hero-v1");

    // Expire TTL and return invalid YAML during SWR -> last-known-good v1 stays active.
    mode = "invalid";
    now = 3_000;
    expect((await loader()).experiences[0]?.id).toBe("hero-v1");
    await new Promise((resolveFn) => setTimeout(resolveFn, 20));
    expect((await loader()).experiences[0]?.id).toBe("hero-v1");

    // Expire TTL and throw during SWR -> last-known-good v1 still stays active.
    mode = "error";
    now = 6_000;
    expect((await loader()).experiences[0]?.id).toBe("hero-v1");
    await new Promise((resolveFn) => setTimeout(resolveFn, 20));
    expect((await loader()).experiences[0]?.id).toBe("hero-v1");

    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("fails open to empty valid FacetConfig when cold load fails and no fallback is provided", async () => {
    const onError = vi.fn();
    const loader = createRemoteConfigLoader({
      url: "https://down.example.com/facet.yaml",
      fetchFn: async () => new Response("Internal Server Error", { status: 500 }),
      onError,
    });

    const cfg = await loader();
    expect(cfg.version).toBe(1);
    expect(cfg.experiences).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("integrates directly with createFacetMiddleware({ config })", async () => {
    const store = createMemoryConfigStore(YAML_V1);
    const middleware = createFacetMiddleware({
      config: createRemoteConfigLoader({
        store,
        ttlMs: 10_000,
        fallback: FALLBACK_YAML,
      }),
      generateVisitorId: () => "vis_remote_1",
    });

    const req = new NextRequest("https://app.example.com/");
    const res = await middleware(req);
    const encodedState = res.headers.get(`x-middleware-request-${FACET_STATE_HEADER}`);
    expect(encodedState).not.toBeNull();

    const state = deserializeFacetState(encodedState!);
    expect(state?.matched[0]?.experienceId).toBe("hero-v1");
    expect(state?.changes[0]?.text).toBe("Remote Headline v1");
  });

  it("maintains strict Web Standard purity with zero Node-only imports in remote-config.ts", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/remote-config.ts"), "utf8");
    const forbidden = [
      /from\s+["']node:[^"']+["']/,
      /from\s+["'](fs|path|crypto|http|https|url|util|stream|os|buffer|process)["']/,
      /\brequire\s*\(/,
      /\bprocess\./,
      /\bBuffer\b/,
    ];
    for (const pattern of forbidden) {
      expect(pattern.test(source)).toBe(false);
    }
  });
});
