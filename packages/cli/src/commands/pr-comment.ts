import path from "node:path";
import {
  buildPreviewUrl,
  type FacetConfig,
  type FacetExperience,
  type FacetValidationError,
  type MatchValue,
} from "@facet/core";
import { resolveCliIO, type CliIO } from "../io.js";
import { formatValidationError, validateConfigFile, type ValidationWarning } from "./validate.js";

export const PR_COMMENT_MARKER = "<!-- facet-pr-preview -->";
export const DEFAULT_PR_PREVIEW_TTL_SECONDS = 604_800; // 7 days

export type PrCommentExperienceStatus = "added" | "modified" | "removed" | "unchanged";

export interface PrCommentExperienceEntry {
  id: string;
  name: string;
  status: PrCommentExperienceStatus;
  enabled: boolean;
  priority: number;
  holdout: number;
  changeCount: number;
  changedFields: string[];
  previewPath: string;
  variantUrl?: string;
  controlUrl?: string;
}

export interface PrCommentSummary {
  total: number;
  enabled: number;
  added: number;
  modified: number;
  removed: number;
  unchanged: number;
}

export interface PrCommentReport {
  marker: string;
  configPath: string;
  baseConfigPath: string | null;
  siteUrl: string;
  hasBase: boolean;
  ttlSeconds: number;
  expiresAt: number;
  expiresAtIso: string;
  summary: PrCommentSummary;
  experiences: PrCommentExperienceEntry[];
  warnings: ValidationWarning[];
}

export interface GeneratePrCommentMarkdownOptions {
  siteUrl: string;
  hasBase: boolean;
  ttlSeconds: number;
  expiresAt: number;
  summary: PrCommentSummary;
  experiences: readonly PrCommentExperienceEntry[];
  warnings?: readonly ValidationWarning[];
  marker?: string;
}

export interface BuildPrCommentReportOptions {
  config: FacetConfig;
  baseConfig?: FacetConfig;
  configPath: string;
  baseConfigPath?: string | null;
  siteUrl: string;
  secret: string;
  ttlSeconds?: number;
  now?: number;
  warnings?: ValidationWarning[];
}

export interface PrCommentCommandOptions {
  configPath?: string;
  url: string;
  secret?: string;
  baseConfigPath?: string;
  ttl?: number;
  json?: boolean;
  now?: number;
}

export interface PrCommentCommandResult {
  exitCode: number;
  report?: PrCommentReport;
  markdown?: string;
  error?: string;
  errors?: FacetValidationError[];
}

export interface ExperienceDiffItem {
  experience: FacetExperience;
  status: PrCommentExperienceStatus;
  changedFields: string[];
}

const STATIC_PATH_PATTERN = /^\/[^\s*?:#[\]{}()]*$/;

function isValidHttpUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry !== undefined) {
        sorted[key] = canonicalizeValue(entry);
      }
    }
    return sorted;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

function getStaticSlotNames(experience: FacetExperience): string[] {
  const names = new Set<string>();
  for (const change of experience.changes) {
    if (change.slot !== undefined && !change.slot.includes("{{")) {
      names.add(change.slot);
    }
  }
  return [...names].sort();
}

function detectChangedFields(
  headExp: FacetExperience,
  baseExp: FacetExperience,
  headConfig: FacetConfig,
  baseConfig: FacetConfig,
): string[] {
  const changed: string[] = [];

  const directFields: ReadonlyArray<keyof FacetExperience> = [
    "name",
    "enabled",
    "priority",
    "stopOnMatch",
    "holdout",
    "originPath",
    "lookup",
    "sticky",
    "match",
    "changes",
  ];

  for (const field of directFields) {
    if (canonicalJson(headExp[field]) !== canonicalJson(baseExp[field])) {
      changed.push(field);
    }
  }

  const slotNames = new Set<string>([
    ...getStaticSlotNames(headExp),
    ...getStaticSlotNames(baseExp),
  ]);
  for (const slotName of slotNames) {
    const headSlot = headConfig.settings.slots[slotName];
    const baseSlot = baseConfig.settings.slots[slotName];
    if (headSlot !== baseSlot) {
      changed.push("slot");
      break;
    }
  }

  if (headExp.lookup !== undefined && baseExp.lookup !== undefined) {
    const tableName = headExp.lookup.table;
    if (tableName === baseExp.lookup.table) {
      const headTable = headConfig.data?.[tableName];
      const baseTable = baseConfig.data?.[tableName];
      if (canonicalJson(headTable) !== canonicalJson(baseTable)) {
        changed.push("data");
      }
    }
  }

  return changed;
}

