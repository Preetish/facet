import { describe, expect, it, vi } from "vitest";
import {
  compileCampaignRows,
  createCloudflareKvTarget,
  createGitHubPrTarget,
  createGoogleSheetsSource,
  hashYaml,
  syncFacetConfig,
  type KVLike,
  type SyncSnapshot,
  type SyncSnapshotMeta,
  type SyncSource,
} from "../src/index.js";

function createMemoryKv(): KVLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  };
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

describe("createCloudflareKvTarget", () => {
  it("publishes validated YAML and maintains bounded snapshot history with direct KV binding", async () => {
    const kv = createMemoryKv();
    const target = createCloudflareKvTarget({
      kv,
      keyPrefix: "facet:test:",
      maxSnapshots: 2,
    });

    const compiled1 = compileCampaignRows([{ id: "v1", path: "/", headline: "Version 1" }]);
    const compiled2 = compileCampaignRows([{ id: "v2", path: "/", headline: "Version 2" }]);
    const compiled3 = compileCampaignRows([{ id: "v3", path: "/", headline: "Version 3" }]);

    const res1 = await target.publish({
      yaml: compiled1.yaml,
      config: compiled1.config,
      hash: await hashYaml(compiled1.yaml),
      author: "alice",
      now: new Date("2026-01-01T00:00:01Z"),
    });
    const res2 = await target.publish({
      yaml: compiled2.yaml,
      config: compiled2.config,
      hash: await hashYaml(compiled2.yaml),
      author: "bob",
      now: new Date("2026-01-01T00:00:02Z"),
    });
    const res3 = await target.publish({
      yaml: compiled3.yaml,
      config: compiled3.config,
      hash: await hashYaml(compiled3.yaml),
      author: "carol",
      now: new Date("2026-01-01T00:00:03Z"),
    });

    expect(res1.changed).toBe(true);
    expect(res2.changed).toBe(true);
    expect(res3.changed).toBe(true);

    const liveRaw = kv.store.get("facet:test:live");
    expect(liveRaw).toBeDefined();
    const live = JSON.parse(liveRaw ?? "{}") as SyncSnapshot;
    expect(live.id).toBe(res3.snapshotId);
    expect(live.author).toBe("carol");
    expect(live.yaml).toBe(compiled3.yaml);

    const history = JSON.parse(kv.store.get("facet:test:history") ?? "[]") as SyncSnapshotMeta[];
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.id)).toEqual([res3.snapshotId, res2.snapshotId]);

    // Oldest snapshot beyond maxSnapshots=2 was pruned from KV
    expect(kv.store.has(`facet:test:snap:${res1.snapshotId}`)).toBe(false);
    expect(kv.store.has(`facet:test:snap:${res2.snapshotId}`)).toBe(true);
    expect(kv.store.has(`facet:test:snap:${res3.snapshotId}`)).toBe(true);

    expect(await target.getCurrentHash?.()).toBe(res3.hash);
  });

  it("publishes via Cloudflare REST API and rejects invalid YAML", async () => {
    const kvState = new Map<string, string>();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const keyEncoded = url.split("/values/")[1] ?? "";
      const key = decodeURIComponent(keyEncoded);

      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer cf-token");

      if (method === "GET") {
        const val = kvState.get(key);
        return val === undefined
          ? new Response("not found", { status: 404 })
          : new Response(val, { status: 200 });
      }
      if (method === "PUT") {
        kvState.set(key, String(init?.body ?? ""));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (method === "DELETE") {
        kvState.delete(key);
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("method not allowed", { status: 405 });
    });

    const target = createCloudflareKvTarget({
      accountId: "acc-123",
      namespaceId: "ns-456",
      apiToken: "cf-token",
      maxSnapshots: 1,
      fetchFn,
    });

    const compiled = compileCampaignRows([{ id: "rest-exp", path: "/", headline: "REST Works" }]);
    const hash = await hashYaml(compiled.yaml);

    expect(await target.getCurrentHash?.()).toBeNull();
    const published = await target.publish({
      yaml: compiled.yaml,
      config: compiled.config,
      hash,
      now: new Date("2026-05-01T12:00:00Z"),
    });
    expect(published.target).toBe("cloudflare-kv-rest");
    expect(await target.getCurrentHash?.()).toBe(hash);

    // Rejects invalid YAML before writing
    await expect(
      target.publish({
        yaml: "version: 999\nexperiences: []\n",
        config: compiled.config,
        hash: "bad",
      }),
    ).rejects.toThrow(/invalid Facet YAML/i);
  });
});

