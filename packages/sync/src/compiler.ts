import {
  validateFacetConfig,
  type ContextPrimitive,
  type FacetConfig,
  type FacetDataTable,
  type FacetExperience,
  type FacetValidationError,
  type MatchCondition,
  type MatchValue,
} from "@facet/core";
import { stringify } from "yaml";
import { hasOwn, isForbiddenKey, sanitizeJsonValue } from "./utils.js";

export interface DefaultSelectors {
  headline?: string;
  subhead?: string;
  cta?: string;
}

export interface CompileCampaignRowsOptions {
  baseConfig?: Partial<FacetConfig>;
  defaultSelector?: DefaultSelectors;
}

export interface RowCompileError {
  rowIndex: number;
  rowNumber: number;
  experienceId?: string;
  errors: FacetValidationError[];
}

export interface CompileRowsSummary {
  totalRows: number;
  compiledCount: number;
  liveCount: number;
  pausedCount: number;
  draftSkipped: number;
  blankSkipped: number;
  errorCount: number;
}

export interface CompileRowsResult {
  ok: boolean;
  experiences: FacetExperience[];
  config: FacetConfig;
  yaml: string;
  errors: RowCompileError[];
  summary: CompileRowsSummary;
}

export interface CompileAccountTableOptions {
  tableName: string;
  keyColumn: string;
}

export interface CompileAccountTableResult {
  table: Record<string, Record<string, ContextPrimitive>>;
  rowCount: number;
  skippedRows: number;
}

const DEFAULT_HEADLINE_SELECTOR = "h1";
const DEFAULT_SUBHEAD_SELECTOR = "[data-facet='subhead']";
const DEFAULT_CTA_SELECTOR = "[data-cta='hero']";

function normalizeColumnKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function buildNormalizedRow(row: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const key of Object.keys(row)) {
    if (!hasOwn(row, key) || isForbiddenKey(key)) {
      continue;
    }
    const normalized = normalizeColumnKey(key);
    if (normalized.length === 0 || isForbiddenKey(normalized)) {
      continue;
    }
    // Prefer exact snake_case key if both exact and aliased forms exist
    if (!map.has(normalized) || key === normalized) {
      map.set(normalized, row[key]);
    }
  }
  return map;
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function isBlankRow(map: Map<string, unknown>): boolean {
  for (const value of map.values()) {
    if (!isEmptyValue(value)) {
      return false;
    }
  }
  return true;
}

function readString(map: Map<string, unknown>, key: string): string | undefined {
  const raw = map.get(key);
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw === "boolean") {
    return String(raw);
  }
  return undefined;
}

function readMatchList(map: Map<string, unknown>, key: string): MatchValue | undefined {
  const raw = map.get(key);
  if (raw === undefined || raw === null) return undefined;

  if (Array.isArray(raw)) {
    const items = raw
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (typeof item === "number" && Number.isFinite(item)) return String(item);
        return "";
      })
      .filter((s) => s.length > 0);
    if (items.length === 0) return undefined;
    return items.length === 1 ? items[0] : items;
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed.includes(",")) {
      const parts = trimmed
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      if (parts.length === 0) return undefined;
      return parts.length === 1 ? parts[0] : parts;
    }
    return trimmed;
  }

  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }

  return undefined;
}

function parseNumberField(
  raw: unknown,
  fieldPath: string,
  allowPercent = false,
): { ok: true; value: number | undefined } | { ok: false; error: FacetValidationError } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      return {
        ok: false,
        error: {
          path: fieldPath,
          code: `invalid_${fieldPath}`,
          message: `Field "${fieldPath}" must be a finite number`,
        },
      };
    }
    return { ok: true, value: raw };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { ok: true, value: undefined };
    }
    if (allowPercent && trimmed.endsWith("%")) {
      const pct = Number(trimmed.slice(0, -1).trim());
      if (!Number.isFinite(pct)) {
        return {
          ok: false,
          error: {
            path: fieldPath,
            code: `invalid_${fieldPath}`,
            message: `Field "${fieldPath}" has invalid percentage "${trimmed}"`,
          },
        };
      }
      return { ok: true, value: pct / 100 };
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return {
        ok: false,
        error: {
          path: fieldPath,
          code: `invalid_${fieldPath}`,
          message: `Field "${fieldPath}" must be a number, received "${trimmed}"`,
        },
      };
    }
    return { ok: true, value: parsed };
  }

  return {
    ok: false,
    error: {
      path: fieldPath,
      code: `invalid_${fieldPath}`,
      message: `Field "${fieldPath}" must be a number`,
    },
  };
}

