import { buildContextFromRequest, evaluate, parseFacetYaml } from "@facet/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_STARTER_YAML } from "../src/shared/defaults.js";
import { validateFacetYamlFull } from "../src/shared/validation.js";
import { serializeFacetConfig } from "../src/shared/yaml-serializer.js";
import {
  applyAudienceFields,
  buildDefaultTestPathForExperience,
  createStarterCampaign,
  detectChangeMode,
  extractAudienceFields,
  getFriendlyChangeTitle,
  roundTripConfigUpdate,
  slugifyCampaignId,
  summarizeExperienceMatch,
  updateAccountTableInConfig,
} from "../src/ui/helpers/campaign-model.js";
import {
  applyPickedElementToChanges,
  buildLivePreviewIframeSrc,
  formatSiteHostname,
  normalizeSiteUrl,
  parseBridgeMessage,
} from "../src/ui/helpers/live-preview.js";

describe("Studio UI State & YAML Round-Tripping", () => {
  it("round-trips starter YAML cleanly through serializer and @facet/core validator", () => {
    const parsed = validateFacetYamlFull(DEFAULT_STARTER_YAML);
    expect(parsed.ok).toBe(true);
    expect(parsed.config).toBeDefined();

    const serialized = serializeFacetConfig(parsed.config!);
    const reparsed = parseFacetYaml(serialized);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.config.experiences.map((e) => e.id)).toEqual([
        "abm-account-page",
        "fintech-paid-search",
      ]);
      expect(reparsed.config.data?.["accounts"]?.["meridian"]?.["name"]).toBe("Meridian Cloud");
    }
  });

  it("preserves advanced match combinators while editing marketer-friendly audience fields", () => {
    const complexMatch = {
      path: "/",
      utm_campaign: ["fintech-q4", "pci-infra"],
      any: [{ "company.industry": ["Financial Services"] }],
    };

    const extracted = extractAudienceFields(complexMatch);
    expect(extracted.path).toBe("/");
    expect(extracted.utmCampaign).toBe("fintech-q4, pci-infra");
    expect(extracted.hasAdvancedRules).toBe(true);

    const updated = applyAudienceFields(complexMatch, {
      ...extracted,
      utmSource: "linkedin",
      geoCountry: "US",
      returning: "returning",
    });

    expect(updated.utm_source).toBe("linkedin");
    expect(updated["geo.country"]).toBe("US");
    expect(updated.returning).toBe(true);
    expect(updated.any).toEqual([{ "company.industry": ["Financial Services"] }]);
  });

  it("evaluates generated test paths with @facet/core for both virtual ABM pages and UTM campaigns", () => {
    const parsed = parseFacetYaml(DEFAULT_STARTER_YAML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const abmExp = parsed.config.experiences[0]!;
    const abmDefaults = buildDefaultTestPathForExperience(abmExp, parsed.config, "meridian");
    expect(abmDefaults.pathAndQuery).toBe("/for/meridian");

    const abmCtx = buildContextFromRequest(
      new Request(`https://preview.example.com${abmDefaults.pathAndQuery}`),
      { visitorId: "visitor-001" },
    );
    const abmEval = evaluate(parsed.config, abmCtx, { visitorId: "visitor-001" });
    expect(abmEval.personalized).toBe(true);
    expect(abmEval.originPath).toBe("/");
    expect(abmEval.activeChanges[0]?.text).toBe(
      "Zero-latency edge routing built for Meridian Cloud",
    );

    const utmExp = parsed.config.experiences[1]!;
    const utmDefaults = buildDefaultTestPathForExperience(utmExp, parsed.config);
    expect(utmDefaults.pathAndQuery).toBe("/?utm_campaign=fintech-q4");

    const utmCtx = buildContextFromRequest(
      new Request(`https://preview.example.com${utmDefaults.pathAndQuery}`),
      { visitorId: "visitor-001" },
    );
    const utmEval = evaluate(parsed.config, utmCtx, {
      visitorId: "visitor-001",
      previewExperienceId: utmExp.id,
      previewBucket: "variant",
    });
    expect(utmEval.personalized).toBe(true);
    expect(utmEval.activeChanges[0]?.text).toBe(
      "Compliance-ready infrastructure for fintech teams",
    );
  });

  it("creates unique starter campaigns, summarizes rules, detects change modes, and updates account tables", () => {
    const parsed = parseFacetYaml(DEFAULT_STARTER_YAML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(slugifyCampaignId("New Campaign", ["new-campaign"])).toBe("new-campaign-2");

    const starter = createStarterCampaign(parsed.config.experiences.map((e) => e.id));
    expect(summarizeExperienceMatch(starter)).toContain("UTM: new-campaign");
    expect(detectChangeMode(starter.changes[0]!)).toBe("text");
    expect(detectChangeMode(starter.changes[1]!)).toBe("cta");

    const withNewCampaign = {
      ...parsed.config,
      experiences: [starter, ...parsed.config.experiences],
    };
    const roundTripped = roundTripConfigUpdate(withNewCampaign);
    expect(roundTripped.validation.ok).toBe(true);

    const withUpdatedTable = updateAccountTableInConfig(withNewCampaign, "accounts", {
      ...(withNewCampaign.data?.["accounts"] ?? {}),
      stripe: { name: "Stripe", headline: "Built for Stripe" },
    });
    const rtTable = roundTripConfigUpdate(withUpdatedTable);
    expect(rtTable.validation.ok).toBe(true);
    expect(rtTable.yaml).toContain("Built for Stripe");
  });

  it("emits non-blocking warnings when lookup tables or slots are referenced before being defined", () => {
    const yaml = `version: 1
experiences:
  - id: missing-refs
    name: Missing Refs
    match:
      path: "/for/:acct"
    lookup:
      table: nonexistent_table
      key: "{{params.acct}}"
      required: true
    changes:
      - selector: "#logos"
        slot: missing-slot
`;
    const result = validateFacetYamlFull(yaml);
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBe(2);
  });

  it("derives plain-English change titles from selectors and swap modes", () => {
    expect(getFriendlyChangeTitle({ selector: "h1", text: "Hi" })).toBe("Headline");
    expect(
      getFriendlyChangeTitle({ selector: "[data-facet-slot='hero-subhead']", text: "Sub" }),
    ).toBe("Subheadline");
    expect(
      getFriendlyChangeTitle({
        selector: "[data-cta='hero']",
        text: "Book demo",
        attrs: { href: "/demo" },
      }),
    ).toBe("Primary button");
    expect(getFriendlyChangeTitle({ selector: "#logo-strip", slot: "fintech-logos" })).toBe(
      "Logo strip",
    );
    expect(getFriendlyChangeTitle({ selector: "#custom-banner", slot: "promo" })).toBe("HTML slot");
    expect(getFriendlyChangeTitle({ selector: "h2", text: "Details" })).toBe("Section heading");
    expect(getFriendlyChangeTitle({ selector: ".pricing-note", text: "Note" })).toBe(
      "Page element",
    );
  });

  it("normalizes live preview site URLs, extracts hostnames, and builds proxy iframe URLs", () => {
    expect(normalizeSiteUrl("facet.preetish.me")).toBe("https://facet.preetish.me/");
    expect(normalizeSiteUrl("https://facet.preetish.me/pricing?ref=nav")).toBe(
      "https://facet.preetish.me/pricing?ref=nav",
    );
    expect(normalizeSiteUrl("http://localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeSiteUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeSiteUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeSiteUrl("   ")).toBeNull();

    expect(formatSiteHostname("https://facet.preetish.me/pricing")).toBe("facet.preetish.me");
    expect(formatSiteHostname("http://localhost:3000/home")).toBe("localhost:3000");
    expect(formatSiteHostname("javascript:void(0)")).toBeNull();
    expect(formatSiteHostname(null)).toBeNull();

    expect(buildLivePreviewIframeSrc("https://facet.preetish.me/")).toBe(
      "/api/live-preview?url=https%3A%2F%2Ffacet.preetish.me%2F",
    );
  });

  it("parses valid preview bridge postMessage payloads and ignores malformed messages", () => {
    expect(
      parseBridgeMessage({
        type: "facet:ready",
        url: "https://facet.preetish.me/",
        title: "Facet",
      }),
    ).toEqual({
      type: "facet:ready",
      url: "https://facet.preetish.me/",
      title: "Facet",
    });

    expect(
      parseBridgeMessage({
        type: "facet:applied",
        matchedCount: 1,
        totalCount: 2,
        missingSelectors: ["[data-cta='hero']", 42],
      }),
    ).toEqual({
      type: "facet:applied",
      matchedCount: 1,
      totalCount: 2,
      missingSelectors: ["[data-cta='hero']"],
    });

    expect(
      parseBridgeMessage({
        type: "facet:picked",
        selector: "a.hero-cta",
        tagName: "A",
        text: "  Book demo  ",
        href: "/demo",
      }),
    ).toEqual({
      type: "facet:picked",
      selector: "a.hero-cta",
      tagName: "a",
      text: "Book demo",
      href: "/demo",
    });

    expect(parseBridgeMessage({ type: "facet:pick-cancelled" })).toEqual({
      type: "facet:pick-cancelled",
    });

    expect(parseBridgeMessage({ type: "facet:picked", selector: "" })).toBeNull();
    expect(parseBridgeMessage({ type: "unknown:event" })).toBeNull();
    expect(parseBridgeMessage("not-an-object")).toBeNull();
    expect(parseBridgeMessage(null)).toBeNull();
  });

  it("applies picked page elements by appending new changes or updating an existing row selector", () => {
    const base = [
      { selector: "h1", text: "Tailored headline for your campaign visitors" },
      { selector: "p.lead", text: "Custom written subhead" },
    ];

    // Append new anchor element -> preserves href in attrs
    const appended = applyPickedElementToChanges(
      base,
      { selector: "a#start-cta", tagName: "a", text: "Try Facet free", href: "/start" },
      null,
    );
    expect(appended).toHaveLength(3);
    expect(appended[2]).toEqual({
      selector: "a#start-cta",
      text: "Try Facet free",
      attrs: { href: "/start" },
    });

    // Re-pick index 0 (placeholder copy) -> updates selector AND prefills text
    const repickedPlaceholder = applyPickedElementToChanges(
      base,
      { selector: ".hero-title", tagName: "h1", text: "Edge personalization for B2B", href: null },
      0,
    );
    expect(repickedPlaceholder[0]).toEqual({
      selector: ".hero-title",
      text: "Edge personalization for B2B",
    });

    // Re-pick index 1 (custom copy) -> updates selector WITHOUT clobbering custom copy
    const repickedCustom = applyPickedElementToChanges(
      base,
      { selector: ".hero-subhead", tagName: "p", text: "Original page subhead", href: null },
      1,
    );
    expect(repickedCustom[1]).toEqual({
      selector: ".hero-subhead",
      text: "Custom written subhead",
    });
  });
});
