import { describe, expect, it } from "vitest";
import {
  DEFAULT_STICKY_COOKIE_NAME,
  MAX_STICKY_COOKIE_BYTES,
  PERSONALIZED_CACHE_CONTROL,
  assignBucket,
  evaluate,
  extractPathParams,
  matchPathPattern,
  matchesConditionWithParams,
  parseCsvTable,
  parseFacetYaml,
  parseStickyCookie,
  parseStickyDurationSeconds,
  serializeStickyCookie,
  type FacetConfig,
  type RequestContext,
  type StickyState,
} from "../src/index.js";

function mustParse(yaml: string): FacetConfig {
  const result = parseFacetYaml(yaml);
  if (!result.ok) {
    throw new Error(`Unexpected parse failure: ${JSON.stringify(result.errors)}`);
  }
  return result.config;
}

function makeContext(overrides?: Partial<RequestContext>): RequestContext {
  return {
    url: "https://example.com/",
    host: "example.com",
    path: "/",
    query: {},
    cookies: {},
    headers: {},
    returning: false,
    geo: {},
    company: {},
    ...overrides,
  };
}

function findVisitorForBucket(
  experienceId: string,
  holdout: number,
  desired: "variant" | "control",
): string {
  for (let i = 0; i < 10000; i++) {
    const vid = `sticky-visitor-${i}`;
    if (assignBucket(vid, experienceId, holdout) === desired) {
      return vid;
    }
  }
  throw new Error(`Could not find visitor for bucket=${desired}`);
}

describe("Named path parameters (/for/:acct)", () => {
  it("extracts single, multiple, URI-decoded, and glob-combined path params", () => {
    expect(matchPathPattern("/for/:acct", "/for/stripe")).toEqual({
      matched: true,
      params: { acct: "stripe" },
    });
    expect(matchPathPattern("/for/:acct", "/for/acme%20corp")).toEqual({
      matched: true,
      params: { acct: "acme corp" },
    });
    expect(matchPathPattern("/for/:acct", "/for/%E0%A4%A")).toEqual({
      matched: true,
      params: { acct: "%E0%A4%A" },
    });
    expect(matchPathPattern("/for/:acct", "/for/")).toEqual({ matched: false, params: {} });
    expect(matchPathPattern("/for/:acct", "/for/stripe/extra")).toEqual({
      matched: false,
      params: {},
    });
    expect(matchPathPattern("/:locale/for/:acct/**", "/en-us/for/plaid/docs/api")).toEqual({
      matched: true,
      params: { locale: "en-us", acct: "plaid" },
    });
    // Prototype-pollution param names are ignored safely
    const protoMatch = matchPathPattern("/for/:__proto__", "/for/evil");
    expect(protoMatch.matched).toBe(true);
    expect(Object.keys(protoMatch.params)).toEqual([]);
  });

  it("extracts path params across arrays, operators, all/any, and never leaks from not", () => {
    const ctx = makeContext({ path: "/welcome/stripe" });
    expect(matchesConditionWithParams({ path: ["/for/:acct", "/welcome/:acct"] }, ctx)).toEqual({
      matched: true,
      params: { acct: "stripe" },
    });

    expect(
      matchesConditionWithParams({ path: { in: ["/for/:acct", "/welcome/:acct"] } }, ctx),
    ).toEqual({
      matched: true,
      params: { acct: "stripe" },
    });

    expect(
      matchesConditionWithParams(
        {
          all: [{ path: "/welcome/:acct" }, { not: { path: "/for/:blocked" } }],
        },
        ctx,
      ),
    ).toEqual({
      matched: true,
      params: { acct: "stripe" },
    });

    expect(extractPathParams({ path: "/for/:acct", utm_source: "never" }, "/for/brex")).toEqual({
      acct: "brex",
    });
  });
});

