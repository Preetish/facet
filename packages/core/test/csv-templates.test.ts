import { describe, expect, it } from "vitest";
import {
  interpolateTemplate,
  parseCsvTable,
  resolveChange,
  validateTemplateSyntax,
  type TemplateContext,
} from "../src/index.js";

describe("parseCsvTable (RFC-4180)", () => {
  it("parses standard CSV with CRLF/LF, BOM, quoted fields, embedded commas, newlines, and escaped quotes", () => {
    const csv = [
      "\uFEFFslug, name ,tagline,notes",
      'stripe,"Stripe, Inc.","Payments ""reimagined""","Line 1\nLine 2"',
      "plaid,Plaid,Financial data,Simple",
      "",
      'brex,"Brex",Corporate cards',
    ].join("\r\n");

    const table = parseCsvTable(csv, "slug");
    expect(Object.keys(table)).toEqual(["stripe", "plaid", "brex"]);
    expect(table["stripe"]).toEqual({
      slug: "stripe",
      name: "Stripe, Inc.",
      tagline: 'Payments "reimagined"',
      notes: "Line 1\nLine 2",
    });
    expect(table["plaid"]).toEqual({
      slug: "plaid",
      name: "Plaid",
      tagline: "Financial data",
      notes: "Simple",
    });
    // Short row pads missing trailing columns with ""
    expect(table["brex"]).toEqual({
      slug: "brex",
      name: "Brex",
      tagline: "Corporate cards",
      notes: "",
    });
  });

  it("returns empty object when CSV has headers only and skips rows with empty keys", () => {
    expect(parseCsvTable("slug,name\n", "slug")).toEqual({});
    expect(parseCsvTable("slug,name\n,NoKey\n  ,WhitespaceKey\nstripe,Stripe\n", "slug")).toEqual({
      stripe: { slug: "stripe", name: "Stripe" },
    });
  });

  it("throws descriptive errors on missing keyColumn, empty keyColumn, or unterminated quotes", () => {
    expect(() => parseCsvTable("slug,name\nstripe,Stripe", "")).toThrow(/non-empty/i);
    expect(() => parseCsvTable("slug,name\nstripe,Stripe", "missing_col")).toThrow(
      /missing required key column "missing_col"/,
    );
    expect(() => parseCsvTable("", "slug")).toThrow(/missing required key column "slug"/);
    expect(() => parseCsvTable('slug,name\nstripe,"unclosed', "slug")).toThrow(
      /unterminated quoted field/i,
    );
  });

  it("filters out prototype-pollution row keys and column headers", () => {
    const csv =
      "slug,__proto__,constructor,prototype,name\n__proto__,x,y,z,Bad1\nconstructor,x,y,z,Bad2\nstripe,x,y,z,Stripe\n";
    const table = parseCsvTable(csv, "slug");
    expect(Object.keys(table)).toEqual(["stripe"]);
    expect(table["stripe"]).toEqual({ slug: "stripe", name: "Stripe" });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(() => parseCsvTable(csv, "__proto__")).toThrow(/not allowed/i);
  });
});

