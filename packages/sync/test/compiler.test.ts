import { parseFacetYaml } from "@facet/core";
import { describe, expect, it } from "vitest";
import { compileAccountTableRows, compileCampaignRows } from "../src/index.js";

describe("compileCampaignRows", () => {
  it("compiles marketer spreadsheet rows into validated FacetConfig and clean YAML", () => {
    const result = compileCampaignRows(
      [
        {
          id: "fintech-q4",
          name: "Fintech Q4 Paid Search",
          status: "live",
          priority: "20",
          path: "/",
          utm_campaign: "fintech-q4, abm-banking",
          utm_source: "google",
          utm_medium: "cpc",
          utm_term: "compliance infra",
          acct: "stripe, plaid",
          country: "US, GB",
          sticky: "7d",
          holdout: "20%",
          headline: "Compliance-ready infrastructure for fintech teams",
          subhead: "Ship faster without audit headaches.",
          cta_selector: "[data-cta='primary']",
          cta_text: "Book fintech demo",
          cta_href: "/demo?segment=fintech",
        },
        {
          id: "abm-stripe-page",
          name: "Stripe Virtual ABM Page",
          status: "live",
          priority: 30,
          path: "/for/:acct",
          origin_path: "/",
          sticky: "session",
          holdout: 0,
          headline_selector: ".hero-title",
          headline: "Built for {{data.name}}",
          changes_json: JSON.stringify([
            { selector: "#logo-strip", slot: "fintech-logos" },
            { selector: ".hero-badge", addClass: ["abm-highlight"] },
          ]),
        },
        {
          id: "q4-draft-idea",
          name: "Work in progress draft",
          status: "draft",
          path: "/pricing",
          headline: "Should never appear in compiled output",
        },
        {
          id: "summer-promo",
          name: "Paused Summer Promo",
          status: "paused",
          priority: 5,
          path: "/pricing",
          utm_campaign: "summer-2026",
          headline: "Summer pricing",
        },
        {
          id: "",
          name: "",
          status: "",
          headline: "",
        },
      ],
      {
        defaultSelector: {
          headline: "h1.hero",
          subhead: "p.hero-sub",
          cta: "a.hero-cta",
        },
        baseConfig: {
          settings: {
            cookieName: "__facet_vid",
            stickyCookieName: "__facet_sticky",
            previewParam: "__facet_preview",
            previewSigParam: "__facet_sig",
            analytics: { providers: ["ga4", "posthog"] },
            slots: { "fintech-logos": "<div>Stripe + Plaid</div>" },
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary).toEqual({
      totalRows: 5,
      compiledCount: 3,
      liveCount: 2,
      pausedCount: 1,
      draftSkipped: 1,
      blankSkipped: 1,
      errorCount: 0,
    });

    expect(result.experiences).toHaveLength(3);

    const fintech = result.experiences[0];
    expect(fintech?.id).toBe("fintech-q4");
    expect(fintech?.enabled).toBe(true);
    expect(fintech?.priority).toBe(20);
    expect(fintech?.holdout).toBe(0.2);
    expect(fintech?.sticky).toBe("7d");
    expect(fintech?.match).toEqual({
      path: "/",
      utm_campaign: ["fintech-q4", "abm-banking"],
      utm_source: "google",
      utm_medium: "cpc",
      utm_term: "compliance infra",
      "query.acct": ["stripe", "plaid"],
      "geo.country": ["US", "GB"],
    });
    expect(fintech?.changes).toEqual([
      { selector: "h1.hero", text: "Compliance-ready infrastructure for fintech teams" },
      { selector: "p.hero-sub", text: "Ship faster without audit headaches." },
      {
        selector: "[data-cta='primary']",
        text: "Book fintech demo",
        attrs: { href: "/demo?segment=fintech" },
      },
    ]);

    const abm = result.experiences[1];
    expect(abm?.originPath).toBe("/");
    expect(abm?.sticky).toBe("session");
    expect(abm?.changes).toEqual([
      { selector: ".hero-title", text: "Built for {{data.name}}" },
      { selector: "#logo-strip", slot: "fintech-logos" },
      { selector: ".hero-badge", addClass: ["abm-highlight"] },
    ]);

    const paused = result.experiences[2];
    expect(paused?.id).toBe("summer-promo");
    expect(paused?.enabled).toBe(false);

    // Serialized YAML round-trips cleanly through @facet/core parseFacetYaml
    const parsed = parseFacetYaml(result.yaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.experiences).toHaveLength(3);
      expect(parsed.config.settings.analytics.providers).toEqual(["ga4", "posthog"]);
    }
  });

  it("isolates invalid rows with per-row errors while keeping valid rows schema-valid", () => {
    const result = compileCampaignRows([
      {
        id: "valid-hero",
        name: "Valid Hero",
        status: "live",
        path: "/",
        headline: "Valid headline",
      },
      {
        id: "bad-holdout",
        name: "Bad Holdout",
        status: "live",
        path: "/",
        holdout: "1.5",
        headline: "Should fail validation",
      },
      {
        id: "bad-origin",
        name: "Bad Origin Path",
        status: "live",
        path: "/for/:acct",
        origin_path: "//evil.com/phish",
        headline: "Should fail originPath check",
      },
      {
        id: "bad-json",
        name: "Broken Changes JSON",
        status: "live",
        path: "/",
        changes_json: "{not valid json",
      },
      {
        id: "no-changes",
        name: "Missing Changes",
        status: "live",
        path: "/",
      },
      {
        id: "valid-hero",
        name: "Duplicate ID",
        status: "live",
        path: "/pricing",
        headline: "Duplicate",
      },
      {
        id: "bad-status",
        name: "Unknown Status",
        status: "archived",
        path: "/",
        headline: "Unknown status",
      },
      {
        id: "second-valid",
        name: "Second Valid",
        status: "live",
        path: "/demo",
        cta_text: "Request Demo",
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.experiences.map((e) => e.id)).toEqual(["valid-hero", "second-valid"]);
    expect(result.errors).toHaveLength(6);
    expect(result.errors.map((e) => ({ row: e.rowNumber, id: e.experienceId }))).toEqual([
      { row: 2, id: "bad-holdout" },
      { row: 3, id: "bad-origin" },
      { row: 4, id: "bad-json" },
      { row: 5, id: "no-changes" },
      { row: 6, id: "valid-hero" },
      { row: 7, id: "bad-status" },
    ]);

    expect(result.summary.compiledCount).toBe(2);
    expect(result.summary.errorCount).toBe(6);

    // Resulting config & YAML remain 100% valid despite bad rows
    const parsed = parseFacetYaml(result.yaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.experiences.map((e) => e.id)).toEqual(["valid-hero", "second-valid"]);
    }
  });

  it("strips prototype-pollution keys from changes_json and row objects", () => {
    const result = compileCampaignRows([
      {
        id: "safe-json",
        name: "Safe JSON",
        path: "/",
        changes_json:
          '[{"selector": "a.cta", "attrs": {"href": "/demo", "__proto__": "bad", "constructor": "bad"}}]',
      },
    ]);

    expect(result.ok).toBe(true);
    const attrs = result.experiences[0]?.changes[0]?.attrs;
    expect(attrs).toEqual({ href: "/demo" });
    expect(Object.prototype.hasOwnProperty.call(attrs ?? {}, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(attrs ?? {}, "constructor")).toBe(false);
  });
});

describe("compileAccountTableRows", () => {
  it("builds keyed account lookup table while filtering empty and prototype-pollution keys", () => {
    const pollutedRow = JSON.parse(
      '{"slug":"stripe","name":"Stripe","employees":8000,"active":true,"tags":["Fintech","Enterprise"],"__proto__":"evil","constructor":"evil","prototype":"evil"}',
    ) as Record<string, unknown>;

    const result = compileAccountTableRows(
      [
        pollutedRow,
        { slug: "  plaid  ", name: "Plaid", industry: "FinTech" },
        { slug: "", name: "Empty Key" },
        { slug: "   ", name: "Whitespace Key" },
        { slug: "__proto__", name: "Proto Row" },
        { slug: "constructor", name: "Constructor Row" },
        { slug: "prototype", name: "Prototype Row" },
      ],
      { tableName: "accounts", keyColumn: "slug" },
    );

    expect(result.rowCount).toBe(2);
    expect(result.skippedRows).toBe(5);
    expect(Object.keys(result.table)).toEqual(["stripe", "plaid"]);
    expect(result.table.stripe).toEqual({
      slug: "stripe",
      name: "Stripe",
      employees: 8000,
      active: true,
      tags: "Fintech, Enterprise",
    });
    expect(result.table.plaid).toEqual({
      slug: "  plaid  ",
      name: "Plaid",
      industry: "FinTech",
    });
    expect(Object.prototype.hasOwnProperty.call(result.table, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.table.stripe ?? {}, "constructor")).toBe(
      false,
    );
  });

  it("rejects empty or prototype-pollution tableName and keyColumn", () => {
    expect(() =>
      compileAccountTableRows([], { tableName: "__proto__", keyColumn: "id" }),
    ).toThrow();
    expect(() =>
      compileAccountTableRows([], { tableName: "accounts", keyColumn: "constructor" }),
    ).toThrow();
    expect(() => compileAccountTableRows([], { tableName: "  ", keyColumn: "id" })).toThrow();
  });
});
