import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server.js";
import { PERSONALIZED_CACHE_CONTROL, signPreviewToken, type FacetConfig } from "@facet/core";
import {
  FACET_STATE_HEADER,
  createFacetMiddleware,
  deserializeFacetState,
  serializeFacetState,
  type FacetRequestState,
} from "../src/index.js";

const SAMPLE_YAML = `
version: 1
settings:
  cookieName: "__facet_vid"
  previewParam: "__facet_preview"
  analytics:
    providers: ["ga4", "posthog"]
  enrichment:
    timeoutMs: 80
experiences:
  - id: fintech-abm
    name: "Fintech ABM"
    priority: 20
    match:
      path: "/"
      any:
        - utm_campaign: ["fintech-q4"]
        - query.acct: ["stripe", "plaid"]
        - company.industry: ["Financial Services"]
    holdout: 0
    changes:
      - selector: "#hero-headline"
        text: "Compliance-ready infrastructure for fintech teams"
      - selector: "[data-facet-slot='hero-cta']"
        text: "See the fintech demo"
        attrs:
          href: "/demo?segment=fintech"
  - id: returning-welcome
    name: "Returning Visitor"
    priority: 10
    match:
      path: "/"
      returning: true
    holdout: 0
    changes:
      - selector: "#hero-headline"
        text: "Welcome back!"
  - id: eu-banner
    name: "EU Geo Banner"
    priority: 5
    match:
      geo.country: ["DE", "FR"]
    holdout: 0
    changes:
      - selector: "#geo-banner"
        text: "EU data residency included"
  - id: holdout-test
    name: "100% Control Holdout"
    priority: 30
    match:
      query.test_holdout: "1"
    holdout: 1
    changes:
      - selector: "#hero-headline"
        text: "Should never show in control"
`;

