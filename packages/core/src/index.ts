export {
  ANALYTICS_PROVIDERS,
  DEFAULT_COOKIE_NAME,
  DEFAULT_ENRICHMENT_CACHE_TTL_SECONDS,
  DEFAULT_ENRICHMENT_TIMEOUT_MS,
  DEFAULT_PREVIEW_BUCKET_PARAM,
  DEFAULT_PREVIEW_PARAM,
  DEFAULT_PREVIEW_SIG_PARAM,
  DOTTED_MATCH_PREFIXES,
  MATCH_COMBINATOR_KEYS,
  MATCH_TOP_LEVEL_KEYS,
  analyticsProviderSchema,
  analyticsSettingsSchema,
  changeSchema,
  enrichmentSettingsSchema,
  experienceSchema,
  facetConfigSchema,
  matchConditionSchema,
  matchOperatorSchema,
  matchScalarSchema,
  matchValueSchema,
  settingsSchema,
} from "./schema.js";
export type {
  AnalyticsProvider,
  AnalyticsSettings,
  DottedMatchPrefix,
  EnrichmentSettings,
  FacetChange,
  FacetConfig,
  FacetExperience,
  FacetSettings,
  MatchCondition,
  MatchOperator,
  MatchScalar,
  MatchValue,
} from "./schema.js";

export { parseFacetYaml, validateFacetConfig } from "./parse.js";
export type { FacetValidationError, ParseFacetResult } from "./parse.js";

export { exportFacetJsonSchema } from "./json-schema.js";
export type { JsonSchemaObject } from "./json-schema.js";

export { assignBucket, fnv1a32, generateVisitorId, hashToUnitInterval } from "./bucketing.js";
export type { Bucket } from "./bucketing.js";

export { buildContextFromRequest, parseCookies } from "./context.js";
export type {
  BuildContextExtras,
  CompanyContext,
  ContextPrimitive,
  GeoContext,
  RequestContext,
} from "./context.js";

export { matchGlob, matchesCondition } from "./matcher.js";

export { PERSONALIZED_CACHE_CONTROL, evaluate } from "./evaluator.js";
export type {
  EvaluateOptions,
  EvaluationResult,
  MatchedExperience,
  PreviewBucket,
} from "./evaluator.js";

export {
  buildPreviewUrl,
  parsePreviewParams,
  signPreviewToken,
  verifyPreviewToken,
} from "./preview.js";
export type {
  BuildPreviewUrlOptions,
  ParsePreviewParamsOptions,
  ParsedPreviewParams,
  SignPreviewTokenOptions,
  VerifyPreviewTokenFailureReason,
  VerifyPreviewTokenResult,
  VerifyPreviewTokenOptions,
} from "./preview.js";

export { escapeHtml, escapeHtmlAttr, normalizeClassList, resolveChange } from "./transforms.js";
export type { ResolvedChange } from "./transforms.js";

export { buildAnalyticsSnippet, safeJsonForScript, toAnalyticsExposures } from "./analytics.js";
export type { AnalyticsExposure } from "./analytics.js";
