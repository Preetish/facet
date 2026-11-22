# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
