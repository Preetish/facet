import { buildPreviewUrl, type StickyCookieDirective } from "@facet/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildOriginUrl,
  createFacetWorker,
  formatStickyCookie,
  handleFacetRequest,
} from "../src/index.js";
import { createWasmRewriterFactory } from "./helpers/wasm-rewriter.js";

const HOME_HTML = `<!doctype html>
<html>
  <head><title>Acme</title></head>
  <body>
    <h1 class="hero">Default Home Headline</h1>
    <p id="subhead">Default subhead</p>
    <a data-cta="hero" href="/demo">Book Demo</a>
    <div id="logo-strip"><span>Default Logos</span></div>
    <div id="card"><span>Card</span></div>
  </body>
</html>`;

const PRICING_HTML = `<!doctype html>
<html>
  <head><title>Pricing</title></head>
  <body>
    <h1 class="hero">Standard Pricing</h1>
    <a data-cta="pricing" href="/signup">Start Free</a>
  </body>
</html>`;

function extractCookieHeader(setCookies: readonly string[]): string {
  return setCookies
    .map((header) => header.split(";", 1)[0]?.trim() ?? "")
    .filter((pair) => pair.length > 0)
    .join("; ");
}

function createRoutingOriginFetch(): {
  fetchFn: typeof fetch;
  requestedUrls: string[];
} {
  const requestedUrls: string[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const req = input as Request;
    requestedUrls.push(req.url);
    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response(HOME_HTML, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=600",
          vary: "Accept-Encoding",
        },
      });
    }

    if (url.pathname === "/pricing") {
      return new Response(PRICING_HTML, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }

    if (url.pathname === "/redirect-target") {
      return new Response(null, {
        status: 302,
        headers: {
          location: "/moved",
          "content-type": "text/html",
        },
      });
    }

    if (url.pathname === "/json-target") {
      return new Response('{"status":"ok"}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=60",
        },
      });
    }

    return new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }) as unknown as typeof fetch;

  return { fetchFn, requestedUrls };
}

const ABM_YAML = `
version: 1
settings:
  cookieName: "__facet_vid"
  stickyCookieName: "__facet_sticky"
  analytics:
    providers: ["ga4", "custom"]
  slots:
    account-badge: '<span class="acct-badge">Partner: {{data.company}}</span>'
data:
  accounts:
    stripe:
      company: "Stripe"
      headline: "Payment infrastructure teams trust Acme"
      cta: "Book Stripe Demo"
    xss-corp:
      company: '<script>alert("xss")</script> & Co'
      headline: 'Built for <img src=x onerror=alert(1)>'
      cta: 'Demo "quoted" <script>'
experiences:
  - id: abm-page
    name: "1:1 ABM Landing Page"
    priority: 20
    match:
      path: "/for/:account"
    lookup:
      table: "accounts"
      key: "{{params.account}}"
      required: true
    originPath: "/"
    sticky: "session"
    changes:
      - selector: "h1"
        text: "{{data.headline}}"
      - selector: "#subhead"
        html: "<strong>Tailored for {{data.company}} ({{params.account}})</strong>"
      - selector: "[data-cta='hero']"
        text: "{{data.cta}}"
        attrs:
          href: "/demo?acct={{params.account}}&co={{data.company}}"
      - selector: "#logo-strip"
        slot: "account-badge"
      - selector: "#card"
        prepend: '<em class="pre">{{data.company}}</em>'
        append: '<em class="post">{{params.account}}</em>'
`;

