# Contributing to Facet

Thank you for your interest in contributing to **Facet**! We welcome bug fixes, documentation improvements, new enrichment adapters, and feature contributions.

## Prerequisites

- **Node.js** 20 or 22 (LTS)
- **npm** 10+

## Local Development Setup

```bash
# 1. Clone and install workspace dependencies
npm install

# 2. Build all workspace packages (@facet/core first, then worker, cli, next)
npm run build

# 3. Run the Vitest test suite
npm test

# 4. Run ESLint
npm run lint

# 5. Run strict TypeScript typechecking across all packages
npm run typecheck

# 6. Format code with Prettier (or verify with `npm run format:check`)
npm run format
```

You can also smoke-test the CLI against the included example site:

```bash
node packages/cli/dist/bin.js validate examples/basic-site/facet.yaml
```

## Workspace Layout

Facet is an npm workspaces monorepo with four packages and ready-to-run examples:

| Path               | Package         | Purpose                                                                                                                              |
| ------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/`   | `@facet/core`   | Pure, zero-I/O TypeScript engine: Zod schema, matchers, FNV-1a holdouts, HMAC preview tokens, analytics snippets                     |
| `packages/worker/` | `@facet/worker` | Cloudflare Worker reverse proxy using streaming `HTMLRewriter`, KV-cached BYOK enrichment adapters, and fail-open handling           |
| `packages/cli/`    | `@facet/cli`    | Local CLI (`init`, `validate`, `preview`, `preview-link`, `schema`) and live preview proxy with Preview Bar                          |
| `packages/next/`   | `@facet/next`   | Hydration-safe Next.js App Router middleware (`createFacetMiddleware`) and Server Components (`<FacetSlot />`, `<FacetAnalytics />`) |
| `examples/`        | —               | Runnable examples for static sites (`basic-site`), Cloudflare Workers (`cloudflare-worker`), and Next.js (`nextjs-app`)              |

## Key Engineering Rules

Please keep these invariants in mind when making changes:

1. **Strict TypeScript, zero `any`:** Every package compiles with `"strict": true`. Never introduce `any`, and provide explicit return types on all public exports.
2. **Web Standard purity in `core` and `worker`:** `packages/core` and `packages/worker` must use only Web Standard APIs (`URL`, `Headers`, `Request`, `Response`, `crypto.subtle`). Do not import Node-only modules (`fs`, `path`, `node:crypto`, etc.) in those packages.
3. **Always fail open:** Invalid configuration, enrichment timeouts (default `150ms`), evaluation errors, or HTML rewrite failures must fall back to the untouched origin response immediately. Facet must never break or slow down a marketing site.
4. **Safe caching & zero secret leaks:** Personalized or cookie-setting responses must emit `Cache-Control: private, no-store` and `Vary: Cookie`. Static assets and non-HTML responses must bypass rewriting. Never leak enrichment tokens, internal account lists, or unpublished rules to the browser.
5. **Tests required:** Add or update Vitest unit/integration tests for every bug fix, matcher operator, bucketing edge case, cache header rule, fail-open timeout, or HTML transform.
6. **Minimal dependencies:** Keep `@facet/core` and `@facet/worker` lightweight so edge cold starts stay near zero.

## Pull Request Guidelines

1. **Keep PRs focused:** Scope each PR to a single fix or feature with small, clear commits.
2. **Run all checks before pushing:**
   ```bash
   npm run build && npm run typecheck && npm run lint && npm run format:check && npm test
   ```
3. **Update docs and examples:** If you change the `facet.yaml` schema or CLI flags, update `README.md` and the example configs in `examples/`.
4. **Fill out the PR template:** Describe what changed, why, and how it was tested.

## Code of Conduct & License

By participating in this project, you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md). All contributions are licensed under the [Apache License 2.0](./LICENSE).