function getForwardedHeader(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name.toLowerCase()}`);
}

describe("@facet/next middleware", () => {
  it("matches UTM and ABM query rules, forwards x-facet-state, sets Cache-Control & Vary, and issues sticky cookie", async () => {
    const middleware = createFacetMiddleware({
      config: SAMPLE_YAML,
      generateVisitorId: () => "vis_fixed_001",
    });

    const req = new NextRequest("https://example.com/?utm_campaign=fintech-q4");
    const res = await middleware(req);

    const encoded = getForwardedHeader(res, FACET_STATE_HEADER);
    expect(encoded).toBeTruthy();

    const state = deserializeFacetState(encoded);
    expect(state.visitorId).toBe("vis_fixed_001");
    expect(state.personalized).toBe(true);
    expect(state.previewMode).toBe(false);
    expect(state.matched).toEqual([{ experienceId: "fintech-abm", bucket: "variant" }]);
    expect(state.changes).toHaveLength(2);
    expect(state.analyticsProviders).toEqual(["ga4", "posthog"]);

    expect(res.headers.get("Cache-Control")).toBe(PERSONALIZED_CACHE_CONTROL);
    expect(res.headers.get("Vary")).toContain("Cookie");

    const cookie = res.cookies.get("__facet_vid");
    expect(cookie?.value).toBe("vis_fixed_001");
  });

  it("supports 1:1 ABM query token (?acct=stripe)", async () => {
    const middleware = createFacetMiddleware({
      config: SAMPLE_YAML,
      generateVisitorId: () => "vis_abm_001",
    });

    const req = new NextRequest("https://example.com/?acct=stripe");
    const res = await middleware(req);
    const state = deserializeFacetState(getForwardedHeader(res, FACET_STATE_HEADER));

    expect(state.matched).toEqual([{ experienceId: "fintech-abm", bucket: "variant" }]);
    expect(state.personalized).toBe(true);
  });

  it("recognizes returning visitor cookie without reissuing cookie", async () => {
    const middleware = createFacetMiddleware({
      config: SAMPLE_YAML,
    });

    const req = new NextRequest("https://example.com/", {
      headers: {
        cookie: "__facet_vid=vis_returning_99",
      },
    });
    const res = await middleware(req);

    const state = deserializeFacetState(getForwardedHeader(res, FACET_STATE_HEADER));
    expect(state.visitorId).toBe("vis_returning_99");
    expect(state.matched).toEqual([{ experienceId: "returning-welcome", bucket: "variant" }]);
    expect(state.changes[0]?.text).toBe("Welcome back!");
    expect(res.cookies.get("__facet_vid")).toBeUndefined();
    expect(res.headers.get("Cache-Control")).toBe(PERSONALIZED_CACHE_CONTROL);
  });

  it("sets Cache-Control: private, no-store on matched control holdout and cookie-issuing first visits, but omits Cache-Control on unmatched returning visits or empty configs", async () => {
    const middleware = createFacetMiddleware({
      config: SAMPLE_YAML,
      generateVisitorId: () => "vis_ctrl_1",
    });

    // Matched control holdout
    const holdoutReq = new NextRequest("https://example.com/?test_holdout=1");
    const holdoutRes = await middleware(holdoutReq);
    const holdoutState = deserializeFacetState(getForwardedHeader(holdoutRes, FACET_STATE_HEADER));
    expect(holdoutState.matched).toEqual([{ experienceId: "holdout-test", bucket: "control" }]);
    expect(holdoutState.changes).toEqual([]);
    expect(holdoutState.personalized).toBe(false);
    expect(holdoutRes.headers.get("Cache-Control")).toBe(PERSONALIZED_CACHE_CONTROL);
    expect(holdoutRes.headers.get("Vary")).toContain("Cookie");

    // First-time visitor on unmatched route: sets sticky cookie AND private, no-store so Set-Cookie is never cached publicly
    const firstVisitUnmatchedReq = new NextRequest("https://example.com/pricing");
    const firstVisitUnmatchedRes = await middleware(firstVisitUnmatchedReq);
    const firstVisitState = deserializeFacetState(
      getForwardedHeader(firstVisitUnmatchedRes, FACET_STATE_HEADER),
    );
    expect(firstVisitState.matched).toEqual([]);
    expect(firstVisitState.personalized).toBe(false);
    expect(firstVisitUnmatchedRes.cookies.get("__facet_vid")?.value).toBe("vis_ctrl_1");
    expect(firstVisitUnmatchedRes.headers.get("Cache-Control")).toBe(PERSONALIZED_CACHE_CONTROL);
    expect(firstVisitUnmatchedRes.headers.get("Vary")).toContain("Cookie");

    // Returning visitor with existing cookie on unmatched route: no Set-Cookie and preserves Cache-Control: null
    const returningUnmatchedReq = new NextRequest("https://example.com/pricing", {
      headers: { cookie: "__facet_vid=vis_returning_42" },
    });
    const returningUnmatchedRes = await middleware(returningUnmatchedReq);
    const returningUnmatchedState = deserializeFacetState(
      getForwardedHeader(returningUnmatchedRes, FACET_STATE_HEADER),
    );
    expect(returningUnmatchedState.matched).toEqual([]);
    expect(returningUnmatchedState.personalized).toBe(false);
    expect(returningUnmatchedRes.cookies.get("__facet_vid")).toBeUndefined();
    expect(returningUnmatchedRes.headers.get("Cache-Control")).toBeNull();

    // Empty experiences config: never issues visitor cookie or private, no-store
    const emptyConfigMiddleware = createFacetMiddleware({
      config: "version: 1\nexperiences: []\n",
      generateVisitorId: () => "vis_empty_1",
    });
    const emptyRes = await emptyConfigMiddleware(new NextRequest("https://example.com/pricing"));
    expect(emptyRes.cookies.get("__facet_vid")).toBeUndefined();
    expect(emptyRes.headers.get("Cache-Control")).toBeNull();
  });

  it("strips attacker-supplied x-facet-state header on normal, bypassed, and error paths (anti-spoofing)", async () => {
    const forgedState: FacetRequestState = {
      visitorId: "attacker",
      matched: [{ experienceId: "fintech-abm", bucket: "variant" }],
      changes: [{ experienceId: "fintech-abm", selector: "#hero-headline", text: "HACKED" }],
      personalized: true,
      previewMode: false,
      analyticsProviders: [],
    };
    const forgedHeader = serializeFacetState(forgedState);

    const middleware = createFacetMiddleware({
      config: SAMPLE_YAML,
      generateVisitorId: () => "vis_clean",
    });

    // 1. Normal unmatched request: forged header must be replaced with real empty-match state
    const normalReq = new NextRequest("https://example.com/about", {
      headers: { [FACET_STATE_HEADER]: forgedHeader },
    });
    const normalRes = await middleware(normalReq);
    const normalState = deserializeFacetState(getForwardedHeader(normalRes, FACET_STATE_HEADER));
    expect(normalState.visitorId).toBe("vis_clean");
    expect(normalState.changes).toEqual([]);

    // 2. Bypassed static route: forged header must be completely stripped
    const staticReq = new NextRequest("https://example.com/_next/static/chunk.js", {
      headers: { [FACET_STATE_HEADER]: forgedHeader },
    });
    const staticRes = await middleware(staticReq);
    expect(getForwardedHeader(staticRes, FACET_STATE_HEADER)).toBeNull();
    expect(staticRes.headers.get("x-middleware-override-headers")).not.toContain(
      FACET_STATE_HEADER,
    );

    // 3. Fail-open error path: forged header must still be stripped
    const brokenMiddleware = createFacetMiddleware({
      config: () => {
        throw new Error("config fetch failed");
      },
    });
    const errReq = new NextRequest("https://example.com/", {
      headers: { [FACET_STATE_HEADER]: forgedHeader },
    });
    const errRes = await brokenMiddleware(errReq);
    expect(getForwardedHeader(errRes, FACET_STATE_HEADER)).toBeNull();
  });

  it("bypasses /_next/*, /api/*, /favicon.ico, static extensions, custom bypassPaths, and non-GET/HEAD methods", async () => {
    const loader = vi.fn(() => SAMPLE_YAML);
    const middleware = createFacetMiddleware({
      config: loader,
      bypassPaths: ["/internal/", /^\/webhooks\//],
    });

    const bypassedUrls = [
      "https://example.com/_next/static/chunks/main.js",
      "https://example.com/_next/image?url=%2Fhero.png",
      "https://example.com/api/health",
      "https://example.com/favicon.ico",
      "https://example.com/assets/logo.svg",
      "https://example.com/styles/app.css",
      "https://example.com/fonts/inter.woff2",
      "https://example.com/images/hero.png",
      "https://example.com/internal/status",
      "https://example.com/webhooks/stripe",
    ];

    for (const url of bypassedUrls) {
      const res = await middleware(new NextRequest(url));
      expect(getForwardedHeader(res, FACET_STATE_HEADER)).toBeNull();
      expect(res.headers.get("Cache-Control")).toBeNull();
    }

    const postRes = await middleware(
      new NextRequest("https://example.com/?utm_campaign=fintech-q4", { method: "POST" }),
    );
    expect(getForwardedHeader(postRes, FACET_STATE_HEADER)).toBeNull();

    expect(loader).not.toHaveBeenCalled();
  });

  it("extracts geo signals from Vercel headers, Cloudflare headers, and legacy request.geo", async () => {
    const middleware = createFacetMiddleware({
      config: SAMPLE_YAML,
      generateVisitorId: () => "vis_geo",
    });

    const vercelReq = new NextRequest("https://example.com/about", {
      headers: {
        "x-vercel-ip-country": "DE",
        "x-vercel-ip-city": "M%C3%BCnchen",
      },
    });
    const vercelRes = await middleware(vercelReq);
    const vercelState = deserializeFacetState(getForwardedHeader(vercelRes, FACET_STATE_HEADER));
    expect(vercelState.matched).toEqual([{ experienceId: "eu-banner", bucket: "variant" }]);

    const cfReq = new NextRequest("https://example.com/about", {
      headers: {
        "cf-ipcountry": "FR",
      },
    });
    const cfRes = await middleware(cfReq);
    const cfState = deserializeFacetState(getForwardedHeader(cfRes, FACET_STATE_HEADER));
    expect(cfState.matched).toEqual([{ experienceId: "eu-banner", bucket: "variant" }]);

    const legacyReq = new NextRequest("https://example.com/about");
    Object.defineProperty(legacyReq, "geo", {
      value: { country: "DE", city: "Berlin" },
      configurable: true,
    });
    const legacyRes = await middleware(legacyReq);
    const legacyState = deserializeFacetState(getForwardedHeader(legacyRes, FACET_STATE_HEADER));
    expect(legacyState.matched).toEqual([{ experienceId: "eu-banner", bucket: "variant" }]);
  });

  it("supports signed preview links, skips visitor cookie and enrichment in preview mode, and rejects invalid or expired tokens", async () => {
    const secret = "super-secret-preview-key";
    const enrich = vi.fn(async () => ({ industry: "Financial Services" }));
    const middleware = createFacetMiddleware({
      config: SAMPLE_YAML,
      previewSecret: secret,
      enrich,
      generateVisitorId: () => "vis_prev",
    });

    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const validToken = await signPreviewToken({
      experienceId: "fintech-abm",
      secret,
      expiresAt: futureExp,
    });

    // Valid signed preview forces experience, skips enrichment, and does not issue visitor cookie
    const validReq = new NextRequest(
      `https://example.com/about?__facet_preview=fintech-abm&__facet_sig=${encodeURIComponent(validToken)}`,
    );
    const validRes = await middleware(validReq);
    const validState = deserializeFacetState(getForwardedHeader(validRes, FACET_STATE_HEADER));
    expect(validState.previewMode).toBe(true);
    expect(validState.personalized).toBe(true);
    expect(validState.matched).toEqual([{ experienceId: "fintech-abm", bucket: "variant" }]);
    expect(validRes.headers.get("Cache-Control")).toBe(PERSONALIZED_CACHE_CONTROL);
    expect(validRes.cookies.get("__facet_vid")).toBeUndefined();
    expect(enrich).not.toHaveBeenCalled();

    // Valid signed preview with control bucket
    const controlToken = await signPreviewToken({
      experienceId: "fintech-abm",
      bucket: "control",
      secret,
      expiresAt: futureExp,
    });
    const controlReq = new NextRequest(
      `https://example.com/about?__facet_preview=fintech-abm&__facet_bucket=control&__facet_sig=${encodeURIComponent(controlToken)}`,
    );
    const controlRes = await middleware(controlReq);
    const controlState = deserializeFacetState(getForwardedHeader(controlRes, FACET_STATE_HEADER));
    expect(controlState.previewMode).toBe(true);
    expect(controlState.matched).toEqual([{ experienceId: "fintech-abm", bucket: "control" }]);
    expect(controlState.changes).toEqual([]);

    // Invalid signature -> ignored, normal evaluation (unmatched on /about)
    const invalidReq = new NextRequest(
      "https://example.com/about?__facet_preview=fintech-abm&__facet_sig=tampered",
    );
    const invalidRes = await middleware(invalidReq);
    const invalidState = deserializeFacetState(getForwardedHeader(invalidRes, FACET_STATE_HEADER));
    expect(invalidState.previewMode).toBe(false);
    expect(invalidState.matched).toEqual([]);

    // Expired token -> ignored
    const expiredToken = await signPreviewToken({
      experienceId: "fintech-abm",
      secret,
      expiresAt: 1000,
    });
    const expiredReq = new NextRequest(
      `https://example.com/about?__facet_preview=fintech-abm&__facet_sig=${encodeURIComponent(expiredToken)}`,
    );
    const expiredRes = await middleware(expiredReq);
    const expiredState = deserializeFacetState(getForwardedHeader(expiredRes, FACET_STATE_HEADER));
    expect(expiredState.previewMode).toBe(false);
    expect(expiredState.matched).toEqual([]);
  });

  it("supports BYOK enrichment and fails open with abort on timeout or enrichment error", async () => {
    // 1. Successful fast enrichment
    const fastMiddleware = createFacetMiddleware({
      config: SAMPLE_YAML,
      generateVisitorId: () => "vis_enrich_ok",
      enrich: async () => ({
        name: "Acme Bank",
        industry: "Financial Services",
      }),
    });

    const okRes = await fastMiddleware(new NextRequest("https://example.com/"));
    const okState = deserializeFacetState(getForwardedHeader(okRes, FACET_STATE_HEADER));
    expect(okState.matched).toEqual([{ experienceId: "fintech-abm", bucket: "variant" }]);

    // 2. Slow enrichment exceeding timeout -> aborts signal and fails open promptly
    let aborted = false;
    const onError = vi.fn();
    const slowMiddleware = createFacetMiddleware({
      config: SAMPLE_YAML,
      enrichmentTimeoutMs: 40,
      onError,
      generateVisitorId: () => "vis_enrich_timeout",
      enrich: (_req, _ctx, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          setTimeout(() => resolve({ industry: "Financial Services" }), 500);
        }),
    });

    const start = Date.now();
    const slowRes = await slowMiddleware(new NextRequest("https://example.com/"));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(300);
    expect(aborted).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    const slowState = deserializeFacetState(getForwardedHeader(slowRes, FACET_STATE_HEADER));
    expect(slowState.matched).toEqual([]);
    expect(slowState.personalized).toBe(false);

    // 3. Throwing enrichment -> fails open cleanly
    const throwingMiddleware = createFacetMiddleware({
      config: SAMPLE_YAML,
      generateVisitorId: () => "vis_enrich_err",
      enrich: async () => {
        throw new Error("upstream 500");
      },
    });
    const errRes = await throwingMiddleware(new NextRequest("https://example.com/"));
    const errState = deserializeFacetState(getForwardedHeader(errRes, FACET_STATE_HEADER));
    expect(errState.matched).toEqual([]);
  });

  it("fails open cleanly on invalid YAML, invalid config object, or failing async loader", async () => {
    const onError = vi.fn();

    const brokenYamlMiddleware = createFacetMiddleware({
      config: "version: 999\nexperiences: [broken",
      onError,
    });
    const res1 = await brokenYamlMiddleware(new NextRequest("https://example.com/"));
    expect(res1.status).toBe(200);
    expect(getForwardedHeader(res1, FACET_STATE_HEADER)).toBeNull();

    const brokenObjMiddleware = createFacetMiddleware({
      config: { version: 2 } as unknown as FacetConfig,
      onError,
    });
    const res2 = await brokenObjMiddleware(new NextRequest("https://example.com/"));
    expect(res2.status).toBe(200);
    expect(getForwardedHeader(res2, FACET_STATE_HEADER)).toBeNull();

    const brokenLoaderMiddleware = createFacetMiddleware({
      config: async () => {
        throw new Error("KV unavailable");
      },
      onError,
    });
    const res3 = await brokenLoaderMiddleware(new NextRequest("https://example.com/"));
    expect(res3.status).toBe(200);
    expect(getForwardedHeader(res3, FACET_STATE_HEADER)).toBeNull();

    expect(onError).toHaveBeenCalledTimes(3);
  });

  it("contains zero Node-only imports or Buffer usage in Edge Runtime source files", () => {
    const srcFiles = [
      "middleware.ts",
      "state.ts",
      "server.ts",
      "FacetSlot.tsx",
      "FacetAnalytics.tsx",
    ];
    const forbiddenImportPattern =
      /from\s+["'](?:node:[^"']+|fs|path|crypto|buffer|os|http|https|stream|url|util|child_process)["']/;
    const forbiddenBufferPattern = /\bBuffer\b/;

    for (const file of srcFiles) {
      const fullPath = resolve(__dirname, "../src", file);
      const source = readFileSync(fullPath, "utf8");
      expect(source, `${file} must not import Node built-ins`).not.toMatch(forbiddenImportPattern);
      expect(source, `${file} must not reference Node Buffer`).not.toMatch(forbiddenBufferPattern);
    }
  });
});
