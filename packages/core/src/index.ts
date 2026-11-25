export {
  ANALYTICS_PROVIDERS,
  DEFAULT_COOKIE_NAME,
  DEFAULT_ENRICHMENT_CACHE_TTL_SECONDS,
  DEFAULT_ENRICHMENT_TIMEOUT_MS,
  DEFAULT_PREVIEW_BUCKET_PARAM,
  DEFAULT_PREVIEW_PARAM,
  DEFAULT_PREVIEW_SIG_PARAM,
  DEFAULT_STICKY_COOKIE_NAME,
  DOTTED_MATCH_PREFIXES,
  MATCH_COMBINATOR_KEYS,
  MATCH_TOP_LEVEL_KEYS,
  analyticsProviderSchema,
  analyticsSettingsSchema,
  changeSchema,
  dataRecordSchema,
  dataTableSchema,
  dataTablesSchema,
  enrichmentSettingsSchema,
  experienceLookupSchema,
  experienceSchema,
  facetConfigSchema,
  matchConditionSchema,
  matchOperatorSchema,
  matchScalarSchema,
  matchValueSchema,
  settingsSchema,
  stickyDurationSchema,
} from "./schema.js";
export type {
  AnalyticsProvider,
  AnalyticsSettings,
  DottedMatchPrefix,
  EnrichmentSettings,
  ExperienceLookup,
  FacetChange,
  FacetConfig,
  FacetDataRow,
  FacetDataTable,
  FacetDataTables,
  FacetExperience,
  FacetSettings,
  MatchCondition,
  MatchOperator,
  MatchScalar,
  MatchValue,
  StickyDuration,
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

export { parseCsvTable } from "./csv.js";

export {
  extractPathParams,
  matchGlob,
  matchPathPattern,
  matchesCondition,
  matchesConditionWithParams,
  matchesPathValue,
} from "./matcher.js";
export type { ConditionMatchResult, PathMatchResult } from "./matcher.js";

export {
  TEMPLATE_NAMESPACES,
  TEMPLATE_TOP_LEVEL_VARS,
  buildTemplateContext,
  interpolateTemplate,
  isForbiddenTemplateKey,
  validateTemplateSyntax,
} from "./templates.js";
export type {
  BuildTemplateContextExtras,
  InterpolateOptions,
  TemplateContext,
  TemplateNamespace,
  TemplateSyntaxError,
  TemplateTopLevelVar,
  TemplateValidationResult,
} from "./templates.js";

export {
  MAX_STICKY_COOKIE_BYTES,
  MAX_STICKY_EXPERIENCES,
  MAX_STICKY_VALUE_LENGTH,
  STICKY_SIGNAL_KEYS,
  createEmptyStickyState,
  normalizeNowSeconds,
  parseStickyCookie,
  parseStickyDurationSeconds,
  serializeStickyCookie,
} from "./sticky.js";
export type {
  StickyCookieDirective,
  StickyExperienceEntry,
  StickySignalKey,
  StickySignals,
  StickyState,
} from "./sticky.js";

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
