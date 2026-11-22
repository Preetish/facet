# Security Policy

## Supported Versions

Security fixes are provided for the following release lines:

| Version | Supported          |
| ------- | ------------------ |
| `0.1.x` | :white_check_mark: |
| `< 0.1` | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, please report them privately using **GitHub Security Advisories** ("Security" tab -> "Advisories" -> "Report a vulnerability" in this repository).

Please include as much of the following information as possible to help us reproduce and triage the issue quickly:

- Affected package(s) (`@facet/core`, `@facet/worker`, `@facet/cli`, `@facet/next`) and version
- Description of the vulnerability and potential impact
- Minimal reproduction steps or proof-of-concept
- Any suggested fix or mitigation (optional)

### Response Timeline

- **Acknowledgement:** Within **48 hours** of your report.
- **Initial triage & status update:** Within **5 business days**, including severity assessment and planned remediation timeline.
- **Coordinated disclosure:** Once a fix is ready, we will coordinate a release and publish a GitHub Security Advisory crediting you (unless you prefer to remain anonymous).

## Security Design Highlights

Facet is engineered to sit safely in front of production marketing sites:

- **Always fail-open:** Invalid `facet.yaml` configs, enrichment API timeouts (hard default `150ms` via `AbortController`), evaluation errors, or streaming `HTMLRewriter` failures immediately pass through the untouched origin response without taking down the site.
- **HMAC-SHA256 signed preview links:** Production preview overrides (`?__facet_preview=...&__facet_sig=...`) are signed and verified using Web Crypto HMAC-SHA256 with constant-time signature comparison and expiration timestamps, preventing unauthorized discovery or activation of unpublished experiences.
- **Header spoofing prevention:** `@facet/next` middleware strips any client-supplied `x-facet-state` header before attaching its evaluated personalization state for Server Components.
- **Safe HTTP caching:** Personalized and cookie-setting responses explicitly set `Cache-Control: private, no-store` and `Vary: Cookie` so upstream CDNs never cache and leak one segment's HTML to another visitor. Non-HTML and static asset requests bypass rewriting completely.
- **Minimal analytics metadata & zero secret leaks:** Enrichment API tokens, internal account lists, and unpublished rules never leave the edge/server. Client-side analytics snippets emit strictly `{ experienceId, bucket }` (`"variant" | "control"`).
- **Safe DOM transforms by default:** `text` transforms HTML-escape content by default; raw HTML injection requires explicit `html` or named `slot` configuration in version-controlled `facet.yaml`.
