import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildAnalyticsSnippet,
  buildPreviewUrl,
  escapeHtml,
  escapeHtmlAttr,
  normalizeClassList,
  parsePreviewParams,
  safeJsonForScript,
  signPreviewToken,
  toAnalyticsExposures,
  verifyPreviewToken,
} from "../src/index.js";

describe("signed preview tokens & URLs", () => {
  const secret = "super-secret-signing-key-2026";

  it("signs and verifies a preview token without expiry", async () => {
    const token = await signPreviewToken({ experienceId: "fintech-abm", secret });
    expect(token).not.toContain(".");

    const verified = await verifyPreviewToken({
      experienceId: "fintech-abm",
      token,
      secret,
    });
    expect(verified).toEqual({
      valid: true,
      experienceId: "fintech-abm",
    });
  });

  it("signs and verifies a preview token with expiry and rejects when expired", async () => {
    const expiresAt = 2_000_000_000;
    const token = await signPreviewToken({
      experienceId: "fintech-abm",
      secret,
      expiresAt,
      bucket: "control",
    });
    expect(token.startsWith(`${expiresAt}.`)).toBe(true);

    const validBefore = await verifyPreviewToken({
      experienceId: "fintech-abm",
      token,
      secret,
      bucket: "control",
      now: expiresAt - 10,
    });
    expect(validBefore).toEqual({
      valid: true,
      experienceId: "fintech-abm",
      expiresAt,
      bucket: "control",
    });

    const expired = await verifyPreviewToken({
      experienceId: "fintech-abm",
      token,
      secret,
      bucket: "control",
      now: expiresAt + 1,
    });
    expect(expired).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects tampered experienceId, bucket, expiry, signature, wrong secret, and malformed tokens", async () => {
    const expiresAt = 2_000_000_000;
    const token = await signPreviewToken({
      experienceId: "fintech-abm",
      secret,
      expiresAt,
      bucket: "variant",
    });

    const wrongExp = await verifyPreviewToken({
      experienceId: "other-exp",
      token,
      secret,
      bucket: "variant",
      now: expiresAt - 10,
    });
    expect(wrongExp).toEqual({ valid: false, reason: "invalid_signature" });

    const wrongBucket = await verifyPreviewToken({
      experienceId: "fintech-abm",
      token,
      secret,
      bucket: "control",
      now: expiresAt - 10,
    });
    expect(wrongBucket).toEqual({ valid: false, reason: "invalid_signature" });

    const tamperedExpiry = `2999999999.${token.split(".")[1]}`;
    const badExp = await verifyPreviewToken({
      experienceId: "fintech-abm",
      token: tamperedExpiry,
      secret,
      bucket: "variant",
      now: expiresAt - 10,
    });
    expect(badExp).toEqual({ valid: false, reason: "invalid_signature" });

    const wrongSecret = await verifyPreviewToken({
      experienceId: "fintech-abm",
      token,
      secret: "wrong-secret",
      bucket: "variant",
      now: expiresAt - 10,
    });
    expect(wrongSecret).toEqual({ valid: false, reason: "invalid_signature" });

    const emptySecret = await verifyPreviewToken({
      experienceId: "fintech-abm",
      token,
      secret: "",
    });
    expect(emptySecret).toEqual({ valid: false, reason: "empty_secret" });

    const malformed = await verifyPreviewToken({
      experienceId: "fintech-abm",
      token: "not.a.valid.token",
      secret,
    });
    expect(malformed).toEqual({ valid: false, reason: "invalid_format" });

    const shortMac = await verifyPreviewToken({
      experienceId: "fintech-abm",
      token: "abcd",
      secret,
    });
    expect(shortMac).toEqual({ valid: false, reason: "invalid_format" });
  });

  it("builds and parses signed preview URLs while preserving existing query params", async () => {
    const url = await buildPreviewUrl({
      baseUrl: "https://example.com/landing?utm_source=slack",
      experienceId: "fintech-abm",
      secret,
      expiresAt: 2_000_000_000,
      bucket: "variant",
    });

    const parsedUrl = new URL(url);
    expect(parsedUrl.searchParams.get("utm_source")).toBe("slack");

    const preview = parsePreviewParams(url);
    expect(preview).not.toBeNull();
    expect(preview?.experienceId).toBe("fintech-abm");
    expect(preview?.bucket).toBe("variant");
    expect(preview?.signature).toBeDefined();

    const verified = await verifyPreviewToken({
      experienceId: preview!.experienceId!,
      token: preview!.signature!,
      secret,
      bucket: preview!.bucket,
      now: 1_999_999_999,
    });
    expect(verified.valid).toBe(true);
  });

  it("returns null from parsePreviewParams when no preview params exist and supports default bucket", () => {
    expect(parsePreviewParams("https://example.com/?foo=bar")).toBeNull();
    expect(parsePreviewParams("https://example.com/?__facet_bucket=default")).toEqual({
      bucket: "default",
    });
    expect(
      parsePreviewParams(new URLSearchParams("p=exp-1&s=tok"), {
        previewParam: "p",
        previewSigParam: "s",
      }),
    ).toEqual({
      experienceId: "exp-1",
      signature: "tok",
    });
  });
});