describe("validateTemplateSyntax", () => {
  it("accepts valid placeholders, default filters, single/double quotes, and plain single braces", () => {
    const validTemplates = [
      "Plain text without placeholders",
      "body { color: red; }",
      "Welcome, {{data.name}}!",
      'Built for {{ company.industry | default("your team") }}',
      "Hi {{query.acct | default('friend')}}",
      'Quote: {{data.quote | default("Say \\"hi\\"")}}',
      'Braces in default: {{data.val | default("}}")}}',
      "{{params.acct}} {{geo.country}} {{utm_source}} {{utm_medium}} {{utm_campaign}} {{utm_term}} {{utm_content}}",
      '{{data.empty | default("")}}',
    ];

    for (const tpl of validTemplates) {
      const res = validateTemplateSyntax(tpl);
      expect(res.valid, `Expected valid for: ${tpl} (${JSON.stringify(res.errors)})`).toBe(true);
      expect(res.errors).toEqual([]);
    }
  });

  it("rejects malformed placeholders, unsupported roots/filters, and prototype-pollution keys", () => {
    const invalidTemplates = [
      "Unclosed {{data.name",
      "Stray closing data.name}}",
      "Nested {{data.{{foo}}}}",
      "Empty {{}}",
      "Whitespace {{   }}",
      "Unknown root {{cookie.session}}",
      "Unknown header {{header.authorization}}",
      "Unknown bare {{foo}}",
      "Missing field {{data.}}",
      "Prototype __proto__ {{data.__proto__}}",
      "Prototype constructor {{query.constructor}}",
      "Prototype prototype {{params.prototype}}",
      "Top-level __proto__ {{__proto__}}",
      "Unsupported filter {{data.name | uppercase}}",
      "Unquoted default {{data.name | default(foo)}}",
      'Unterminated default {{data.name | default("abc)}}',
      "Trailing pipe {{data.name | }}",
      "Leading pipe {{ | default('x') }}",
    ];

    for (const tpl of invalidTemplates) {
      const res = validateTemplateSyntax(tpl);
      expect(res.valid, `Expected invalid for: ${tpl}`).toBe(false);
      expect(res.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("interpolateTemplate & resolveChange XSS safety", () => {
  const ctx: TemplateContext = {
    data: {
      name: "Stripe",
      seats: 0,
      verified: false,
      empty: "",
      xss: `<img src=x onerror="alert('xss')">`,
    },
    company: { industry: "FinTech" },
    query: { acct: "stripe", evil: `<script>alert("pwn")</script>` },
    geo: { country: "US" },
    params: { acct: "stripe", raw: `<b>bold & 'quoted'</b>` },
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "fintech-q4",
    utm_term: "payments",
    utm_content: "hero-a",
  };

  it("interpolates all supported roots, defaults, and preserves 0/false values", () => {
    expect(
      interpolateTemplate(
        "{{data.name}} / {{company.industry}} / {{query.acct}} / {{geo.country}} / {{params.acct}} / {{utm_source}} / {{utm_medium}} / {{utm_campaign}} / {{utm_term}} / {{utm_content}}",
        ctx,
      ),
    ).toBe(
      "Stripe / FinTech / stripe / US / stripe / google / cpc / fintech-q4 / payments / hero-a",
    );

    // 0 and false are valid values and must NOT trigger default()
    expect(interpolateTemplate('{{data.seats | default("10")}}', ctx)).toBe("0");
    expect(interpolateTemplate('{{data.verified | default("yes")}}', ctx)).toBe("false");

    // Empty string and undefined trigger default()
    expect(interpolateTemplate('{{data.empty | default("Fallback")}}', ctx)).toBe("Fallback");
    expect(interpolateTemplate("{{data.missing | default('Guest')}}", ctx)).toBe("Guest");
    expect(interpolateTemplate("Hi {{data.missing}}!", ctx)).toBe("Hi !");
  });

  it("blocks prototype-pollution lookups at runtime without touching Object.prototype", () => {
    expect(interpolateTemplate("{{data.__proto__}}", ctx)).toBe("");
    expect(interpolateTemplate("{{data.constructor}}", ctx)).toBe("");
    expect(interpolateTemplate("{{data.prototype}}", ctx)).toBe("");
    expect(interpolateTemplate("{{data.toString}}", ctx)).toBe("");
    expect(interpolateTemplate("{{query.valueOf}}", ctx)).toBe("");
  });

  it("escapes interpolated values in html, slot, prepend, and append, while keeping raw strings in text and attrs", () => {
    const slots = {
      banner: '<div class="banner">Welcome {{query.evil}} from {{params.raw}}</div>',
    };

    const textChange = resolveChange(
      {
        selector: "h1",
        text: "Hello {{query.evil}}",
        attrs: { "data-raw": "{{params.raw}}", "data-del": null },
      },
      "exp-1",
      slots,
      ctx,
    );
    expect(textChange.text).toBe('Hello <script>alert("pwn")</script>');
    expect(textChange.attrs).toEqual({
      "data-raw": "<b>bold & 'quoted'</b>",
      "data-del": null,
    });

    const htmlChange = resolveChange(
      {
        selector: "#hero",
        html: "<span>Hello {{query.evil}}</span>",
        prepend: "<em>{{data.xss}}</em>",
        append: "<small>{{params.raw}}</small>",
      },
      "exp-1",
      slots,
      ctx,
    );
    expect(htmlChange.html).toBe(
      "<span>Hello &lt;script&gt;alert(&quot;pwn&quot;)&lt;/script&gt;</span>",
    );
    expect(htmlChange.prepend).toBe(
      "<em>&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;</em>",
    );
    expect(htmlChange.append).toBe("<small>&lt;b&gt;bold &amp; &#39;quoted&#39;&lt;/b&gt;</small>");

    const slotChange = resolveChange({ selector: "#slot", slot: "banner" }, "exp-1", slots, ctx);
    expect(slotChange.slot).toBe("banner");
    expect(slotChange.html).toBe(
      '<div class="banner">Welcome &lt;script&gt;alert(&quot;pwn&quot;)&lt;/script&gt; from &lt;b&gt;bold &amp; &#39;quoted&#39;&lt;/b&gt;</div>',
    );

    const dynamicSlotChange = resolveChange(
      { selector: "#slot", slot: "slot-{{query.evil}}" },
      "exp-1",
      slots,
      ctx,
    );
    expect(dynamicSlotChange.slot).toBe("slot-&lt;script&gt;alert(&quot;pwn&quot;)&lt;/script&gt;");
  });
});
