# Facet

**Open-source website personalization with zero flicker. Match headlines, proof, and CTAs to every campaign.**

Live site (dogfooding `@facet/next`): **[facet.preetish.me](https://facet.preetish.me)** ([try 1:1 Stripe preview](https://facet.preetish.me/?acct=stripe))

Facet is a self-hosted, Apache-2.0 alternative to Mutiny. Put a Cloudflare Worker in front of any marketing site (Webflow, WordPress, Ghost, Astro, Framer static pages, or plain HTML) — or drop in the hydration-safe Next.js adapter — define segments, deterministic holdouts, and DOM swaps in a single `facet.yaml` file in git, and measure real conversion lift without a `$2,000/mo` SaaS bill or client-side flicker.

---

## Why Facet?

Most personalization tools inject a blocking JavaScript tag that hides the page (`opacity: 0`) while fetching rules, hurting Core Web Vitals and flashing default copy before swapping headlines. Facet evaluates rules **at the edge before first paint** and starts with **100%-match-rate workflows** that work in 60 seconds with zero paid enrichment keys:

1. **Paid ad message-match:** Match `utm_campaign`, `utm_term`, `utm_source`, or `referrer` to swap hero headlines, subheads, proof logos, and CTAs dynamically without cloning 30 duplicate landing pages.
2. **1:1 ABM links & account pages:** Ship tailored account pages via clean URLs or query tokens (e.g. `?acct=stripe` or `/for/stripe`).
3. **Geo, path & returning-visitor rules:** Target built-in edge signals (`geo.country`, `geo.continent`, `returning`, cookies, headers, path globs).
4. **Optional BYOK enrichment:** Plug in IPinfo, custom webhooks, HubSpot, Clearbit, 6sense, or RB2B behind a strict fail-open `150ms` timeout and KV cache — never required to get started.

---

## Architecture: Two Delivery Modes, One `facet.yaml`

Rewriting HTML via a reverse-proxy `HTMLRewriter` works cleanly on Webflow, WordPress, Ghost, Astro, and static HTML — **but** client-hydrated React/Next.js apps overwrite proxy-mutated DOM nodes during hydration. Facet solves this by powering two delivery modes from the exact same `@facet/core` engine and `facet.yaml`:

```text
                           ┌──────────────────────────────────────────────────┐
                           │        facet.yaml  +  @facet/core engine         │
                           │  Zod schema · Matchers · FNV-1a holdouts · HMAC  │
                           └───────────────┬──────────────────┬───────────────┘
                                           │                  │
              ┌────────────────────────────▼────┐        ┌────▼────────────────────────────┐
              │   Mode 1: Edge Proxy (@facet/   │        │  Mode 2: Next.js (@facet/next)  │
              │            worker)              │        │                                 │
              │  Cloudflare Worker + streaming  │        │  Next.js Middleware evaluates   │
              │  HTMLRewriter before first      │        │  once & passes x-facet-state to │
              │  paint. Zero origin changes.    │        │  <FacetSlot /> Server Components│
              └─────────────────────────────────┘        └─────────────────────────────────┘
              Webflow · WordPress · Ghost · Astro        Next.js App Router · React SSR
```

| Mode                       | Package         | Best For                                      | Zero Flicker                    | Zero Hydration Mismatch                      |
| -------------------------- | --------------- | --------------------------------------------- | ------------------------------- | -------------------------------------------- |
| **Edge Proxy**             | `@facet/worker` | Webflow, WordPress, Ghost, Astro, static HTML | Yes (streaming `HTMLRewriter`)  | N/A (non-hydrated HTML)                      |
| **Hydration-Safe Next.js** | `@facet/next`   | Next.js App Router & React Server Components  | Yes (SSR with middleware state) | Yes (`<FacetSlot />` renders identical HTML) |

---

## 60-Second Quickstart

Test `facet.yaml` against any live site locally in seconds — no Cloudflare account required.

### 1. Create a starter `facet.yaml`

```bash
npx facet init --schema
```

This creates a commented `facet.yaml` plus `facet.schema.json` (Draft 2020-12 JSON Schema) with a YAML language-server header for editor autocomplete.

### 2. Validate your config

```bash
npx facet validate facet.yaml
```

Validates schema types, regex patterns, conflicting transforms, CSS selectors (via `lol-html`), and shadowed rules with line-accurate error messages.

### 3. Preview live against any site

```bash
npx facet preview --target https://yoursite.com --config ./facet.yaml
```

Starts a local reverse proxy on `http://127.0.0.1:8787` using the same `@facet/core` engine + WASM `HTMLRewriter`, live-reloads when `facet.yaml` changes, and injects a dev-only **Preview Bar** so marketers and engineers can toggle between **Auto**, **Default**, **Control**, and any **Experience** live.

### 4. Generate a signed shareable preview link

```bash
FACET_PREVIEW_SECRET="replace-with-random-32-byte-secret" \
  npx facet preview-link fintech-abm --url https://yoursite.com --bucket variant --ttl 86400
```

Produces an HMAC-SHA256 signed URL (`?__facet_preview=fintech-abm&__facet_bucket=variant&__facet_sig=...`) you can share in Slack to QA unpublished ABM experiences in production without exposing rules publicly.

### CLI Commands Reference

| Command                                                                                                                                 | Description                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `facet init [--out <path>] [--schema] [--force]`                                                                                        | Create a starter `facet.yaml` (and optional `facet.schema.json`) |
| `facet validate [configPath]`                                                                                                           | Validate `facet.yaml` schema, CSS selectors, and rule sanity     |
| `facet preview --target <url> [--config <path>] [--port <n>] [--host <h>]`                                                              | Start the local reverse proxy with live reload & Preview Bar     |
| `facet preview-link <experienceId> --url <siteUrl> [--secret <s>] [--bucket variant\|control\|default] [--ttl <sec>] [--config <path>]` | Generate an HMAC-SHA256 signed shareable preview URL             |
| `facet schema [--out <path>]`                                                                                                           | Export the Draft 2020-12 JSON Schema for `facet.yaml`            |

---

## Live Demo Walkthrough

Try Facet locally in under a minute using the included [`examples/basic-site/`](./examples/basic-site) landing page:

```bash
# 1. Install and build workspace packages
npm install
npm run build

# 2. Validate the example config
node packages/cli/dist/bin.js validate examples/basic-site/facet.yaml

# 3. Serve the static example landing page in one terminal
python3 -m http.server 4000 --directory examples/basic-site

# 4. Start the Facet local preview proxy in another terminal
node packages/cli/dist/bin.js preview \
  --target http://127.0.0.1:4000 \
  --config examples/basic-site/facet.yaml
```

Now open these URLs in your browser:

- **Default page:** `http://127.0.0.1:8787/` — renders the untouched Meridian Cloud landing page.
- **Virtual 1:1 ABM page (`/for/:acct` + `originPath: "/"`):** `http://127.0.0.1:8787/for/stripe` or `http://127.0.0.1:8787/for/plaid` — fetches `/` from the origin so `/for/:acct` never 404s, looks up the account row in `data.accounts`, interpolates `{{data.* | default(...)}}` copy, and sets a 7-day `__facet_sticky` cookie.
- **1:1 ABM query link:** `http://127.0.0.1:8787/?acct=stripe` or `http://127.0.0.1:8787/?acct=ramp` — matches `abm-query-account` from the same `data.accounts` table and stays sticky across subsequent visits to `/`.
- **Paid ad message-match:** `http://127.0.0.1:8787/?utm_campaign=fintech-q4` — matches `fintech-abm` (with a 20% deterministic control holdout and 7-day session stickiness).
- **Preview Bar:** Use the floating bar in the bottom-right corner to switch between `Auto`, `Default`, `Control`, `abm-account-page`, `abm-query-account`, `fintech-abm`, and `eu-returning-visitor` — or edit `examples/basic-site/facet.yaml` and refresh to see changes immediately.

---

## `facet.yaml` Reference

Every personalization rule lives in a single version-controlled `facet.yaml` validated by Zod (`@facet/core`):

```yaml
version: 1

settings:
  cookieName: "__facet_vid" # Default: "__facet_vid"
  stickyCookieName: "__facet_sticky" # Default: "__facet_sticky"
  previewParam: "__facet_preview" # Default: "__facet_preview"
  previewSigParam: "__facet_sig" # Default: "__facet_sig"
  analytics:
    # Supported: "ga4" | "umami" | "posthog" | "custom"
    providers: ["ga4", "umami", "posthog"]
  enrichment:
    timeoutMs: 150 # Default: 150ms (strict fail-open)
    cacheTtlSeconds: 3600 # Default: 3600s (KV cache TTL)
  slots:
    fintech-logos: '<div class="logo-row"><span>Ramp</span><span>Mercury</span></div>'

# Optional inline lookup tables (or load CSVs at runtime with parseCsvTable)
data:
  accounts:
    stripe:
      name: "Stripe"
      headline: "Zero-latency edge routing built for Stripe's global scale"
      cta: "Open Stripe's architecture walkthrough"

experiences:
  - id: abm-account-page # Required unique ID: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
    name: "1:1 ABM Virtual Account Page"
    priority: 100
    originPath: "/" # Fetch "/" from origin for virtual URLs like /for/stripe
    sticky: "7d" # Persist match + attribution signals for 7 days
    match:
      path: "/for/:acct" # Named :param segments extracted into {{params.*}}
    lookup:
      table: "accounts" # References top-level data.accounts
      key: "{{params.acct}}"
      required: true # Default: true (skip experience if key is missing)
    changes:
      - selector: "h1"
        text: '{{data.headline | default("Edge infrastructure for your team")}}'
      - selector: "[data-cta='hero']"
        text: '{{data.cta | default("Book a demo")}}'
        attrs:
          href: "/demo?acct={{params.acct}}"

  - id: fintech-abm
    name: "Fintech ABM & Paid Search"
    enabled: true # Default: true
    priority: 10 # Default: 0 (higher priority evaluates first)
    stopOnMatch: true # Default: true (stop after first matching experience)
    holdout: 0.2 # 0..1 deterministic sticky control group (default: 0)
    sticky: "7d" # Optional: true | "session" | "<n>m" | "<n>h" | "<n>d"
    match:
      path: "/" # Supports exact paths, globs ("/blog/*", "/for/**"), and :params
      any: # Combinators: `all`, `any`, `not`
        - utm_campaign: ["fintech-q4", "abm-banking"]
        - query.acct: ["stripe", "plaid"]
        - company.industry: ["Financial Services", "FinTech"]
    changes:
      - selector: "h1"
        text: "Compliance-ready infrastructure for fintech teams" # HTML-escaped by default
      - selector: "[data-cta='hero']"
        text: "See the fintech demo"
        attrs:
          href: "/demo?segment=fintech"
      - selector: "#logo-strip"
        slot: "fintech-logos" # Resolves from settings.slots (or Next.js <FacetSlot />)
```

### Supported Match Fields & Operators

- **Top-level fields:** `path` (supports exact paths, globs `*` / `**` / `?`, and named `:param` segments like `/for/:acct`), `host`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `referrer`, `returning` (`boolean`)
- **Dotted or nested maps:** `query.*`, `cookie.*`, `header.*`, `geo.*` (`country`, `region`, `city`, `continent`, `timezone`), `company.*` (`name`, `domain`, `industry`, `size`, `employees`, `revenue`, or custom enrichment keys)
- **Combinators:** `all` (AND array), `any` (OR array), `not` (negated condition)
- **Match values:** scalar (`"stripe"`, `true`, `100`), array of scalars (`["fintech-q4", "abm-banking"]`), or operator object:
  - `equals`, `in`, `contains`, `startsWith`, `endsWith`, `regex`, `gt`, `gte`, `lt`, `lte`, `exists`

### Virtual ABM URLs (`originPath`) & Named Path Parameters (`:param`)

Ship clean 1:1 account URLs (such as `/for/stripe` or `/for/plaid`) without creating duplicate pages in your CMS:

- **Named `:param` paths:** Use `:param` segments in `match.path` (e.g. `/for/:acct`, `/:locale/pricing/**`). Matched segments are safely URL-decoded and exposed as `{{params.<name>}}`.
- **`originPath`:** Tell `@facet/worker`, `@facet/next`, and `facet preview` which origin path to fetch or rewrite internally (e.g. `originPath: "/"`). Incoming query strings are preserved, control-group visitors still receive the rewritten origin page (never a 404), and SSRF / path-traversal sequences (`//`, `\`, `..`) are rejected automatically.

### Data Lookup Tables (`data:`, `lookup:`, and `parseCsvTable`)

Scale one experience rule across hundreds of target accounts with zero per-account YAML duplication:

- Define keyed tables inline under top-level `data.<tableName>.<key>`, or load a CSV file at startup using `parseCsvTable(csvString, keyColumn)` from `@facet/core` (pure RFC-4180 parser, zero Node `fs` dependencies) and merge it into `config.data`:

```ts
import { parseCsvTable, parseFacetYaml } from "@facet/core";
import facetYaml from "./facet.yaml";
import accountsCsv from "./accounts.csv";

const parsed = parseFacetYaml(facetYaml);
if (parsed.ok) {
  parsed.config.data = {
    ...parsed.config.data,
    accounts: parseCsvTable(accountsCsv, "slug"),
  };
}
```

- Attach `lookup: { table: "accounts", key: "{{params.acct}}", required: true }` to an experience. When `required: true` (the default), the experience only matches if the resolved key exists in `config.data[table]`. Matched row fields become available via `{{data.*}}`.

### Dynamic Variables & XSS-Safe Templating (`{{...}}`)

Interpolate dynamic values across `originPath`, `lookup.key`, `settings.slots`, and change `text`, `html`, `slot`, `prepend`, `append`, and `attrs`:

- **Syntax:** `{{expr}}` or `{{expr | default("fallback")}}` (single or double quotes).
- **Allowed roots:** `data.*`, `company.*`, `query.*`, `geo.*`, `params.*`, plus top-level `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`. Prototype keys (`__proto__`, `constructor`, `prototype`) are strictly blocked.
- **Automatic XSS protection:** Interpolated variable values inside `html`, `slot`, `prepend`, and `append` are **always HTML-escaped** (`&`, `<`, `>`, `"`, `'`) so untrusted query/path input can never inject scripts. `text` and `attrs` interpolate raw strings and rely on downstream text/attribute escaping.
- **Static validation:** `npx facet validate` checks every template expression with `validateTemplateSyntax` and warns on missing `data` tables or unreferenced `{{params.*}}` placeholders.

### Session-Sticky Matching (`sticky:`)

Keep a visitor's campaign or ABM experience consistent as they navigate from `/` to `/pricing` or `/demo` without carrying UTM query parameters on every link:

- Add `sticky: true` / `sticky: "session"` (session cookie, no `Max-Age`) or a bounded duration (`"30m"`, `"24h"`, `"7d"`) to any experience.
- Facet stores compact, non-sensitive sticky state (matched experience IDs, optional `dataKey`, and attribution signals `utm_*` / `acct`) in the first-party `__facet_sticky` cookie (`settings.stickyCookieName`).
- Incoming URL parameters always take precedence over sticky signals, preview mode suppresses sticky cookie writes, and responses that read or write sticky state automatically set `Cache-Control: private, no-store` and `Vary: Cookie`.

### Supported DOM Transforms (`changes`)

| Field                      | Behavior                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `text`                     | Replaces inner text (**HTML-escaped by default**)                                                                                      |
| `html`                     | Replaces inner HTML explicitly                                                                                                         |
| `slot`                     | References a named HTML snippet from `settings.slots` (or matches `<FacetSlot id="..." />` in Next.js)                                 |
| `attrs`                    | Sets attributes (`string`) or removes them (`null`)                                                                                    |
| `addClass` / `removeClass` | Adds or removes CSS classes (string or string array)                                                                                   |
| `prepend` / `append`       | Prepends or appends content around element inner content (HTML or text in `@facet/worker`/`@facet/cli`; escaped text in `@facet/next`) |
| `remove`                   | Removes the matched element (`true`; cannot be combined with other mutations)                                                          |

> `text`, `html`, and `slot` are mutually exclusive on a single change entry.

### Analytics Exposure Events

Facet injects a tiny inline snippet containing **only** `{ experienceId, bucket }` (`"variant" | "control"`):

- **`ga4`**: `window.gtag("event", "facet_exposure", { experience_id, bucket })`
- **`umami`**: `window.umami.track("facet_exposure", { experience_id, bucket })`
- **`posthog`**: `window.posthog.capture("facet_exposure", { experience_id, bucket })`
- **`custom`**: `window.dispatchEvent(new CustomEvent("facet:exposure", { detail: { experienceId, bucket } }))`

---

## Deploying

### Mode 1: Cloudflare Worker (`@facet/worker`)

See the full ready-to-adapt template in [`examples/cloudflare-worker/`](./examples/cloudflare-worker):

```ts
import {
  createFacetWorker,
  createIpinfoAdapter,
  type EnrichmentCacheStore,
  type FacetWorkerEnv,
} from "@facet/worker";
import facetYaml from "./facet.yaml";

interface Env extends FacetWorkerEnv {
  ORIGIN_URL: string;
  FACET_PREVIEW_SECRET?: string;
  IPINFO_TOKEN?: string;
  FACET_CACHE?: EnrichmentCacheStore;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const worker = createFacetWorker<Env>({
      origin: (_req, workerEnv) => workerEnv?.ORIGIN_URL ?? "https://your-site.webflow.io",
      config: facetYaml,
      previewSecret: (workerEnv) => workerEnv?.FACET_PREVIEW_SECRET,
      kv: (workerEnv) => workerEnv?.FACET_CACHE,
      // Optional BYOK enrichment (strict 150ms fail-open timeout + KV cache)
      ...(env.IPINFO_TOKEN ? { enrichment: createIpinfoAdapter({ token: env.IPINFO_TOKEN }) } : {}),
    });
    return worker.fetch(request, env, ctx);
  },
};
```

### Mode 2: Next.js App Router (`@facet/next`)

See the full ready-to-adapt template in [`examples/nextjs-app/`](./examples/nextjs-app):

```ts
// middleware.ts
import { createFacetMiddleware } from "@facet/next";
import facetYaml from "./facet.yaml";

export const middleware = createFacetMiddleware({
  config: facetYaml,
  previewSecret: process.env.FACET_PREVIEW_SECRET,
});
```

```tsx
// app/page.tsx (Server Component)
import { FacetAnalytics, FacetSlot, readFacetState } from "@facet/next";
import { headers } from "next/headers";

export default async function HomePage() {
  const state = readFacetState(await headers());

  return (
    <main>
      <FacetSlot id="hero-headline" as="h1" state={state}>
        Default headline
      </FacetSlot>
      <FacetAnalytics state={state} />
    </main>
  );
}
```

---

## Packages

| Package                              | Description                                                    | Key Exports                                                                                                                                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@facet/core`](./packages/core)     | Pure, zero-I/O TypeScript engine (Web Standard APIs only)      | `parseFacetYaml`, `validateFacetConfig`, `exportFacetJsonSchema`, `evaluate`, `assignBucket`, `buildContextFromRequest`, `parseCsvTable`, `interpolateTemplate`, `validateTemplateSyntax`, `parseStickyCookie`, `signPreviewToken`, `verifyPreviewToken` |
| [`@facet/worker`](./packages/worker) | Cloudflare Worker reverse proxy using streaming `HTMLRewriter` | `createFacetWorker`, `handleFacetRequest`, `createIpinfoAdapter`, `createWebhookEnrichmentAdapter`, `runEnrichment`, `rewriteHtmlResponse`                                                                                                               |
| [`@facet/cli`](./packages/cli)       | Local CLI & live preview proxy with Preview Bar                | `facet init`, `facet validate`, `facet preview`, `facet preview-link`, `facet schema`                                                                                                                                                                    |
| [`@facet/next`](./packages/next)     | Hydration-safe Next.js Middleware & Server Components          | `createFacetMiddleware`, `readFacetState`, `FacetSlot`, `FacetAnalytics`                                                                                                                                                                                 |

---

## Reliability, Caching & Security Guarantees

1. **Always fail open:** Invalid `facet.yaml`, enrichment timeouts, unexpected evaluation errors, or HTML rewrite failures immediately pass through the untouched origin response. Facet never takes down your marketing site.
2. **Strict enrichment timeout & caching:** BYOK enrichment adapters (`createIpinfoAdapter`, `createWebhookEnrichmentAdapter`, or custom `EnrichmentAdapter`) enforce a hard timeout (`150ms` default via `AbortController`) and cache results (including negative misses) in Cloudflare KV via `ctx.waitUntil`.
3. **Safe HTTP caching:** Personalized, sticky-matched, or cookie-setting responses always set `Cache-Control: private, no-store` and `Vary: Cookie` so CDNs never leak one segment's HTML to another visitor. Static assets (`.js`, `.css`, images, fonts, etc.) and non-HTML responses bypass rewriting completely.
4. **Zero secret leaks & XSS-safe templating:** Enrichment tokens, internal account lists, and unpublished rules never reach the browser. Analytics payloads emit strictly `{ experienceId, bucket }`, preview URLs use Web Crypto HMAC-SHA256 with constant-time verification, `{{...}}` interpolation HTML-escapes values inside HTML contexts (`html`/`slot`/`prepend`/`append`) and blocks prototype keys, `originPath` rejects protocol-relative and traversal paths, and `@facet/next` strips incoming `x-facet-state` headers to prevent spoofing.
5. **Minimal edge footprint:** `@facet/core` and `@facet/worker` rely solely on Web Standard APIs (`URL`, `Headers`, `Request`, `Response`, `crypto.subtle`) for near-zero cold starts.

---

## Development

```bash
npm install           # Install workspace dependencies
npm run build         # Compile all packages (@facet/core, worker, cli, next)
npm run typecheck     # Run strict TypeScript checks across all workspaces
npm test              # Run the Vitest suite
npm run lint          # Run ESLint
npm run format:check  # Check formatting with Prettier
npm run format        # Auto-format all files with Prettier
```

---

## License

Licensed under the [Apache License 2.0](./LICENSE).
