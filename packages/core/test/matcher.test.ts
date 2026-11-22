import { describe, expect, it } from "vitest";
import {
  buildContextFromRequest,
  matchGlob,
  matchesCondition,
  parseCookies,
  type RequestContext,
} from "../src/index.js";

function makeContext(overrides?: Partial<RequestContext>): RequestContext {
  return {
    url: "https://example.com/?utm_source=google&utm_campaign=fintech-q4&acct=stripe&seats=150",
    host: "example.com",
    path: "/",
    query: {
      utm_source: "google",
      utm_campaign: "fintech-q4",
      acct: "stripe",
      seats: "150",
    },
    utm_source: "google",
    utm_campaign: "fintech-q4",
    referrer: "https://www.google.com/search?q=fintech",
    cookies: {
      __facet_vid: "vid-123",
      plan: "enterprise",
    },
    headers: {
      "x-region": "us-east",
      "user-agent": "Mozilla/5.0",
    },
    returning: true,
    visitorId: "vid-123",
    geo: {
      country: "US",
      region: "CA",
      city: "San Francisco",
    },
    company: {
      name: "Stripe",
      industry: "FinTech",
      employees: 8000,
    },
    ...overrides,
  };
}

describe("context extraction", () => {
  it("extracts URL, query, UTMs, headers, referrer, cookies, and returning flag", () => {
    const req = new Request(
      "https://acme.io/pricing?utm_source=linkedin&utm_medium=paid&utm_campaign=abm&utm_term=saas&utm_content=hero-a&acct=plaid",
      {
        headers: {
          Referer: "https://linkedin.com/feed",
          Cookie: "__facet_vid=abc-123; theme=dark; bad=%E0%A4%A",
          "X-Custom-Header": "hello",
        },
      },
    );

    const ctx = buildContextFromRequest(req, {
      geo: { country: "GB" },
      company: { industry: "Financial Services", employees: 500 },
    });

    expect(ctx.host).toBe("acme.io");
    expect(ctx.path).toBe("/pricing");
    expect(ctx.utm_source).toBe("linkedin");
    expect(ctx.utm_medium).toBe("paid");
    expect(ctx.utm_campaign).toBe("abm");
    expect(ctx.utm_term).toBe("saas");
    expect(ctx.utm_content).toBe("hero-a");
    expect(ctx.query["acct"]).toBe("plaid");
    expect(ctx.referrer).toBe("https://linkedin.com/feed");
    expect(ctx.headers["x-custom-header"]).toBe("hello");
    expect(ctx.cookies["__facet_vid"]).toBe("abc-123");
    expect(ctx.cookies["theme"]).toBe("dark");
    expect(ctx.cookies["bad"]).toBe("%E0%A4%A");
    expect(ctx.visitorId).toBe("abc-123");
    expect(ctx.returning).toBe(true);
    expect(ctx.geo.country).toBe("GB");
    expect(ctx.company.employees).toBe(500);
  });

  it("sets returning to false when visitor cookie is absent", () => {
    const req = new Request("https://acme.io/");
    const ctx = buildContextFromRequest(req);
    expect(ctx.returning).toBe(false);
    expect(ctx.visitorId).toBeUndefined();
  });

  it("parses edge-case cookie headers safely", () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies("")).toEqual({});
    expect(parseCookies("a=1=2; b=hello%20world; invalid; =noname; a=second")).toEqual({
      a: "1=2",
      b: "hello world",
    });
  });
});

describe("matchGlob", () => {
  it("handles exact paths, single-segment *, multi-segment **, ?, and regex chars", () => {
    expect(matchGlob("/", "/")).toBe(true);
    expect(matchGlob("/", "/about")).toBe(false);
    expect(matchGlob("/pricing/*", "/pricing/enterprise")).toBe(true);
    expect(matchGlob("/pricing/*", "/pricing/enterprise/extra")).toBe(false);
    expect(matchGlob("/blog/**", "/blog/2026/launch")).toBe(true);
    expect(matchGlob("/blog/**", "/blog/post")).toBe(true);
    expect(matchGlob("/blog/**", "/blog-old/post")).toBe(false);
    expect(matchGlob("/**", "/anything/at/all")).toBe(true);
    expect(matchGlob("/v?/docs", "/v2/docs")).toBe(true);
    expect(matchGlob("/v?/docs", "/v10/docs")).toBe(false);
    expect(matchGlob("/file.v1+(test).html", "/file.v1+(test).html")).toBe(true);
    expect(matchGlob("/file.v1+(test).html", "/fileXv1+(test).html")).toBe(false);
  });
});

