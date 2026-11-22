import { buildPreviewUrl, parseFacetYaml, type FacetConfig } from "@facet/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildOriginUrl,
  createFacetWorker,
  extractCloudflareGeo,
  formatVisitorCookie,
  handleFacetRequest,
  isHtmlContentType,
  isStaticAssetPath,
  type EnrichmentAdapter,
  type EnrichmentCacheStore,
  type FacetWorkerEnv,
} from "../src/index.js";
import { createWasmRewriterFactory } from "./helpers/wasm-rewriter.js";

const SAMPLE_HTML = `<!doctype html>
<html>
  <head><title>Default Site</title></head>
  <body>
    <h1 class="hero-title old-theme">Default Headline</h1>
    <p id="subhead">Default subhead</p>
    <a data-cta="hero" href="/signup" data-old="remove-me" class="btn primary">Get Started</a>
    <div id="logo-strip"><span>Default Logos</span></div>
    <div id="promo-banner">Banner</div>
    <div id="card"><span>Card Body</span></div>
  </body>
</html>`;

const BASE_YAML = `
version: 1
settings:
  cookieName: "__facet_vid"
  previewParam: "__facet_preview"
  analytics:
    providers: ["ga4", "umami", "posthog", "custom"]
  slots:
    fintech-logos: '<ul class="logos"><li>Stripe</li><li>Plaid</li></ul>'
experiences:
  - id: fintech-abm
    name: "Fintech ABM & Paid Search"
    priority: 10
    match:
      path: "/"
      any:
        - utm_campaign: ["fintech-q4"]
        - query.acct: ["stripe"]
        - company.industry: ["FinTech"]
    holdout: 0
    changes:
      - selector: "h1"
        text: "Compliance-ready <script>alert(1)</script> fintech"
        addClass: ["fintech-hero", "hero-title"]
        removeClass: "old-theme"
      - selector: "#subhead"
        html: "<strong>Trusted by banks</strong>"
      - selector: "[data-cta='hero']"
        text: "See the fintech demo"
        attrs:
          href: "/demo?segment=fintech"
          data-old: null
          data-segment: "fintech"
      - selector: "#logo-strip"
        slot: "fintech-logos"
      - selector: "#promo-banner"
        remove: true
      - selector: "#card"
        prepend: '<span class="badge">New</span>'
        append: '<span class="footer">SOC2</span>'
`;

function createMockOriginFetch(
  html = SAMPLE_HTML,
  headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=600",
    "content-length": String(html.length),
    vary: "Accept-Encoding",
  },
): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    return new Response(html, {
      status: 200,
      headers,
    });
  }) as unknown as typeof fetch;
}