export function diffFacetExperiences(
  headConfig: FacetConfig,
  baseConfig?: FacetConfig,
): ExperienceDiffItem[] {
  if (!baseConfig) {
    return headConfig.experiences.map((experience) => ({
      experience,
      status: "unchanged",
      changedFields: [],
    }));
  }

  const baseById = new Map<string, FacetExperience>();
  for (const exp of baseConfig.experiences) {
    baseById.set(exp.id, exp);
  }

  const headIds = new Set<string>();
  const items: ExperienceDiffItem[] = [];

  for (const headExp of headConfig.experiences) {
    headIds.add(headExp.id);
    const baseExp = baseById.get(headExp.id);
    if (!baseExp) {
      items.push({
        experience: headExp,
        status: "added",
        changedFields: [],
      });
      continue;
    }

    const changedFields = detectChangedFields(headExp, baseExp, headConfig, baseConfig);
    items.push({
      experience: headExp,
      status: changedFields.length > 0 ? "modified" : "unchanged",
      changedFields,
    });
  }

  for (const baseExp of baseConfig.experiences) {
    if (!headIds.has(baseExp.id)) {
      items.push({
        experience: baseExp,
        status: "removed",
        changedFields: [],
      });
    }
  }

  return items;
}

function extractStaticPathFromMatchValue(value: MatchValue | undefined): string | null {
  if (typeof value === "string") {
    return STATIC_PATH_PATTERN.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && STATIC_PATH_PATTERN.test(item)) {
        return item;
      }
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    if (typeof value.equals === "string" && STATIC_PATH_PATTERN.test(value.equals)) {
      return value.equals;
    }
    if (Array.isArray(value.in)) {
      for (const item of value.in) {
        if (typeof item === "string" && STATIC_PATH_PATTERN.test(item)) {
          return item;
        }
      }
    }
  }
  return null;
}

function resolveExperiencePreviewTarget(
  siteUrl: string,
  experience: FacetExperience,
): { baseUrl: string; previewPath: string } {
  const parsed = new URL(siteUrl);
  if (parsed.pathname === "/" && parsed.search === "") {
    const staticPath = extractStaticPathFromMatchValue(experience.match.path);
    if (staticPath !== null) {
      parsed.pathname = staticPath;
    }
  }
  return {
    baseUrl: parsed.toString(),
    previewPath: parsed.pathname,
  };
}

export async function buildPrCommentReport(
  options: BuildPrCommentReportOptions,
): Promise<PrCommentReport> {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_PR_PREVIEW_TTL_SECONDS;
  const nowSec = options.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + ttlSeconds;
  const hasBase = options.baseConfig !== undefined;
  const diffItems = diffFacetExperiences(options.config, options.baseConfig);

  const experiences: PrCommentExperienceEntry[] = [];

  for (const item of diffItems) {
    const { experience, status, changedFields } = item;
    const { baseUrl, previewPath } = resolveExperiencePreviewTarget(options.siteUrl, experience);

    const shouldSign =
      experience.enabled && (!hasBase || status === "added" || status === "modified");

    let variantUrl: string | undefined;
    let controlUrl: string | undefined;

    if (shouldSign) {
      variantUrl = await buildPreviewUrl({
        baseUrl,
        experienceId: experience.id,
        secret: options.secret,
        bucket: "variant",
        expiresAt,
        previewParam: options.config.settings.previewParam,
        previewSigParam: options.config.settings.previewSigParam,
      });

      if (experience.holdout > 0) {
        controlUrl = await buildPreviewUrl({
          baseUrl,
          experienceId: experience.id,
          secret: options.secret,
          bucket: "control",
          expiresAt,
          previewParam: options.config.settings.previewParam,
          previewSigParam: options.config.settings.previewSigParam,
        });
      }
    }

    experiences.push({
      id: experience.id,
      name: experience.name,
      status,
      enabled: experience.enabled,
      priority: experience.priority,
      holdout: experience.holdout,
      changeCount: experience.changes.length,
      changedFields,
      previewPath,
      ...(variantUrl !== undefined ? { variantUrl } : {}),
      ...(controlUrl !== undefined ? { controlUrl } : {}),
    });
  }

  let added = 0;
  let modified = 0;
  let removed = 0;
  let unchanged = 0;

  for (const entry of experiences) {
    if (entry.status === "added") added += 1;
    else if (entry.status === "modified") modified += 1;
    else if (entry.status === "removed") removed += 1;
    else unchanged += 1;
  }

  const summary: PrCommentSummary = {
    total: options.config.experiences.length,
    enabled: options.config.experiences.filter((exp) => exp.enabled).length,
    added,
    modified,
    removed,
    unchanged,
  };

  return {
    marker: PR_COMMENT_MARKER,
    configPath: options.configPath,
    baseConfigPath: options.baseConfigPath ?? null,
    siteUrl: options.siteUrl,
    hasBase,
    ttlSeconds,
    expiresAt,
    expiresAtIso: new Date(expiresAt * 1000).toISOString(),
    summary,
    experiences,
    warnings: options.warnings ?? [],
  };
}

