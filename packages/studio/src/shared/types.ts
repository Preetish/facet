import type {
  ConfigSnapshot,
  ConfigSnapshotMeta,
  ConfigStore,
  FacetConfig,
  FacetDataTable,
  FacetValidationError,
  PreviewBucket,
  PublishOptions,
  PublishResult,
  SaveDraftResult,
} from "@facet/core";

export type {
  ConfigSnapshot,
  ConfigSnapshotMeta,
  ConfigStore,
  PublishOptions,
  PublishResult,
  SaveDraftResult,
};

export interface ValidationWarning {
  path: string;
  message: string;
}

export interface StudioCapabilities {
  canSignPreview: boolean;
  targetUrl: string | null;
  authRequired: boolean;
  user: string | null;
  isDemoMode: boolean;
  storageLabel: string;
  canLivePreview: boolean;
}

export interface StudioStateResponse {
  live: ConfigSnapshot | null;
  draft: string | null;
  activeYaml: string;
  config: FacetConfig | null;
  errors: FacetValidationError[];
  warnings: ValidationWarning[];
  snapshots: ConfigSnapshotMeta[];
  capabilities: StudioCapabilities;
}

export interface StudioValidateResponse {
  ok: boolean;
  config?: FacetConfig;
  errors: FacetValidationError[];
  warnings: ValidationWarning[];
}

export interface StudioDraftResponse {
  ok: boolean;
  config?: FacetConfig;
  errors?: FacetValidationError[];
  warnings?: ValidationWarning[];
}

export interface StudioPublishResponse {
  ok: boolean;
  snapshot?: ConfigSnapshot;
  config?: FacetConfig;
  errors?: FacetValidationError[];
}

export interface StudioRollbackResponse {
  ok: boolean;
  snapshot?: ConfigSnapshot;
  config?: FacetConfig;
  errors?: FacetValidationError[];
}

export interface StudioPreviewLinkRequest {
  experienceId: string;
  bucket?: PreviewBucket;
  baseUrl?: string;
  ttlSeconds?: number;
  queryParams?: Record<string, string>;
}

export interface StudioPreviewLinkResponse {
  ok: boolean;
  url?: string;
  token?: string;
  expiresAt?: number;
  error?: string;
}

export interface StudioImportCsvRequest {
  csv: string;
  tableName: string;
  keyColumn: string;
  baseYaml?: string;
  mergeMode?: "merge" | "replace";
}

export interface StudioImportCsvResponse {
  ok: boolean;
  tableName?: string;
  rowCount?: number;
  columns?: string[];
  table?: FacetDataTable;
  yaml?: string;
  config?: FacetConfig;
  error?: string;
  errors?: FacetValidationError[];
}