describe("@facet/worker handler & HTMLRewriter end-to-end", () => {
  it("applies all DOM transforms (text escaping, html, slot, attrs, classes, remove, prepend, append) and analytics", async () => {
    const fetchFn = createMockOriginFetch();
    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: BASE_YAML,
      fetchFn,
      createRewriter: createWasmRewriterFactory(),
      generateVisitorId: () => "vis_12345",
    });

    const req = new Request("https://site.example.com/?utm_campaign=fintech-q4");
    const res = await worker.fetch(req);
    const body = await res.text();

    // text is HTML-escaped
    expect(body).toContain("Compliance-ready &lt;script&gt;alert(1)&lt;/script&gt; fintech");
    expect(body).not.toContain("<script>alert(1)</script>");

    // addClass (deduped) + removeClass
    expect(body).toMatch(/<h1 class="hero-title fintech-hero">/);
    expect(body).not.toContain("old-theme");

    // raw html replacement
    expect(body).toContain('<p id="subhead"><strong>Trusted by banks</strong></p>');

    // attrs set + null removal + text
    expect(body).toContain('href="/demo?segment=fintech"');
    expect(body).toContain('data-segment="fintech"');
    expect(body).not.toContain("data-old");
    expect(body).toContain("See the fintech demo");

    // slot resolved from settings.slots
    expect(body).toContain('<ul class="logos"><li>Stripe</li><li>Plaid</li></ul>');

    // remove: true
    expect(body).not.toContain("promo-banner");

    // prepend & append
    expect(body).toContain(
      '<div id="card"><span class="badge">New</span><span>Card Body</span><span class="footer">SOC2</span></div>',
    );

    // analytics snippet injected right before </body>, strictly minimal payload
    expect(body).toMatch(/<script data-facet-analytics>.*<\/script>\s*<\/body>/s);
    expect(body).toContain('"experienceId":"fintech-abm"');
    expect(body).toContain('"bucket":"variant"');
    expect(body).not.toContain("Fintech ABM & Paid Search");
    expect(body).toContain("window.gtag");
    expect(body).toContain("window.umami");
    expect(body).toContain("window.posthog");
    expect(body).toContain("facet:exposure");

    // safe HTTP caching + Vary merge + content-length stripped
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toBe("Accept-Encoding, Cookie");
    expect(res.headers.get("content-length")).toBeNull();

    // sticky first-party cookie with Secure on HTTPS
    expect(res.headers.get("set-cookie")).toBe(
      "__facet_vid=vis_12345; Path=/; SameSite=Lax; HttpOnly; Max-Age=31536000; Secure",
    );
  });

  it("removes empty class attribute when removeClass strips all classes", async () => {
    const yaml = `
version: 1
experiences:
  - id: strip-classes
    name: "Strip classes"
    match:
      path: "/"
    changes:
      - selector: "h1"
        removeClass: ["hero-title", "old-theme"]
`;
    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: yaml,
      fetchFn: createMockOriginFetch(),
      createRewriter: createWasmRewriterFactory(),
    });

    const res = await worker.fetch(new Request("https://site.example.com/"));
    const body = await res.text();
    expect(body).toContain("<h1>Default Headline</h1>");
  });

  it("bypasses non-GET/HEAD requests untouched without evaluating or setting cookies", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const req = input as Request;
      const text = await req.text();
      return new Response(JSON.stringify({ echo: text }), {
        status: 201,
        headers: { "content-type": "text/html" },
      });
    });
    const configLoader = vi.fn(() => BASE_YAML);

    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: configLoader,
      fetchFn: fetchMock as unknown as typeof fetch,
      createRewriter: createWasmRewriterFactory(),
    });

    const res = await worker.fetch(
      new Request("https://site.example.com/submit", {
        method: "POST",
        body: "hello=world",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );

    expect(res.status).toBe(201);
    expect(await res.text()).toBe('{"echo":"hello=world"}');
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(configLoader).not.toHaveBeenCalled();
  });

  it("bypasses static asset paths and non-HTML Content-Type responses untouched", async () => {
    const configLoader = vi.fn(() => BASE_YAML);
    const enrichMock: EnrichmentAdapter = {
      name: "spy",
      enrich: vi.fn(async () => ({ industry: "FinTech" })),
    };

    const fetchFn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL((input as Request).url);
      if (url.pathname === "/api/data") {
        return new Response('{"ok":true}', {
          headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
        });
      }
      return new Response("body{color:red}", {
        headers: { "content-type": "text/css", "cache-control": "public, max-age=86400" },
      });
    });

    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: configLoader,
      enrichment: enrichMock,
      fetchFn: fetchFn as unknown as typeof fetch,
      createRewriter: createWasmRewriterFactory(),
    });

    const cssRes = await worker.fetch(new Request("https://site.example.com/assets/app.CSS"));
    expect(await cssRes.text()).toBe("body{color:red}");
    expect(cssRes.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(cssRes.headers.get("set-cookie")).toBeNull();

    const jsonRes = await worker.fetch(new Request("https://site.example.com/api/data"));
    expect(await jsonRes.text()).toBe('{"ok":true}');
    expect(jsonRes.headers.get("cache-control")).toBe("public, max-age=60");
    expect(jsonRes.headers.get("set-cookie")).toBeNull();

    expect(configLoader).not.toHaveBeenCalled();
    expect(enrichMock.enrich).not.toHaveBeenCalled();
  });

  it("supports application/xhtml+xml responses", async () => {
    const fetchFn = createMockOriginFetch(SAMPLE_HTML, {
      "content-type": "application/xhtml+xml; charset=utf-8",
    });

    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: BASE_YAML,
      fetchFn,
      createRewriter: createWasmRewriterFactory(),
    });

    const res = await worker.fetch(new Request("https://site.example.com/?acct=stripe"));
    const body = await res.text();
    expect(body).toContain("See the fintech demo");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("handles sticky cookie, HTTP non-Secure cookie, origin Set-Cookie preservation, and returning visitor rules", async () => {
    const yaml = `
version: 1
settings:
  cookieName: "my_vid"
experiences:
  - id: welcome-back
    name: "Welcome Back"
    match:
      path: "/"
      returning: true
    changes:
      - selector: "h1"
        text: "Welcome back!"
`;

    const fetchFn = createMockOriginFetch(SAMPLE_HTML, {
      "content-type": "text/html",
      "cache-control": "public, max-age=300",
      "set-cookie": "origin_sess=abc; Path=/",
    });

    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: yaml,
      fetchFn,
      createRewriter: createWasmRewriterFactory(),
      generateVisitorId: () => "sticky_001",
    });

    // First visit (HTTP): not returning, gets cookie without Secure, preserves origin cookie,
    // and marks response private, no-store + Vary: Cookie so per-visitor Set-Cookie is never publicly cached
    const res1 = await worker.fetch(new Request("http://localhost:8787/"));
    expect(await res1.text()).toContain("Default Headline");
    expect(res1.headers.get("cache-control")).toBe("private, no-store");
    expect(res1.headers.get("vary")).toBe("Cookie");

    const setCookies1 = res1.headers.getSetCookie();
    expect(setCookies1).toContain("origin_sess=abc; Path=/");
    expect(setCookies1).toContain(
      "my_vid=sticky_001; Path=/; SameSite=Lax; HttpOnly; Max-Age=31536000",
    );

    // Second visit with cookie on matching path: returning === true -> matches! No duplicate Set-Cookie
    const res2 = await worker.fetch(
      new Request("http://localhost:8787/", {
        headers: { cookie: "my_vid=sticky_001" },
      }),
    );
    expect(await res2.text()).toContain("Welcome back!");
    expect(res2.headers.get("cache-control")).toBe("private, no-store");
    expect(res2.headers.getSetCookie()).toEqual(["origin_sess=abc; Path=/"]);

    // Returning visitor on unmatched path: preserves origin Cache-Control and emits no extra Set-Cookie
    const res3 = await worker.fetch(
      new Request("http://localhost:8787/unmatched-page", {
        headers: { cookie: "my_vid=sticky_001" },
      }),
    );
    expect(await res3.text()).toContain("Default Headline");
    expect(res3.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res3.headers.getSetCookie()).toEqual(["origin_sess=abc; Path=/"]);
  });

  it("extracts Cloudflare request.cf geo fields for geo matching", async () => {
    const yaml = `
version: 1
experiences:
  - id: uk-geo
    name: "UK Geo"
    match:
      geo.country: "GB"
      geo.city: "London"
    changes:
      - selector: "h1"
        text: "Hello London!"
`;
    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: yaml,
      fetchFn: createMockOriginFetch(),
      createRewriter: createWasmRewriterFactory(),
    });

    const req = new Request("https://site.example.com/");
    Object.defineProperty(req, "cf", {
      value: { country: "GB", region: "England", city: "London", continent: "EU" },
    });

    const res = await worker.fetch(req);
    expect(await res.text()).toContain("Hello London!");
    expect(extractCloudflareGeo(req)).toEqual({
      country: "GB",
      region: "England",
      city: "London",
      continent: "EU",
    });
  });

  it("enforces control holdout: zero DOM swaps, analytics control exposure, and private no-store cache headers", async () => {
    const yaml = `
version: 1
settings:
  analytics:
    providers: ["ga4", "posthog"]
experiences:
  - id: holdout-exp
    name: "Full Holdout Experiment"
    holdout: 1
    match:
      path: "/"
    changes:
      - selector: "h1"
        text: "SHOULD NOT APPEAR"
`;
    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: yaml,
      fetchFn: createMockOriginFetch(),
      createRewriter: createWasmRewriterFactory(),
    });

    const res = await worker.fetch(new Request("https://site.example.com/"));
    const body = await res.text();

    // Original DOM untouched
    expect(body).toContain("Default Headline");
    expect(body).not.toContain("SHOULD NOT APPEAR");

    // Control exposure injected
    expect(body).toContain('"experienceId":"holdout-exp"');
    expect(body).toContain('"bucket":"control"');

    // Safe cache headers set
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toBe("Accept-Encoding, Cookie");
  });

  it("activates signed preview only when signature is valid and unexpired, ignoring tampered/unsigned/expired tokens", async () => {
    const secret = "super-secret-preview-key";
    const nowSec = 1700000000;

    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: BASE_YAML,
      previewSecret: secret,
      fetchFn: createMockOriginFetch(),
      createRewriter: createWasmRewriterFactory(),
      now: () => nowSec,
    });

    // 1. Valid signed preview URL (doesn't match utm_campaign/acct normally)
    const validUrl = await buildPreviewUrl({
      baseUrl: "https://site.example.com/pricing",
      experienceId: "fintech-abm",
      secret,
      expiresAt: nowSec + 3600,
    });
    const validRes = await worker.fetch(new Request(validUrl));
    const validBody = await validRes.text();
    expect(validBody).toContain("See the fintech demo");
    expect(validRes.headers.get("cache-control")).toBe("private, no-store");
    expect(validRes.headers.get("vary")).toContain("Cookie");
    // Analytics suppressed in preview mode by default
    expect(validBody).not.toContain("data-facet-analytics");

    // 2. Signed preview with control bucket
    const controlUrl = await buildPreviewUrl({
      baseUrl: "https://site.example.com/pricing",
      experienceId: "fintech-abm",
      secret,
      bucket: "control",
    });
    const controlRes = await worker.fetch(new Request(controlUrl));
    expect(await controlRes.text()).toContain("Default Headline");
    expect(controlRes.headers.get("cache-control")).toBe("private, no-store");

    // 3. Unsigned preview param -> ignored (returning visitor preserves origin Cache-Control)
    const unsignedRes = await worker.fetch(
      new Request("https://site.example.com/pricing?__facet_preview=fintech-abm", {
        headers: { cookie: "__facet_vid=existing_visitor" },
      }),
    );
    expect(await unsignedRes.text()).toContain("Default Headline");
    expect(unsignedRes.headers.get("cache-control")).toBe("public, max-age=600");

    // 4. Tampered signature -> ignored
    const tamperedUrl = new URL(validUrl);
    tamperedUrl.searchParams.set("__facet_sig", "0".repeat(43));
    const tamperedRes = await worker.fetch(new Request(tamperedUrl.toString()));
    expect(await tamperedRes.text()).toContain("Default Headline");

    // 5. Expired token -> ignored
    const expiredUrl = await buildPreviewUrl({
      baseUrl: "https://site.example.com/pricing",
      experienceId: "fintech-abm",
      secret,
      expiresAt: nowSec - 10,
    });
    const expiredRes = await worker.fetch(new Request(expiredUrl));
    expect(await expiredRes.text()).toContain("Default Headline");

    // 6. Preview with includeAnalyticsInPreview: true
    const analyticsPreviewRes = await handleFacetRequest(new Request(validUrl), {
      origin: "https://origin.example.com",
      config: BASE_YAML,
      previewSecret: secret,
      includeAnalyticsInPreview: true,
      fetchFn: createMockOriginFetch(),
      createRewriter: createWasmRewriterFactory(),
      now: () => nowSec,
    });
    expect(await analyticsPreviewRes.text()).toContain("data-facet-analytics");
  });

  it("integrates BYOK enrichment + KV cache inside worker handler and never leaks company data to HTML", async () => {
    const kvData = new Map<string, string>();
    const kv: EnrichmentCacheStore = {
      get: vi.fn(async (key: string) => kvData.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        kvData.set(key, value);
      }),
    };

    const enrichFn = vi.fn(async () => ({
      name: "Secret Corp",
      industry: "FinTech",
      revenue: "$500M",
    }));

    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: BASE_YAML,
      enrichment: { name: "test-enrich", enrich: enrichFn },
      kv,
      fetchFn: createMockOriginFetch(),
      createRewriter: createWasmRewriterFactory(),
    });

    const req1 = new Request("https://site.example.com/", {
      headers: { "cf-connecting-ip": "203.0.113.42" },
    });
    const res1 = await worker.fetch(req1);
    const body1 = await res1.text();

    expect(body1).toContain("See the fintech demo");
    expect(body1).not.toContain("Secret Corp");
    expect(body1).not.toContain("$500M");
    expect(enrichFn).toHaveBeenCalledTimes(1);

    // Second request from same IP hits KV cache
    const req2 = new Request("https://site.example.com/", {
      headers: { "cf-connecting-ip": "203.0.113.42" },
    });
    const res2 = await worker.fetch(req2);
    expect(await res2.text()).toContain("See the fintech demo");
    expect(enrichFn).toHaveBeenCalledTimes(1);
  });

  it("fails open on bad YAML config, throwing config loader, throwing enrichment, slow enrichment timeout, and throwing rewriter", async () => {
    const onError = vi.fn();

    // 1. Bad YAML config
    const badYamlRes = await handleFacetRequest(new Request("https://site.example.com/"), {
      origin: "https://origin.example.com",
      config: "version: 999\nexperiences: [invalid",
      fetchFn: createMockOriginFetch(),
      createRewriter: createWasmRewriterFactory(),
      onError,
    });
    expect(badYamlRes.status).toBe(200);
    expect(await badYamlRes.text()).toBe(SAMPLE_HTML);
    expect(onError).toHaveBeenCalledWith(expect.anything(), "config");

    // 2. Throwing async config loader
    const throwingConfigRes = await handleFacetRequest(new Request("https://site.example.com/"), {
      origin: "https://origin.example.com",
      config: async () => {
        throw new Error("KV unreachable");
      },
      fetchFn: createMockOriginFetch(),
      onError,
    });
    expect(throwingConfigRes.status).toBe(200);
    expect(await throwingConfigRes.text()).toBe(SAMPLE_HTML);

    // 3. Throwing enrichment fails open and still serves page cleanly
    const throwingEnrichRes = await handleFacetRequest(new Request("https://site.example.com/"), {
      origin: "https://origin.example.com",
      config: BASE_YAML,
      enrichment: {
        name: "boom",
        async enrich() {
          throw new Error("503 upstream down");
        },
      },
      fetchFn: createMockOriginFetch(),
      createRewriter: createWasmRewriterFactory(),
      onError,
    });
    expect(throwingEnrichRes.status).toBe(200);
    expect(await throwingEnrichRes.text()).toContain("Default Headline");

    // 4. Slow enrichment (>150ms) times out and fails open quickly
    const slowYaml = `
version: 1
settings:
  enrichment:
    timeoutMs: 30
experiences:
  - id: slow-enrich
    name: "Slow"
    match:
      company.industry: "FinTech"
    changes:
      - selector: "h1"
        text: "Should timeout"
`;
    const start = Date.now();
    const slowRes = await handleFacetRequest(new Request("https://site.example.com/"), {
      origin: "https://origin.example.com",
      config: slowYaml,
      enrichment: {
        name: "slow",
        async enrich(_req, _ctx, signal) {
          return new Promise((resolve) => {
            const t = setTimeout(() => resolve({ industry: "FinTech" }), 1000);
            signal.addEventListener("abort", () => {
              clearTimeout(t);
              resolve(undefined);
            });
          });
        },
      },
      fetchFn: createMockOriginFetch(),
      createRewriter: createWasmRewriterFactory(),
      onError,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(300);
    expect(await slowRes.text()).toContain("Default Headline");

    // 5. Throwing HTMLRewriter fails open returning untouched cloned origin body
    const brokenRewriterRes = await handleFacetRequest(
      new Request("https://site.example.com/?utm_campaign=fintech-q4"),
      {
        origin: "https://origin.example.com",
        config: BASE_YAML,
        fetchFn: createMockOriginFetch(),
        createRewriter: () => ({
          on() {
            return this;
          },
          async transform(response: Response): Promise<Response> {
            // Simulate partially consuming response body before failing
            await response.text();
            throw new Error("WASM panic");
          },
        }),
        onError,
      },
    );
    expect(brokenRewriterRes.status).toBe(200);
    expect(await brokenRewriterRes.text()).toBe(SAMPLE_HTML);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "rewrite");
    // 6. createFacetWorker parses static config lazily only after bypasses and inside fail-open try/catch
    const lazyErrorSpy = vi.fn();
    const brokenStaticWorker = createFacetWorker({
      origin: "https://origin.example.com",
      config: "version: 999\nexperiences: [unterminated",
      fetchFn: vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = new URL((input as Request).url);
        if (url.pathname.endsWith(".js")) {
          return new Response("console.log(1);", {
            headers: { "content-type": "application/javascript" },
          });
        }
        return new Response(SAMPLE_HTML, {
          headers: { "content-type": "text/html" },
        });
      }) as unknown as typeof fetch,
      onError: lazyErrorSpy,
    });

    const jsBypassRes = await brokenStaticWorker.fetch(
      new Request("https://site.example.com/app.js"),
    );
    expect(await jsBypassRes.text()).toBe("console.log(1);");
    expect(lazyErrorSpy).not.toHaveBeenCalled();

    const htmlFailOpenRes = await brokenStaticWorker.fetch(
      new Request("https://site.example.com/"),
    );
    expect(await htmlFailOpenRes.text()).toBe(SAMPLE_HTML);
    expect(lazyErrorSpy).toHaveBeenCalledWith(expect.anything(), "config");
  });

  it("handles HEAD requests on HTML pages without rewriting body while preserving headers", async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });

    const createRewriter = vi.fn(createWasmRewriterFactory());
    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: BASE_YAML,
      fetchFn: fetchFn as unknown as typeof fetch,
      createRewriter,
    });

    const res = await worker.fetch(
      new Request("https://site.example.com/?utm_campaign=fintech-q4", { method: "HEAD" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get("set-cookie")).toContain("__facet_vid=");
    expect(createRewriter).not.toHaveBeenCalled();
  });

  it("supports dynamic env-based origin, config, previewSecret, and pre-parsed FacetConfig", async () => {
    interface CustomEnv extends FacetWorkerEnv {
      ORIGIN_URL: string;
      PREVIEW_SECRET: string;
    }

    const parsed = parseFacetYaml(BASE_YAML);
    expect(parsed.ok).toBe(true);
    const configObj: FacetConfig = parsed.ok ? parsed.config : ({} as FacetConfig);

    const fetchFn = createMockOriginFetch();
    const worker = createFacetWorker<CustomEnv>({
      origin: (_req, env) => env?.ORIGIN_URL ?? "https://fallback.example.com",
      config: configObj,
      previewSecret: (env) => env?.PREVIEW_SECRET,
      fetchFn,
      createRewriter: createWasmRewriterFactory(),
    });

    const env: CustomEnv = {
      ORIGIN_URL: "https://webflow.example.com",
      PREVIEW_SECRET: "env-secret-123",
    };

    const previewUrl = await buildPreviewUrl({
      baseUrl: "https://site.example.com/about",
      experienceId: "fintech-abm",
      secret: env.PREVIEW_SECRET,
    });

    const res = await worker.fetch(new Request(previewUrl), env);
    expect(await res.text()).toContain("See the fintech demo");
    const calledReq = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Request;
    expect(calledReq.url).toMatch(/^https:\/\/webflow\.example\.com\/about\?/);
  });

  it("bypasses 3xx redirect and 304/204 null-body responses even with text/html Content-Type", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL((input as Request).url);
      if (url.pathname === "/redirect") {
        return new Response(null, {
          status: 302,
          headers: { location: "/new-home", "content-type": "text/html" },
        });
      }
      return new Response(null, {
        status: 304,
        headers: { "content-type": "text/html", etag: '"abc"' },
      });
    });

    const createRewriter = vi.fn(createWasmRewriterFactory());
    const worker = createFacetWorker({
      origin: "https://origin.example.com",
      config: BASE_YAML,
      fetchFn: fetchFn as unknown as typeof fetch,
      createRewriter,
    });

    const redirectRes = await worker.fetch(
      new Request("https://site.example.com/redirect?utm_campaign=fintech-q4"),
    );
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.get("location")).toBe("/new-home");

    const notModifiedRes = await worker.fetch(
      new Request("https://site.example.com/?utm_campaign=fintech-q4"),
    );
    expect(notModifiedRes.status).toBe(304);
    expect(createRewriter).not.toHaveBeenCalled();
  });

  it("exposes accurate URL, static path, content-type, and cookie helpers", () => {
    expect(isStaticAssetPath("/bundle.js")).toBe(true);
    expect(isStaticAssetPath("/fonts/inter.woff2")).toBe(true);
    expect(isStaticAssetPath("/video/hero.webm")).toBe(true);
    expect(isStaticAssetPath("/pricing")).toBe(false);
    expect(isStaticAssetPath("/for/stripe.com")).toBe(false);
    expect(isStaticAssetPath("/.well-known/acme")).toBe(false);

    expect(isHtmlContentType("text/html")).toBe(true);
    expect(isHtmlContentType("TEXT/HTML; charset=UTF-8")).toBe(true);
    expect(isHtmlContentType("application/xhtml+xml")).toBe(true);
    expect(isHtmlContentType("application/json")).toBe(false);
    expect(isHtmlContentType(null)).toBe(false);

    expect(
      buildOriginUrl(
        new Request("https://edge.example.com/blog/post?a=1"),
        "https://origin.example.com/base/",
      ).toString(),
    ).toBe("https://origin.example.com/base/blog/post?a=1");

    expect(formatVisitorCookie("__facet_vid", "v123", true)).toBe(
      "__facet_vid=v123; Path=/; SameSite=Lax; HttpOnly; Max-Age=31536000; Secure",
    );
    expect(formatVisitorCookie("__facet_vid", "v123", false)).toBe(
      "__facet_vid=v123; Path=/; SameSite=Lax; HttpOnly; Max-Age=31536000",
    );
  });
});
