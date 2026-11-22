# Facet — Project Instructions (`AGENTS.md`)

## What Facet Is

**Facet** is an open-source (Apache-2.0), zero-flicker edge website personalization and ad message-match engine for B2B growth teams.

- **One-line pitch:** An open-source, zero-flicker alternative to Mutiny. Put a Cloudflare Worker in front of any marketing site (Webflow, WordPress, Ghost, Astro, static HTML) — or use the hydration-safe Next.js adapter — define segments, holdouts, and page swaps in a YAML file in git, and measure real conversion lift with no `$2,000/mo` SaaS bill.
- **Philosophy (sibling to Switchboard):** Config-as-code in git, self-hosted, transparent, minimal dependencies, zero per-seat or per-visitor SaaS tax.

### Product Positioning Discipline
Lead with **100%-match-rate workflows** that work in 60 seconds with zero paid enrichment keys:
1. **Paid ad message-match:** Match `utm_campaign`, `utm_term`, `utm_source`, or referrer to dynamically swap hero headlines, subheads, proof logos, and CTAs without cloning 30 duplicate landing pages.
2. **1:1 ABM links & account pages:** Tailored experiences via clean account URLs or query tokens (e.g. `?acct=stripe` or `/for/stripe`).
3. **Geo, path & returning-visitor rules:** Built-in edge signals (`request.cf`, cookies, path globs).
4. **Optional BYOK enrichment:** Reverse-IP (IPinfo, Clearbit, 6sense, RB2B) or HubSpot lookup via a pluggable adapter interface — never a required dependency for getting started.

---

## Architecture: Two Delivery Modes, One `facet.yaml`

Do not ignore the **React / Next.js hydration trap**: rewriting DOM text via a reverse-proxy `HTMLRewriter` works cleanly on Webflow, WordPress, Ghost, Astro, and static HTML, **but** breaks or gets overwritten on client-hydrated React/Next.js SPAs.

Facet solves this cleanly by powering two delivery modes from the same core engine and `facet.yaml`:

1. **Edge Proxy Mode (Cloudflare Worker + `HTMLRewriter`)**
   - Drop-in reverse proxy for Webflow, WordPress, Ghost, Astro, Framer static pages, or any HTML origin.
   - Uses Cloudflare’s streaming zero-copy `HTMLRewriter` (`lol-html`) to rewrite text, attributes, classes, or HTML slots **before first paint** (zero CLS, zero client-side flicker, zero origin code changes).
2. **Hydration-Safe Next.js / React Mode**
   - Lightweight Next.js Middleware + Server Component `<FacetSlot id="hero-headline">Default</FacetSlot>` helper reading the exact same `facet.yaml` evaluation result via request headers/cookies — zero flicker and zero React hydration mismatches.

---

## Core Design & `facet.yaml` Spec

Every rule lives in a single version-controlled `facet.yaml` validated with Zod (and paired with an exported JSON Schema for editor autocomplete):

```yaml
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
        slot: "fintech-logos" # or explicit `html:`
```

### Core Engine Requirements (`packages/core`)
- **Pure, zero-I/O TypeScript:** Runs identically in Cloudflare Workers, Node.js (CLI), and Next.js Edge Runtime.
- **Deterministic sticky bucketing:** Hash `(visitorId + ":" + experienceId)` (e.g. FNV-1a) into `[0, 1)` to assign `control` vs `variant` deterministically, persisted in a first-party cookie.
- **Precedence & conflict resolution:** Sort matching experiences by `priority` (descending) and support `stopOnMatch` (default `true` per experience) so rules stay predictable.
- **Safe transforms:** `text` escapes HTML by default. Raw `html` replacement must be explicit. Support `text`, `html`, `attrs`, `addClass`, `removeClass`, `remove`, `prepend`, `append`.

---

## Local Developer & Marketer Experience (CLI)

The fastest "aha moment" is testing `facet.yaml` against a real live site in 30 seconds without touching Cloudflare:

