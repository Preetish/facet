import {
  createFacetWorker,
  createIpinfoAdapter,
  type EnrichmentCacheStore,
  type FacetWorkerEnv,
  type FacetWorkerHandler,
} from "@facet/worker";

export interface Env extends FacetWorkerEnv {
  /** Marketing site origin URL (configured in wrangler.toml [vars]) */
  ORIGIN_URL: string;
  /** Optional HMAC secret for signed preview links (`wrangler secret put FACET_PREVIEW_SECRET`) */
  FACET_PREVIEW_SECRET?: string;
  /** Optional IPinfo token for BYOK company enrichment (`wrangler secret put IPINFO_TOKEN`) */
  IPINFO_TOKEN?: string;
  /** Optional Cloudflare KV namespace binding for caching enrichment results */
  FACET_CACHE?: EnrichmentCacheStore;
}

/**
 * Inline starter facet.yaml so this example compiles out of the box.
 * In production, import your git-tracked `facet.yaml` directly via Wrangler text rules
 * (see wrangler.toml) or load it dynamically from KV/R2.
 */
const FACET_YAML = `
version: 1

settings:
  cookieName: "__facet_vid"
  previewParam: "__facet_preview"
  previewSigParam: "__facet_sig"
  analytics:
    providers: ["ga4", "umami", "posthog"]
  enrichment:
    timeoutMs: 150
    cacheTtlSeconds: 3600
  slots:
    fintech-logos: '<div class="logo-row"><span>Ramp</span><span>Mercury</span><span>Plaid</span></div>'

experiences:
  - id: stripe-abm
    name: "Stripe 1:1 ABM"
    priority: 100
    holdout: 0
    match:
      query.acct: ["stripe"]
    changes:
      - selector: "h1"
        text: "Zero-latency edge routing built for Stripe's global scale"
      - selector: "[data-cta='hero']"
        text: "Open Stripe's architecture walkthrough"
        attrs:
          href: "/demo?acct=stripe"

  - id: fintech-abm
    name: "Fintech Paid Search & BYOK Enrichment"
    priority: 50
    holdout: 0.2
    match:
      path: "/"
      any:
        - utm_campaign: ["fintech-q4", "abm-banking"]
        - company.industry: ["Financial Services", "FinTech"]
    changes:
      - selector: "h1"
        text: "Compliance-ready infrastructure for fintech teams"
      - selector: "[data-cta='hero']"
        text: "See the fintech demo"
        attrs:
          href: "/demo?segment=fintech"
      - selector: "#logo-strip"
        slot: "fintech-logos"
`;

let cachedWorker: FacetWorkerHandler<Env> | undefined;
let cachedIpinfoToken: string | undefined;

function getWorker(env: Env): FacetWorkerHandler<Env> {
  if (cachedWorker !== undefined && cachedIpinfoToken === env.IPINFO_TOKEN) {
    return cachedWorker;
  }

  const enrichment =
    env.IPINFO_TOKEN !== undefined && env.IPINFO_TOKEN.length > 0
      ? createIpinfoAdapter({ token: env.IPINFO_TOKEN })
      : undefined;

  cachedIpinfoToken = env.IPINFO_TOKEN;
  cachedWorker = createFacetWorker<Env>({
    origin: (_request, workerEnv) => workerEnv?.ORIGIN_URL ?? "https://example.com",
    config: FACET_YAML,
    previewSecret: (workerEnv) => workerEnv?.FACET_PREVIEW_SECRET,
    kv: (workerEnv) => workerEnv?.FACET_CACHE,
    ...(enrichment !== undefined ? { enrichment } : {}),
    onError(error, stage) {
      // Facet always fails open and passes through the untouched origin response.
      console.error(`[facet:${stage}]`, error);
    },
  });

  return cachedWorker;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getWorker(env).fetch(request, env, ctx);
  },
};
