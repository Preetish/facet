export {
  STATIC_ASSET_EXTENSIONS,
  buildOriginUrl,
  createFacetWorker,
  extractCloudflareGeo,
  formatStickyCookie,
  formatVisitorCookie,
  handleFacetRequest,
  isHtmlContentType,
  isStaticAssetPath,
} from "./handler.js";
export type {
  FacetConfigSource,
  FacetErrorStage,
  FacetWorkerEnv,
  FacetWorkerHandler,
  FacetWorkerOptions,
} from "./handler.js";

export { applyChangeToElement, createDefaultRewriter, rewriteHtmlResponse } from "./rewriter.js";
export type {
  CreateRewriterFn,
  FacetElementHandler,
  FacetHtmlElement,
  FacetHtmlRewriter,
  FacetRewriterContentOptions,
  RewriteHtmlOptions,
} from "./rewriter.js";

export {
  createIpinfoAdapter,
  createWebhookEnrichmentAdapter,
  extractClientIp,
  runEnrichment,
} from "./enrichment.js";
export type {
  EnrichmentAdapter,
  EnrichmentCacheStore,
  IpinfoAdapterOptions,
  RunEnrichmentOptions,
  WebhookEnrichmentAdapterOptions,
} from "./enrichment.js";

export {
  DEFAULT_CONFIG_CACHE_TTL_MS,
  DEFAULT_KV_CONFIG_KEY_PREFIX,
  createCachedConfigLoader,
  createKvConfigStore,
} from "./config-store.js";
export type { CachedConfigLoaderOptions, KvConfigStoreOptions } from "./config-store.js";
