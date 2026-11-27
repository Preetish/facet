export { compileAccountTableRows, compileCampaignRows } from "./compiler.js";
export type {
  CompileAccountTableOptions,
  CompileAccountTableResult,
  CompileCampaignRowsOptions,
  CompileRowsResult,
  CompileRowsSummary,
  DefaultSelectors,
  RowCompileError,
} from "./compiler.js";

export {
  createAirtableSource,
  createGoogleSheetsSource,
  createNotionSource,
  extractNotionPropertyValue,
} from "./sources.js";
export type {
  AirtableSourceOptions,
  GoogleSheetsSourceOptions,
  NotionSourceOptions,
  SyncRow,
  SyncSource,
} from "./sources.js";

export { createCloudflareKvTarget, createGitHubPrTarget } from "./targets.js";
export type {
  CloudflareKvTargetOptions,
  GitHubPrTargetOptions,
  KVLike,
  PublishPayload,
  SyncSnapshot,
  SyncSnapshotMeta,
  SyncTarget,
  SyncTargetPublishResult,
} from "./targets.js";

export { syncFacetConfig } from "./sync.js";
export type {
  AccountTableSyncSource,
  SyncCompileFn,
  SyncFacetConfigOptions,
  SyncFacetConfigResult,
} from "./sync.js";

export { hashYaml, parseCsvMatrix, parseCsvRecords } from "./utils.js";
