import {
  parseFacetYaml,
  type FacetConfig,
  type FacetDataTables,
  type FacetValidationError,
} from "@facet/core";
import {
  compileAccountTableRows,
  compileCampaignRows,
  type CompileCampaignRowsOptions,
  type CompileRowsResult,
} from "./compiler.js";
import type { SyncRow, SyncSource } from "./sources.js";
import type { PublishPayload, SyncTarget, SyncTargetPublishResult } from "./targets.js";
import { hashYaml, isForbiddenKey } from "./utils.js";

export type SyncCompileFn = (
  rows: readonly SyncRow[],
) => CompileRowsResult | Promise<CompileRowsResult>;

export interface AccountTableSyncSource {
  source: SyncSource;
  tableName: string;
  keyColumn: string;
}

export interface SyncFacetConfigOptions {
  source: SyncSource;
  target?: SyncTarget;
  compile?: SyncCompileFn;
  compileOptions?: CompileCampaignRowsOptions;
  accountTables?: readonly AccountTableSyncSource[];
  dryRun?: boolean;
  failOnRowErrors?: boolean;
  force?: boolean;
  author?: string;
  note?: string;
  now?: () => Date;
}

export interface SyncFacetConfigResult {
  ok: boolean;
  status: "published" | "unchanged" | "dry-run" | "failed";
  published: boolean;
  changed: boolean;
  dryRun: boolean;
  hash: string;
  yaml: string;
  config: FacetConfig | null;
  compiled: CompileRowsResult;
  validationErrors: FacetValidationError[];
  publishResult?: SyncTargetPublishResult;
}

/**
 * End-to-end orchestrator that fetches marketer rows from a source (and optional account
 * lookup table sources), compiles and validates the resulting `FacetConfig` with `@facet/core`,
 * skips no-op identical hashes, and publishes cleanly to the configured target.
 */
export async function syncFacetConfig(
  options: SyncFacetConfigOptions,
): Promise<SyncFacetConfigResult> {
  const dryRun = options.dryRun === true;
  if (!dryRun && !options.target) {
    throw new Error("syncFacetConfig requires a target unless dryRun is true");
  }

  const [rows, compiledTables] = await Promise.all([
    options.source.fetchRows(),
    options.accountTables && options.accountTables.length > 0
      ? Promise.all(
          options.accountTables.map(async (entry) => {
            const tableRows = await entry.source.fetchRows();
            const compiledTable = compileAccountTableRows(tableRows, {
              tableName: entry.tableName,
              keyColumn: entry.keyColumn,
            });
            return { tableName: entry.tableName.trim(), table: compiledTable.table };
          }),
        )
      : Promise.resolve([]),
  ]);

  let mergedCompileOptions: CompileCampaignRowsOptions | undefined = options.compileOptions;
  if (compiledTables.length > 0) {
    const mergedData: FacetDataTables = {
      ...(options.compileOptions?.baseConfig?.data ?? {}),
    };
    for (const item of compiledTables) {
      if (!isForbiddenKey(item.tableName)) {
        mergedData[item.tableName] = item.table;
      }
    }
    mergedCompileOptions = {
      ...options.compileOptions,
      baseConfig: {
        ...options.compileOptions?.baseConfig,
        data: mergedData,
      },
    };
  }

  const compiled = options.compile
    ? await options.compile(rows)
    : compileCampaignRows(rows, mergedCompileOptions);

  const hash = await hashYaml(compiled.yaml);

  // Fail-safe guard 1: explicit strict row error abort
  if (options.failOnRowErrors && compiled.errors.length > 0) {
    return {
      ok: false,
      status: "failed",
      published: false,
      changed: false,
      dryRun,
      hash,
      yaml: compiled.yaml,
      config: null,
      compiled,
      validationErrors: compiled.errors.flatMap((rowErr) => rowErr.errors),
    };
  }

  // Fail-safe guard 2: refuse to wipe live config when every candidate row failed validation
  if (compiled.experiences.length === 0 && compiled.errors.length > 0) {
    return {
      ok: false,
      status: "failed",
      published: false,
      changed: false,
      dryRun,
      hash,
      yaml: compiled.yaml,
      config: null,
      compiled,
      validationErrors: compiled.errors.flatMap((rowErr) => rowErr.errors),
    };
  }

  // Fail-safe guard 3: always round-trip validate serialized YAML via @facet/core before publishing
  const parsed = parseFacetYaml(compiled.yaml);
  if (!parsed.ok) {
    return {
      ok: false,
      status: "failed",
      published: false,
      changed: false,
      dryRun,
      hash,
      yaml: compiled.yaml,
      config: null,
      compiled,
      validationErrors: parsed.errors,
    };
  }

  let currentHash: string | null = null;
  if (options.target?.getCurrentHash) {
    currentHash = await options.target.getCurrentHash();
  }

  const hasChanges = currentHash === null || currentHash !== hash;

  if (dryRun) {
    return {
      ok: compiled.errors.length === 0,
      status: "dry-run",
      published: false,
      changed: hasChanges,
      dryRun: true,
      hash,
      yaml: compiled.yaml,
      config: parsed.config,
      compiled,
      validationErrors: [],
    };
  }

  if (!options.force && !hasChanges) {
    return {
      ok: compiled.errors.length === 0,
      status: "unchanged",
      published: false,
      changed: false,
      dryRun: false,
      hash,
      yaml: compiled.yaml,
      config: parsed.config,
      compiled,
      validationErrors: [],
    };
  }

  const target = options.target;
  if (!target) {
    throw new Error("syncFacetConfig requires a target unless dryRun is true");
  }

  const payload: PublishPayload = {
    yaml: compiled.yaml,
    config: parsed.config,
    hash,
  };
  if (options.author !== undefined) payload.author = options.author;
  if (options.note !== undefined) payload.note = options.note;
  if (options.now !== undefined) payload.now = options.now();

  const publishResult = await target.publish(payload);

  return {
    ok: compiled.errors.length === 0,
    status: publishResult.changed ? "published" : "unchanged",
    published: publishResult.changed,
    changed: publishResult.changed,
    dryRun: false,
    hash,
    yaml: compiled.yaml,
    config: parsed.config,
    compiled,
    validationErrors: [],
    publishResult,
  };
}
