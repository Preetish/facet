import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_SNAPSHOTS,
  createMemoryConfigStore,
  hashConfigYaml,
  type ConfigSnapshot,
} from "../src/index.js";

const VALID_YAML_V1 = `version: 1
experiences:
  - id: hero-v1
    name: "Hero v1"
    priority: 10
    match:
      path: "/"
    changes:
      - selector: "h1"
        text: "Version One"
`;

const VALID_YAML_V2 = `version: 1
experiences:
  - id: hero-v2
    name: "Hero v2"
    priority: 20
    match:
      path: "/"
    changes:
      - selector: "h1"
        text: "Version Two"
  - id: cta-v2
    name: "CTA v2"
    priority: 10
    match:
      path: "/pricing"
    changes:
      - selector: ".cta"
        text: "Book Demo"
`;

const INVALID_YAML_SCHEMA = `version: 2
experiences: []
`;

const INVALID_YAML_SYNTAX = `version: 1
experiences: [unclosed
`;

describe("hashConfigYaml", () => {
  it("computes deterministic lowercase SHA-256 hex digests", async () => {
    const emptyHash = await hashConfigYaml("");
    expect(emptyHash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    const hashA = await hashConfigYaml(VALID_YAML_V1);
    const hashB = await hashConfigYaml(VALID_YAML_V1);
    const hashC = await hashConfigYaml(VALID_YAML_V2);

    expect(hashA).toMatch(/^[a-f0-9]{64}$/);
    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(hashC);
  });
});

describe("createMemoryConfigStore", () => {
  it("starts empty when no initial YAML is provided", async () => {
    const store = createMemoryConfigStore();

    expect(await store.getLive()).toBeNull();
    expect(await store.getDraft()).toBeNull();
    expect(await store.listSnapshots()).toEqual([]);
    expect(await store.getSnapshot("missing")).toBeNull();
  });

  it("seeds initial live snapshot and history when initialYaml is valid", async () => {
    let now = 1_700_000_000_000;
    const store = createMemoryConfigStore(VALID_YAML_V1, {
      now: () => now,
      author: "alice@example.com",
      note: "Initial seed",
    });

    const live = await store.getLive();
    expect(live).not.toBeNull();
    expect(live?.yaml).toBe(VALID_YAML_V1);
    expect(live?.experienceCount).toBe(1);
    expect(live?.author).toBe("alice@example.com");
    expect(live?.note).toBe("Initial seed");
    expect(live?.publishedAt).toBe(new Date(now).toISOString());
    expect(live?.hash).toBe(await hashConfigYaml(VALID_YAML_V1));

    const history = await store.listSnapshots();
    expect(history).toHaveLength(1);
    expect(history[0]?.id).toBe(live?.id);

    // Mutating returned snapshot must not corrupt store state.
    if (live) {
      live.yaml = "mutated";
    }
    const freshLive = await store.getLive();
    expect(freshLive?.yaml).toBe(VALID_YAML_V1);
    now += 1000;
  });

  it("throws immediately when initialYaml is invalid", () => {
    expect(() => createMemoryConfigStore(INVALID_YAML_SCHEMA)).toThrow(
      /Invalid initial Facet YAML/,
    );
  });

  it("validates YAML on saveDraft and preserves previous valid draft on failure", async () => {
    const store = createMemoryConfigStore();

    const saved = await store.saveDraft(VALID_YAML_V1);
    expect(saved).toEqual({ ok: true });
    expect(await store.getDraft()).toBe(VALID_YAML_V1);

    const rejectedSyntax = await store.saveDraft(INVALID_YAML_SYNTAX);
    expect(rejectedSyntax.ok).toBe(false);
    if (!rejectedSyntax.ok) {
      expect(rejectedSyntax.errors.length).toBeGreaterThan(0);
    }

    const rejectedSchema = await store.saveDraft(INVALID_YAML_SCHEMA);
    expect(rejectedSchema.ok).toBe(false);

    // Existing valid draft remains untouched.
    expect(await store.getDraft()).toBe(VALID_YAML_V1);
  });

  it("publishes valid YAML, rejects invalid YAML, and orders snapshots newest-first", async () => {
    let now = 1_700_000_000_000;
    const store = createMemoryConfigStore(undefined, { now: () => now });

    const r1 = await store.publish(VALID_YAML_V1, { author: "alice", note: "Launch v1" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error("Expected publish v1 to succeed");
    expect(r1.snapshot.experienceCount).toBe(1);
    expect(r1.snapshot.author).toBe("alice");
    expect(r1.snapshot.note).toBe("Launch v1");
    expect(r1.config.experiences[0]?.id).toBe("hero-v1");

    now += 5000;
    const bad = await store.publish(INVALID_YAML_SCHEMA, { author: "bob" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.length).toBeGreaterThan(0);
    }
    // Live config remains v1 after failed publish.
    expect((await store.getLive())?.id).toBe(r1.snapshot.id);

    now += 5000;
    const r2 = await store.publish(VALID_YAML_V2, { author: "bob", note: "Launch v2" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error("Expected publish v2 to succeed");
    expect(r2.snapshot.experienceCount).toBe(2);

    const live = await store.getLive();
    expect(live?.id).toBe(r2.snapshot.id);
    expect(live?.yaml).toBe(VALID_YAML_V2);

    const all = await store.listSnapshots();
    expect(all.map((s) => s.id)).toEqual([r2.snapshot.id, r1.snapshot.id]);
    expect(await store.listSnapshots(1)).toHaveLength(1);
    expect((await store.listSnapshots(1))[0]?.id).toBe(r2.snapshot.id);
    expect(await store.listSnapshots(0)).toEqual([]);
    expect(await store.listSnapshots(-3)).toEqual([]);

    const fetched = await store.getSnapshot(r1.snapshot.id);
    expect(fetched?.yaml).toBe(VALID_YAML_V1);
  });

  it("truncates snapshot history to maxSnapshots and evicts oldest snapshots", async () => {
    let now = 1_700_000_000_000;
    const store = createMemoryConfigStore(undefined, { maxSnapshots: 3, now: () => now });
    const ids: string[] = [];

    for (let i = 1; i <= 5; i++) {
      now += 1000;
      const yaml = `version: 1\nexperiences:\n  - id: exp-${i}\n    name: "Experience ${i}"\n    match:\n      path: "/"\n    changes:\n      - selector: "h1"\n        text: "Headline ${i}"\n`;
      const res = await store.publish(yaml, { note: `Release ${i}` });
      expect(res.ok).toBe(true);
      if (res.ok) {
        ids.push(res.snapshot.id);
      }
    }

    const history = await store.listSnapshots();
    expect(history).toHaveLength(3);
    expect(history.map((s) => s.id)).toEqual([ids[4], ids[3], ids[2]]);

    // Oldest two snapshots were evicted.
    expect(await store.getSnapshot(ids[0]!)).toBeNull();
    expect(await store.getSnapshot(ids[1]!)).toBeNull();
    expect(await store.getSnapshot(ids[2]!)).not.toBeNull();
  });

  it("caps default history at DEFAULT_MAX_SNAPSHOTS (20)", async () => {
    expect(DEFAULT_MAX_SNAPSHOTS).toBe(20);
    const store = createMemoryConfigStore();

    for (let i = 1; i <= 23; i++) {
      const yaml = `version: 1\nexperiences:\n  - id: exp-${i}\n    name: "Experience ${i}"\n    match:\n      path: "/"\n    changes:\n      - selector: "h1"\n        text: "Text ${i}"\n`;
      const res = await store.publish(yaml);
      expect(res.ok).toBe(true);
    }

    const history = await store.listSnapshots();
    expect(history).toHaveLength(20);
  });

  it("supports 1-click rollback creating a new live snapshot and rejects unknown snapshot IDs", async () => {
    let now = 1_700_000_000_000;
    const store = createMemoryConfigStore(undefined, { now: () => now });

    const pub1 = await store.publish(VALID_YAML_V1, { author: "alice", note: "v1" });
    now += 1000;
    const pub2 = await store.publish(VALID_YAML_V2, { author: "bob", note: "v2" });
    if (!pub1.ok || !pub2.ok) throw new Error("Setup publishes failed");

    now += 1000;
    const rolled = await store.rollback(pub1.snapshot.id, { author: "carol" });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) throw new Error("Rollback should succeed");

    expect(rolled.snapshot.id).not.toBe(pub1.snapshot.id);
    expect(rolled.snapshot.yaml).toBe(VALID_YAML_V1);
    expect(rolled.snapshot.hash).toBe(pub1.snapshot.hash);
    expect(rolled.snapshot.author).toBe("carol");
    expect(rolled.snapshot.note).toBe(`Rollback to ${pub1.snapshot.id}`);

    const live: ConfigSnapshot | null = await store.getLive();
    expect(live?.id).toBe(rolled.snapshot.id);
    expect(live?.yaml).toBe(VALID_YAML_V1);

    const history = await store.listSnapshots();
    expect(history.map((s) => s.id)).toEqual([
      rolled.snapshot.id,
      pub2.snapshot.id,
      pub1.snapshot.id,
    ]);

    const missing = await store.rollback("snap_does_not_exist");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors[0]?.code).toBe("snapshot_not_found");
    }
  });

  it("clears saved draft after publish and rollback", async () => {
    const store = createMemoryConfigStore();

    expect(await store.saveDraft(VALID_YAML_V1)).toEqual({ ok: true });
    expect(await store.getDraft()).toBe(VALID_YAML_V1);

    const pub1 = await store.publish(VALID_YAML_V1);
    expect(pub1.ok).toBe(true);
    expect(await store.getDraft()).toBeNull();

    const pub2 = await store.publish(VALID_YAML_V2);
    expect(pub2.ok).toBe(true);
    if (!pub1.ok || !pub2.ok) throw new Error("Setup publishes failed");

    expect(await store.saveDraft(VALID_YAML_V2)).toEqual({ ok: true });
    expect(await store.getDraft()).toBe(VALID_YAML_V2);

    const rolled = await store.rollback(pub1.snapshot.id);
    expect(rolled.ok).toBe(true);
    expect(await store.getDraft()).toBeNull();
  });

  it("maintains strict Web Standard purity with zero Node-only imports in store.ts", () => {
    const storeSource = readFileSync(resolve(import.meta.dirname, "../src/store.ts"), "utf8");
    const forbidden = [
      /from\s+["']node:[^"']+["']/,
      /from\s+["'](fs|path|crypto|http|https|url|util|stream|os|buffer|process)["']/,
      /\brequire\s*\(/,
      /\bprocess\./,
      /\bBuffer\b/,
    ];
    for (const pattern of forbidden) {
      expect(pattern.test(storeSource)).toBe(false);
    }
  });
});
