import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server.js";
import {
  FACET_STATE_HEADER,
  FacetAnalytics,
  FacetSlot,
  createEmptyFacetState,
  createFacetMiddleware,
  readFacetState,
  type FacetRequestState,
} from "../src/index.js";

describe("@facet/next components (<FacetSlot /> & <FacetAnalytics />)", () => {
  it("renders default children unchanged when no active change matches", () => {
    const state = createEmptyFacetState();
    const html = renderToStaticMarkup(
      <FacetSlot id="hero-headline" state={state} as="h1" className="title">
        Default headline
      </FacetSlot>,
    );

    expect(html).toBe('<h1 class="title" data-facet-slot="hero-headline">Default headline</h1>');
  });

  it("renders default children unchanged when visitor is in control holdout", () => {
    const controlState: FacetRequestState = {
      visitorId: "vis-control",
      matched: [{ experienceId: "fintech-abm", bucket: "control" }],
      changes: [],
      personalized: false,
      previewMode: false,
      analyticsProviders: ["ga4"],
    };

    const html = renderToStaticMarkup(
      <FacetSlot id="hero-headline" state={controlState} as="h1">
        Default headline
      </FacetSlot>,
    );

    expect(html).toBe('<h1 data-facet-slot="hero-headline">Default headline</h1>');
  });

  it("replaces content via text safely (auto-escaping HTML)", () => {
    const state: FacetRequestState = {
      ...createEmptyFacetState(),
      personalized: true,
      changes: [
        {
          experienceId: "xss-test",
          selector: "#hero-headline",
          text: '<script>alert("xss")</script> & <b>safe</b>',
        },
      ],
    };

    const html = renderToStaticMarkup(
      <FacetSlot id="hero-headline" state={state} as="h1">
        Default
      </FacetSlot>,
    );

    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(html).toContain("&amp; &lt;b&gt;safe&lt;/b&gt;");
    expect(html).not.toContain("<script>");
  });

  it("replaces content via explicit html and composes escaped prepend/append cleanly", () => {
    const state: FacetRequestState = {
      ...createEmptyFacetState(),
      personalized: true,
      changes: [
        {
          experienceId: "logos",
          selector: "#logo-strip",
          slot: "fintech-logos",
          html: '<span class="logo">Stripe</span><span class="logo">Plaid</span>',
          prepend: "Trusted by <top> ",
          append: " & more",
        },
      ],
    };

    const html = renderToStaticMarkup(
      <FacetSlot id="fintech-logos" state={state} as="section">
        <span>Default Logo</span>
      </FacetSlot>,
    );

    expect(html).toBe(
      '<section data-facet-slot="fintech-logos">Trusted by &lt;top&gt; <span class="logo">Stripe</span><span class="logo">Plaid</span> &amp; more</section>',
    );
  });

  it("matches all supported slot selector forms", () => {
    const state: FacetRequestState = {
      ...createEmptyFacetState(),
      personalized: true,
      changes: [
        { experienceId: "e1", selector: "bare-id", text: "From bare" },
        { experienceId: "e1", selector: "#hash-id", text: "From hash" },
        { experienceId: "e1", selector: '[data-facet-slot="dq-id"]', text: "From double quotes" },
        { experienceId: "e1", selector: "[data-facet-slot='sq-id']", text: "From single quotes" },
        { experienceId: "e1", selector: ".ignored", slot: "named-slot", text: "From slot" },
      ],
    };

    expect(
      renderToStaticMarkup(
        <FacetSlot id="bare-id" state={state} as="p">
          Default
        </FacetSlot>,
      ),
    ).toContain("From bare");
    expect(
      renderToStaticMarkup(
        <FacetSlot id="hash-id" state={state} as="p">
          Default
        </FacetSlot>,
      ),
    ).toContain("From hash");
    expect(
      renderToStaticMarkup(
        <FacetSlot id="dq-id" state={state} as="p">
          Default
        </FacetSlot>,
      ),
    ).toContain("From double quotes");
    expect(
      renderToStaticMarkup(
        <FacetSlot id="sq-id" state={state} as="p">
          Default
        </FacetSlot>,
      ),
    ).toContain("From single quotes");
    expect(
      renderToStaticMarkup(
        <FacetSlot id="named-slot" state={state} as="p">
          Default
        </FacetSlot>,
      ),
    ).toContain("From slot");
  });

  it("applies attrs (mapping class->className, removing null attrs, parsing inline style, ignoring dangerous attrs) and addClass/removeClass", () => {
    const state: FacetRequestState = {
      ...createEmptyFacetState(),
      personalized: true,
      changes: [
        {
          experienceId: "cta",
          selector: "#hero-cta",
          text: "Book fintech demo",
          attrs: {
            href: "/demo?segment=fintech",
            "data-track": "fintech-cta",
            title: null,
            style: "background-color: navy; color: white",
            onclick: "alert(1)",
          },
          addClass: ["btn-fintech", "btn-lg"],
          removeClass: ["btn-default"],
        },
      ],
    };

    const html = renderToStaticMarkup(
      <FacetSlot
        id="hero-cta"
        state={state}
        as="a"
        href="/demo"
        title="Default tooltip"
        className="btn btn-default"
      >
        Book demo
      </FacetSlot>,
    );

    expect(html).toContain('href="/demo?segment=fintech"');
    expect(html).toContain('data-track="fintech-cta"');
    expect(html).not.toContain("title=");
    expect(html).not.toContain("onclick");
    expect(html).toContain('class="btn btn-fintech btn-lg"');
    expect(html).toContain("background-color:navy");
    expect(html).toContain("Book fintech demo");
  });

  it("maps attrs.class to className and removes className when all classes are removed", () => {
    const state: FacetRequestState = {
      ...createEmptyFacetState(),
      personalized: true,
      changes: [
        {
          experienceId: "cls",
          selector: "#box",
          attrs: { class: "base temp" },
          removeClass: ["base", "temp"],
        },
      ],
    };

    const html = renderToStaticMarkup(
      <FacetSlot id="box" state={state} as="div" className="old">
        Content
      </FacetSlot>,
    );

    expect(html).toBe('<div data-facet-slot="box">Content</div>');
  });

  it("returns null when remove: true", () => {
    const state: FacetRequestState = {
      ...createEmptyFacetState(),
      personalized: true,
      changes: [
        {
          experienceId: "hide-promo",
          selector: "#promo-banner",
          remove: true,
        },
      ],
    };

    const html = renderToStaticMarkup(
      <FacetSlot id="promo-banner" state={state} as="div">
        Old Promo
      </FacetSlot>,
    );

    expect(html).toBe("");
  });

  it("prepends and appends text around default children when neither text nor html replaces body", () => {
    const state: FacetRequestState = {
      ...createEmptyFacetState(),
      personalized: true,
      changes: [
        {
          experienceId: "wrap",
          selector: "#badge",
          prepend: "[NEW] ",
          append: " (Enterprise)",
        },
      ],
    };

    const html = renderToStaticMarkup(
      <FacetSlot id="badge" state={state} as="span">
        <strong>SOC 2 Type II</strong>
      </FacetSlot>,
    );

    expect(html).toBe(
      '<span data-facet-slot="badge">[NEW] <strong>SOC 2 Type II</strong> (Enterprise)</span>',
    );
  });

  it("renders void elements cleanly when updating attrs without children", () => {
    const state: FacetRequestState = {
      ...createEmptyFacetState(),
      personalized: true,
      changes: [
        {
          experienceId: "img-swap",
          selector: "#hero-img",
          attrs: { src: "/fintech.png", alt: "Fintech dashboard" },
        },
      ],
    };

    const html = renderToStaticMarkup(
      <FacetSlot id="hero-img" state={state} as="img" src="/default.png" alt="Default" />,
    );

    expect(html).toContain(
      '<img src="/fintech.png" alt="Fintech dashboard" data-facet-slot="hero-img"/>',
    );
    expect(html).not.toContain("/default.png");
  });

  it("<FacetAnalytics /> renders minimal { experienceId, bucket } script with nonce and respects previewMode", () => {
    // Empty state -> null
    expect(renderToStaticMarkup(<FacetAnalytics state={createEmptyFacetState()} />)).toBe("");

    // Active exposure (including control holdout)
    const state: FacetRequestState = {
      visitorId: "vis-123",
      matched: [
        { experienceId: "fintech-abm", bucket: "variant" },
        { experienceId: "pricing-holdout", bucket: "control" },
      ],
      changes: [],
      personalized: true,
      previewMode: false,
      analyticsProviders: ["ga4", "umami"],
    };

    const html = renderToStaticMarkup(<FacetAnalytics state={state} nonce="nonce-abc" />);
    expect(html).toContain('<script data-facet-analytics="" nonce="nonce-abc">');
    expect(html).toContain('{"experienceId":"fintech-abm","bucket":"variant"}');
    expect(html).toContain('{"experienceId":"pricing-holdout","bucket":"control"}');
    expect(html).toContain('window.gtag("event","facet_exposure"');
    expect(html).toContain('window.umami.track("facet_exposure"');
    expect(html).not.toContain("vis-123");

    // Preview mode suppresses analytics by default, unless includePreview is true
    const previewState: FacetRequestState = { ...state, previewMode: true };
    expect(renderToStaticMarkup(<FacetAnalytics state={previewState} />)).toBe("");
    expect(
      renderToStaticMarkup(
        <FacetAnalytics state={previewState} includePreview providers={["custom"]} />,
      ),
    ).toContain('new CustomEvent("facet:exposure"');

    // Escapes </script> sequences in experienceId to prevent script-tag breakout XSS
    const xssState: FacetRequestState = {
      ...state,
      matched: [{ experienceId: "</script><script>alert(1)</script>", bucket: "variant" }],
    };
    const xssHtml = renderToStaticMarkup(<FacetAnalytics state={xssState} />);
    expect(xssHtml).toContain("\\u003c/script\\u003e");
    expect(xssHtml.match(/<\/script>/g)).toHaveLength(1);
  });

  it("integrates end-to-end from createFacetMiddleware to readFacetState, <FacetSlot />, and <FacetAnalytics />", async () => {
    const middleware = createFacetMiddleware({
      config: `
version: 1
settings:
  analytics:
    providers: ["posthog"]
experiences:
  - id: abm-stripe
    name: "Stripe 1:1 ABM"
    match:
      path: "/"
      query.acct: ["stripe"]
    changes:
      - selector: "#hero-headline"
        text: "Built for Stripe's engineering velocity"
      - selector: "[data-facet-slot='hero-cta']"
        text: "Talk to your Stripe rep"
        attrs:
          href: "/contact?acct=stripe"
`,
      generateVisitorId: () => "vis_e2e_1",
    });

    const res = await middleware(new NextRequest("https://example.com/?acct=stripe"));
    const forwardedHeaderValue = res.headers.get(`x-middleware-request-${FACET_STATE_HEADER}`);

    // Simulate Next.js Server Component receiving forwarded headers
    const serverHeaders = new Headers();
    if (forwardedHeaderValue) {
      serverHeaders.set(FACET_STATE_HEADER, forwardedHeaderValue);
    }
    const state = readFacetState(serverHeaders);

    const pageMarkup = renderToStaticMarkup(
      <main>
        <FacetSlot id="hero-headline" state={state} as="h1">
          Generic SaaS Headline
        </FacetSlot>
        <FacetSlot id="hero-cta" state={state} as="a" href="/contact">
          Contact sales
        </FacetSlot>
        <FacetAnalytics state={state} />
      </main>,
    );

    expect(pageMarkup).toContain("Built for Stripe&#x27;s engineering velocity");
    expect(pageMarkup).toContain('href="/contact?acct=stripe"');
    expect(pageMarkup).toContain("Talk to your Stripe rep");
    expect(pageMarkup).toContain('{"experienceId":"abm-stripe","bucket":"variant"}');
    expect(pageMarkup).toContain('window.posthog.capture("facet_exposure"');
  });
});