describe("Virtual ABM URLs (originPath) & Data Lookup Tables", () => {
  it("resolves virtual ABM route /for/:acct with lookup, templating, and originPath", () => {
    const config = mustParse(`
version: 1
data:
  accounts:
    stripe:
      name: "Stripe"
      industry: "Payments"
      template: "enterprise"
    plaid:
      name: "Plaid"
      industry: "Open Banking"
      template: "fintech"
experiences:
  - id: abm-page
    name: "1:1 ABM Page"
    priority: 20
    originPath: "/templates/{{data.template}}"
    lookup:
      table: accounts
      key: "{{params.acct}}"
    match:
      path: "/for/:acct"
    changes:
      - selector: "h1"
        text: "Built for {{data.name}} ({{data.industry}})"
      - selector: "#cta"
        attrs:
          href: "/demo?acct={{params.acct}}"
  - id: fallback-for
    name: "Fallback ABM"
    priority: 5
    originPath: "/"
    match:
      path: "/for/:acct"
    changes:
      - selector: "h1"
        text: "Welcome {{params.acct}}"
`);

    const stripeRes = evaluate(config, makeContext({ path: "/for/stripe" }), { visitorId: "v1" });
    expect(stripeRes.matched.map((m) => m.experienceId)).toEqual(["abm-page"]);
    expect(stripeRes.originPath).toBe("/templates/enterprise");
    expect(stripeRes.activeChanges).toEqual([
      { experienceId: "abm-page", selector: "h1", text: "Built for Stripe (Payments)" },
      { experienceId: "abm-page", selector: "#cta", attrs: { href: "/demo?acct=stripe" } },
    ]);

    // Unknown account fails required lookup on abm-page and falls through to fallback-for
    const unknownRes = evaluate(config, makeContext({ path: "/for/unknown" }), { visitorId: "v1" });
    expect(unknownRes.matched.map((m) => m.experienceId)).toEqual(["fallback-for"]);
    expect(unknownRes.originPath).toBe("/");
    expect(unknownRes.activeChanges[0]?.text).toBe("Welcome unknown");
  });

  it("supports lookup.required: false with default() fallbacks and CSV-parsed data tables", () => {
    const config = mustParse(`
version: 1
experiences:
  - id: optional-abm
    name: "Optional Lookup ABM"
    lookup:
      table: accounts
      key: "{{query.acct}}"
      required: false
    match:
      path: "/"
    changes:
      - selector: "h1"
        text: 'Hello {{data.name | default("Valued Guest")}}'
`);

    const csvTable = parseCsvTable("slug,name\nstripe,Stripe\n", "slug");
    const hydratedConfig: FacetConfig = {
      ...config,
      data: { accounts: csvTable },
    };

    const hit = evaluate(hydratedConfig, makeContext({ query: { acct: "stripe" } }), {
      visitorId: "v1",
    });
    expect(hit.activeChanges[0]?.text).toBe("Hello Stripe");

    const miss = evaluate(hydratedConfig, makeContext({ query: { acct: "nope" } }), {
      visitorId: "v1",
    });
    expect(miss.matched).toHaveLength(1);
    expect(miss.activeChanges[0]?.text).toBe("Hello Valued Guest");
  });

  it("exposes originPath for control holdouts and preview mode, and blocks protocol-relative SSRF paths", () => {
    const config = mustParse(`
version: 1
experiences:
  - id: virtual-holdout
    name: "Virtual Holdout"
    holdout: 0.5
    originPath: "/{{params.slug}}"
    match:
      path: "/v/:slug"
    changes:
      - selector: "h1"
        text: "Variant"
`);

    const controlVid = findVisitorForBucket("virtual-holdout", 0.5, "control");
    const controlRes = evaluate(config, makeContext({ path: "/v/home" }), {
      visitorId: controlVid,
    });
    expect(controlRes.matched[0]?.bucket).toBe("control");
    expect(controlRes.activeChanges).toEqual([]);
    expect(controlRes.originPath).toBe("/home");

    // Preview mode resolves originPath for variant & control, null for default
    const previewRes = evaluate(config, makeContext({ path: "/v/landing" }), {
      visitorId: "v1",
      previewExperienceId: "virtual-holdout",
      previewBucket: "control",
    });
    expect(previewRes.originPath).toBe("/landing");
    expect(previewRes.stickyCookie).toBeNull();

    const defaultPreview = evaluate(config, makeContext({ path: "/v/landing" }), {
      visitorId: "v1",
      previewBucket: "default",
    });
    expect(defaultPreview.originPath).toBeNull();

    // Post-interpolation SSRF & path-traversal guards:
    // "/{{params.slug}}" with slug="/evil.com" -> "//evil.com" -> null!
    const ssrfRes = evaluate(config, makeContext({ path: "/v/%2Fevil.com" }), {
      visitorId: "v1",
    });
    expect(ssrfRes.originPath).toBeNull();

    // Path traversal: "/templates/{{params.slug}}" with slug="../admin" -> null!
    const traversalConfig = mustParse(`
version: 1
experiences:
  - id: template-route
    name: "Template Route"
    originPath: "/templates/{{params.slug}}"
    match:
      path: "/v/:slug"
    changes:
      - selector: "h1"
        text: "Template"
`);
    expect(
      evaluate(traversalConfig, makeContext({ path: "/v/..%2Fadmin" }), { visitorId: "v1" })
        .originPath,
    ).toBeNull();
    expect(
      evaluate(traversalConfig, makeContext({ path: "/v/.." }), { visitorId: "v1" }).originPath,
    ).toBeNull();
    expect(
      evaluate(traversalConfig, makeContext({ path: "/v/foo%5Cbar" }), { visitorId: "v1" })
        .originPath,
    ).toBeNull();
    expect(
      evaluate(traversalConfig, makeContext({ path: "/v/enterprise" }), { visitorId: "v1" })
        .originPath,
    ).toBe("/templates/enterprise");
  });
});