describe("HTML transforms & escaping", () => {
  it("escapes HTML special characters safely", () => {
    expect(escapeHtml(`<script>alert("xss" & '1')</script>`)).toBe(
      "&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;1&#39;)&lt;/script&gt;",
    );
    expect(escapeHtmlAttr(`" onclick="alert(1)`)).toBe("&quot; onclick=&quot;alert(1)");
  });

  it("normalizes and deduplicates class lists", () => {
    expect(normalizeClassList("  btn   btn-primary  btn ")).toEqual(["btn", "btn-primary"]);
    expect(normalizeClassList(["a b", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(normalizeClassList(undefined)).toEqual([]);
  });
});

describe("analytics snippet generation & XSS safety", () => {
  it("returns empty string when exposures or providers are empty", () => {
    expect(buildAnalyticsSnippet([], ["ga4"])).toBe("");
    expect(buildAnalyticsSnippet([{ experienceId: "e1", bucket: "variant" }], [])).toBe("");
  });

  it("emits scripts for all providers and strips internal fields including experience name", () => {
    const exposures = toAnalyticsExposures([
      {
        experienceId: "fintech-abm",
        name: "Secret Internal ABM Campaign Name",
        priority: 10,
        bucket: "variant",
        holdout: 0.2,
        applied: true,
        preview: false,
      },
    ]);

    expect(exposures).toEqual([{ experienceId: "fintech-abm", bucket: "variant" }]);

    const snippet = buildAnalyticsSnippet(exposures, ["ga4", "umami", "posthog", "custom", "ga4"]);
    expect(snippet).toContain('window.gtag("event","facet_exposure"');
    expect(snippet).toContain('window.umami.track("facet_exposure"');
    expect(snippet).toContain('window.posthog.capture("facet_exposure"');
    expect(snippet).toContain('new CustomEvent("facet:exposure"');
    expect(snippet).not.toContain("Secret Internal ABM Campaign Name");
    expect(snippet).not.toContain("experience_name");
    expect(snippet).not.toContain("holdout");
    expect(snippet).not.toContain("priority");
    // Deduplicated ga4
    expect(snippet.match(/window\.gtag\("event"/g)).toHaveLength(1);
  });

  it("escapes </script>, HTML comments, and JS line separators against XSS injection", () => {
    const payload = `</script><script>alert("pwned")</script><!-- &\u2028\u2029`;
    const encoded = safeJsonForScript({ experienceId: payload });
    expect(encoded).not.toContain("</script>");
    expect(encoded).not.toContain("<");
    expect(encoded).not.toContain(">");
    expect(encoded).not.toContain("&");
    expect(encoded).not.toContain("\u2028");
    expect(encoded).not.toContain("\u2029");

    const snippet = buildAnalyticsSnippet(
      [{ experienceId: payload, bucket: "control" }],
      ["custom"],
    );
    // Only the outer opening and closing script tags should exist
    expect(snippet.match(/<\/script>/gi)).toHaveLength(1);
    expect(snippet.endsWith("</script>")).toBe(true);
  });
});

describe("Web Standard runtime purity", () => {
  it("contains zero Node-only imports in packages/core/src/**", () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    const forbiddenImport =
      /from\s+["'](?:node:|fs|path|crypto|http|https|os|url|stream|buffer|util|child_process)["']/;

    for (const file of files) {
      const content = readFileSync(join(srcDir, file), "utf8");
      expect(content, `Node-only import found in ${file}`).not.toMatch(forbiddenImport);
    }
  });
});
