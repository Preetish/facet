import type http from "node:http";
import { describe, expect, it } from "vitest";
import { parseFacetYaml } from "@facet/core";
import {
  appendVaryHeader,
  applyPreviewResponseHeaders,
  buildUpstreamUrl,
  evaluatePreviewRequest,
  formatStickySetCookie,
} from "../src/index.js";

const SAMPLE_V02_YAML = `version: 1
settings:
  cookieName: "__facet_vid"
  stickyCookieName: "__facet_sticky"
  previewParam: "__facet_preview"
data:
  accounts:
    stripe:
      name: "Stripe"
      headline: "Built for Stripe"
experiences:
  - id: abm-virtual
    name: "ABM Virtual"
    priority: 100
    originPath: "/"
    sticky: "7d"
    holdout: 0
    match:
      path: "/for/:acct"
    lookup:
      table: "accounts"
      key: "{{params.acct}}"
      required: true
    changes:
      - selector: "h1"
        text: '{{data.headline | default("Default")}}'
  - id: abm-holdout-virtual
    name: "ABM Holdout Virtual"
    priority: 95
    originPath: "/"
    holdout: 1
    match:
      path: "/holdout/:acct"
    changes:
      - selector: "h1"
        text: "Should be control"
  - id: session-sticky
    name: "Session Sticky"
    priority: 50
    sticky: true
    holdout: 0
    match:
      utm_campaign: "spring"
    changes:
      - selector: "h1"
        text: "Spring Campaign"
`;

function parseSampleConfig() {
  const parsed = parseFacetYaml(SAMPLE_V02_YAML);
  if (!parsed.ok) {
    throw new Error(`Expected valid YAML, got: ${JSON.stringify(parsed.errors)}`);
  }
  return parsed.config;
}