describe("Sticky helpers (src/sticky.ts)", () => {
  it("parses sticky duration values accurately", () => {
    expect(parseStickyDurationSeconds(undefined)).toBeUndefined();
    expect(parseStickyDurationSeconds(false)).toBeUndefined();
    expect(parseStickyDurationSeconds(true)).toBeNull();
    expect(parseStickyDurationSeconds("session")).toBeNull();
    expect(parseStickyDurationSeconds("30m")).toBe(1800);
    expect(parseStickyDurationSeconds("24h")).toBe(86400);
    expect(parseStickyDurationSeconds("7d")).toBe(604800);
    expect(parseStickyDurationSeconds("0m")).toBeUndefined();
    expect(parseStickyDurationSeconds("-5d")).toBeUndefined();
    expect(parseStickyDurationSeconds("invalid")).toBeUndefined();
  });

  it("serializes, parses, handles UTF-8, prunes oversized state, and fails safe on corrupt cookies", () => {
    const state: StickyState = {
      v: 1,
      experiences: {
        "exp-1": { exp: 2_000_000_000, dataKey: "stripe" },
        "exp-session": {},
      },
      signals: {
        utm_source: "google",
        utm_campaign: "café-q4",
        acct: "stripe",
        exp: 2_000_000_000,
      },
    };

    const encoded = serializeStickyCookie(state);
    expect(encoded.length).toBeLessThanOrEqual(MAX_STICKY_COOKIE_BYTES);

    const decoded = parseStickyCookie(encoded, 1_999_999_000);
    expect(decoded).toEqual(state);

    // Expired relative to now (supports both seconds and milliseconds)
    const afterExpirySec = parseStickyCookie(encoded, 2_000_000_001);
    expect(afterExpirySec.experiences).toEqual({ "exp-session": {} });
    expect(afterExpirySec.signals).toEqual({});

    const afterExpiryMs = parseStickyCookie(encoded, 2_000_000_001_000);
    expect(afterExpiryMs.experiences).toEqual({ "exp-session": {} });
    expect(afterExpiryMs.signals).toEqual({});

    // Corrupt / oversized / wrong version / prototype pollution fail-safe
    const empty = { v: 1, experiences: {}, signals: {} };
    expect(parseStickyCookie(null)).toEqual(empty);
    expect(parseStickyCookie("")).toEqual(empty);
    expect(parseStickyCookie("!!!not-base64!!!")).toEqual(empty);
    expect(parseStickyCookie("a".repeat(5000))).toEqual(empty);
    expect(parseStickyCookie(btoa("not json"))).toEqual(empty);
    expect(parseStickyCookie(btoa(JSON.stringify({ v: 99, e: { a: {} } })))).toEqual(empty);

    // Oversized state is bounded cleanly to <= MAX_STICKY_COOKIE_BYTES
    const bigState: StickyState = { v: 1, experiences: {}, signals: { utm_campaign: "big" } };
    for (let i = 0; i < 40; i++) {
      bigState.experiences[`experience-with-a-very-long-identifier-number-${i}`] = {
        exp: 2_000_000_000 + i,
        dataKey: `account-key-${"x".repeat(90)}-${i}`,
      };
    }
    const bounded = serializeStickyCookie(bigState);
    expect(bounded.length).toBeLessThanOrEqual(MAX_STICKY_COOKIE_BYTES);
    expect(parseStickyCookie(bounded).v).toBe(1);
  });
});

