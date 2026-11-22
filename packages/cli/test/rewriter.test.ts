import { describe, expect, it } from "vitest";
import {
  deserializeLocalPreviewMode,
  isStaticAssetPath,
  resolveLocalPreviewMode,
  rewriteHtml,
  serializeLocalPreviewMode,
} from "../src/index.js";

describe("HTML rewriter & preview helpers", () => {
  it("escapes HTML in text changes and handles fragments without <body>", async () => {
    const out = await rewriteHtml({
      html: "<section><h1>Old</h1><div id='slot'>Keep</div></section>",
      changes: [
        {
          experienceId: "exp-1",
          selector: "h1",
          text: '<script>alert("xss")</script> & More',
        },
        {
          // External slot (no resolved html) should leave element untouched
          experienceId: "exp-1",
          selector: "#slot",
          slot: "external-next-slot",
        },
      ],
      previewBarHtml: '<div id="__facet-preview-bar">Bar</div>',
    });

    const html = out.toString("utf8");
    expect(html).toContain('&lt;script&gt;alert("xss")&lt;/script&gt; &amp; More');
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("<div id='slot'>Keep</div>");
    expect(html).toContain('<div id="__facet-preview-bar">Bar</div>');
  });

  it("removes empty class attribute when last class is removed", async () => {
    const out = await rewriteHtml({
      html: '<body><div id="box" class="only-class">Hi</div></body>',
      changes: [
        {
          experienceId: "exp-1",
          selector: "#box",
          removeClass: ["only-class"],
        },
      ],
    });

    const html = out.toString("utf8");
    expect(html).toBe('<body><div id="box">Hi</div></body>');
  });

  it("serializes, deserializes, and resolves local preview modes with query precedence over cookie", () => {
    expect(deserializeLocalPreviewMode(serializeLocalPreviewMode({ kind: "auto" }))).toEqual({
      kind: "auto",
    });
    expect(deserializeLocalPreviewMode(serializeLocalPreviewMode({ kind: "default" }))).toEqual({
      kind: "default",
    });
    expect(
      deserializeLocalPreviewMode(
        serializeLocalPreviewMode({
          kind: "experience",
          experienceId: "abm-stripe",
          bucket: "control",
        }),
      ),
    ).toEqual({
      kind: "experience",
      experienceId: "abm-stripe",
      bucket: "control",
    });
    expect(deserializeLocalPreviewMode("corrupt-value")).toEqual({ kind: "auto" });

    // Query overrides cookie
    const resolved = resolveLocalPreviewMode(
      new URL("http://localhost:8787/?__facet_preview=exp-a&__facet_bucket=control"),
      { __facet_local_mode: "default" },
    );
    expect(resolved.mode).toEqual({
      kind: "experience",
      experienceId: "exp-a",
      bucket: "control",
    });
    expect(resolved.fromQuery).toBe(true);
  });

  it("detects static asset paths while keeping HTML pages rewritable", () => {
    expect(isStaticAssetPath("/assets/app.js")).toBe(true);
    expect(isStaticAssetPath("/styles/main.CSS")).toBe(true);
    expect(isStaticAssetPath("/fonts/inter.woff2")).toBe(true);
    expect(isStaticAssetPath("/img/logo.png")).toBe(true);
    expect(isStaticAssetPath("/")).toBe(false);
    expect(isStaticAssetPath("/pricing")).toBe(false);
    expect(isStaticAssetPath("/for/stripe")).toBe(false);
    expect(isStaticAssetPath("/index.html")).toBe(false);
  });
});
