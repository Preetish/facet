import { describe, expect, it } from "vitest";
import {
  ANALYTICS_PROVIDERS,
  DEFAULT_COOKIE_NAME,
  DEFAULT_ENRICHMENT_CACHE_TTL_SECONDS,
  DEFAULT_ENRICHMENT_TIMEOUT_MS,
  DEFAULT_PREVIEW_PARAM,
  DEFAULT_PREVIEW_SIG_PARAM,
  DEFAULT_STICKY_COOKIE_NAME,
  exportFacetJsonSchema,
  parseFacetYaml,
  validateFacetConfig,
} from "../src/index.js";

const VERBATIM_AGENTS_YAML = `
version: 1

settings:
  cookieName: "__facet_vid"
  previewParam: "__facet_preview"
  analytics:
    providers: ["ga4", "umami", "posthog"] # emits experience_id + bucket ("variant" | "control")

experiences:
  - id: fintech-abm
    name: "Fintech ABM & Paid Search"
    priority: 10
    match:
      path: "/"
      any:
        - utm_campaign: ["fintech-q4", "abm-banking"]
        - query.acct: ["stripe", "plaid"]
        - company.industry: ["Financial Services", "FinTech"]
    holdout: 0.2 # deterministic 20% sticky control group
    changes:
      - selector: "h1"
        text: "Compliance-ready infrastructure for fintech teams"
      - selector: "[data-cta='hero']"
        text: "See the fintech demo"
        attrs:
          href: "/demo?segment=fintech"
      - selector: "#logo-strip"
        slot: "fintech-logos" # or explicit \`html:\`
`;

const VALID_AGENTS_YAML = `
version: 1

settings:
  cookieName: "__facet_vid"
  previewParam: "__facet_preview"
  analytics:
    providers: ["ga4", "umami", "posthog"]
  slots:
    fintech-logos: "<div class='logos'>Stripe Plaid Brex</div>"
  enrichment:
    timeoutMs: 120
    cacheTtlSeconds: 1800

experiences:
  - id: fintech-abm
    name: "Fintech ABM & Paid Search"
    priority: 10
    match:
      path: "/"
      any:
        - utm_campaign: ["fintech-q4", "abm-banking"]
        - query.acct: ["stripe", "plaid"]
        - company.industry: ["Financial Services", "FinTech"]
    holdout: 0.2
    changes:
      - selector: "h1"
        text: "Compliance-ready infrastructure for fintech teams"
      - selector: "[data-cta='hero']"
        text: "See the fintech demo"
        attrs:
          href: "/demo?segment=fintech"
      - selector: "#logo-strip"
        slot: "fintech-logos"
`;

