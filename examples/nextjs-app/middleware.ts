import { createFacetMiddleware } from "@facet/next";

/**
 * Use the exact same `facet.yaml` format as the Cloudflare Worker.
 * In a real Next.js app, you can bundle `facet.yaml` as a raw text module or
 * pass a validated `FacetConfig` object imported at build time.
 */
const FACET_YAML = `
version: 1

settings:
  cookieName: "__facet_vid"
  previewParam: "__facet_preview"
  previewSigParam: "__facet_sig"
  analytics:
    providers: ["ga4", "umami", "posthog"]
  slots:
    fintech-logos: '<div class="logo-row"><span>Ramp</span><span>Mercury</span><span>Plaid</span></div>'

experiences:
  - id: stripe-abm
    name: "Stripe 1:1 ABM"
    priority: 100
    holdout: 0
    match:
      any:
        - query.acct: ["stripe"]
        - path: "/for/stripe"
    changes:
      - selector: "[data-facet-slot='hero-eyebrow']"
        text: "Prepared for the Stripe infrastructure team"
      - selector: "[data-facet-slot='hero-headline']"
        text: "Zero-latency edge routing built for Stripe's global scale"
      - selector: "[data-facet-slot='hero-subhead']"
        text: "Cut p99 checkout latency by 38% with deterministic failover."
      - selector: "[data-facet-slot='hero-cta']"
        text: "Open Stripe's architecture walkthrough"
        attrs:
          href: "/demo?acct=stripe"

  - id: fintech-abm
    name: "Fintech Paid Search"
    priority: 50
    holdout: 0.2
    match:
      path: "/"
      any:
        - utm_campaign: ["fintech-q4", "abm-banking"]
        - utm_term:
            contains: "fintech"
    changes:
      - selector: "[data-facet-slot='hero-eyebrow']"
        text: "Built for regulated fintech teams"
      - selector: "[data-facet-slot='hero-headline']"
        text: "Compliance-ready infrastructure for fintech teams"
      - selector: "[data-facet-slot='hero-subhead']"
        text: "Launch SOC 2 and PCI-ready ledger workloads in days, not quarters."
      - selector: "[data-facet-slot='hero-cta']"
        text: "See the fintech demo"
        attrs:
          href: "/demo?segment=fintech"
      - selector: "#logo-strip"
        slot: "fintech-logos"
`;

const previewSecret = process.env.FACET_PREVIEW_SECRET;

export const middleware = createFacetMiddleware({
  config: FACET_YAML,
  ...(previewSecret !== undefined && previewSecret.length > 0 ? { previewSecret } : {}),
  onError(error) {
    // Middleware always fails open so your Next.js routes keep rendering normally.
    console.error("[facet:next]", error);
  },
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