function parseBooleanField(
  raw: unknown,
  fieldPath: string,
): { ok: true; value: boolean | undefined } | { ok: false; error: FacetValidationError } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (typeof raw === "boolean") {
    return { ok: true, value: raw };
  }
  if (typeof raw === "string") {
    const lower = raw.trim().toLowerCase();
    if (lower.length === 0) {
      return { ok: true, value: undefined };
    }
    if (lower === "true" || lower === "yes" || lower === "1") {
      return { ok: true, value: true };
    }
    if (lower === "false" || lower === "no" || lower === "0") {
      return { ok: true, value: false };
    }
    return {
      ok: false,
      error: {
        path: fieldPath,
        code: `invalid_${fieldPath}`,
        message: `Field "${fieldPath}" must be a boolean, received "${raw}"`,
      },
    };
  }
  return {
    ok: false,
    error: {
      path: fieldPath,
      code: `invalid_${fieldPath}`,
      message: `Field "${fieldPath}" must be a boolean`,
    },
  };
}

function parseStickyField(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    const lower = trimmed.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
    return trimmed;
  }
  return raw;
}

function parseChangesJson(
  raw: unknown,
): { ok: true; changes: unknown[] } | { ok: false; error: FacetValidationError } {
  if (raw === undefined || raw === null) {
    return { ok: true, changes: [] };
  }

  let parsed: unknown;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { ok: true, changes: [] };
    }
    try {
      parsed = JSON.parse(trimmed, (key, value: unknown) =>
        isForbiddenKey(key) ? undefined : value,
      );
    } catch (err) {
      return {
        ok: false,
        error: {
          path: "changes_json",
          code: "invalid_changes_json",
          message: `Invalid JSON in changes_json: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  } else if (typeof raw === "object") {
    parsed = sanitizeJsonValue(raw);
  } else {
    return {
      ok: false,
      error: {
        path: "changes_json",
        code: "invalid_changes_json",
        message: "changes_json must be a JSON string, array, or change object",
      },
    };
  }

  if (Array.isArray(parsed)) {
    return { ok: true, changes: parsed };
  }
  if (parsed !== null && typeof parsed === "object") {
    return { ok: true, changes: [parsed] };
  }

  return {
    ok: false,
    error: {
      path: "changes_json",
      code: "invalid_changes_json",
      message: "changes_json must decode to a change object or an array of changes",
    },
  };
}

function buildBaseConfigShell(baseConfig?: Partial<FacetConfig>): Record<string, unknown> {
  const shell: Record<string, unknown> = {
    version: baseConfig?.version ?? 1,
  };
  if (baseConfig?.settings !== undefined) {
    shell.settings = sanitizeJsonValue(baseConfig.settings);
  }
  if (baseConfig?.data !== undefined) {
    shell.data = sanitizeJsonValue(baseConfig.data);
  }
  return shell;
}

function stripExperiencePrefix(path: string): string {
  return path.replace(/^experiences\[0\]\.?/, "") || "$";
}

/**
 * Compiles marketer-friendly spreadsheet/database rows into validated Facet experiences,
 * a schema-valid `FacetConfig`, and clean YAML.
 *
 * Every row is validated individually via `@facet/core`'s `validateFacetConfig` so invalid
 * marketer edits are reported with clear per-row errors and never corrupt the output config.
 */
export function compileCampaignRows(
  rows: readonly Record<string, unknown>[],
  options?: CompileCampaignRowsOptions,
): CompileRowsResult {
  const headlineDefault = options?.defaultSelector?.headline ?? DEFAULT_HEADLINE_SELECTOR;
  const subheadDefault = options?.defaultSelector?.subhead ?? DEFAULT_SUBHEAD_SELECTOR;
  const ctaDefault = options?.defaultSelector?.cta ?? DEFAULT_CTA_SELECTOR;

  const baseShell = buildBaseConfigShell(options?.baseConfig);
  const existingBaseExperiences: FacetExperience[] = [];
  const seenIds = new Set<string>();
  const rowErrors: RowCompileError[] = [];

  if (options?.baseConfig?.experiences && options.baseConfig.experiences.length > 0) {
    const baseCheck = validateFacetConfig({
      ...baseShell,
      experiences: sanitizeJsonValue(options.baseConfig.experiences),
    });
    if (baseCheck.ok) {
      for (const exp of baseCheck.config.experiences) {
        existingBaseExperiences.push(exp);
        seenIds.add(exp.id);
      }
    } else {
      rowErrors.push({
        rowIndex: -1,
        rowNumber: 0,
        errors: baseCheck.errors,
      });
    }
  }

  const compiledExperiences: FacetExperience[] = [];
  let liveCount = 0;
  let pausedCount = 0;
  let draftSkipped = 0;
  let blankSkipped = 0;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const rawRow = rows[rowIndex];
    const rowNumber = rowIndex + 1;

    if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
      rowErrors.push({
        rowIndex,
        rowNumber,
        errors: [
          {
            path: "$",
            code: "invalid_row",
            message: "Row must be a non-null key/value object",
          },
        ],
      });
      continue;
    }

    const map = buildNormalizedRow(rawRow);
    if (isBlankRow(map)) {
      blankSkipped += 1;
      continue;
    }

    const rawStatus = readString(map, "status");
    const status = rawStatus ? rawStatus.toLowerCase() : "live";

    if (status === "draft") {
      draftSkipped += 1;
      continue;
    }

    const id = readString(map, "id");
    const parseIssues: FacetValidationError[] = [];

    let enabled = true;
    if (status === "paused") {
      enabled = false;
    } else if (status !== "live") {
      parseIssues.push({
        path: "status",
        code: "invalid_status",
        message: `Invalid status "${rawStatus ?? ""}". Expected "live", "draft", or "paused"`,
      });
    }

    if (!id) {
      parseIssues.push({
        path: "id",
        code: "missing_id",
        message: "Experience id is required",
      });
    } else if (seenIds.has(id)) {
      parseIssues.push({
        path: "id",
        code: "duplicate_id",
        message: `Duplicate experience id "${id}"`,
      });
    }

    const priorityResult = parseNumberField(map.get("priority"), "priority", false);
    if (!priorityResult.ok) {
      parseIssues.push(priorityResult.error);
    }

    const holdoutResult = parseNumberField(map.get("holdout"), "holdout", true);
    if (!holdoutResult.ok) {
      parseIssues.push(holdoutResult.error);
    }

    const stopOnMatchResult = parseBooleanField(map.get("stop_on_match"), "stop_on_match");
    if (!stopOnMatchResult.ok) {
      parseIssues.push(stopOnMatchResult.error);
    }

    const changesJsonResult = parseChangesJson(map.get("changes_json"));
    if (!changesJsonResult.ok) {
      parseIssues.push(changesJsonResult.error);
    }

    if (parseIssues.length > 0) {
      const errorEntry: RowCompileError = {
        rowIndex,
        rowNumber,
        errors: parseIssues,
      };
      if (id !== undefined) {
        errorEntry.experienceId = id;
      }
      rowErrors.push(errorEntry);
      continue;
    }

    const match: MatchCondition = {};
    const pathVal = readMatchList(map, "path");
    if (pathVal !== undefined) match.path = pathVal;

    const utmCampaign = readMatchList(map, "utm_campaign");
    if (utmCampaign !== undefined) match.utm_campaign = utmCampaign;

    const utmSource = readMatchList(map, "utm_source");
    if (utmSource !== undefined) match.utm_source = utmSource;

    const utmMedium = readMatchList(map, "utm_medium");
    if (utmMedium !== undefined) match.utm_medium = utmMedium;

    const utmTerm = readMatchList(map, "utm_term");
    if (utmTerm !== undefined) match.utm_term = utmTerm;

    const utmContent = readMatchList(map, "utm_content");
    if (utmContent !== undefined) match.utm_content = utmContent;

    const acct = readMatchList(map, "acct");
    if (acct !== undefined) match["query.acct"] = acct;

    const country = readMatchList(map, "country");
    if (country !== undefined) match["geo.country"] = country;

    const changes: unknown[] = [];

    const headline = readString(map, "headline");
    if (headline !== undefined) {
      const selector = readString(map, "headline_selector") ?? headlineDefault;
      changes.push({ selector, text: headline });
    }

    const subhead = readString(map, "subhead");
    if (subhead !== undefined) {
      const selector = readString(map, "subhead_selector") ?? subheadDefault;
      changes.push({ selector, text: subhead });
    }

    const ctaText = readString(map, "cta_text");
    const ctaHref = readString(map, "cta_href");
    if (ctaText !== undefined || ctaHref !== undefined) {
      const selector = readString(map, "cta_selector") ?? ctaDefault;
      const ctaChange: Record<string, unknown> = { selector };
      if (ctaText !== undefined) ctaChange.text = ctaText;
      if (ctaHref !== undefined) ctaChange.attrs = { href: ctaHref };
      changes.push(ctaChange);
    }

    if (changesJsonResult.ok && changesJsonResult.changes.length > 0) {
      changes.push(...changesJsonResult.changes);
    }

    const candidate: Record<string, unknown> = {
      id,
      name: readString(map, "name") ?? id,
      enabled,
      priority: priorityResult.ok && priorityResult.value !== undefined ? priorityResult.value : 0,
      holdout: holdoutResult.ok && holdoutResult.value !== undefined ? holdoutResult.value : 0,
      match,
      changes,
    };

    if (stopOnMatchResult.ok && stopOnMatchResult.value !== undefined) {
      candidate.stopOnMatch = stopOnMatchResult.value;
    }

    const originPath = readString(map, "origin_path");
    if (originPath !== undefined) {
      candidate.originPath = originPath;
    }

    const sticky = parseStickyField(map.get("sticky"));
    if (sticky !== undefined) {
      candidate.sticky = sticky;
    }

    const lookupTable = readString(map, "lookup_table");
    const lookupKey = readString(map, "lookup_key");
    if (lookupTable !== undefined && lookupKey !== undefined) {
      const lookupReq = parseBooleanField(map.get("lookup_required"), "lookup_required");
      candidate.lookup = {
        table: lookupTable,
        key: lookupKey,
        required: lookupReq.ok && lookupReq.value !== undefined ? lookupReq.value : true,
      };
    }

    const validated = validateFacetConfig({
      version: 1,
      experiences: [candidate],
    });

    if (!validated.ok) {
      const errorEntry: RowCompileError = {
        rowIndex,
        rowNumber,
        errors: validated.errors.map((err) => ({
          ...err,
          path: stripExperiencePrefix(err.path),
        })),
      };
      if (id !== undefined) {
        errorEntry.experienceId = id;
      }
      rowErrors.push(errorEntry);
      continue;
    }

    const validExp = validated.config.experiences[0];
    if (!validExp) {
      continue;
    }

    seenIds.add(validExp.id);
    compiledExperiences.push(validExp);
    if (validExp.enabled) {
      liveCount += 1;
    } else {
      pausedCount += 1;
    }
  }

  const allExperiences = [...existingBaseExperiences, ...compiledExperiences];
  const finalValidation = validateFacetConfig({
    ...baseShell,
    experiences: allExperiences,
  });

  let finalConfig: FacetConfig;
  if (finalValidation.ok) {
    finalConfig = finalValidation.config;
  } else {
    rowErrors.push({
      rowIndex: -1,
      rowNumber: 0,
      errors: finalValidation.errors,
    });
    const fallbackValidation = validateFacetConfig({
      version: 1,
      experiences: compiledExperiences,
    });
    if (!fallbackValidation.ok) {
      throw new Error("Unexpected internal validation failure while building fallback FacetConfig");
    }
    finalConfig = fallbackValidation.config;
  }

  const yaml = stringify(finalConfig, { indent: 2, lineWidth: 100 });

  return {
    ok: rowErrors.length === 0,
    experiences: compiledExperiences,
    config: finalConfig,
    yaml,
    errors: rowErrors,
    summary: {
      totalRows: rows.length,
      compiledCount: compiledExperiences.length,
      liveCount,
      pausedCount,
      draftSkipped,
      blankSkipped,
      errorCount: rowErrors.length,
    },
  };
}

function toContextPrimitive(value: unknown): ContextPrimitive | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (typeof item === "number" && Number.isFinite(item)) return String(item);
        if (typeof item === "boolean") return String(item);
        return "";
      })
      .filter((s) => s.length > 0);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  return undefined;
}

/**
 * Compiles arbitrary marketer account/lookup rows into a keyed `config.data[tableName]`
 * table while stripping empty keys and prototype-pollution keys.
 */
export function compileAccountTableRows(
  rows: readonly Record<string, unknown>[],
  options: CompileAccountTableOptions,
): CompileAccountTableResult {
  const tableName = options.tableName.trim();
  const keyColumn = options.keyColumn.trim();

  if (tableName.length === 0) {
    throw new Error("tableName must be a non-empty string");
  }
  if (isForbiddenKey(tableName)) {
    throw new Error(`tableName "${tableName}" is not allowed`);
  }
  if (keyColumn.length === 0) {
    throw new Error("keyColumn must be a non-empty string");
  }
  if (isForbiddenKey(keyColumn)) {
    throw new Error(`keyColumn "${keyColumn}" is not allowed`);
  }

  const table: FacetDataTable = {};
  let skippedRows = 0;

  for (const rawRow of rows) {
    if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
      skippedRows += 1;
      continue;
    }

    const rawKey = hasOwn(rawRow, keyColumn) ? rawRow[keyColumn] : undefined;
    const keyPrimitive = toContextPrimitive(rawKey);
    const rowKey = keyPrimitive !== undefined ? String(keyPrimitive).trim() : "";

    if (rowKey.length === 0 || isForbiddenKey(rowKey)) {
      skippedRows += 1;
      continue;
    }

    const record: Record<string, ContextPrimitive> = {};
    for (const col of Object.keys(rawRow)) {
      if (!hasOwn(rawRow, col)) continue;
      const colName = col.trim();
      if (colName.length === 0 || isForbiddenKey(colName)) {
        continue;
      }
      const primitive = toContextPrimitive(rawRow[col]);
      if (primitive !== undefined) {
        record[colName] = primitive;
      }
    }

    table[rowKey] = record;
  }

  return {
    table,
    rowCount: Object.keys(table).length,
    skippedRows,
  };
}