describe("parseFacetYaml & schema validation", () => {
  it("parses the verbatim AGENTS.md facet.yaml sample without requiring settings.slots", () => {
    const result = parseFacetYaml(VERBATIM_AGENTS_YAML);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.config.version).toBe(1);
    expect(result.config.settings.slots).toEqual({});
    expect(result.config.experiences[0]?.id).toBe("fintech-abm");
    expect(result.config.experiences[0]?.changes[2]?.slot).toBe("fintech-logos");
  });

  it("parses a complete facet.yaml with all settings and experiences", () => {
    const result = parseFacetYaml(VALID_AGENTS_YAML);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.config.version).toBe(1);
    expect(result.config.settings.cookieName).toBe("__facet_vid");
    expect(result.config.settings.previewParam).toBe("__facet_preview");
    expect(result.config.settings.previewSigParam).toBe(DEFAULT_PREVIEW_SIG_PARAM);
    expect(result.config.settings.analytics.providers).toEqual(["ga4", "umami", "posthog"]);
    expect(result.config.settings.enrichment).toEqual({
      timeoutMs: 120,
      cacheTtlSeconds: 1800,
    });
    expect(result.config.experiences).toHaveLength(1);
    const exp = result.config.experiences[0];
    expect(exp?.enabled).toBe(true);
    expect(exp?.stopOnMatch).toBe(true);
    expect(exp?.holdout).toBe(0.2);
  });

  it("applies default settings and experience fields when omitted", () => {
    const minimalYaml = `
version: 1
experiences:
  - id: hero-swap
    name: "Hero Swap"
    match:
      path: "/"
    changes:
      - selector: "h1"
        text: "Hello"
`;
    const result = parseFacetYaml(minimalYaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.config.settings).toEqual({
      cookieName: DEFAULT_COOKIE_NAME,
      stickyCookieName: DEFAULT_STICKY_COOKIE_NAME,
      previewParam: DEFAULT_PREVIEW_PARAM,
      previewSigParam: DEFAULT_PREVIEW_SIG_PARAM,
      analytics: { providers: [] },
      slots: {},
    });
    const exp = result.config.experiences[0];
    expect(exp?.enabled).toBe(true);
    expect(exp?.priority).toBe(0);
    expect(exp?.stopOnMatch).toBe(true);
    expect(exp?.holdout).toBe(0);
  });

  it("applies enrichment defaults when enrichment object is empty", () => {
    const yaml = `
version: 1
settings:
  enrichment: {}
`;
    const result = parseFacetYaml(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.config.settings.enrichment).toEqual({
      timeoutMs: DEFAULT_ENRICHMENT_TIMEOUT_MS,
      cacheTtlSeconds: DEFAULT_ENRICHMENT_CACHE_TTL_SECONDS,
    });
  });

  it("rejects duplicate experience IDs with path and line info", () => {
    const yaml = `
version: 1
experiences:
  - id: dup-exp
    name: "First"
    match:
      path: "/"
    changes:
      - selector: "h1"
        text: "A"
  - id: dup-exp
    name: "Second"
    match:
      path: "/pricing"
    changes:
      - selector: "h1"
        text: "B"
`;
    const result = parseFacetYaml(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("experiences[1].id");
    expect(result.errors[0]?.message).toContain('Duplicate experience id "dup-exp"');
    expect(result.errors[0]?.line).toBeGreaterThan(1);
  });

  it("allows external slot references even when not defined in settings.slots", () => {
    const yaml = `
version: 1
settings:
  slots:
    existing-slot: "<p>OK</p>"
experiences:
  - id: external-slot
    name: "External Slot"
    match:
      path: "/"
    changes:
      - selector: "#logos"
        slot: "next-facet-slot"
`;
    const result = parseFacetYaml(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.config.experiences[0]?.changes[0]?.slot).toBe("next-facet-slot");
  });

  it("rejects combining remove: true with any other mutation", () => {
    const invalidCombinations = [
      { selector: "h1", remove: true, text: "hi" },
      { selector: "h1", remove: true, html: "<b>hi</b>" },
      { selector: "h1", remove: true, slot: "hero" },
      { selector: "h1", remove: true, attrs: { "data-x": "1" } },
      { selector: "h1", remove: true, addClass: "gone" },
      { selector: "h1", remove: true, removeClass: "visible" },
      { selector: "h1", remove: true, prepend: "!" },
      { selector: "h1", remove: true, append: "!" },
    ];

    for (const change of invalidCombinations) {
      const result = validateFacetConfig({
        version: 1,
        experiences: [
          {
            id: "bad-remove",
            name: "Bad Remove",
            match: { path: "/" },
            changes: [change],
          },
        ],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.message.includes('cannot combine "remove: true"'))).toBe(
          true,
        );
      }
    }
  });

  it("rejects mutually exclusive body replacements on a single change", () => {
    const pairs = [
      { selector: "h1", text: "hi", html: "<b>hi</b>" },
      { selector: "h1", text: "hi", slot: "s1" },
      { selector: "h1", html: "<b>hi</b>", slot: "s1" },
      { selector: "h1", text: "hi", html: "<b>hi</b>", slot: "s1" },
    ];

    for (const change of pairs) {
      const result = validateFacetConfig({
        version: 1,
        settings: { slots: { s1: "<span>slot</span>" } },
        experiences: [
          {
            id: "test",
            name: "Test",
            match: { path: "/" },
            changes: [change],
          },
        ],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.message.includes("mutually exclusive"))).toBe(true);
      }
    }
  });

  it("rejects a change with no mutation or only remove: false", () => {
    const noMutation = validateFacetConfig({
      version: 1,
      experiences: [
        {
          id: "empty-change",
          name: "Empty",
          match: { path: "/" },
          changes: [{ selector: "h1" }],
        },
      ],
    });
    expect(noMutation.ok).toBe(false);

    const removeFalse = validateFacetConfig({
      version: 1,
      experiences: [
        {
          id: "remove-false",
          name: "Remove False",
          match: { path: "/" },
          changes: [{ selector: "h1", remove: false }],
        },
      ],
    });
    expect(removeFalse.ok).toBe(false);
  });

  it("accepts all non-body change mutations", () => {
    const result = validateFacetConfig({
      version: 1,
      experiences: [
        {
          id: "all-mutations",
          name: "All Mutations",
          match: { path: "/" },
          changes: [
            { selector: ".a", attrs: { href: "/go", "data-old": null } },
            { selector: ".b", addClass: "highlight active" },
            { selector: ".c", addClass: ["one", "two"], removeClass: ["old"] },
            { selector: ".d", remove: true },
            { selector: ".e", prepend: "<span>New</span>", append: "<em>!</em>" },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unknown match keys, invalid regexes, empty operators, and empty combinators", () => {
    const unknownKey = validateFacetConfig({
      version: 1,
      experiences: [
        {
          id: "typo",
          name: "Typo",
          match: { utm_campain: "foo" },
          changes: [{ selector: "h1", text: "x" }],
        },
      ],
    });
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) {
      expect(unknownKey.errors[0]?.message).toContain('Unknown match key "utm_campain"');
    }

    const badRegex = validateFacetConfig({
      version: 1,
      experiences: [
        {
          id: "bad-regex",
          name: "Bad Regex",
          match: { referrer: { regex: "[unclosed" } },
          changes: [{ selector: "h1", text: "x" }],
        },
      ],
    });
    expect(badRegex.ok).toBe(false);

    const emptyOp = validateFacetConfig({
      version: 1,
      experiences: [
        {
          id: "empty-op",
          name: "Empty Op",
          match: { utm_source: {} },
          changes: [{ selector: "h1", text: "x" }],
        },
      ],
    });
    expect(emptyOp.ok).toBe(false);

    const emptyAny = validateFacetConfig({
      version: 1,
      experiences: [
        {
          id: "empty-any",
          name: "Empty Any",
          match: { any: [] },
          changes: [{ selector: "h1", text: "x" }],
        },
      ],
    });
    expect(emptyAny.ok).toBe(false);
  });

  it("rejects out-of-range holdout, invalid version, and invalid YAML syntax", () => {
    const badHoldout = validateFacetConfig({
      version: 1,
      experiences: [
        {
          id: "bad-holdout",
          name: "Bad Holdout",
          holdout: 1.5,
          match: { path: "/" },
          changes: [{ selector: "h1", text: "x" }],
        },
      ],
    });
    expect(badHoldout.ok).toBe(false);

    const badVersion = parseFacetYaml("version: 2\nexperiences: []\n");
    expect(badVersion.ok).toBe(false);

    const badYaml = parseFacetYaml("version: 1\nexperiences:\n  - id: [unclosed\n");
    expect(badYaml.ok).toBe(false);
    if (!badYaml.ok) {
      expect(badYaml.errors[0]?.code).toBe("yaml_syntax_error");
      expect(badYaml.errors[0]?.line).toBeDefined();
    }

    const emptyYaml = parseFacetYaml("");
    expect(emptyYaml.ok).toBe(false);
  });

  it("exports a valid draft 2020-12 JSON Schema", () => {
    const schema = exportFacetJsonSchema();
    expect(schema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema["type"]).toBe("object");
    expect(schema["required"]).toEqual(["version"]);

    const defs = schema["$defs"] as Record<string, Record<string, unknown>>;
    expect(defs["Settings"]).toBeDefined();
    expect(defs["Experience"]).toBeDefined();
    expect(defs["MatchCondition"]).toBeDefined();
    expect(defs["MatchOperator"]).toBeDefined();
    expect(defs["Change"]).toBeDefined();

    const matchCondition = defs["MatchCondition"];
    const patternProps = matchCondition?.["patternProperties"] as Record<string, unknown>;
    expect(Object.keys(patternProps)).toContain("^(query|cookie|header|geo|company)\\..+$");

    const settings = defs["Settings"];
    const settingsProps = settings?.["properties"] as Record<string, Record<string, unknown>>;
    expect(settingsProps["stickyCookieName"]?.["default"]).toBe(DEFAULT_STICKY_COOKIE_NAME);
    const analyticsProps = settingsProps["analytics"]?.["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    const providerItems = analyticsProps["providers"]?.["items"] as Record<string, unknown>;
    expect(providerItems["enum"]).toEqual([...ANALYTICS_PROVIDERS]);

    const expProps = defs["Experience"]?.["properties"] as Record<string, unknown>;
    expect(expProps["originPath"]).toBeDefined();
    expect(expProps["lookup"]).toBeDefined();
    expect(expProps["sticky"]).toBeDefined();
    expect(defs["DataTables"]).toBeDefined();
    expect(defs["ExperienceLookup"]).toBeDefined();
    expect(defs["StickyDuration"]).toBeDefined();
  });

  it("validates v0.2 schema fields (originPath, data, lookup, sticky, stickyCookieName)", () => {
    const valid = parseFacetYaml(`
version: 1
settings:
  stickyCookieName: "__my_sticky"
data:
  accounts:
    stripe:
      name: "Stripe"
      employees: 8000
      enterprise: true
experiences:
  - id: abm-for
    name: "ABM Virtual Page"
    originPath: "/"
    sticky: "7d"
    lookup:
      table: accounts
      key: "{{params.acct}}"
    match:
      path: "/for/:acct"
    changes:
      - selector: "h1"
        text: "Welcome {{data.name}}"
  - id: session-sticky
    name: "Session Sticky"
    sticky: true
    match:
      utm_campaign: "q4"
    changes:
      - selector: "h1"
        text: "Q4"
`);
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(valid.config.settings.stickyCookieName).toBe("__my_sticky");
    expect(valid.config.data?.["accounts"]?.["stripe"]?.["employees"]).toBe(8000);
    expect(valid.config.experiences[0]?.originPath).toBe("/");
    expect(valid.config.experiences[0]?.lookup).toEqual({
      table: "accounts",
      key: "{{params.acct}}",
      required: true,
    });
    expect(valid.config.experiences[0]?.sticky).toBe("7d");
    expect(valid.config.experiences[1]?.sticky).toBe(true);

    // Rejects invalid originPath (missing leading /, protocol-relative //, backslashes, traversal ..)
    for (const badOriginPath of [
      "enterprise",
      "//evil.com",
      "/\\evil",
      "/a\\b",
      "/a\nb",
      "/templates/../admin",
      "/..",
    ]) {
      const res = validateFacetConfig({
        version: 1,
        experiences: [
          {
            id: "bad-origin",
            name: "Bad Origin",
            originPath: badOriginPath,
            match: { path: "/for/:acct" },
            changes: [{ selector: "h1", text: "x" }],
          },
        ],
      });
      expect(res.ok, `Expected failure for originPath=${badOriginPath}`).toBe(false);
    }

    // Rejects invalid sticky durations
    for (const badSticky of ["0m", "-1d", "7w", "always", ""]) {
      const res = validateFacetConfig({
        version: 1,
        experiences: [
          {
            id: "bad-sticky",
            name: "Bad Sticky",
            sticky: badSticky,
            match: { path: "/" },
            changes: [{ selector: "h1", text: "x" }],
          },
        ],
      });
      expect(res.ok, `Expected failure for sticky=${badSticky}`).toBe(false);
    }
  });
});
