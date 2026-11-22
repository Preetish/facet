import { describe, expect, it } from "vitest";
import {
  PERSONALIZED_CACHE_CONTROL,
  assignBucket,
  evaluate,
  parseFacetYaml,
  type FacetConfig,
  type RequestContext,
} from "../src/index.js";

function mustParse(yaml: string): FacetConfig {
  const result = parseFacetYaml(yaml);
  if (!result.ok) {
    throw new Error(`Unexpected parse failure: ${JSON.stringify(result.errors)}`);
  }
  return result.config;
}

function makeContext(overrides?: Partial<RequestContext>): RequestContext {
  return {
    url: "https://example.com/",
    host: "example.com",
    path: "/",
    query: {},
    cookies: {},
    headers: {},
    returning: false,
    geo: {},
    company: {},
    ...overrides,
  };
}

function findVisitorForBucket(
  experienceId: string,
  holdout: number,
  desired: "variant" | "control",
): string {
  for (let i = 0; i < 10000; i++) {
    const vid = `test-visitor-${i}`;
    if (assignBucket(vid, experienceId, holdout) === desired) {
      return vid;
    }
  }
  throw new Error(`Could not find visitor for bucket=${desired}`);
}

describe("evaluate", () => {
  it("sorts enabled experiences by priority desc and preserves definition order on ties", () => {
    const config = mustParse(`
version: 1
experiences:
  - id: low-prio
    name: "Low"
    priority: 1
    match: { path: "/" }
    changes:
      - selector: "h1"
        text: "Low"
  - id: disabled-highest
    name: "Disabled"
    enabled: false
    priority: 100
    match: { path: "/" }
    changes:
      - selector: "h1"
        text: "Disabled"
  - id: tie-first
    name: "Tie First"
    priority: 10
    match: { path: "/" }
    changes:
      - selector: "h1"
        text: "Tie First"
  - id: tie-second
    name: "Tie Second"
    priority: 10
    match: { path: "/" }
    changes:
      - selector: "h1"
        text: "Tie Second"
`);

    const result = evaluate(config, makeContext(), { visitorId: "v1" });
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]?.experienceId).toBe("tie-first");
    expect(result.activeChanges).toEqual([
      { experienceId: "tie-first", selector: "h1", text: "Tie First" },
    ]);
    expect(result.personalized).toBe(true);
    expect(result.cacheControl).toBe(PERSONALIZED_CACHE_CONTROL);
  });

  it("supports stopOnMatch: false to stack multiple experiences and resolves slots/classes", () => {
    const config = mustParse(`
version: 1
settings:
  slots:
    fintech-logos: "<div>Stripe Plaid</div>"
experiences:
  - id: banner
    name: "Banner"
    priority: 20
    stopOnMatch: false
    match: { path: "/" }
    changes:
      - selector: "#banner"
        addClass: "visible banner-top"
        removeClass: ["hidden"]
  - id: logos
    name: "Logos"
    priority: 10
    stopOnMatch: true
    match: { path: "/" }
    changes:
      - selector: "#logos"
        slot: "fintech-logos"
  - id: skipped-after-stop
    name: "Skipped"
    priority: 5
    match: { path: "/" }
    changes:
      - selector: "h1"
        text: "Should not run"
`);

    const result = evaluate(config, makeContext(), { visitorId: "v1" });
    expect(result.matched.map((m) => m.experienceId)).toEqual(["banner", "logos"]);
    expect(result.activeChanges).toEqual([
      {
        experienceId: "banner",
        selector: "#banner",
        addClass: ["visible", "banner-top"],
        removeClass: ["hidden"],
      },
      {
        experienceId: "logos",
        selector: "#logos",
        slot: "fintech-logos",
        html: "<div>Stripe Plaid</div>",
      },
    ]);
  });

  it("preserves slot name on ResolvedChange when resolved externally (not in settings.slots)", () => {
    const config = mustParse(`
version: 1
experiences:
  - id: next-slot-exp
    name: "Next Slot Exp"
    match: { path: "/" }
    changes:
      - selector: "#logo-strip"
        slot: "fintech-logos"
`);

    const result = evaluate(config, makeContext(), { visitorId: "v1" });
    expect(result.activeChanges).toEqual([
      {
        experienceId: "next-slot-exp",
        selector: "#logo-strip",
        slot: "fintech-logos",
      },
    ]);
  });

  it("applies changes ONLY for variant, never control, and honors stopOnMatch for control", () => {
    const config = mustParse(`
version: 1
experiences:
  - id: exp-holdout
    name: "Holdout Exp"
    priority: 10
    holdout: 0.5
    stopOnMatch: true
    match: { path: "/" }
    changes:
      - selector: "h1"
        text: "Variant Headline"
  - id: fallback-exp
    name: "Fallback"
    priority: 1
    match: { path: "/" }
    changes:
      - selector: "h1"
        text: "Fallback Headline"
`);

    const controlVisitor = findVisitorForBucket("exp-holdout", 0.5, "control");
    const controlResult = evaluate(config, makeContext(), { visitorId: controlVisitor });
    expect(controlResult.matched).toHaveLength(1);
    expect(controlResult.matched[0]?.experienceId).toBe("exp-holdout");
    expect(controlResult.matched[0]?.bucket).toBe("control");
    expect(controlResult.matched[0]?.applied).toBe(false);
    expect(controlResult.activeChanges).toEqual([]);
    expect(controlResult.personalized).toBe(false);
    expect(controlResult.cacheControl).toBe(PERSONALIZED_CACHE_CONTROL);

    const variantVisitor = findVisitorForBucket("exp-holdout", 0.5, "variant");
    const variantResult = evaluate(config, makeContext(), { visitorId: variantVisitor });
    expect(variantResult.matched).toHaveLength(1);
    expect(variantResult.matched[0]?.bucket).toBe("variant");
    expect(variantResult.matched[0]?.applied).toBe(true);
    expect(variantResult.activeChanges).toHaveLength(1);
    expect(variantResult.personalized).toBe(true);
  });

  it("returns null cacheControl and generates a new visitorId when unmatched and no cookie", () => {
    const config = mustParse(`
version: 1
experiences:
  - id: pricing-only
    name: "Pricing"
    match: { path: "/pricing" }
    changes:
      - selector: "h1"
        text: "Pricing"
`);

    const result = evaluate(config, makeContext({ path: "/about" }), {
      generateVisitorId: () => "generated-vid-1",
    });
    expect(result.visitorId).toBe("generated-vid-1");
    expect(result.isNewVisitor).toBe(true);
    expect(result.matched).toEqual([]);
    expect(result.activeChanges).toEqual([]);
    expect(result.personalized).toBe(false);
    expect(result.previewMode).toBe(false);
    expect(result.cacheControl).toBeNull();
  });

  it("reads visitorId from configured cookieName when present", () => {
    const config = mustParse(`
version: 1
settings:
  cookieName: "custom_vid"
experiences: []
`);
    const result = evaluate(config, makeContext({ cookies: { custom_vid: "existing-99" } }));
    expect(result.visitorId).toBe("existing-99");
    expect(result.isNewVisitor).toBe(false);
  });

  it("handles preview mode for variant, control, default, disabled, and unknown experiences", () => {
    const config = mustParse(`
version: 1
experiences:
  - id: draft-abm
    name: "Draft ABM"
    enabled: false
    holdout: 1
    match: { utm_campaign: "never-matches" }
    changes:
      - selector: "h1"
        text: "Draft ABM Headline"
`);

    const variantPreview = evaluate(config, makeContext(), {
      visitorId: "v1",
      previewExperienceId: "draft-abm",
    });
    expect(variantPreview.previewMode).toBe(true);
    expect(variantPreview.personalized).toBe(true);
    expect(variantPreview.matched[0]?.bucket).toBe("variant");
    expect(variantPreview.matched[0]?.preview).toBe(true);
    expect(variantPreview.activeChanges[0]?.text).toBe("Draft ABM Headline");
    expect(variantPreview.cacheControl).toBe(PERSONALIZED_CACHE_CONTROL);

    const controlPreview = evaluate(config, makeContext(), {
      visitorId: "v1",
      previewExperienceId: "draft-abm",
      previewBucket: "control",
    });
    expect(controlPreview.previewMode).toBe(true);
    expect(controlPreview.personalized).toBe(false);
    expect(controlPreview.matched[0]?.bucket).toBe("control");
    expect(controlPreview.matched[0]?.applied).toBe(false);
    expect(controlPreview.activeChanges).toEqual([]);

    const defaultPreview = evaluate(config, makeContext(), {
      visitorId: "v1",
      previewExperienceId: "draft-abm",
      previewBucket: "default",
    });
    expect(defaultPreview.previewMode).toBe(true);
    expect(defaultPreview.matched).toEqual([]);
    expect(defaultPreview.activeChanges).toEqual([]);
    expect(defaultPreview.personalized).toBe(false);

    const unknownPreview = evaluate(config, makeContext(), {
      visitorId: "v1",
      previewExperienceId: "does-not-exist",
    });
    expect(unknownPreview.previewMode).toBe(true);
    expect(unknownPreview.matched).toEqual([]);
    expect(unknownPreview.activeChanges).toEqual([]);
  });
});