- `npx facet validate` — validates `facet.yaml` with line-clear Zod errors and checks selector/rule sanity.
- `npx facet preview --target https://yoursite.com --config ./facet.yaml` — starts a local reverse proxy on `http://localhost:8787` using the same core engine + WASM `HTMLRewriter`, plus a dev-only floating preview bar allowing marketers/engineers to toggle between **Default**, **Control**, and any **Experience** live.
- **Shareable production previews:** Support signed `?__facet_preview=<id>&__facet_sig=<hmac>` links (generated via `npx facet preview-link <id>`) so teams can share live previews in Slack without exposing unpublished ABM variants publicly.

---

## Reliability, Caching & Security Rules (Non-Negotiable)

1. **Always fail open:** If `facet.yaml` fails to load, an enrichment API times out, or an unexpected error occurs, pass through the untouched origin response immediately. Facet must **never** take down or slow down a marketing site.
2. **Strict enrichment timeouts & caching:** Any BYOK enrichment adapter (IP-to-company, HubSpot, custom webhook) must enforce a hard timeout (default `150ms`), run fail-open, and cache results in Cloudflare KV (or in-memory LRU locally) keyed by IP/identifier.
3. **Safe HTTP caching:** Personalized responses must set `Cache-Control: private, no-store` (or appropriate `Vary`) so upstream CDNs never serve one segment’s personalized HTML to another visitor. Unmatched/static assets (`.js`, `.css`, images, fonts) must bypass HTML rewriting completely.
4. **No secret leaks:** Never expose enrichment API keys, internal account lists, or unpublished variant rules to the browser client. Only inject minimal non-sensitive metadata (`experienceId`, `bucket`) for analytics events.
5. **Minimal bundle size:** Keep `packages/core` and `packages/worker` tiny with minimal runtime dependencies so edge cold starts stay near zero.

---

## Explicit v1 Scope & Non-Goals

### Build in v1
- [ ] Workspace setup (TypeScript strict, ESM, Vitest, ESLint/Prettier, Apache-2.0 `LICENSE`)
- [ ] `packages/core`: Zod schema, JSON Schema generator, segment evaluator, deterministic holdout bucketing, transform model, full unit test suite
- [ ] `packages/cli`: `facet init`, `facet validate`, `facet preview --target <url>`, `facet preview-link`
- [ ] `packages/worker`: Cloudflare Worker reverse proxy using `HTMLRewriter`, sticky first-party cookie, bypass for non-HTML assets, analytics event injection (`ga4`, `umami`, `posthog`, `custom`), signed preview mode, pluggable KV-cached enrichment interface + 1 reference adapter (e.g. IPinfo or webhook)
- [ ] `packages/next`: Hydration-safe Next.js Middleware + `<FacetSlot />` helper sharing `packages/core`
- [ ] `examples/` + polished `README.md` with 60-second quickstart, sample `facet.yaml`, and live demo walkthrough

### Explicitly Out of Scope for v1 (Do Not Build Yet)
- No WYSIWYG drag-and-drop visual editor
- No built-in analytics warehouse or statistical significance dashboard (emit events to existing GA4 / Umami / PostHog instead)
- No multi-tenant SaaS authentication, billing, or hosted control plane
- No client-side anti-flicker `opacity: 0` DOM-hiding scripts

---

## Coding Conventions

- **Language:** TypeScript (`strict: true`, no `any`, explicit return types on public exports).
- **Runtime compatibility:** `packages/core` must use only Web Standard APIs (`URL`, `Headers`, `Request`, `Response`, `crypto.subtle`) — no Node-only `fs`/`path` imports inside `core` or `worker`.
- **Testing:** Every matcher operator, bucketing edge case, cache-header behavior, fail-open timeout, and HTML transform must have Vitest coverage.
- **Commits & Docs:** Keep commits small and scoped by milestone. Update `README.md` and example `facet.yaml` whenever the schema changes.