describe("Session-sticky evaluation flows", () => {
  it("hydrates utm_* and query.acct across pages, with current URL params winning over sticky", () => {
    const config = mustParse(`
version: 1
experiences:
  - id: fintech-pricing
    name: "Fintech Pricing"
    sticky: "7d"
    match:
      path: "/pricing"
      utm_campaign: "fintech-q4"
    changes:
      - selector: "h1"
        text: "Fintech pricing for {{query.acct | default('your team')}}"
  - id: healthcare-pricing
    name: "Healthcare Pricing"
    priority: 10
    sticky: "7d"
    match:
      path: "/pricing"
      utm_campaign: "healthcare-q4"
    changes:
      - selector: "h1"
        text: "Healthcare pricing"
`);

    const t0 = 1_700_000_000;

    // Step 1: Land on homepage with UTMs + acct (experience is scoped to /pricing, doesn't match yet)
    const step1 = evaluate(
      config,
      makeContext({
        path: "/",
        utm_campaign: "fintech-q4",
        query: { utm_campaign: "fintech-q4", acct: "stripe" },
      }),
      { visitorId: "v1", now: t0 },
    );
    expect(step1.matched).toEqual([]);
    expect(step1.stickyCookie).not.toBeNull();
    expect(step1.stickyCookie?.name).toBe(DEFAULT_STICKY_COOKIE_NAME);
    expect(step1.stickyCookie?.maxAgeSeconds).toBe(7 * 86400);
    expect(step1.cacheControl).toBe(PERSONALIZED_CACHE_CONTROL);

    // Step 2: Navigate to /pricing with NO query params, sending sticky cookie
    const step2 = evaluate(
      config,
      makeContext({
        path: "/pricing",
        cookies: { [DEFAULT_STICKY_COOKIE_NAME]: step1.stickyCookie!.value },
      }),
      { visitorId: "v1", now: t0 + 60 },
    );
    expect(step2.matched.map((m) => m.experienceId)).toEqual(["fintech-pricing"]);
    expect(step2.activeChanges[0]?.text).toBe("Fintech pricing for stripe");
    expect(step2.cacheControl).toBe(PERSONALIZED_CACHE_CONTROL);

    // Step 3: Current URL query params override sticky signals immediately
    const step3 = evaluate(
      config,
      makeContext({
        path: "/pricing",
        utm_campaign: "healthcare-q4",
        query: { utm_campaign: "healthcare-q4" },
        cookies: { [DEFAULT_STICKY_COOKIE_NAME]: step1.stickyCookie!.value },
      }),
      { visitorId: "v1", now: t0 + 120 },
    );
    expect(step3.matched.map((m) => m.experienceId)).toEqual(["healthcare-pricing"]);
    expect(step3.activeChanges[0]?.text).toBe("Healthcare pricing");

    // Step 4: After 7d expiry, sticky cookie no longer matches and cacheControl is null
    const step4 = evaluate(
      config,
      makeContext({
        path: "/pricing",
        cookies: { [DEFAULT_STICKY_COOKIE_NAME]: step1.stickyCookie!.value },
      }),
      { visitorId: "v1", now: t0 + 7 * 86400 + 1 },
    );
    expect(step4.matched).toEqual([]);
    expect(step4.stickyCookie).toBeNull();
    expect(step4.cacheControl).toBeNull();
  });

  it("matches via stored sticky experience entry, respects top-level path, and re-resolves lookup via dataKey", () => {
    const config = mustParse(`
version: 1
settings:
  stickyCookieName: "__custom_sticky"
data:
  accounts:
    stripe:
      name: "Stripe"
experiences:
  - id: abm-sitewide
    name: "ABM Sitewide"
    sticky: "24h"
    lookup:
      table: accounts
      key: "{{company.slug}}"
    match:
      company.industry: "FinTech"
    changes:
      - selector: "h1"
        text: "Tailored for {{data.name}}"
  - id: pricing-only
    name: "Pricing Only Sticky"
    priority: 20
    sticky: true
    match:
      path: "/pricing"
      header.x-vip: "true"
    changes:
      - selector: "h1"
        text: "VIP Pricing"
`);

    const t0 = 1_700_000_000;

    // Fresh match on page 1 with enrichment company data
    const page1 = evaluate(
      config,
      makeContext({
        path: "/",
        company: { industry: "FinTech", slug: "stripe" },
      }),
      { visitorId: "v1", now: t0 },
    );
    expect(page1.matched.map((m) => m.experienceId)).toEqual(["abm-sitewide"]);
    expect(page1.activeChanges[0]?.text).toBe("Tailored for Stripe");
    expect(page1.stickyCookie?.name).toBe("__custom_sticky");
    expect(page1.stickyCookie?.maxAgeSeconds).toBe(86400);

    // Page 2: No enrichment company data at all, still matches via sticky + re-resolves Stripe via dataKey!
    const page2 = evaluate(
      config,
      makeContext({
        path: "/features",
        cookies: { __custom_sticky: page1.stickyCookie!.value },
      }),
      { visitorId: "v1", now: t0 + 3600 },
    );
    expect(page2.matched.map((m) => m.experienceId)).toEqual(["abm-sitewide"]);
    expect(page2.activeChanges[0]?.text).toBe("Tailored for Stripe");
    expect(page2.cacheControl).toBe(PERSONALIZED_CACHE_CONTROL);

    // Session sticky (`sticky: true`) respects top-level path condition
    const vip1 = evaluate(
      config,
      makeContext({
        path: "/pricing",
        headers: { "x-vip": "true" },
      }),
      { visitorId: "v2", now: t0 },
    );
    expect(vip1.matched.map((m) => m.experienceId)).toEqual(["pricing-only"]);
    expect(vip1.stickyCookie?.maxAgeSeconds).toBeNull();

    // Return to /pricing without header -> matches via sticky
    const vip2 = evaluate(
      config,
      makeContext({
        path: "/pricing",
        cookies: { __custom_sticky: vip1.stickyCookie!.value },
      }),
      { visitorId: "v2", now: t0 + 100 },
    );
    expect(vip2.matched.map((m) => m.experienceId)).toEqual(["pricing-only"]);

    // Navigate to /blog without header -> top-level path "/pricing" is respected, does NOT match!
    const vipBlog = evaluate(
      config,
      makeContext({
        path: "/blog",
        cookies: { __custom_sticky: vip1.stickyCookie!.value },
      }),
      { visitorId: "v2", now: t0 + 200 },
    );
    expect(vipBlog.matched).toEqual([]);
    expect(vipBlog.cacheControl).toBeNull();
  });

  it("never sets stickyCookie when config has no sticky experiences", () => {
    const config = mustParse(`
version: 1
experiences:
  - id: non-sticky
    name: "Non Sticky"
    match:
      path: "/pricing"
      utm_campaign: "q4"
    changes:
      - selector: "h1"
        text: "Q4"
`);

    const res = evaluate(
      config,
      makeContext({ path: "/", utm_campaign: "q4", query: { utm_campaign: "q4" } }),
      { visitorId: "v1" },
    );
    expect(res.matched).toEqual([]);
    expect(res.stickyCookie).toBeNull();
    expect(res.cacheControl).toBeNull();
  });

  it("falls back to stored sticky dataKey when match is broad (path: '/**') and avoids refreshing TTL on hydrated lookup", () => {
    const t0 = 1_700_000_000;

    // Case 1: Broad match (`path: "/**"`) + non-sticky lookup key (`{{company.slug}}`)
    const broadCompanyConfig = mustParse(`
version: 1
data:
  accounts:
    stripe:
      name: "Stripe"
experiences:
  - id: broad-company-abm
    name: "Broad Company ABM"
    sticky: "24h"
    lookup:
      table: accounts
      key: "{{company.slug}}"
    match:
      path: "/**"
    changes:
      - selector: "h1"
        text: "Built for {{data.name}}"
`);

    const visit1 = evaluate(
      broadCompanyConfig,
      makeContext({ path: "/", company: { slug: "stripe" } }),
      { visitorId: "v1", now: t0 },
    );
    expect(visit1.matched.map((m) => m.experienceId)).toEqual(["broad-company-abm"]);
    expect(visit1.activeChanges[0]?.text).toBe("Built for Stripe");
    expect(visit1.stickyCookie).not.toBeNull();
    expect(visit1.stickyCookie?.maxAgeSeconds).toBe(86400);

    // Visit 2: no company enrichment, broad match passes freshly but lookup key is empty -> falls back to sticky dataKey!
    const visit2 = evaluate(
      broadCompanyConfig,
      makeContext({
        path: "/pricing",
        cookies: { [DEFAULT_STICKY_COOKIE_NAME]: visit1.stickyCookie!.value },
      }),
      { visitorId: "v1", now: t0 + 3600 },
    );
    expect(visit2.matched.map((m) => m.experienceId)).toEqual(["broad-company-abm"]);
    expect(visit2.activeChanges[0]?.text).toBe("Built for Stripe");
    expect(visit2.stickyCookie).toBeNull();
    expect(visit2.cacheControl).toBe(PERSONALIZED_CACHE_CONTROL);

    // Case 2: Broad match (`path: "/**"`) + hydrated `{{query.acct}}` lookup does NOT refresh TTL / re-emit cookie
    const broadAcctConfig = mustParse(`
version: 1
data:
  accounts:
    stripe:
      name: "Stripe"
experiences:
  - id: broad-acct-abm
    name: "Broad Acct ABM"
    sticky: "1h"
    lookup:
      table: accounts
      key: "{{query.acct}}"
    match:
      path: "/**"
    changes:
      - selector: "h1"
        text: "Welcome {{data.name}}"
`);

    const acctVisit1 = evaluate(
      broadAcctConfig,
      makeContext({ path: "/", query: { acct: "stripe" } }),
      { visitorId: "v2", now: t0 },
    );
    expect(acctVisit1.matched.map((m) => m.experienceId)).toEqual(["broad-acct-abm"]);
    expect(acctVisit1.stickyCookie?.maxAgeSeconds).toBe(3600);

    // Visit 2 at t0 + 1800: matches via hydrated query.acct, does NOT rewrite cookie or extend TTL
    const acctVisit2 = evaluate(
      broadAcctConfig,
      makeContext({
        path: "/docs",
        cookies: { [DEFAULT_STICKY_COOKIE_NAME]: acctVisit1.stickyCookie!.value },
      }),
      { visitorId: "v2", now: t0 + 1800 },
    );
    expect(acctVisit2.matched.map((m) => m.experienceId)).toEqual(["broad-acct-abm"]);
    expect(acctVisit2.activeChanges[0]?.text).toBe("Welcome Stripe");
    expect(acctVisit2.stickyCookie).toBeNull();
    expect(acctVisit2.cacheControl).toBe(PERSONALIZED_CACHE_CONTROL);

    // Explicit unknown ?acct=unknown does NOT fall back to stale sticky Stripe
    const explicitUnknown = evaluate(
      broadAcctConfig,
      makeContext({
        path: "/docs",
        query: { acct: "unknown" },
        cookies: { [DEFAULT_STICKY_COOKIE_NAME]: acctVisit1.stickyCookie!.value },
      }),
      { visitorId: "v2", now: t0 + 1900 },
    );
    expect(explicitUnknown.matched).toEqual([]);
  });
});
