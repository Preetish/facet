import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPreviewServer, type PreviewServer } from "../src/index.js";

const MOCK_ORIGIN_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Acme Home</title>
    <link rel="stylesheet" href="/assets/app.css" />
  </head>
  <body>
    <header>
      <div id="banner" class="promo old-theme">Default Banner</div>
    </header>
    <main>
      <h1>Default Hero Headline</h1>
      <a data-cta="hero" href="/demo" data-legacy="true">Book a demo</a>
      <div id="logo-strip">Default logos</div>
      <div id="raw-box">Raw default</div>
      <div id="list-box"><span>Core</span></div>
      <div id="remove-me">Should disappear</div>
    </main>
  </body>
</html>`;

interface OriginTracker {
  lastAcceptEncoding?: string;
}

async function startMockOrigin(tracker: OriginTracker): Promise<{
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (reqUrl.pathname === "/assets/app.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end("body { color: #111; }");
      return;
    }

    if (reqUrl.pathname === "/api/status") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, htmlLike: "<h1>not html</h1>" }));
      return;
    }

    if (reqUrl.pathname === "/old-pricing") {
      const addr = server.address() as AddressInfo;
      res.writeHead(302, { location: `http://127.0.0.1:${addr.port}/pricing?ref=redirect` });
      res.end();
      return;
    }

    if (reqUrl.pathname === "/external-redirect") {
      res.writeHead(302, { location: "https://example.org/docs" });
      res.end();
      return;
    }

    tracker.lastAcceptEncoding =
      typeof req.headers["accept-encoding"] === "string"
        ? req.headers["accept-encoding"]
        : undefined;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(MOCK_ORIGIN_HTML);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