function escapeMarkdownCell(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, " ");
}

function escapeInlineCode(input: string): string {
  return escapeMarkdownCell(input).replace(/`/g, "\\`");
}

function formatHoldoutPercent(holdout: number): string {
  const pct = Math.round(holdout * 1000) / 10;
  return `${pct}%`;
}

function formatTtlHuman(seconds: number): string {
  if (seconds % 86400 === 0) {
    return `${seconds / 86400}d`;
  }
  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }
  return `${seconds}s`;
}

function formatExpiryUtc(expiresAt: number): string {
  const iso = new Date(expiresAt * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function formatStatusBadge(entry: PrCommentExperienceEntry, hasBase: boolean): string {
  if (!hasBase) {
    return entry.enabled ? "`Enabled`" : "`Disabled`";
  }

  switch (entry.status) {
    case "added":
      return entry.enabled ? "`Added`" : "`Added (disabled)`";
    case "modified":
      return entry.enabled ? "`Modified`" : "`Modified (disabled)`";
    case "removed":
      return "`Removed`";
    case "unchanged":
      return entry.enabled ? "`Unchanged`" : "`Unchanged (disabled)`";
  }
}

function formatExperienceCell(entry: PrCommentExperienceEntry): string {
  const idPart = `\`${escapeInlineCode(entry.id)}\``;
  const namePart = escapeMarkdownCell(entry.name);
  const base = `${idPart} — ${namePart}`;

  if (entry.status === "modified" && entry.changedFields.length > 0) {
    const fields = entry.changedFields.map(escapeMarkdownCell).join(", ");
    return `${base}<br><sub>Changed: ${fields}</sub>`;
  }
  return base;
}

function formatPreviewCell(entry: PrCommentExperienceEntry): string {
  if (entry.status === "removed") {
    return "—";
  }
  if (!entry.enabled) {
    return "_Disabled_";
  }
  if (!entry.variantUrl) {
    return "—";
  }
  if (entry.controlUrl) {
    return `[Variant](${entry.variantUrl}) · [Control](${entry.controlUrl})`;
  }
  return `[Variant](${entry.variantUrl})`;
}

function formatTableRow(entry: PrCommentExperienceEntry, hasBase: boolean): string {
  const status = formatStatusBadge(entry, hasBase);
  const experience = formatExperienceCell(entry);
  const priority = String(entry.priority);
  const holdout = formatHoldoutPercent(entry.holdout);
  const changes = `${entry.changeCount} ${entry.changeCount === 1 ? "rule" : "rules"}`;
  const preview = formatPreviewCell(entry);
  return `| ${status} | ${experience} | ${priority} | ${holdout} | ${changes} | ${preview} |`;
}

function renderExperienceTable(
  entries: readonly PrCommentExperienceEntry[],
  hasBase: boolean,
): string[] {
  const lines = [
    "| Status | Experience | Priority | Holdout | Changes | Preview |",
    "| --- | --- | ---: | ---: | ---: | --- |",
  ];
  for (const entry of entries) {
    lines.push(formatTableRow(entry, hasBase));
  }
  return lines;
}

export function generatePrCommentMarkdown(options: GeneratePrCommentMarkdownOptions): string {
  const marker = options.marker ?? PR_COMMENT_MARKER;
  const warnings = options.warnings ?? [];
  const lines: string[] = [marker, "## Facet Preview Links", ""];

  if (options.hasBase) {
    const { added, modified, removed, unchanged } = options.summary;
    lines.push(
      `**Summary:** ${added} added · ${modified} modified · ${removed} removed · ${unchanged} unchanged`,
    );
  } else {
    const { total, enabled } = options.summary;
    const expLabel = total === 1 ? "experience" : "experiences";
    lines.push(`**Summary:** ${total} ${expLabel} (${enabled} enabled)`);
  }
  lines.push("");

  if (options.hasBase) {
    const addedEntries = options.experiences.filter((entry) => entry.status === "added");
    const modifiedEntries = options.experiences.filter((entry) => entry.status === "modified");
    const removedEntries = options.experiences.filter((entry) => entry.status === "removed");
    const unchangedEntries = options.experiences.filter((entry) => entry.status === "unchanged");

    const changedEntries = [...addedEntries, ...modifiedEntries, ...removedEntries];
    if (changedEntries.length === 0) {
      lines.push("No experience changes detected compared to base config.");
    } else {
      lines.push(...renderExperienceTable(changedEntries, true));
    }

    if (unchangedEntries.length > 0) {
      lines.push("");
      lines.push("<details>");
      lines.push(`<summary>Unchanged experiences (${unchangedEntries.length})</summary>`);
      lines.push("");
      lines.push(...renderExperienceTable(unchangedEntries, true));
      lines.push("");
      lines.push("</details>");
    }
  } else if (options.experiences.length === 0) {
    lines.push("No experiences configured in this file.");
  } else {
    lines.push(...renderExperienceTable(options.experiences, false));
  }

  if (warnings.length > 0) {
    lines.push("");
    lines.push(`> **Validation warnings (${warnings.length}):**`);
    for (const warning of warnings) {
      lines.push(
        `> - \`${escapeInlineCode(warning.code)}\`: ${escapeMarkdownCell(warning.message)}`,
      );
    }
  }

  const hasAnySignedLinks = options.experiences.some((entry) => entry.variantUrl !== undefined);
  lines.push("");
  if (hasAnySignedLinks) {
    lines.push(
      `_Signed preview links for ${escapeMarkdownCell(options.siteUrl)} expire on ${formatExpiryUtc(options.expiresAt)} (TTL: ${formatTtlHuman(options.ttlSeconds)})._`,
    );
  } else {
    lines.push(`_Preview target: ${escapeMarkdownCell(options.siteUrl)}._`);
  }

  return lines.join("\n");
}

export async function runPrCommentCommand(
  options: PrCommentCommandOptions,
  ioOverrides?: Partial<CliIO>,
): Promise<PrCommentCommandResult> {
  const io = resolveCliIO(ioOverrides);

  if (!options.url || !isValidHttpUrl(options.url)) {
    const error = `Invalid --url "${options.url ?? ""}". Provide a valid http:// or https:// URL.`;
    io.stderr(`Error: ${error}\n`);
    return { exitCode: 1, error };
  }

  const secret = (options.secret ?? io.env.FACET_PREVIEW_SECRET ?? "").trim();
  if (!secret) {
    const error =
      "Missing preview signing secret. Pass --secret <secret> or set FACET_PREVIEW_SECRET.";
    io.stderr(`Error: ${error}\n`);
    return { exitCode: 1, error };
  }

  const ttlSeconds = options.ttl ?? DEFAULT_PR_PREVIEW_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    const error = `Invalid --ttl "${String(options.ttl)}". Expected a positive integer number of seconds.`;
    io.stderr(`Error: ${error}\n`);
    return { exitCode: 1, error };
  }

  const resolvedConfigPath = path.resolve(io.cwd, options.configPath ?? "facet.yaml");
  const headValidation = await validateConfigFile(resolvedConfigPath);
  if (!headValidation.ok || !headValidation.config) {
    io.stderr(`Invalid Facet configuration: ${resolvedConfigPath}\n`);
    for (const err of headValidation.errors) {
      io.stderr(`${formatValidationError(err)}\n`);
    }
    return {
      exitCode: 1,
      error: `Invalid Facet configuration: ${resolvedConfigPath}`,
      errors: headValidation.errors,
    };
  }

  let baseConfig: FacetConfig | undefined;
  let resolvedBasePath: string | null = null;
  if (options.baseConfigPath !== undefined) {
    resolvedBasePath = path.resolve(io.cwd, options.baseConfigPath);
    const baseValidation = await validateConfigFile(resolvedBasePath);
    if (!baseValidation.ok || !baseValidation.config) {
      io.stderr(`Invalid base Facet configuration: ${resolvedBasePath}\n`);
      for (const err of baseValidation.errors) {
        io.stderr(`${formatValidationError(err)}\n`);
      }
      return {
        exitCode: 1,
        error: `Invalid base Facet configuration: ${resolvedBasePath}`,
        errors: baseValidation.errors,
      };
    }
    baseConfig = baseValidation.config;
  }

  const report = await buildPrCommentReport({
    config: headValidation.config,
    ...(baseConfig !== undefined ? { baseConfig } : {}),
    configPath: resolvedConfigPath,
    baseConfigPath: resolvedBasePath,
    siteUrl: options.url,
    secret,
    ttlSeconds,
    ...(options.now !== undefined ? { now: options.now } : {}),
    warnings: headValidation.warnings,
  });

  const markdown = generatePrCommentMarkdown(report);

  if (options.json === true) {
    io.stdout(`${JSON.stringify({ ...report, markdown }, null, 2)}\n`);
  } else {
    io.stdout(`${markdown}\n`);
  }

  return {
    exitCode: 0,
    report,
    markdown,
  };
}