describe("matchesCondition", () => {
  it("matches top-level fields and path globs", () => {
    const ctx = makeContext({ path: "/for/stripe" });
    expect(matchesCondition({ path: "/for/*" }, ctx)).toBe(true);
    expect(matchesCondition({ path: ["/pricing", "/for/*"] }, ctx)).toBe(true);
    expect(matchesCondition({ path: "/blog/**" }, ctx)).toBe(false);
    expect(matchesCondition({ host: "example.com" }, ctx)).toBe(true);
    expect(matchesCondition({ utm_source: "google", returning: true }, ctx)).toBe(true);
    expect(matchesCondition({ returning: false }, ctx)).toBe(false);
  });

  it("matches dotted keys and nested maps identically", () => {
    const ctx = makeContext();
    expect(
      matchesCondition(
        {
          "query.acct": ["stripe", "plaid"],
          "cookie.plan": "enterprise",
          "header.X-Region": "us-east",
          "geo.country": "US",
          "company.industry": "FinTech",
        },
        ctx,
      ),
    ).toBe(true);

    expect(
      matchesCondition(
        {
          query: { acct: "stripe" },
          cookie: { plan: "enterprise" },
          header: { "x-region": "us-east" },
          geo: { country: "US", city: "San Francisco" },
          company: { industry: ["Financial Services", "FinTech"] },
        },
        ctx,
      ),
    ).toBe(true);
  });

  it("supports all comparison operators including numeric string coercion and exists", () => {
    const ctx = makeContext();

    expect(matchesCondition({ utm_campaign: { equals: "fintech-q4" } }, ctx)).toBe(true);
    expect(matchesCondition({ utm_campaign: { in: ["fintech-q4", "other"] } }, ctx)).toBe(true);
    expect(matchesCondition({ referrer: { contains: "google.com" } }, ctx)).toBe(true);
    expect(matchesCondition({ referrer: { startsWith: "https://" } }, ctx)).toBe(true);
    expect(matchesCondition({ utm_campaign: { endsWith: "-q4" } }, ctx)).toBe(true);
    expect(matchesCondition({ utm_campaign: { regex: "^fintech-q[1-4]$" } }, ctx)).toBe(true);
    expect(matchesCondition({ "company.employees": { gt: 1000, lte: 8000 } }, ctx)).toBe(true);
    expect(matchesCondition({ "company.employees": { gte: 8000, lt: 9000 } }, ctx)).toBe(true);
    expect(matchesCondition({ "company.employees": { gt: 8000 } }, ctx)).toBe(false);
    // Numeric coercion from query string "150"
    expect(matchesCondition({ "query.seats": { gte: 100, lt: 200 } }, ctx)).toBe(true);
    expect(matchesCondition({ "query.acct": { gte: 10 } }, ctx)).toBe(false);
    // exists operator
    expect(matchesCondition({ "query.acct": { exists: true } }, ctx)).toBe(true);
    expect(matchesCondition({ "query.missing": { exists: false } }, ctx)).toBe(true);
    expect(matchesCondition({ "query.acct": { exists: false } }, ctx)).toBe(false);
    expect(matchesCondition({ "query.missing": { exists: true } }, ctx)).toBe(false);
    // path globs inside `in` operator
    expect(
      matchesCondition(
        { path: { in: ["/blog/**", "/pricing/*"] } },
        makeContext({ path: "/blog/2026/a" }),
      ),
    ).toBe(true);
  });

  it("evaluates recursive all/any/not combinators", () => {
    const ctx = makeContext();

    expect(
      matchesCondition(
        {
          path: "/",
          any: [
            { utm_campaign: ["other"] },
            {
              all: [{ "query.acct": "stripe" }, { not: { "geo.country": "FR" } }],
            },
          ],
        },
        ctx,
      ),
    ).toBe(true);

    expect(
      matchesCondition(
        {
          not: { "company.industry": "FinTech" },
        },
        ctx,
      ),
    ).toBe(false);
  });

  it("ignores inherited Object.prototype properties on plain maps and preserves real keys with those names", () => {
    const emptyCtx = makeContext({
      query: {},
      cookies: {},
      headers: {},
      geo: {},
      company: {},
    });

    expect(matchesCondition({ "query.toString": { exists: true } }, emptyCtx)).toBe(false);
    expect(matchesCondition({ "query.toString": { exists: false } }, emptyCtx)).toBe(true);
    expect(matchesCondition({ "cookie.constructor": { exists: true } }, emptyCtx)).toBe(false);
    expect(matchesCondition({ "header.valueOf": { exists: true } }, emptyCtx)).toBe(false);
    expect(matchesCondition({ "geo.hasOwnProperty": { exists: true } }, emptyCtx)).toBe(false);
    expect(matchesCondition({ "company.toString": { exists: true } }, emptyCtx)).toBe(false);

    const req = new Request("https://acme.io/?toString=hello&constructor=world", {
      headers: {
        Cookie: "toString=cookie-val; constructor=ctor-val",
      },
    });
    const parsedCtx = buildContextFromRequest(req);
    expect(matchesCondition({ "query.toString": "hello" }, parsedCtx)).toBe(true);
    expect(matchesCondition({ "query.constructor": "world" }, parsedCtx)).toBe(true);
    expect(matchesCondition({ "cookie.toString": "cookie-val" }, parsedCtx)).toBe(true);
    expect(matchesCondition({ "cookie.constructor": "ctor-val" }, parsedCtx)).toBe(true);
  });
});