describe("facet preview reverse proxy (end-to-end)", () => {
  const tempDirs: string[] = [];
  const cleanupFns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) {
        await fn();
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("rewrites HTML transforms, bypasses non-HTML assets, injects preview bar, toggles modes, and fails open on broken config", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "facet-cli-preview-"));
    tempDirs.push(tmpDir);
    const configPath = path.join(tmpDir, "facet.yaml");

    const validConfigYaml = `version: 1
settings:
  cookieName: "__facet_vid"
  previewParam: "__facet_preview"
  analytics:
    providers: ["ga4", "custom"]
  slots:
    fintech-logos: "<ul class='logos'><li>Stripe</li><li>Plaid</li></ul>"
experiences:
  - id: fintech-paid
    name: "Fintech <script>alert(1)</script> Paid"
    priority: 20
    holdout: 0
    match:
      path: "/"
      utm_campaign: "fintech-q4"
    changes:
      - selector: "h1"
        text: "Built for <fintech> & 'compliance' teams"
      - selector: "[data-cta='hero']"
        text: "See fintech demo"
        attrs:
          href: "/demo?segment=fintech"
          data-legacy: null
      - selector: "#banner"
        addClass: ["is-fintech", "highlighted"]
        removeClass: "old-theme"
      - selector: "#logo-strip"
        slot: "fintech-logos"
      - selector: "#raw-box"
        html: "<strong>Injected HTML</strong>"
      - selector: "#list-box"
        prepend: "<em>Start</em>"
        append: "<em>End</em>"
      - selector: "#remove-me"
        remove: true
  - id: abm-stripe
    name: "ABM Stripe"
    priority: 30
    holdout: 0
    match:
      query.acct: "stripe"
    changes:
      - selector: "h1"
        text: "Welcome, Stripe!"
`;
    await writeFile(configPath, validConfigYaml, "utf8");

    const tracker: OriginTracker = {};
    const origin = await startMockOrigin(tracker);
    cleanupFns.push(origin.close);

    const warnings: string[] = [];
    const proxy: PreviewServer = createPreviewServer({
      target: origin.url,
      configPath,
      port: 0,
      host: "127.0.0.1",
      logger: {
        info: () => {},
        warn: (msg) => {
          warnings.push(msg);
        },
        error: () => {},
      },
    });
    const addr = await proxy.start();
    cleanupFns.push(() => proxy.close());

    // 1. Auto match via utm_campaign: verifies all transforms + HTML escaping + analytics + preview bar
    const resMatched = await fetch(`${addr.url}/?utm_campaign=fintech-q4`);
    expect(resMatched.status).toBe(200);
    expect(tracker.lastAcceptEncoding).toBe("identity");
    expect(resMatched.headers.get("cache-control")).toBe("private, no-store");
    expect(resMatched.headers.get("x-facet-status")).toBe("personalized");
    expect(resMatched.headers.get("set-cookie")).toContain("__facet_vid=");

    const htmlMatched = await resMatched.text();
    // HTML-escaped h1 text (angle brackets & ampersand escaped by HTMLRewriter text mode)
    expect(htmlMatched).toContain("<h1>Built for &lt;fintech&gt; &amp; 'compliance' teams</h1>");
    expect(htmlMatched).not.toContain("<fintech>");
    // CTA text + href swap + null attr removal
    expect(htmlMatched).toContain('href="/demo?segment=fintech"');
    expect(htmlMatched).toContain(">See fintech demo</a>");
    expect(htmlMatched).not.toContain("data-legacy");
    // addClass / removeClass
    expect(htmlMatched).toContain('class="promo is-fintech highlighted"');
    expect(htmlMatched).not.toContain("old-theme");
    // slot & raw html
    expect(htmlMatched).toContain("<ul class='logos'><li>Stripe</li><li>Plaid</li></ul>");
    expect(htmlMatched).toContain('<div id="raw-box"><strong>Injected HTML</strong></div>');
    // prepend & append
    expect(htmlMatched).toContain(
      '<div id="list-box"><em>Start</em><span>Core</span><em>End</em></div>',
    );
    // remove
    expect(htmlMatched).not.toContain("remove-me");
    expect(htmlMatched).not.toContain("Should disappear");
    // Analytics snippet injected with only experienceId + bucket
    expect(htmlMatched).toContain("data-facet-analytics");
    expect(htmlMatched).toContain('"experienceId":"fintech-paid"');
    expect(htmlMatched).toContain('"bucket":"variant"');
    // Preview bar injected before </body> and XSS in experience name escaped
    expect(htmlMatched).toContain('id="__facet-preview-bar"');
    expect(htmlMatched).not.toContain("Fintech <script>alert(1)</script> Paid");
    expect(htmlMatched).toContain("Fintech &lt;script&gt;alert(1)&lt;/script&gt; Paid");
    const barIndex = htmlMatched.indexOf('id="__facet-preview-bar"');
    const bodyEndIndex = htmlMatched.indexOf("</body>");
    expect(barIndex).toBeGreaterThan(-1);
    expect(barIndex).toBeLessThan(bodyEndIndex);

    // 2. Non-HTML static asset (.css) & JSON endpoint bypass
    const cssRes = await fetch(`${addr.url}/assets/app.css`);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type")).toContain("text/css");
    const cssBody = await cssRes.text();
    expect(cssBody).toBe("body { color: #111; }");
    expect(cssBody).not.toContain("__facet-preview-bar");

    const jsonRes = await fetch(`${addr.url}/api/status`);
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get("content-type")).toContain("application/json");
    const jsonBody = await jsonRes.text();
    expect(jsonBody).toBe(JSON.stringify({ ok: true, htmlLike: "<h1>not html</h1>" }));

    // 3. Redirect Location rewriting for target origin (and untouched for external origin)
    const redirectRes = await fetch(`${addr.url}/old-pricing`, { redirect: "manual" });
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.get("location")).toBe(`${addr.url}/pricing?ref=redirect`);

    const externalRedirectRes = await fetch(`${addr.url}/external-redirect`, {
      redirect: "manual",
    });
    expect(externalRedirectRes.status).toBe(302);
    expect(externalRedirectRes.headers.get("location")).toBe("https://example.org/docs");

    // 4. Live toggle: Default mode suppresses personalization even when UTM matches
    const defaultRes = await fetch(
      `${addr.url}/?utm_campaign=fintech-q4&__facet_local_mode=default`,
    );
    expect(defaultRes.status).toBe(200);
    expect(defaultRes.headers.get("set-cookie")).toContain("__facet_local_mode=default");
    const defaultHtml = await defaultRes.text();
    expect(defaultHtml).toContain("<h1>Default Hero Headline</h1>");
    expect(defaultHtml).toContain('data-facet-mode="default"');

    // 5. Live toggle: Force Experience variant via cookie (as set by the Preview Bar JS)
    const expVariantRes = await fetch(`${addr.url}/`, {
      headers: { cookie: "__facet_local_mode=exp%3Aabm-stripe%3Avariant" },
    });
    const expVariantHtml = await expVariantRes.text();
    expect(expVariantHtml).toContain("<h1>Welcome, Stripe!</h1>");
    expect(expVariantHtml).toContain('data-facet-mode="exp:abm-stripe:variant"');

    // 6. Live toggle: Force Control (holdout) for selected experience
    const controlRes = await fetch(
      `${addr.url}/?__facet_preview=fintech-paid&__facet_bucket=control`,
    );
    expect(controlRes.headers.get("x-facet-status")).toBe("control");
    const controlHtml = await controlRes.text();
    expect(controlHtml).toContain("<h1>Default Hero Headline</h1>");
    expect(controlHtml).toContain("fintech-paid (control)");
    expect(controlHtml).toContain('data-facet-mode="exp:fintech-paid:control"');

    // 7. Live toggle: Back to Auto mode
    const autoRes = await fetch(`${addr.url}/?utm_campaign=fintech-q4&__facet_local_mode=auto`);
    const autoHtml = await autoRes.text();
    expect(autoHtml).toContain("<h1>Built for &lt;fintech&gt; &amp; 'compliance' teams</h1>");
    expect(autoHtml).toContain('data-facet-mode="auto"');

    // 8. Fail-open when facet.yaml is broken, then auto-reload when fixed
    await writeFile(configPath, "version: 999\nexperiences: [broken\n", "utf8");
    const brokenRes = await fetch(`${addr.url}/?utm_campaign=fintech-q4`);
    expect(brokenRes.status).toBe(200);
    expect(brokenRes.headers.get("x-facet-status")).toBe("fail-open");
    const brokenHtml = await brokenRes.text();
    expect(brokenHtml).toBe(MOCK_ORIGIN_HTML);
    expect(warnings.some((w) => w.includes("failed to validate"))).toBe(true);

    // Fix config with new headline and confirm hot reload works immediately
    await writeFile(
      configPath,
      `version: 1
experiences:
  - id: fintech-paid
    name: "Fintech Reloaded"
    match:
      utm_campaign: "fintech-q4"
    changes:
      - selector: "h1"
        text: "Hot Reloaded Headline"
`,
      "utf8",
    );
    const reloadedRes = await fetch(`${addr.url}/?utm_campaign=fintech-q4`);
    expect(reloadedRes.status).toBe(200);
    expect(reloadedRes.headers.get("x-facet-status")).toBe("personalized");
    const reloadedHtml = await reloadedRes.text();
    expect(reloadedHtml).toContain("<h1>Hot Reloaded Headline</h1>");
  });
});