describe("@facet/worker v0.2 features (originPath, templates/XSS, stickyCookie)", () => {
  it("rewrites /for/stripe virtual URL to origin '/' preserving query params for variant matches", async () => {
    const { fetchFn, requestedUrls } = createRoutingOriginFetch();
    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: ABM_YAML,
      fetchFn,
      createRewriter: createWasmRewriterFactory(),
      generateVisitorId: () => "vis_abm_1",
    });

    const res = await worker.fetch(
      new Request("https://site.example.com/for/stripe?utm_source=linkedin&ref=outbound"),
    );
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(requestedUrls).toEqual(["https://origin.example.com/?utm_source=linkedin&ref=outbound"]);
    expect(body).toContain("Payment infrastructure teams trust Acme");
    expect(body).toContain("<strong>Tailored for Stripe (stripe)</strong>");
    expect(body).toContain("Book Stripe Demo");
    expect(body).toContain('<span class="acct-badge">Partner: Stripe</span>');
    expect(body).toContain('<em class="pre">Stripe</em>');
    expect(body).toContain('<em class="post">stripe</em>');
    expect(body).toContain('"experienceId":"abm-page"');
    expect(body).toContain('"bucket":"variant"');

    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toBe("Accept-Encoding, Cookie");

    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith("__facet_vid=vis_abm_1;"))).toBe(true);
    const stickySetCookie = setCookies.find((c) => c.startsWith("__facet_sticky="));
    expect(stickySetCookie).toBeDefined();
    expect(stickySetCookie).toContain("Path=/; SameSite=Lax; HttpOnly; Secure");
    expect(stickySetCookie).not.toContain("Max-Age=");
  });

  it("rewrites /for/stripe to origin '/' even for control holdout visitors (no 404, no DOM swaps)", async () => {
    const controlYaml = ABM_YAML.replace('sticky: "session"', 'holdout: 1\n    sticky: "session"');
    const { fetchFn, requestedUrls } = createRoutingOriginFetch();
    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: controlYaml,
      fetchFn,
      createRewriter: createWasmRewriterFactory(),
      generateVisitorId: () => "vis_control_1",
    });

    const res = await worker.fetch(new Request("https://site.example.com/for/stripe?ref=abm"));
    const body = await res.text();

    // Virtual URL must still resolve to "/" on origin so control visitors don't 404
    expect(res.status).toBe(200);
    expect(requestedUrls).toEqual(["https://origin.example.com/?ref=abm"]);

    // Control bucket receives untouched default headline + control exposure
    expect(body).toContain("Default Home Headline");
    expect(body).not.toContain("Payment infrastructure teams trust Acme");
    expect(body).toContain('"experienceId":"abm-page"');
    expect(body).toContain('"bucket":"control"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toBe("Accept-Encoding, Cookie");
  });

  it("falls through to original pathname when required lookup misses on /for/unknown", async () => {
    const { fetchFn, requestedUrls } = createRoutingOriginFetch();
    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: ABM_YAML,
      fetchFn,
      createRewriter: createWasmRewriterFactory(),
    });

    const res = await worker.fetch(new Request("https://site.example.com/for/unknown-corp"));
    expect(res.status).toBe(404);
    expect(requestedUrls).toEqual(["https://origin.example.com/for/unknown-corp"]);
  });

  it("escapes untrusted {{data.*}} and {{params.*}} values across text, html, slot, prepend, append, and attrs without double-escaping", async () => {
    const { fetchFn } = createRoutingOriginFetch();
    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: ABM_YAML,
      fetchFn,
      createRewriter: createWasmRewriterFactory(),
      generateVisitorId: () => "vis_xss_1",
    });

    const res = await worker.fetch(new Request("https://site.example.com/for/xss-corp"));
    const body = await res.text();

    expect(res.status).toBe(200);
    // text: escaped once (no raw <img and no double-escaped &amp;lt;)
    expect(body).toContain("Built for &lt;img src=x onerror=alert(1)&gt;");
    expect(body).not.toContain("<img src=x onerror=alert(1)>");
    expect(body).not.toContain("&amp;lt;");

    // html: static <strong> kept, interpolated data escaped
    expect(body).toContain(
      "<strong>Tailored for &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; Co (xss-corp)</strong>",
    );
    expect(body).not.toContain('<script>alert("xss")</script>');

    // slot, prepend, append: static markup kept, interpolated values escaped
    expect(body).toContain(
      '<span class="acct-badge">Partner: &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; Co</span>',
    );
    expect(body).toContain(
      '<em class="pre">&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; Co</em>',
    );

    // attrs & text: <script> escaped in text node and quotes escaped inside attribute value
    expect(body).toContain('Demo "quoted" &lt;script&gt;');
    expect(body).toMatch(/href="\/demo\?acct=xss-corp&(?:amp;)?co=[^"]*&quot;xss&quot;[^"]*"/);
  });

  it("persists session-sticky attribution across subsequent navigation to /pricing without query params", async () => {
    const stickyMultiPageYaml = `
version: 1
settings:
  cookieName: "__facet_vid"
  stickyCookieName: "__facet_sticky"
data:
  accounts:
    stripe:
      company: "Stripe"
experiences:
  - id: utm-home
    name: "Fintech Home"
    priority: 10
    match:
      path: "/"
      utm_campaign: "fintech-q4"
    sticky: "session"
    changes:
      - selector: "h1"
        text: "Fintech Home Hero"
  - id: utm-pricing
    name: "Fintech Pricing"
    priority: 10
    match:
      path: "/pricing"
      utm_campaign: "fintech-q4"
    sticky: "session"
    changes:
      - selector: "h1"
        text: "Enterprise Fintech Pricing"
`;
    const { fetchFn } = createRoutingOriginFetch();
    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: stickyMultiPageYaml,
      fetchFn,
      createRewriter: createWasmRewriterFactory(),
      generateVisitorId: () => "vis_sticky_session",
    });

    // 1. Landing page with UTM (HTTP -> no Secure flag, session -> no Max-Age)
    const res1 = await worker.fetch(new Request("http://localhost:8787/?utm_campaign=fintech-q4"));
    expect(await res1.text()).toContain("Fintech Home Hero");
    expect(res1.headers.get("cache-control")).toBe("private, no-store");
    expect(res1.headers.get("vary")).toContain("Cookie");

    const cookies1 = res1.headers.getSetCookie();
    const sticky1 = cookies1.find((c) => c.startsWith("__facet_sticky="));
    expect(sticky1).toBeDefined();
    expect(sticky1).toContain("Path=/; SameSite=Lax; HttpOnly");
    expect(sticky1).not.toContain("Max-Age=");
    expect(sticky1).not.toContain("Secure");

    // 2. Subsequent visit to /pricing without UTMs, sending cookies from visit 1
    const cookieHeader1 = extractCookieHeader(cookies1);
    const res2 = await worker.fetch(
      new Request("http://localhost:8787/pricing", {
        headers: { cookie: cookieHeader1 },
      }),
    );
    expect(await res2.text()).toContain("Enterprise Fintech Pricing");
    expect(res2.headers.get("cache-control")).toBe("private, no-store");
    expect(res2.headers.get("vary")).toBe("Cookie");

    // 3. Third visit to /pricing with updated cookies still matches and does not re-emit Set-Cookie
    const cookies2 = res2.headers.getSetCookie();
    const mergedCookieHeader = extractCookieHeader([
      ...cookies1.filter((c) => c.startsWith("__facet_vid=")),
      ...(cookies2.length > 0 ? cookies2 : cookies1.filter((c) => c.startsWith("__facet_sticky="))),
    ]);
    const res3 = await worker.fetch(
      new Request("http://localhost:8787/pricing", {
        headers: { cookie: mergedCookieHeader },
      }),
    );
    expect(await res3.text()).toContain("Enterprise Fintech Pricing");
    expect(res3.headers.get("cache-control")).toBe("private, no-store");
    expect(res3.headers.getSetCookie()).toEqual([]);
  });

  it("emits timed stickyCookie with Max-Age using options.now() and expires after duration", async () => {
    const timedYaml = `
version: 1
experiences:
  - id: timed-home
    name: "Timed Home"
    match:
      path: "/"
      query.acct: "stripe"
    sticky: "30m"
    changes:
      - selector: "h1"
        text: "Stripe Home"
  - id: timed-pricing
    name: "Timed Pricing"
    match:
      path: "/pricing"
      query.acct: "stripe"
    sticky: "30m"
    changes:
      - selector: "h1"
        text: "Stripe Pricing"
`;
    let currentTimeSec = 1700000000;
    const { fetchFn } = createRoutingOriginFetch();
    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: timedYaml,
      fetchFn,
      createRewriter: createWasmRewriterFactory(),
      generateVisitorId: () => "vis_timed_1",
      now: () => currentTimeSec,
    });

    // First visit at t=0 -> sets Max-Age=1800 and Secure on HTTPS
    const res1 = await worker.fetch(new Request("https://site.example.com/?acct=stripe"));
    expect(await res1.text()).toContain("Stripe Home");
    const cookies1 = res1.headers.getSetCookie();
    const sticky1 = cookies1.find((c) => c.startsWith("__facet_sticky="));
    expect(sticky1).toBeDefined();
    expect(sticky1).toContain("Path=/; SameSite=Lax; HttpOnly; Max-Age=1800; Secure");

    const cookieHeader = extractCookieHeader(cookies1);

    // Within TTL (t + 600s) -> /pricing still matches via sticky cookie
    currentTimeSec += 600;
    const res2 = await worker.fetch(
      new Request("https://site.example.com/pricing", {
        headers: { cookie: cookieHeader },
      }),
    );
    expect(await res2.text()).toContain("Stripe Pricing");
    expect(res2.headers.get("cache-control")).toBe("private, no-store");
    expect(res2.headers.get("vary")).toBe("Cookie");

    // Past TTL (t + 2000s > 1800s) -> expired, returns standard pricing with origin cache-control
    currentTimeSec += 1400;
    const res3 = await worker.fetch(
      new Request("https://site.example.com/pricing", {
        headers: { cookie: cookieHeader },
      }),
    );
    expect(await res3.text()).toContain("Standard Pricing");
    expect(res3.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res3.headers.getSetCookie()).toEqual([]);
  });

  it("suppresses stickyCookie and visitor cookie in previewMode while still applying originPath", async () => {
    const secret = "preview-secret-v02";
    const nowSec = 1700000000;
    const { fetchFn, requestedUrls } = createRoutingOriginFetch();
    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: ABM_YAML,
      previewSecret: secret,
      fetchFn,
      createRewriter: createWasmRewriterFactory(),
      now: () => nowSec,
    });

    const previewUrl = await buildPreviewUrl({
      baseUrl: "https://site.example.com/for/stripe",
      experienceId: "abm-page",
      secret,
      expiresAt: nowSec + 3600,
    });

    const res = await worker.fetch(new Request(previewUrl));
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(requestedUrls[0]).toMatch(/^https:\/\/origin\.example\.com\/\?/);
    expect(body).toContain("Payment infrastructure teams trust Acme");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toContain("Cookie");
    // Preview mode must never set visitor or sticky cookies
    expect(res.headers.getSetCookie()).toEqual([]);

    // Millisecond options.now() (e.g. Date.now()) works consistently for verifyPreviewToken too
    const msWorker = createFacetWorker({
      origin: "https://origin.example.com",
      config: ABM_YAML,
      previewSecret: secret,
      fetchFn,
      createRewriter: createWasmRewriterFactory(),
      now: () => nowSec * 1000,
    });
    const msRes = await msWorker.fetch(new Request(previewUrl));
    expect(msRes.status).toBe(200);
    expect(await msRes.text()).toContain("Payment infrastructure teams trust Acme");
    expect(msRes.headers.getSetCookie()).toEqual([]);
  });

  it("passes non-HTML and 3xx upstream responses through untouched without setting cookies even when originPath matched", async () => {
    const redirectAndJsonYaml = `
version: 1
experiences:
  - id: to-redirect
    name: "Redirect originPath"
    match:
      path: "/go-redirect"
    originPath: "/redirect-target"
    sticky: "7d"
    changes:
      - selector: "h1"
        text: "Should not run"
  - id: to-json
    name: "JSON originPath"
    match:
      path: "/go-json"
    originPath: "/json-target"
    sticky: "7d"
    changes:
      - selector: "h1"
        text: "Should not run"
`;
    const { fetchFn } = createRoutingOriginFetch();
    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: redirectAndJsonYaml,
      fetchFn,
      createRewriter: createWasmRewriterFactory(),
    });

    const redirectRes = await worker.fetch(new Request("https://site.example.com/go-redirect"));
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.get("location")).toBe("/moved");
    expect(redirectRes.headers.getSetCookie()).toEqual([]);

    const jsonRes = await worker.fetch(new Request("https://site.example.com/go-json"));
    expect(jsonRes.status).toBe(200);
    expect(await jsonRes.text()).toBe('{"status":"ok"}');
    expect(jsonRes.headers.get("cache-control")).toBe("public, max-age=60");
    expect(jsonRes.headers.getSetCookie()).toEqual([]);
  });

  it("fails open to fetching original incoming pathname on config or evaluate errors", async () => {
    const onError = vi.fn();
    const { fetchFn, requestedUrls } = createRoutingOriginFetch();

    // 1. Invalid config falls back to fetching original /for/stripe untouched
    const badConfigRes = await handleFacetRequest(
      new Request("https://site.example.com/for/stripe?a=1"),
      {
        origin: "https://origin.example.com",
        config: "version: 999\ninvalid: [",
        fetchFn,
        onError,
      },
    );
    expect(badConfigRes.status).toBe(404);
    expect(requestedUrls[0]).toBe("https://origin.example.com/for/stripe?a=1");
    expect(badConfigRes.headers.getSetCookie()).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.anything(), "config");

    // 2. Throwing options.now() fails open to original pathname without crashing
    const throwingNowRes = await handleFacetRequest(
      new Request("https://site.example.com/pricing?x=2"),
      {
        origin: "https://origin.example.com",
        config: ABM_YAML,
        fetchFn,
        now: () => {
          throw new Error("clock unavailable");
        },
        onError,
      },
    );
    expect(throwingNowRes.status).toBe(200);
    expect(await throwingNowRes.text()).toContain("Standard Pricing");
    expect(requestedUrls[1]).toBe("https://origin.example.com/pricing?x=2");
    expect(throwingNowRes.headers.getSetCookie()).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "evaluate");
  });

  it("guards buildOriginUrl against //, \\\\, and .. path traversal and formats sticky cookies accurately", () => {
    const req = new Request("https://site.example.com/for/stripe?utm_source=ads");
    const originWithBase = "https://origin.example.com/app/";

    // Valid overrides preserve query params and basePath
    expect(buildOriginUrl(req, originWithBase, "/").toString()).toBe(
      "https://origin.example.com/app/?utm_source=ads",
    );
    expect(buildOriginUrl(req, originWithBase, "/landing?tpl=abm").toString()).toBe(
      "https://origin.example.com/app/landing?utm_source=ads&tpl=abm",
    );

    // Unsafe overrides are ignored (fall back to incoming pathname, never change host or escape basePath)
    const unsafeOverrides = [
      "//evil.com/phish",
      "/\\evil.com/phish",
      "/../secret",
      "/a/../../secret",
      "/%2e%2e/secret",
      "/%252e%252e/secret",
      "/%5cevil.com",
      "https://evil.com/phish",
      "/bad\r\nheader",
    ];
    for (const unsafe of unsafeOverrides) {
      const built = buildOriginUrl(req, originWithBase, unsafe);
      expect(built.origin).toBe("https://origin.example.com");
      expect(built.toString()).toBe("https://origin.example.com/app/for/stripe?utm_source=ads");
    }

    // formatStickyCookie: session (null), zero, positive Max-Age, Secure vs non-Secure
    const sessionDirective: StickyCookieDirective = {
      name: "__facet_sticky",
      value: "eyJ2IjoxfQ",
      maxAgeSeconds: null,
    };
    expect(formatStickyCookie(sessionDirective, true)).toBe(
      "__facet_sticky=eyJ2IjoxfQ; Path=/; SameSite=Lax; HttpOnly; Secure",
    );
    expect(formatStickyCookie(sessionDirective, false)).toBe(
      "__facet_sticky=eyJ2IjoxfQ; Path=/; SameSite=Lax; HttpOnly",
    );

    const zeroDirective: StickyCookieDirective = {
      name: "__facet_sticky",
      value: "eyJ2IjoxfQ",
      maxAgeSeconds: 0,
    };
    expect(formatStickyCookie(zeroDirective, false)).toBe(
      "__facet_sticky=eyJ2IjoxfQ; Path=/; SameSite=Lax; HttpOnly",
    );

    const timedDirective: StickyCookieDirective = {
      name: "__facet_sticky",
      value: "eyJ2IjoxfQ",
      maxAgeSeconds: 3600,
    };
    expect(formatStickyCookie(timedDirective, true)).toBe(
      "__facet_sticky=eyJ2IjoxfQ; Path=/; SameSite=Lax; HttpOnly; Max-Age=3600; Secure",
    );
  });
});
