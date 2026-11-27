import { describe, expect, it, vi } from "vitest";
import { createStudioHandler } from "../src/server/handler.js";
import {
  buildPreviewBridgeScript,
  handleLivePreviewRequest,
  rewriteHtmlForPreview,
  validatePreviewTargetUrl,
} from "../src/server/preview-proxy.js";
import { createMemoryConfigStore } from "../src/server/store.js";
import { DEFAULT_STARTER_YAML } from "../src/shared/defaults.js";
import type { StudioStateResponse } from "../src/shared/types.js";

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/html; charset=utf-8");
  }
  return new Response(body, { status: init.status ?? 200, headers });
}

describe("Live Site Preview Proxy & Click-to-Pick Bridge", () => {
  describe("SSRF URL validation", () => {
    it("rejects non-http(s) protocols and invalid URLs with 400", () => {
      const badUrls = [
        "",
        "not-a-url",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,<h1>hi</h1>",
        "ftp://example.com/index.html",
        "https://user:pass@example.com/",
      ];

      for (const raw of badUrls) {
        const res = validatePreviewTargetUrl(raw, false);
        expect(res.ok, `expected ${raw} to fail`).toBe(false);
        if (!res.ok) {
          expect(res.status, `expected 400 for ${raw}`).toBe(400);
        }
      }
    });

    it("blocks localhost, loopback, private IPv4/IPv6, metadata, and numeric IPv4 with 403", () => {
      const blockedUrls = [
        "http://localhost:3000/",
        "http://sub.localhost/page",
        "http://localhost./",
        "http://127.0.0.1:8787/",
        "http://127.255.0.1/",
        "http://0.0.0.0/",
        "http://10.0.0.1/",
        "http://10.255.255.254/internal",
        "http://169.254.169.254/latest/meta-data/",
        "http://172.16.0.1/",
        "http://172.31.255.254/",
        "http://192.168.1.1/",
        "http://100.64.0.1/",
        "http://[::1]:3000/",
        "http://[::]/",
        "http://[fc00::1]/",
        "http://[fd12:3456::1]/",
        "http://[fe80::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://[::ffff:169.254.169.254]/",
        "http://[::ffff:7f00:1]/",
        "http://2130706433/",
        "http://0x7f000001/",
        "http://0177.0.0.1/",
        "http://127.1/",
        "http://134744072/",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://service.local/",
      ];

      for (const raw of blockedUrls) {
        const res = validatePreviewTargetUrl(raw, false);
        expect(res.ok, `expected ${raw} to be blocked`).toBe(false);
        if (!res.ok) {
          expect(res.status, `expected 403 for ${raw}`).toBe(403);
        }
      }
    });

    it("allows public http(s) URLs and public IPs", () => {
      const allowed = [
        "https://facet.preetish.me/",
        "https://example.com/pricing?utm_campaign=fintech",
        "http://93.184.216.34/",
        "http://172.32.0.1/",
        "http://192.169.0.1/",
      ];

      for (const raw of allowed) {
        const res = validatePreviewTargetUrl(raw, false);
        expect(res.ok, `expected ${raw} to be allowed`).toBe(true);
      }
    });

    it("allows local targets when allowLocalTarget is true, while still blocking non-http protocols and cloud metadata", () => {
      expect(validatePreviewTargetUrl("http://localhost:3000/", true).ok).toBe(true);
      expect(validatePreviewTargetUrl("http://127.0.0.1:4321/", true).ok).toBe(true);
      expect(validatePreviewTargetUrl("http://192.168.1.50:8080/", true).ok).toBe(true);

      const fileRes = validatePreviewTargetUrl("file:///etc/passwd", true);
      expect(fileRes.ok).toBe(false);
      if (!fileRes.ok) {
        expect(fileRes.status).toBe(400);
      }

      const metadataUrls = [
        "http://169.254.169.254/latest/meta-data/",
        "http://169.254.0.1/",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://metadata.goog/",
        "http://metadata/",
        "http://[::ffff:169.254.169.254]/",
        "http://[fe80::1]/",
        "http://2852039166/",
      ];
      for (const raw of metadataUrls) {
        const res = validatePreviewTargetUrl(raw, true);
        expect(res.ok, `expected ${raw} to stay blocked with allowLocalTarget: true`).toBe(false);
        if (!res.ok) {
          expect(res.status, `expected 403 for ${raw}`).toBe(403);
        }
      }
    });
  });

  describe("Redirect validation, timeouts, size limits, and content-type checks", () => {
    it("follows up to 3 valid redirects and uses the final URL for <base> and bridge", async () => {
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url === "https://example.com/start") {
          return new Response(null, {
            status: 302,
            headers: { Location: "/step-2" },
          });
        }
        if (url === "https://example.com/step-2") {
          return new Response(null, {
            status: 301,
            headers: { Location: "https://www.example.com/landing/page" },
          });
        }
        return htmlResponse(
          "<!doctype html><html><head><title>Landing</title></head><body><h1>Hello</h1></body></html>",
        );
      });

      const res = await handleLivePreviewRequest("https://example.com/start", {
        fetchFn: fetchMock,
      });

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const html = await res.text();
      expect(html).toContain('<base href="https://www.example.com/landing/" target="_blank">');
      expect(html).toContain('"https://www.example.com/landing/page"');
    });

    it("blocks redirects to private/metadata IPs with 403 and never fetches the blocked target", async () => {
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url === "https://evil.example.com/bounce") {
          return new Response(null, {
            status: 302,
            headers: { Location: "http://169.254.169.254/latest/meta-data/" },
          });
        }
        throw new Error(`Should not have fetched blocked redirect target: ${url}`);
      });

      const res = await handleLivePreviewRequest("https://evil.example.com/bounce", {
        fetchFn: fetchMock,
      });

      expect(res.status).toBe(403);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns 502 when redirect chain exceeds maxRedirects (3)", async () => {
      let count = 0;
      const fetchMock = vi.fn<typeof fetch>(async () => {
        count += 1;
        return new Response(null, {
          status: 302,
          headers: { Location: `https://example.com/hop-${count}` },
        });
      });

      const res = await handleLivePreviewRequest("https://example.com/hop-0", {
        fetchFn: fetchMock,
      });

      expect(res.status).toBe(502);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("rejects non-HTML responses cleanly with 415", async () => {
      const fetchMock = vi.fn<typeof fetch>(async () => {
        return new Response(JSON.stringify({ hello: "world" }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      });

      const res = await handleLivePreviewRequest("https://example.com/api/data", {
        fetchFn: fetchMock,
      });

      expect(res.status).toBe(415);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
    });

    it("enforces max HTML size limit and returns 413", async () => {
      const oversized = "<html><body>" + "a".repeat(2048) + "</body></html>";
      const fetchMock = vi.fn<typeof fetch>(async () => htmlResponse(oversized));

      const res = await handleLivePreviewRequest("https://example.com/big", {
        fetchFn: fetchMock,
        maxBytes: 512,
      });

      expect(res.status).toBe(413);
    });

    it("enforces timeout via AbortController and returns 504", async () => {
      const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });

      const res = await handleLivePreviewRequest("https://slow.example.com/", {
        fetchFn: fetchMock,
        timeoutMs: 30,
      });

      expect(res.status).toBe(504);
    });
  });

  describe("HTML rewriting, header hygiene, and bridge script", () => {
    it("strips upstream scripts and script preloads while preserving stylesheets and injecting the Studio bridge", () => {
      const upstreamHtml = `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="/_next/static/css/app.css">
    <link rel="preload" as="script" href="/_next/static/chunks/main.js">
    <link rel="modulepreload" href="/assets/app.js">
    <script src="/_next/static/chunks/webpack.js" async=""></script>
  </head>
  <body>
    <h1>Hello world</h1>
    <script>window.__NEXT_DATA__={};throw new Error("boom");</script>
  </body>
</html>`;

      const rewritten = rewriteHtmlForPreview(upstreamHtml, "https://facet.preetish.me/");
      expect(rewritten).toContain('<link rel="stylesheet" href="/_next/static/css/app.css">');
      expect(rewritten).not.toContain("/_next/static/chunks/webpack.js");
      expect(rewritten).not.toContain("/_next/static/chunks/main.js");
      expect(rewritten).not.toContain("/assets/app.js");
      expect(rewritten).not.toContain("__NEXT_DATA__");
      expect(rewritten).toContain('type:"facet:ready"');
    });

    it("strips upstream CSP/X-Frame-Options headers and meta CSP tags, sets X-Frame-Options: SAMEORIGIN", async () => {
      const upstreamHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'">
    <meta content="frame-ancestors 'none'" HTTP-EQUIV='Content-Security-Policy'>
    <meta http-equiv="X-Frame-Options" content="DENY">
    <title>Acme Site</title>
  </head>
  <body>
    <h1 id="hero">Default Headline</h1>
  </body>
</html>`;

      const fetchMock = vi.fn<typeof fetch>(async () =>
        htmlResponse(upstreamHtml, {
          headers: {
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
            "X-Frame-Options": "DENY",
          },
        }),
      );

      const res = await handleLivePreviewRequest("https://acme.example.com/docs/intro", {
        fetchFn: fetchMock,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(res.headers.get("content-security-policy")).toBeNull();

      const body = await res.text();
      expect(body).not.toMatch(/http-equiv\s*=\s*["']?content-security-policy/i);
      expect(body).not.toMatch(/http-equiv\s*=\s*["']?x-frame-options/i);
      expect(body).toContain('<base href="https://acme.example.com/docs/" target="_blank">');
      expect(body).toContain('type:"facet:ready"');
      expect(body).toContain('type:"facet:applied"');
      expect(body).toContain('type:"facet:picked"');
      expect(body).toContain('type:"facet:pick-cancelled"');
      expect(body).toContain("event.source!==window.parent");
    });

    it("safely escapes <base href> and serialized URL inside bridge script, and produces valid JS", () => {
      const trickyUrl = 'https://example.com/a"b/</script><script>alert(1)</script>?x=$&';
      const rewritten = rewriteHtmlForPreview(
        "<html><head></head><body>Hi</body></html>",
        trickyUrl,
      );

      expect(rewritten).not.toContain("</script><script>alert(1)");
      expect(rewritten).toContain("<base href=");

      const scriptTag = buildPreviewBridgeScript(trickyUrl);
      const innerJs = scriptTag.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
      // Must parse as valid JavaScript without syntax errors
      expect(() => new Function(innerJs)).not.toThrow();
      expect(innerJs).toContain("rawTarget===document.documentElement||rawTarget===document.body");
      expect(innerJs).toContain("vbscript:");
      expect(innerJs).toContain("data:\\s*text\\/html");
      expect(innerJs).toContain("key.toLowerCase()");
    });

    it("injects <base> and bridge cleanly even when HTML has no <head> or <body>", () => {
      const rewritten = rewriteHtmlForPreview("<h1>Minimal Page</h1>", "https://example.com/");
      expect(rewritten.startsWith('<base href="https://example.com/" target="_blank">')).toBe(true);
      expect(rewritten).toContain("<script data-facet-studio-ui=");
    });

    it("skips hashed CSS Module / CSS-in-JS classes and volatile React IDs when picking elements", () => {
      interface MockEl {
        nodeType: number;
        tagName: string;
        id: string;
        classList: string[];
        attrs: Record<string, string>;
        parentElement: MockEl | null;
        children: MockEl[];
        textContent: string;
        innerText: string;
        style: Record<string, string>;
        getAttribute: (name: string) => string | null;
        hasAttribute: (name: string) => boolean;
        setAttribute: (name: string, val: string) => void;
        closest: () => null;
        matches: () => boolean;
        appendChild: () => void;
        removeChild: () => void;
      }

      const makeEl = (
        tag: string,
        opts: {
          id?: string;
          classes?: string[];
          attrs?: Record<string, string>;
          text?: string;
          parent?: MockEl | null;
        } = {},
      ): MockEl => {
        const attrs = { ...(opts.attrs ?? {}) };
        const el: MockEl = {
          nodeType: 1,
          tagName: tag.toUpperCase(),
          id: opts.id ?? "",
          classList: opts.classes ?? [],
          attrs,
          parentElement: opts.parent ?? null,
          children: [],
          textContent: opts.text ?? "",
          innerText: opts.text ?? "",
          style: {},
          getAttribute: (name) => (name in attrs ? attrs[name]! : null),
          hasAttribute: (name) => name in attrs,
          setAttribute: (name, val) => {
            attrs[name] = val;
          },
          closest: () => null,
          matches: () => false,
          appendChild: () => undefined,
          removeChild: () => undefined,
        };
        if (opts.parent) {
          opts.parent.children.push(el);
        }
        return el;
      };

      const runPick = (target: MockEl, queryMap: Record<string, MockEl[]>): string => {
        const scriptTag = buildPreviewBridgeScript("https://facet.preetish.me/");
        const innerJs = scriptTag.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
        const posted: Array<Record<string, unknown>> = [];
        const winListeners = new Map<string, Array<(e: unknown) => void>>();
        const docListeners = new Map<string, Array<(e: unknown) => void>>();

        const body = makeEl("body");
        const docEl = makeEl("html");
        const head = makeEl("head");

        const mockParent = {
          postMessage: (msg: Record<string, unknown>) => {
            posted.push(msg);
          },
        };

        const mockWindow = {
          location: { origin: "http://127.0.0.1:4174" },
          parent: mockParent,
          innerWidth: 1280,
          CSS: { escape: (v: string) => v.replace(/([^a-zA-Z0-9_-])/g, "\\$1") },
          addEventListener: (type: string, fn: (e: unknown) => void) => {
            const list = winListeners.get(type) ?? [];
            list.push(fn);
            winListeners.set(type, list);
          },
          removeEventListener: (type: string, fn: (e: unknown) => void) => {
            winListeners.set(
              type,
              (winListeners.get(type) ?? []).filter((f) => f !== fn),
            );
          },
        };

        const mockDocument = {
          readyState: "complete",
          title: "Facet",
          documentElement: docEl,
          body,
          head,
          createElement: (tag: string) => makeEl(tag),
          querySelectorAll: (sel: string) => queryMap[sel] ?? [],
          addEventListener: (type: string, fn: (e: unknown) => void) => {
            const list = docListeners.get(type) ?? [];
            list.push(fn);
            docListeners.set(type, list);
          },
          removeEventListener: (type: string, fn: (e: unknown) => void) => {
            docListeners.set(
              type,
              (docListeners.get(type) ?? []).filter((f) => f !== fn),
            );
          },
        };

        const runner = new Function("window", "document", innerJs) as (
          w: unknown,
          d: unknown,
        ) => void;
        runner(mockWindow, mockDocument);

        for (const fn of winListeners.get("message") ?? []) {
          fn({
            source: mockParent,
            origin: "http://127.0.0.1:4174",
            data: { type: "facet:pick-mode", enabled: true },
          });
        }

        for (const fn of docListeners.get("click") ?? []) {
          fn({
            target,
            preventDefault: () => undefined,
            stopPropagation: () => undefined,
            stopImmediatePropagation: () => undefined,
          });
        }

        const picked = posted.find((m) => m.type === "facet:picked");
        return typeof picked?.selector === "string" ? picked.selector : "";
      };

      // 1. Next.js CSS Module link in <header> with duplicate href in footer -> landmark-scoped href
      const header = makeEl("header");
      const ghLink = makeEl("a", {
        classes: ["SiteHeader_githubLink__8xKq2"],
        attrs: { href: "https://github.com/preetish/facet" },
        text: "GitHub ↗",
        parent: header,
      });
      const footerGhLink = makeEl("a", {
        attrs: { href: "https://github.com/preetish/facet" },
      });
      expect(
        runPick(ghLink, {
          "a.SiteHeader_githubLink__8xKq2": [ghLink],
          'a[href="https://github.com/preetish/facet"]': [ghLink, footerGhLink],
          'header a[href="https://github.com/preetish/facet"]': [ghLink],
        }),
      ).toBe('header a[href="https://github.com/preetish/facet"]');

      // 2. CSS-in-JS hashed classes -> falls through to aria-label
      const demoBtn = makeEl("button", {
        classes: ["css-1a2b3c", "sc-bdfBwQ"],
        attrs: { "aria-label": "Book demo" },
        text: "Book demo",
      });
      expect(
        runPick(demoBtn, {
          "button.css-1a2b3c": [demoBtn],
          "button.sc-bdfBwQ": [demoBtn],
          'button[aria-label="Book demo"]': [demoBtn],
        }),
      ).toBe('button[aria-label="Book demo"]');

      // 3. Lowercase BEM class is preserved as a stable selector
      const bemSubtitle = makeEl("p", {
        classes: ["hero__subtitle"],
        text: "Subtitle",
      });
      expect(runPick(bemSubtitle, { "p.hero__subtitle": [bemSubtitle] })).toBe("p.hero__subtitle");

      // 4. React useId() volatile ID is skipped in favor of stable name attribute
      const formBtn = makeEl("button", {
        id: ":r1:",
        attrs: { name: "signup" },
        text: "Sign up",
      });
      expect(
        runPick(formBtn, {
          "#\\:r1\\:": [formBtn],
          'button[name="signup"]': [formBtn],
        }),
      ).toBe('button[name="signup"]');

      // 5. Explicit data-facet-slot always wins even with hashed classes
      const heroSlot = makeEl("h1", {
        classes: ["Hero_title__Ab3x9"],
        attrs: { "data-facet-slot": "hero-headline" },
        text: "Every ad click is different.",
      });
      expect(
        runPick(heroSlot, {
          '[data-facet-slot="hero-headline"]': [heroSlot],
          h1: [heroSlot],
        }),
      ).toBe('[data-facet-slot="hero-headline"]');
    });
  });

  describe("Studio handler integration (/api/live-preview & capabilities)", () => {
    it("enforces fail-closed authentication on /api/live-preview", async () => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        htmlResponse("<html><head></head><body><h1>Secret</h1></body></html>"),
      );

      const handler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
        requireAuth: true,
        authenticate: (req) => req.headers.get("x-studio-token") === "valid-token",
        fetchFn: fetchMock,
      });

      const unauthRes = await handler(
        new Request("http://studio.local/api/live-preview?url=https://example.com/"),
      );
      expect(unauthRes.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();

      const authRes = await handler(
        new Request("http://studio.local/api/live-preview?url=https://example.com/", {
          headers: { "x-studio-token": "valid-token" },
        }),
      );
      expect(authRes.status).toBe(200);
      expect(authRes.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to options.targetUrl when ?url= is omitted and respects disableLivePreview", async () => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        htmlResponse("<html><head></head><body><h1>Target</h1></body></html>"),
      );

      const handler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
        targetUrl: "https://facet.preetish.me/",
        fetchFn: fetchMock,
      });

      const res = await handler(new Request("http://studio.local/api/live-preview"));
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://facet.preetish.me/",
        expect.objectContaining({ method: "GET", redirect: "manual" }),
      );

      const disabledHandler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
        targetUrl: "https://facet.preetish.me/",
        disableLivePreview: true,
        fetchFn: fetchMock,
      });
      const disabledRes = await disabledHandler(
        new Request("http://studio.local/api/live-preview"),
      );
      expect(disabledRes.status).toBe(403);
    });

    it("respects allowLocalTarget option in handler", async () => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        htmlResponse("<html><head></head><body><h1>Local Dev</h1></body></html>"),
      );

      const prodHandler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
        fetchFn: fetchMock,
      });
      const blocked = await prodHandler(
        new Request("http://studio.local/api/live-preview?url=http://localhost:3000/"),
      );
      expect(blocked.status).toBe(403);

      const localHandler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
        allowLocalTarget: true,
        fetchFn: fetchMock,
      });
      const allowed = await localHandler(
        new Request("http://studio.local/api/live-preview?url=http://localhost:3000/"),
      );
      expect(allowed.status).toBe(200);
    });

    it("exposes isDemoMode, storageLabel, and canLivePreview in /api/state capabilities", async () => {
      const demoHandler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
        isDemoMode: true,
        storageLabel: "In-memory demo",
      });
      const demoState = (await (
        await demoHandler(new Request("http://studio.local/api/state"))
      ).json()) as StudioStateResponse;
      expect(demoState.capabilities.isDemoMode).toBe(true);
      expect(demoState.capabilities.storageLabel).toBe("In-memory demo");
      expect(demoState.capabilities.canLivePreview).toBe(true);

      const kvHandler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
        storageLabel: "Cloudflare KV",
        disableLivePreview: true,
      });
      const kvState = (await (
        await kvHandler(new Request("http://studio.local/api/state"))
      ).json()) as StudioStateResponse;
      expect(kvState.capabilities.isDemoMode).toBe(false);
      expect(kvState.capabilities.storageLabel).toBe("Cloudflare KV");
      expect(kvState.capabilities.canLivePreview).toBe(false);
    });
  });
});