describe("createGitHubPrTarget", () => {
  it("creates branch, commits YAML, and opens a new PR on first sync", async () => {
    const compiled = compileCampaignRows([{ id: "gh-exp", path: "/", headline: "Hello — 世界" }]);
    const hash = await hashYaml(compiled.yaml);
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];

    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const parsedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body: parsedBody });

      if (method === "GET" && url.endsWith("/git/ref/heads/facet/sync-config")) {
        return new Response("Not Found", { status: 404 });
      }
      if (method === "GET" && url.endsWith("/git/ref/heads/main")) {
        return new Response(JSON.stringify({ object: { sha: "base-sha-111" } }), { status: 200 });
      }
      if (method === "POST" && url.endsWith("/git/refs")) {
        return new Response(JSON.stringify({ ref: "refs/heads/facet/sync-config" }), {
          status: 201,
        });
      }
      if (method === "GET" && url.includes("/contents/facet.yaml")) {
        return new Response("Not Found", { status: 404 });
      }
      if (method === "PUT" && url.endsWith("/contents/facet.yaml")) {
        return new Response(JSON.stringify({ commit: { sha: "commit-sha-222" } }), { status: 201 });
      }
      if (method === "GET" && url.includes("/pulls?")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (method === "POST" && url.endsWith("/pulls")) {
        return new Response(
          JSON.stringify({
            number: 42,
            html_url: "https://github.com/acme/site/pull/42",
          }),
          { status: 201 },
        );
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    const target = createGitHubPrTarget({
      owner: "acme",
      repo: "site",
      token: "ghp_test",
      fetchFn,
    });

    const res = await target.publish({
      yaml: compiled.yaml,
      config: compiled.config,
      hash,
      author: "growth-bot",
    });

    expect(res).toEqual({
      target: "github-pr",
      changed: true,
      hash,
      branchName: "facet/sync-config",
      commitSha: "commit-sha-222",
      prNumber: 42,
      url: "https://github.com/acme/site/pull/42",
    });

    const putCall = calls.find((c) => c.method === "PUT" && c.url.endsWith("/contents/facet.yaml"));
    expect(putCall?.body).toMatchObject({
      branch: "facet/sync-config",
      content: encodeBase64(compiled.yaml),
    });
  });

  it("updates existing file and existing open PR on subsequent sync", async () => {
    const oldYaml = "version: 1\nexperiences: []\n";
    const compiled = compileCampaignRows([
      { id: "updated-exp", path: "/pricing", headline: "New Pricing" },
    ]);
    const hash = await hashYaml(compiled.yaml);
    let patchBody: unknown;
    let putBody: unknown;

    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url.endsWith("/git/ref/heads/facet/sync")) {
        return new Response(JSON.stringify({ object: { sha: "branch-sha" } }), { status: 200 });
      }
      if (method === "GET" && url.includes("/contents/config/facet.yaml")) {
        return new Response(
          JSON.stringify({
            sha: "old-file-sha-999",
            encoding: "base64",
            content: encodeBase64(oldYaml),
          }),
          { status: 200 },
        );
      }
      if (method === "PUT" && url.endsWith("/contents/config/facet.yaml")) {
        putBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ commit: { sha: "commit-sha-333" } }), { status: 200 });
      }
      if (method === "GET" && url.includes("/pulls?")) {
        return new Response(
          JSON.stringify([{ number: 7, html_url: "https://github.com/acme/site/pull/7" }]),
          { status: 200 },
        );
      }
      if (method === "PATCH" && url.endsWith("/pulls/7")) {
        patchBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ number: 7, html_url: "https://github.com/acme/site/pull/7" }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    const target = createGitHubPrTarget({
      owner: "acme",
      repo: "site",
      token: "ghp_test",
      filePath: "config/facet.yaml",
      branchName: "facet/sync",
      prTitle: "Update Facet Config",
      fetchFn,
    });

    const currentHash = await target.getCurrentHash?.();
    expect(currentHash).toBe(await hashYaml(oldYaml));

    const res = await target.publish({
      yaml: compiled.yaml,
      config: compiled.config,
      hash,
    });

    expect(res.prNumber).toBe(7);
    expect(res.commitSha).toBe("commit-sha-333");
    expect(putBody).toMatchObject({ sha: "old-file-sha-999", branch: "facet/sync" });
    expect(patchBody).toMatchObject({ title: "Update Facet Config" });
  });

  it("rejects invalid YAML before making any GitHub API requests", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const target = createGitHubPrTarget({
      owner: "acme",
      repo: "site",
      token: "ghp_test",
      fetchFn,
    });

    const compiled = compileCampaignRows([{ id: "ok", path: "/", headline: "Valid" }]);
    await expect(
      target.publish({
        yaml: "version: 2\nexperiences: []\n",
        config: compiled.config,
        hash: "bad-hash",
      }),
    ).rejects.toThrow(/invalid Facet YAML/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("syncFacetConfig", () => {
  it("runs end-to-end sync with account tables, skips no-op identical hashes, and supports dryRun", async () => {
    const campaignCsv =
      "id,name,status,path,origin_path,lookup_table,lookup_key,headline\n" +
      'abm-accounts,ABM Accounts,live,/for/:acct,/,accounts,"{{params.acct}}","Built for {{data.name}}"\n';
    const accountCsv = "slug,name,industry\nstripe,Stripe,Payments\nplaid,Plaid,FinTech\n";

    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("campaigns.csv")) {
        return new Response(campaignCsv, { status: 200 });
      }
      if (url.includes("accounts.csv")) {
        return new Response(accountCsv, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const campaignSource = createGoogleSheetsSource({
      csvUrl: "https://example.com/campaigns.csv",
      fetchFn,
    });
    const accountsSource = createGoogleSheetsSource({
      csvUrl: "https://example.com/accounts.csv",
      fetchFn,
    });

    const kv = createMemoryKv();
    const target = createCloudflareKvTarget({ kv });

    // 1. Dry-run validates and detects change without writing to KV
    const dryRes = await syncFacetConfig({
      source: campaignSource,
      target,
      accountTables: [{ source: accountsSource, tableName: "accounts", keyColumn: "slug" }],
      dryRun: true,
    });
    expect(dryRes.ok).toBe(true);
    expect(dryRes.status).toBe("dry-run");
    expect(dryRes.published).toBe(false);
    expect(dryRes.changed).toBe(true);
    expect(dryRes.config?.data?.accounts?.stripe?.name).toBe("Stripe");
    expect(kv.store.size).toBe(0);

    // 2. Real publish writes to KV
    const firstPub = await syncFacetConfig({
      source: campaignSource,
      target,
      accountTables: [{ source: accountsSource, tableName: "accounts", keyColumn: "slug" }],
      author: "sync-bot",
    });
    expect(firstPub.ok).toBe(true);
    expect(firstPub.status).toBe("published");
    expect(firstPub.published).toBe(true);
    expect(firstPub.publishResult?.snapshotId).toBeDefined();

    // 3. Second sync with identical data skips publish as unchanged no-op
    const putSpy = vi.spyOn(kv, "put");
    const secondPub = await syncFacetConfig({
      source: campaignSource,
      target,
      accountTables: [{ source: accountsSource, tableName: "accounts", keyColumn: "slug" }],
    });
    expect(secondPub.ok).toBe(true);
    expect(secondPub.status).toBe("unchanged");
    expect(secondPub.published).toBe(false);
    expect(secondPub.changed).toBe(false);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("refuses to overwrite live config when all rows are invalid or failOnRowErrors is true", async () => {
    const kv = createMemoryKv();
    const target = createCloudflareKvTarget({ kv });
    const putSpy = vi.spyOn(kv, "put");

    const allBadSource: SyncSource = {
      name: "bad-sheet",
      async fetchRows() {
        return [{ id: "broken", path: "/", holdout: "5.0", headline: "Invalid" }];
      },
    };

    const allBadResult = await syncFacetConfig({ source: allBadSource, target });
    expect(allBadResult.ok).toBe(false);
    expect(allBadResult.status).toBe("failed");
    expect(allBadResult.published).toBe(false);
    expect(putSpy).not.toHaveBeenCalled();

    const mixedSource: SyncSource = {
      name: "mixed-sheet",
      async fetchRows() {
        return [
          { id: "good", path: "/", headline: "Valid" },
          { id: "bad", path: "/", holdout: "99", headline: "Invalid" },
        ];
      },
    };

    const strictResult = await syncFacetConfig({
      source: mixedSource,
      target,
      failOnRowErrors: true,
    });
    expect(strictResult.ok).toBe(false);
    expect(strictResult.status).toBe("failed");
    expect(strictResult.published).toBe(false);
    expect(putSpy).not.toHaveBeenCalled();

    // Default mode isolates bad row and publishes valid sibling experiences safely
    const partialResult = await syncFacetConfig({
      source: mixedSource,
      target,
    });
    expect(partialResult.ok).toBe(false);
    expect(partialResult.status).toBe("published");
    expect(partialResult.published).toBe(true);
    expect(partialResult.config?.experiences.map((e) => e.id)).toEqual(["good"]);
    expect(partialResult.compiled.errors).toHaveLength(1);

    // force: true publishes a fresh snapshot even when hash is unchanged
    const forcedResult = await syncFacetConfig({
      source: mixedSource,
      target,
      force: true,
    });
    expect(forcedResult.status).toBe("published");
    expect(forcedResult.published).toBe(true);

    // Custom compiler returning invalid YAML is blocked by final @facet/core validation gate
    putSpy.mockClear();
    const invalidCustomResult = await syncFacetConfig({
      source: mixedSource,
      target,
      compile: () => ({
        ok: true,
        experiences: [],
        config: {
          version: 1,
          settings: {
            cookieName: "__facet_vid",
            stickyCookieName: "__facet_sticky",
            previewParam: "__facet_preview",
            previewSigParam: "__facet_sig",
            analytics: { providers: [] },
            slots: {},
          },
          experiences: [],
        },
        yaml: "version: 99\nexperiences: invalid\n",
        errors: [],
        summary: {
          totalRows: 1,
          compiledCount: 0,
          liveCount: 0,
          pausedCount: 0,
          draftSkipped: 0,
          blankSkipped: 0,
          errorCount: 0,
        },
      }),
    });
    expect(invalidCustomResult.ok).toBe(false);
    expect(invalidCustomResult.status).toBe("failed");
    expect(invalidCustomResult.published).toBe(false);
    expect(invalidCustomResult.validationErrors.length).toBeGreaterThan(0);
    expect(putSpy).not.toHaveBeenCalled();
  });
});
