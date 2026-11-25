# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`@facet/core` (v0.2 engine features):**
  - **Virtual ABM URLs (`originPath`):** Experiences can specify a safe relative `originPath` (e.g. `originPath: "/"` for `/for/:acct`), exposed as `EvaluationResult.originPath` (interpolated and guarded against `//`, backslashes, newlines, and `..` path traversal).
  - **Named path parameters (`:param`):** `match.path` now supports named segments (e.g. `/for/:acct`, `/:locale/pricing/**`) alongside exact paths and globs, exporting `matchPathPattern`, `matchesPathValue`, `matchesConditionWithParams`, and `extractPathParams`.
  - **Data lookup tables (`data:` + `lookup:` + `parseCsvTable`):** Top-level `data:` keyed tables, per-experience `lookup: { table, key, required }`, and a pure RFC-4180 `parseCsvTable(csv, keyColumn)` parser for scaling 1:1 ABM rules without duplicating YAML.
  - **Dynamic variables & XSS-safe templating (`{{...}}`):** Support for `{{expr}}` and `{{expr | default("fallback")}}` across `data.*`, `company.*`, `query.*`, `geo.*`, `params.*`, and `utm_*` with prototype-key protection, `validateTemplateSyntax`, and automatic HTML escaping inside `html`, `slot`, `prepend`, and `append`.
  - **Session-sticky matching (`sticky:`):** Per-experience `sticky: true | "session" | "<n>m" | "<n>h" | "<n>d"`, `settings.stickyCookieName` (default `"__facet_sticky"`), bounded fail-safe sticky cookie serialization (`parseStickyCookie`, `serializeStickyCookie`), attribution signal hydration (`utm_*`, `acct`), and `EvaluationResult.stickyCookie`.
  - Updated `exportFacetJsonSchema()` with `data`, `settings.stickyCookieName`, `originPath`, `lookup`, and `sticky`.
- **`@facet/worker`:**
  - Pre-fetch evaluation supporting `originPath` upstream rewrites (including control-group matches) with fail-open fallback and untouched passthrough for non-HTML/3xx/204/205 responses.
  - Emits `__facet_sticky` `Set-Cookie` (omitting `Max-Age` for session cookies, suppressed in preview mode) with `Cache-Control: private, no-store` and `Vary: Cookie`.
- **`@facet/next`:**
  - Same-origin `NextResponse.rewrite` when `originPath` is set (preserving incoming query parameters and request state headers).
  - Session-sticky cookie emission respecting `stickyCookie.maxAgeSeconds` (never inheriting visitor cookie TTL) and optional `now` clock injection.
- **`@facet/cli`:**
  - `facet preview` evaluates before upstream fetch so `originPath` rewrites virtual routes locally, and emits `Set-Cookie` for `stickyCookie` with `Cache-Control: private, no-store` and `Vary: Cookie`.
  - `facet validate` checks template syntax across `originPath`, `lookup.key`, change fields (`text`/`html`/`slot`/`prepend`/`append`/`attrs`), and `settings.slots`, warns on missing `data` tables, unreferenced `{{params.*}}`, and suspicious `originPath` values, and accounts for required `lookup` tables/keys during rule shadowing detection.
- **Examples, Documentation & Release Readiness:**
  - Updated `examples/basic-site/facet.yaml` to showcase `data:` lookup tables, `/for/:acct` + `originPath: "/"`, `{{data.* | default(...)}}` templating, and `sticky: "7d"`.
  - Expanded `README.md` with full v0.2 documentation and added npm publish metadata (`repository`, `homepage`, `bugs`, `keywords`, `publishConfig`) across all workspace packages.

## [0.1.0] - 2026-11-22

Initial v1 open-source release of **Facet** — zero-flicker edge website personalization and ad message-match for B2B growth teams.

### Added

- **`@facet/core`**:
  - Pure, zero-I/O TypeScript engine using only Web Standard APIs (`URL`, `Headers`, `Request`, `Response`, `crypto.subtle`).
  - Zod-validated `facet.yaml` parser and Draft 2020-12 JSON Schema exporter (`parseFacetYaml`, `validateFacetConfig`, `exportFacetJsonSchema`).
  - Segment evaluator with priority ordering, `stopOnMatch`, combinators (`all`, `any`, `not`), path globs, and rich matcher operators (`equals`, `in`, `contains`, `startsWith`, `endsWith`, `regex`, `gt`, `gte`, `lt`, `lte`, `exists`).
  - Deterministic sticky FNV-1a holdout bucketing (`assignBucket`) and request context builder (`buildContextFromRequest`).
  - Web Crypto HMAC-SHA256 preview link signing and constant-time verification (`signPreviewToken`, `verifyPreviewToken`).
  - Minimal analytics exposure snippet builder (`ga4`, `umami`, `posthog`, `custom`) emitting strictly `{ experienceId, bucket }`.
- **`@facet/worker`**:
  - Cloudflare Worker reverse proxy (`createFacetWorker`, `handleFacetRequest`) powered by streaming `HTMLRewriter` for zero-flicker DOM personalization before first paint.
  - Sticky first-party visitor cookie (`__facet_vid`), static asset / non-HTML bypass, safe cache headers (`Cache-Control: private, no-store`, `Vary: Cookie`), signed preview mode, and strict fail-open error handling.
  - Pluggable KV-cached BYOK enrichment runner (`runEnrichment`) with hard `150ms` default timeout, plus reference `createIpinfoAdapter` and `createWebhookEnrichmentAdapter`.
- **`@facet/cli`**:
  - `facet init` to scaffold `facet.yaml` and optional `facet.schema.json`.
  - `facet validate` for schema, CSS selector (`lol-html`), and rule sanity checks.
  - `facet preview` local reverse proxy with WASM `HTMLRewriter`, live config reload, and dev-only floating Preview Bar.
  - `facet preview-link` for generating HMAC-SHA256 signed shareable preview URLs.
  - `facet schema` for exporting the `facet.yaml` JSON Schema.
- **`@facet/next`**:
  - Hydration-safe Next.js App Router middleware (`createFacetMiddleware`) with incoming `x-facet-state` spoofing protection.
  - Server Components (`readFacetState`, `<FacetSlot />`, `<FacetAnalytics />`) sharing `@facet/core` evaluation with zero flicker and zero React hydration mismatches.
- **Examples & Documentation**:
  - `examples/basic-site/` interactive demo landing page with paid search, 1:1 ABM, and geo/returning-visitor rules.
  - `examples/cloudflare-worker/` ready-to-adapt Worker template with optional IPinfo enrichment.
  - `examples/nextjs-app/` ready-to-adapt Next.js App Router template.
  - Comprehensive `README.md` with 60-second quickstart, live demo walkthrough, and full `facet.yaml` reference.
