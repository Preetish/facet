import { buildContextFromRequest } from "@facet/core";
import { describe, expect, it, vi } from "vitest";
import {
  createIpinfoAdapter,
  createWebhookEnrichmentAdapter,
  extractClientIp,
  runEnrichment,
  type EnrichmentAdapter,
  type EnrichmentCacheStore,
} from "../src/index.js";

function createMemoryKv(): {
  store: Map<string, { value: string; expirationTtl?: number }>;
  kv: EnrichmentCacheStore;
} {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  const kv: EnrichmentCacheStore = {
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
      store.set(key, {
        value,
        ...(options?.expirationTtl !== undefined ? { expirationTtl: options.expirationTtl } : {}),
      });
    }),
  };
  return { store, kv };
}

describe("@facet/worker enrichment & KV caching", () => {
  it("extracts client IP prioritizing CF-Connecting-IP over X-Forwarded-For", () => {
    const req1 = new Request("https://example.com/", {
      headers: {
        "cf-connecting-ip": "198.51.100.10",
        "x-forwarded-for": "203.0.113.5, 10.0.0.1",
      },
    });
    expect(extractClientIp(req1)).toBe("198.51.100.10");

    const req2 = new Request("https://example.com/", {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    });
    expect(extractClientIp(req2)).toBe("203.0.113.5");

    expect(extractClientIp(new Request("https://example.com/"))).toBeUndefined();
  });

  it("enforces hard timeout even when adapter ignores AbortSignal and aborts the signal", async () => {
    let signalAborted = false;
    const onError = vi.fn();
    const { store, kv } = createMemoryKv();

    const hangingAdapter: EnrichmentAdapter = {
      name: "hanging",
      async enrich(_req, _ctx, signal) {
        signal.addEventListener("abort", () => {
          signalAborted = true;
        });
        // Intentionally never resolves even on abort
        return new Promise(() => undefined);
      },
    };

    const req = new Request("https://example.com/", {
      headers: { "cf-connecting-ip": "198.51.100.20" },
    });
    const ctx = buildContextFromRequest(req);

    const start = Date.now();
    const result = await runEnrichment(hangingAdapter, req, ctx, {
      timeoutMs: 35,
      kv,
      onError,
    });
    const elapsed = Date.now() - start;

    expect(result).toBeUndefined();
    expect(signalAborted).toBe(true);
    expect(elapsed).toBeLessThan(250);
    expect(onError).toHaveBeenCalledTimes(1);
    // Timed-out result must NOT be cached
    expect(store.size).toBe(0);
  });

  it("caches positive and negative results in KV and respects waitUntil and cacheTtlSeconds", async () => {
    const { store, kv } = createMemoryKv();
    const enrichMock = vi
      .fn()
      .mockResolvedValueOnce({ name: "Stripe", industry: "FinTech", employees: 8000 })
      .mockResolvedValueOnce(undefined);

    const adapter: EnrichmentAdapter = { name: "custom", enrich: enrichMock };

    const req1 = new Request("https://example.com/", {
      headers: { "cf-connecting-ip": "198.51.100.1" },
    });
    const ctx1 = buildContextFromRequest(req1);

    const pending: Promise<unknown>[] = [];
    const res1 = await runEnrichment(adapter, req1, ctx1, {
      kv,
      cacheTtlSeconds: 600,
      waitUntil: (p) => pending.push(p),
    });
    expect(res1).toEqual({ name: "Stripe", industry: "FinTech", employees: 8000 });
    expect(pending.length).toBe(1);
    await Promise.all(pending);

    expect(store.get("facet:enrich:custom:198.51.100.1")).toEqual({
      value: JSON.stringify({ name: "Stripe", industry: "FinTech", employees: 8000 }),
      expirationTtl: 600,
    });

    // Cache hit avoids adapter call
    const res1Cached = await runEnrichment(adapter, req1, ctx1, { kv });
    expect(res1Cached).toEqual({ name: "Stripe", industry: "FinTech", employees: 8000 });
    expect(enrichMock).toHaveBeenCalledTimes(1);

    // Negative result cached as "null" and short-circuits repeat lookups
    const req2 = new Request("https://example.com/", {
      headers: { "cf-connecting-ip": "198.51.100.2" },
    });
    const ctx2 = buildContextFromRequest(req2);
    expect(await runEnrichment(adapter, req2, ctx2, { kv, cacheTtlSeconds: 10 })).toBeUndefined();
    expect(store.get("facet:enrich:custom:198.51.100.2")).toEqual({
      value: "null",
      expirationTtl: 60, // clamped to Cloudflare KV minimum
    });

    expect(await runEnrichment(adapter, req2, ctx2, { kv })).toBeUndefined();
    expect(enrichMock).toHaveBeenCalledTimes(2);
  });

  it("fails open when KV get/put throws or adapter rejects, without poisoning cache", async () => {
    const onError = vi.fn();
    const brokenKv: EnrichmentCacheStore = {
      get: vi.fn(async () => {
        throw new Error("KV read error");
      }),
      put: vi.fn(async () => {
        throw new Error("KV write error");
      }),
    };

    const adapter: EnrichmentAdapter = {
      name: "ok-adapter",
      async enrich() {
        return { name: "Acme" };
      },
    };

    const req = new Request("https://example.com/", {
      headers: { "cf-connecting-ip": "198.51.100.50" },
    });
    const ctx = buildContextFromRequest(req);

    const company = await runEnrichment(adapter, req, ctx, { kv: brokenKv, onError });
    expect(company).toEqual({ name: "Acme" });
    expect(onError).toHaveBeenCalledTimes(2);

    const failingAdapter: EnrichmentAdapter = {
      name: "fail-adapter",
      async enrich() {
        throw new Error("network down");
      },
    };
    const { store, kv } = createMemoryKv();
    const failed = await runEnrichment(failingAdapter, req, ctx, { kv, onError });
    expect(failed).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("createIpinfoAdapter maps IPinfo responses and sends Bearer token", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ip: "203.0.113.9",
          org: "AS15169 Google LLC",
          company: {
            name: "Stripe Inc.",
            domain: "stripe.com",
            type: "business",
            employees: 8000,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const adapter = createIpinfoAdapter({
      token: "ipinfo-secret-token",
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const req = new Request("https://example.com/", {
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });
    const ctx = buildContextFromRequest(req);
    const company = await runEnrichment(adapter, req, ctx);

    expect(company).toEqual({
      name: "Stripe Inc.",
      domain: "stripe.com",
      industry: "business",
      employees: 8000,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ipinfo.io/203.0.113.9");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer ipinfo-secret-token");

    // Org fallback stripping ASN prefix when company object is absent
    const orgFallbackFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ org: "AS13335 Cloudflare, Inc." }), { status: 200 });
    });
    const fallbackAdapter = createIpinfoAdapter({
      token: "t",
      fetchFn: orgFallbackFetch as unknown as typeof fetch,
    });
    expect(await runEnrichment(fallbackAdapter, req, ctx)).toEqual({
      name: "Cloudflare, Inc.",
    });

    // Missing IP skips fetch completely
    const noIpFetch = vi.fn();
    const noIpAdapter = createIpinfoAdapter({
      token: "t",
      fetchFn: noIpFetch as unknown as typeof fetch,
    });
    expect(
      await runEnrichment(noIpAdapter, new Request("https://example.com/"), ctx),
    ).toBeUndefined();
    expect(noIpFetch).not.toHaveBeenCalled();
  });

  it("createWebhookEnrichmentAdapter supports POST and GET modes and sanitizes output", async () => {
    const postFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          company: {
            name: "Plaid",
            industry: "FinTech",
            employees: 1200,
            nested: { ignored: true },
            constructor: "polluted",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const postAdapter = createWebhookEnrichmentAdapter({
      url: "https://enrich.internal/lookup",
      headers: { "X-API-Key": "hook-secret" },
      fetchFn: postFetch as unknown as typeof fetch,
    });

    const req = new Request("https://site.example.com/pricing?acct=plaid", {
      headers: { "cf-connecting-ip": "198.51.100.77" },
    });
    const ctx = buildContextFromRequest(req);
    const result = await runEnrichment(postAdapter, req, ctx);

    expect(result).toEqual({
      name: "Plaid",
      industry: "FinTech",
      employees: 1200,
    });

    const [postUrl, postInit] = postFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(postUrl).toBe("https://enrich.internal/lookup");
    expect(postInit.method).toBe("POST");
    expect(new Headers(postInit.headers).get("x-api-key")).toBe("hook-secret");
    expect(JSON.parse(String(postInit.body))).toMatchObject({
      ip: "198.51.100.77",
      host: "site.example.com",
      path: "/pricing",
    });

    // GET mode + flat response object
    const getFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ name: "Linear", industry: "SaaS" }), { status: 200 });
    });
    const getAdapter = createWebhookEnrichmentAdapter({
      url: "https://enrich.internal/get",
      method: "GET",
      fetchFn: getFetch as unknown as typeof fetch,
    });
    const getResult = await runEnrichment(getAdapter, req, ctx);
    expect(getResult).toEqual({ name: "Linear", industry: "SaaS" });
    const [getUrl] = getFetch.mock.calls[0] as unknown as [string];
    expect(getUrl).toContain("ip=198.51.100.77");
    expect(getUrl).toContain("path=%2Fpricing");
  });
});
