import { describe, expect, it } from "vitest";
import { evaluate, parseFacetYaml, type ResolvedChange } from "@facet/core";
import {
  FACET_STATE_HEADER,
  MAX_FACET_STATE_HEADER_BYTES,
  createEmptyFacetState,
  createFacetStateFromEvaluation,
  deserializeFacetState,
  readFacetState,
  resolveSlotChange,
  serializeFacetState,
  type FacetRequestState,
} from "../src/index.js";

describe("@facet/next wire state", () => {
  it("roundtrips full state including UTF-8 and emoji characters", () => {
    const state: FacetRequestState = {
      visitorId: "vis_🚀_日本語_123",
      matched: [
        { experienceId: "fintech-abm", bucket: "variant" },
        { experienceId: "banner-test", bucket: "control" },
      ],
      changes: [
        {
          experienceId: "fintech-abm",
          selector: "#hero-headline",
          text: "Infrastructure for fintech teams — café 🚀 東京",
          attrs: { "data-segment": "fintech", href: "/demo?lang=日本語", disabled: null },
          addClass: ["hero-fintech", "highlight"],
          removeClass: ["hero-default"],
          prepend: "✨ ",
          append: " →",
        },
      ],
      personalized: true,
      previewMode: false,
      analyticsProviders: ["ga4", "posthog"],
    };

    const encoded = serializeFacetState(state);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);

    const decoded = deserializeFacetState(encoded);
    expect(decoded).toEqual(state);
  });

  it("never leaks raw rules, experience names, company data, or secrets into the serialized header", () => {
    const parsed = parseFacetYaml(`
version: 1
settings:
  analytics:
    providers: ["ga4", "umami"]
experiences:
  - id: secret-abm
    name: "CONFIDENTIAL_ENTERPRISE_TARGET_LIST"
    match:
      company.industry: ["Financial Services"]
    changes:
      - selector: "#hero"
        text: "Welcome enterprise team"
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = evaluate(parsed.config, {
      url: "https://example.com/",
      host: "example.com",
      path: "/",
      query: {},
      cookies: {},
      headers: {},
      returning: false,
      geo: { country: "US" },
      company: {
        name: "Stripe Secret Corp",
        industry: "Financial Services",
        revenue: "$10B",
      },
    });

    const state = createFacetStateFromEvaluation(
      result,
      parsed.config.settings.analytics.providers,
    );

    // Simulate someone structurally attaching extra secret fields to the state object
    const taintedState = {
      ...state,
      enrichmentApiKey: "sk_live_super_secret",
      rawConfig: parsed.config,
      company: { name: "Stripe Secret Corp" },
      matched: state.matched.map((m) => ({
        ...m,
        name: "CONFIDENTIAL_ENTERPRISE_TARGET_LIST",
      })),
    } as unknown as FacetRequestState;

    const encoded = serializeFacetState(taintedState);
    const decodedJson = new TextDecoder().decode(
      Uint8Array.from(
        atob(
          encoded.replace(/-/g, "+").replace(/_/g, "/") +
            "=".repeat((4 - (encoded.length % 4)) % 4),
        ),
        (c) => c.charCodeAt(0),
      ),
    );

    expect(decodedJson).not.toContain("CONFIDENTIAL_ENTERPRISE_TARGET_LIST");
    expect(decodedJson).not.toContain("Stripe Secret Corp");
    expect(decodedJson).not.toContain("Financial Services");
    expect(decodedJson).not.toContain("sk_live_super_secret");
    expect(decodedJson).not.toContain("rawConfig");

    const parsedState = deserializeFacetState(encoded);
    expect(parsedState.matched).toEqual([{ experienceId: "secret-abm", bucket: "variant" }]);
  });

  it("fails open to empty state for missing, corrupted, invalid-schema, or oversized headers", () => {
    const empty = createEmptyFacetState();

    expect(deserializeFacetState(null)).toEqual(empty);
    expect(deserializeFacetState(undefined)).toEqual(empty);
    expect(deserializeFacetState("")).toEqual(empty);
    expect(deserializeFacetState("   ")).toEqual(empty);
    expect(deserializeFacetState("not!valid@base64url")).toEqual(empty);
    expect(deserializeFacetState("AAAA")).toEqual(empty); // valid base64, invalid JSON

    // Valid base64url with invalid UTF-8 byte sequence (0xff, 0xfe)
    expect(deserializeFacetState("__4")).toEqual(empty);

    // Valid JSON but wrong structure
    const wrongShape = btoa(JSON.stringify({ visitorId: 123, matched: "nope" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(deserializeFacetState(wrongShape)).toEqual(empty);

    // Invalid bucket value
    const invalidBucket = btoa(
      JSON.stringify({
        visitorId: "v1",
        matched: [{ experienceId: "exp1", bucket: "admin" }],
        changes: [],
        personalized: false,
        previewMode: false,
        analyticsProviders: [],
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(deserializeFacetState(invalidBucket)).toEqual(empty);

    // Invalid analytics provider
    const invalidProvider = btoa(
      JSON.stringify({
        visitorId: "v1",
        matched: [],
        changes: [],
        personalized: false,
        previewMode: false,
        analyticsProviders: ["evil-tracker"],
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(deserializeFacetState(invalidProvider)).toEqual(empty);

    // Oversized header
    const oversized = "a".repeat(MAX_FACET_STATE_HEADER_BYTES + 1);
    expect(deserializeFacetState(oversized)).toEqual(empty);
  });

  it("strips prototype-polluting keys from change attrs on deserialize", () => {
    const rawJson =
      '{"visitorId":"v1","matched":[],"changes":[{"experienceId":"e1","selector":"#h1","attrs":{"__proto__":"bad","constructor":"bad","href":"/ok"}}],"personalized":true,"previewMode":false,"analyticsProviders":[]}';
    const encoded = btoa(rawJson).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const decoded = deserializeFacetState(encoded);
    expect(decoded.changes).toHaveLength(1);
    expect(decoded.changes[0]?.attrs).toEqual({ href: "/ok" });
    expect(Object.prototype.hasOwnProperty.call(decoded.changes[0]?.attrs, "__proto__")).toBe(
      false,
    );
  });

  it("resolves slot changes by slot name, bare id, #id, and data-facet-slot selectors", () => {
    const changes: ResolvedChange[] = [
      { experienceId: "e1", selector: "#logo-strip", slot: "fintech-logos", html: "<img/>" },
      { experienceId: "e1", selector: "bare-slot", text: "Bare" },
      { experienceId: "e1", selector: "#hero-title", text: "Hash" },
      { experienceId: "e1", selector: '[data-facet-slot="cta-primary"]', text: "Double" },
      { experienceId: "e1", selector: "[data-facet-slot='cta-secondary']", text: "Single" },
    ];

    const state: FacetRequestState = {
      ...createEmptyFacetState(),
      changes,
      personalized: true,
    };

    expect(resolveSlotChange(state, "fintech-logos")?.html).toBe("<img/>");
    expect(resolveSlotChange(state, "logo-strip")?.slot).toBe("fintech-logos");
    expect(resolveSlotChange(state, "bare-slot")?.text).toBe("Bare");
    expect(resolveSlotChange(state, "hero-title")?.text).toBe("Hash");
    expect(resolveSlotChange(state, "cta-primary")?.text).toBe("Double");
    expect(resolveSlotChange(state, "cta-secondary")?.text).toBe("Single");
    expect(resolveSlotChange(state, "nonexistent")).toBeUndefined();
    expect(resolveSlotChange(state, "")).toBeUndefined();
  });

  it("readFacetState reads from Headers and fails open on null or throwing headers", () => {
    const state: FacetRequestState = {
      visitorId: "vis-42",
      matched: [{ experienceId: "abm", bucket: "variant" }],
      changes: [{ experienceId: "abm", selector: "#hero", text: "Hi" }],
      personalized: true,
      previewMode: false,
      analyticsProviders: ["ga4"],
    };

    const headers = new Headers();
    headers.set(FACET_STATE_HEADER, serializeFacetState(state));
    expect(readFacetState(headers)).toEqual(state);

    expect(readFacetState(null)).toEqual(createEmptyFacetState());
    expect(readFacetState(undefined)).toEqual(createEmptyFacetState());
    expect(
      readFacetState({
        get() {
          throw new Error("boom");
        },
      }),
    ).toEqual(createEmptyFacetState());
  });
});
