export const DEFAULT_STARTER_YAML = `version: 1

settings:
  cookieName: "__facet_vid"
  stickyCookieName: "__facet_sticky"
  previewParam: "__facet_preview"
  previewSigParam: "__facet_sig"
  analytics:
    providers: ["ga4", "posthog"]
  slots:
    fintech-logos: >-
      <div class="logo-row" aria-label="Illustrative example partner badges">
        <span class="logo-pill">SOC 2 Type II</span>
        <span class="logo-pill">PCI-DSS Level 1</span>
        <span class="logo-pill">99.995% SLA</span>
      </div>

data:
  accounts:
    meridian:
      name: "Meridian Cloud"
      team: "infrastructure"
      headline: "Zero-latency edge routing built for Meridian Cloud"
      subhead: "See how edge personalization pairs with global APIs without page flicker."
      cta: "Open Meridian Cloud's walkthrough"
    alder:
      name: "Alder Data"
      team: "platform"
      headline: "Resilient data delivery tailored for Alder Data"
      subhead: "Keep high-throughput pipelines fast and compliant across every region."
      cta: "Explore Alder Data's benchmark"

experiences:
  - id: abm-account-page
    name: "1:1 ABM Virtual Account Page"
    priority: 100
    holdout: 0
    originPath: "/"
    sticky: "7d"
    match:
      path: "/for/:acct"
    lookup:
      table: "accounts"
      key: "{{params.acct}}"
      required: true
    changes:
      - selector: "h1"
        text: '{{data.headline | default("Edge infrastructure built for your team")}}'
      - selector: "[data-facet-slot='hero-subhead']"
        text: '{{data.subhead | default("Match every landing page to your campaign before first paint.")}}'
      - selector: "[data-cta='hero']"
        text: '{{data.cta | default("Book a tailored demo")}}'
        attrs:
          href: "/demo?acct={{params.acct}}"

  - id: fintech-paid-search
    name: "Fintech Paid Search"
    priority: 50
    holdout: 0.2
    sticky: "7d"
    match:
      path: "/"
      utm_campaign: ["fintech-q4", "pci-infra"]
    changes:
      - selector: "h1"
        text: "Compliance-ready infrastructure for fintech teams"
      - selector: "[data-facet-slot='hero-subhead']"
        text: "Launch SOC 2 and PCI-ready workloads in days with deterministic edge failover."
      - selector: "[data-cta='hero']"
        text: "See the fintech demo"
        attrs:
          href: "/demo?segment=fintech"
      - selector: "#logo-strip"
        slot: "fintech-logos"
`;