describe("preview server v0.2 helpers (originPath & stickyCookie)", () => {
  it("buildUpstreamUrl rewrites virtual paths to originPath while preserving query params and rejecting unsafe paths", () => {
    const targetUrl = new URL("https://origin.example.com");
    const incomingUrl = new URL("http://127.0.0.1:8787/for/stripe?utm_source=linkedin&ref=1");

    // Rewrites pathname to "/" and keeps incoming query params
    const rewritten = buildUpstreamUrl(targetUrl, incomingUrl, "/");
    expect(rewritten.toString()).toBe("https://origin.example.com/?utm_source=linkedin&ref=1");

    // Merges originPath query params without dropping incoming query params
    const merged = buildUpstreamUrl(targetUrl, incomingUrl, "/landing?tpl=abm&ref=override");
    expect(merged.pathname).toBe("/landing");
    expect(merged.searchParams.get("tpl")).toBe("abm");
    expect(merged.searchParams.get("ref")).toBe("override");
    expect(merged.searchParams.get("utm_source")).toBe("linkedin");

    // Null originPath preserves incoming pathname + search
    const untouched = buildUpstreamUrl(targetUrl, incomingUrl, null);
    expect(untouched.toString()).toBe(
      "https://origin.example.com/for/stripe?utm_source=linkedin&ref=1",
    );

    // Unsafe originPaths fall back safely to incoming pathname
    for (const unsafe of [
      "//evil.example.net/pwn",
      "/../etc/passwd",
      "/%2e%2e/secret",
      "/foo\\bar",
      "https://evil.example.net/",
    ]) {
      const safe = buildUpstreamUrl(targetUrl, incomingUrl, unsafe);
      expect(safe.toString()).toBe(
        "https://origin.example.com/for/stripe?utm_source=linkedin&ref=1",
      );
    }
  });

  it("formatStickySetCookie omits Max-Age for session cookies and emits Max-Age for timed cookies", () => {
    const sessionCookie = formatStickySetCookie({
      name: "__facet_sticky",
      value: "abc123",
      maxAgeSeconds: null,
    });
    expect(sessionCookie).toBe("__facet_sticky=abc123; Path=/; SameSite=Lax; HttpOnly");
    expect(sessionCookie).not.toContain("Max-Age");

    const timedCookie = formatStickySetCookie({
      name: "__facet_sticky",
      value: "abc123",
      maxAgeSeconds: 604800,
    });
    expect(timedCookie).toBe(
      "__facet_sticky=abc123; Path=/; SameSite=Lax; HttpOnly; Max-Age=604800",
    );
  });

  it("appendVaryHeader merges Cookie without duplicating existing Vary tokens", () => {
    const h1: http.OutgoingHttpHeaders = {};
    appendVaryHeader(h1, "Cookie");
    expect(h1["vary"]).toBe("Cookie");

    const h2: http.OutgoingHttpHeaders = { vary: "Accept-Encoding" };
    appendVaryHeader(h2, "Cookie");
    expect(h2["vary"]).toBe("Accept-Encoding, Cookie");

    // Idempotent (case-insensitive)
    appendVaryHeader(h2, "cookie");
    expect(h2["vary"]).toBe("Accept-Encoding, Cookie");

    // Respects wildcard Vary: *
    const h3: http.OutgoingHttpHeaders = { vary: "*" };
    appendVaryHeader(h3, "Cookie");
    expect(h3["vary"]).toBe("*");
  });

  it("evaluatePreviewRequest + applyPreviewResponseHeaders handle originPath, timed stickyCookie, Cache-Control, and Vary", () => {
    const config = parseSampleConfig();
    const incomingUrl = new URL("http://127.0.0.1:8787/for/stripe?utm_source=linkedin");

    const { evaluation, resolvedMode } = evaluatePreviewRequest(
      config,
      incomingUrl,
      "GET",
      {},
      () => 1_700_000_000,
    );

    expect(evaluation.originPath).toBe("/");
    expect(evaluation.personalized).toBe(true);
    expect(evaluation.activeChanges[0]?.text).toBe("Built for Stripe");
    expect(evaluation.stickyCookie).not.toBeNull();
    expect(evaluation.stickyCookie?.name).toBe("__facet_sticky");
    expect(evaluation.stickyCookie?.maxAgeSeconds).toBe(7 * 24 * 60 * 60);

    const outHeaders: http.OutgoingHttpHeaders = { vary: "Accept-Encoding" };
    applyPreviewResponseHeaders(outHeaders, {
      config,
      evaluation,
      resolvedMode,
      bodyByteLength: 128,
    });

    expect(outHeaders["cache-control"]).toBe("private, no-store");
    expect(outHeaders["vary"]).toBe("Accept-Encoding, Cookie");
    expect(outHeaders["x-facet-status"]).toBe("personalized");

    const setCookies = outHeaders["set-cookie"] as string[];
    expect(Array.isArray(setCookies)).toBe(true);
    expect(setCookies.some((c) => c.startsWith("__facet_vid="))).toBe(true);
    const stickyHeader = setCookies.find((c) => c.startsWith("__facet_sticky="));
    expect(stickyHeader).toBeDefined();
    expect(stickyHeader).toContain("Max-Age=604800");
  });

  it("omits Max-Age for session-sticky experiences and suppresses sticky Set-Cookie in preview mode", () => {
    const config = parseSampleConfig();

    // Session sticky (sticky: true)
    const sessionRes = evaluatePreviewRequest(
      config,
      new URL("http://127.0.0.1:8787/?utm_campaign=spring"),
      "GET",
      { cookie: "__facet_vid=existing-vid" },
      () => 1_700_000_000,
    );
    expect(sessionRes.evaluation.stickyCookie).not.toBeNull();
    expect(sessionRes.evaluation.stickyCookie?.maxAgeSeconds).toBeNull();

    const sessionHeaders: http.OutgoingHttpHeaders = {};
    applyPreviewResponseHeaders(sessionHeaders, {
      config,
      evaluation: sessionRes.evaluation,
      resolvedMode: sessionRes.resolvedMode,
      bodyByteLength: 64,
    });
    const sessionSetCookies = sessionHeaders["set-cookie"] as string[];
    const stickySession = sessionSetCookies.find((c) => c.startsWith("__facet_sticky="));
    expect(stickySession).toBeDefined();
    expect(stickySession).not.toContain("Max-Age");
    expect(sessionHeaders["cache-control"]).toBe("private, no-store");
    expect(sessionHeaders["vary"]).toBe("Cookie");

    // Preview mode suppresses stickyCookie
    const previewRes = evaluatePreviewRequest(
      config,
      new URL(
        "http://127.0.0.1:8787/for/stripe?__facet_preview=abm-virtual&__facet_bucket=variant",
      ),
      "GET",
      { cookie: "__facet_vid=existing-vid" },
      () => 1_700_000_000,
    );
    expect(previewRes.evaluation.previewMode).toBe(true);
    expect(previewRes.evaluation.originPath).toBe("/");
    expect(previewRes.evaluation.stickyCookie).toBeNull();

    const previewHeaders: http.OutgoingHttpHeaders = {};
    applyPreviewResponseHeaders(previewHeaders, {
      config,
      evaluation: previewRes.evaluation,
      resolvedMode: previewRes.resolvedMode,
      bodyByteLength: 64,
    });
    const previewSetCookies = (previewHeaders["set-cookie"] as string[] | undefined) ?? [];
    expect(previewSetCookies.some((c) => c.startsWith("__facet_sticky="))).toBe(false);
  });

  it("still resolves originPath for control-bucket holdout matches so virtual URLs do not 404", () => {
    const config = parseSampleConfig();
    const res = evaluatePreviewRequest(
      config,
      new URL("http://127.0.0.1:8787/holdout/stripe"),
      "GET",
      { cookie: "__facet_vid=existing-vid" },
    );

    expect(res.evaluation.matched).toHaveLength(1);
    expect(res.evaluation.matched[0]?.bucket).toBe("control");
    expect(res.evaluation.personalized).toBe(false);
    expect(res.evaluation.originPath).toBe("/");

    const upstream = buildUpstreamUrl(
      new URL("https://origin.example.com"),
      new URL("http://127.0.0.1:8787/holdout/stripe"),
      res.evaluation.originPath,
    );
    expect(upstream.toString()).toBe("https://origin.example.com/");
  });
});
