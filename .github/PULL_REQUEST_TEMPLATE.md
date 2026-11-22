## Summary

Briefly describe the changes in this pull request and why they are needed.

Fixes #(issue)

## Affected Packages

- [ ] `@facet/core`
- [ ] `@facet/worker`
- [ ] `@facet/cli`
- [ ] `@facet/next`
- [ ] Examples / Docs / CI

## Checklist

- [ ] `npm run build` succeeds
- [ ] `npm run typecheck` passes with strict TypeScript and zero `any`
- [ ] `npm run lint` passes
- [ ] `npm run format:check` passes
- [ ] `npm test` passes (with new/updated tests covering these changes)
- [ ] `@facet/core` and `@facet/worker` remain Web Standard only (no Node-only imports)
- [ ] Fail-open behavior, cache headers, and secret-safety invariants are preserved
- [ ] Updated `README.md` and `examples/` if the `facet.yaml` schema or CLI changed
