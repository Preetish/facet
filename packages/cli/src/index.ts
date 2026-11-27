export { runCli } from "./cli.js";
export type { RunCliOptions } from "./cli.js";

export { CLI_VERSION, resolveCliIO } from "./io.js";
export type { CliIO } from "./io.js";

export { buildStarterFacetYaml, runInitCommand } from "./commands/init.js";
export type { InitCommandOptions, InitCommandResult, StarterYamlOptions } from "./commands/init.js";

export {
  checkCssSelector,
  collectConfigWarnings,
  collectTemplateErrors,
  formatValidationError,
  runValidateCommand,
  validateConfigFile,
} from "./commands/validate.js";
export type {
  SelectorCheckResult,
  ValidateResult,
  ValidationWarning,
} from "./commands/validate.js";

export { runSchemaCommand } from "./commands/schema.js";
export type { SchemaCommandOptions, SchemaCommandResult } from "./commands/schema.js";

export { isPreviewBucket, runPreviewLinkCommand } from "./commands/preview-link.js";
export type {
  PreviewLinkCommandOptions,
  PreviewLinkCommandResult,
} from "./commands/preview-link.js";

export {
  DEFAULT_PR_PREVIEW_TTL_SECONDS,
  PR_COMMENT_MARKER,
  buildPrCommentReport,
  diffFacetExperiences,
  generatePrCommentMarkdown,
  runPrCommentCommand,
} from "./commands/pr-comment.js";
export type {
  BuildPrCommentReportOptions,
  ExperienceDiffItem,
  GeneratePrCommentMarkdownOptions,
  PrCommentCommandOptions,
  PrCommentCommandResult,
  PrCommentExperienceEntry,
  PrCommentExperienceStatus,
  PrCommentReport,
  PrCommentSummary,
} from "./commands/pr-comment.js";

export { runPreviewCommand } from "./commands/preview.js";
export type { PreviewCommandOptions, PreviewCommandResult } from "./commands/preview.js";

export {
  LOCAL_MODE_COOKIE_NAME,
  LOCAL_MODE_QUERY_PARAM,
  buildPreviewBarHtml,
  deserializeLocalPreviewMode,
  resolveLocalPreviewMode,
  serializeLocalPreviewMode,
} from "./preview/preview-bar.js";
export type {
  LocalPreviewMode,
  PreviewBarOptions,
  ResolvedLocalPreviewMode,
} from "./preview/preview-bar.js";

export { applyResolvedChange, rewriteHtml } from "./preview/rewriter.js";
export type { RewriteHtmlOptions } from "./preview/rewriter.js";

export {
  appendVaryHeader,
  applyPreviewResponseHeaders,
  buildUpstreamUrl,
  createPreviewServer,
  evaluatePreviewRequest,
  formatStickySetCookie,
  isStaticAssetPath,
} from "./preview/server.js";
export type {
  EvaluatedPreviewRequest,
  LoadedConfigState,
  PreviewLogger,
  PreviewResponseHeaderParams,
  PreviewServer,
  PreviewServerAddress,
  PreviewServerOptions,
} from "./preview/server.js";
