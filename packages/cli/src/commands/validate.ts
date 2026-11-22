import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseFacetYaml,
  type FacetConfig,
  type FacetExperience,
  type FacetValidationError,
} from "@facet/core";
import { HTMLRewriter } from "html-rewriter-wasm";
import { resolveCliIO, type CliIO } from "../io.js";

export interface ValidationWarning {
  code:
    | "empty_experiences"
    | "disabled_experience"
    | "full_holdout"
    | "invalid_selector"
    | "shadowed_experience"
    | "duplicate_priority_match";
  message: string;
  experienceId?: string;
  selector?: string;
}

export interface ValidateResult {
  ok: boolean;
  exitCode: number;
  configPath: string;
  config?: FacetConfig;
  errors: FacetValidationError[];
  warnings: ValidationWarning[];
}

export interface SelectorCheckResult {
  valid: boolean;
  reason?: string;
}

function hasUnbalancedDelimiters(selector: string): string | null {
  let bracketDepth = 0;
  let parenDepth = 0;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === undefined) continue;

    if (quote !== null) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "[") {
      bracketDepth++;
    } else if (ch === "]") {
      bracketDepth--;
      if (bracketDepth < 0) return "unmatched closing ']'";
    } else if (ch === "(") {
      parenDepth++;
    } else if (ch === ")") {
      parenDepth--;
      if (parenDepth < 0) return "unmatched closing ')'";
    }
  }

  if (quote !== null) return `unclosed string quote (${quote})`;
  if (bracketDepth !== 0) return "unclosed '[' attribute selector";
  if (parenDepth !== 0) return "unclosed '(' pseudo-class";
  return null;
}

export function checkCssSelector(selector: string): SelectorCheckResult {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: "selector is empty" };
  }

  const delimiterIssue = hasUnbalancedDelimiters(trimmed);
  if (delimiterIssue !== null) {
    return { valid: false, reason: delimiterIssue };
  }

  if (/(^|,\s*)[>+~]/.test(trimmed) || /[>+~,]\s*$/.test(trimmed)) {
    return { valid: false, reason: "dangling combinator or comma in selector" };
  }

  const rewriter = new HTMLRewriter(() => {
    // Discard output; used strictly to validate selector syntax with lol-html.
  });
  try {
    rewriter.on(trimmed, {});
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    rewriter.free();
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
      sorted[key] = canonicalizeValue(record[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalizeMatch(match: FacetExperience["match"]): string {
  return JSON.stringify(canonicalizeValue(match));
}

function isWildcardMatch(match: FacetExperience["match"]): boolean {
  return Object.keys(match).length === 0;
}

export function collectConfigWarnings(config: FacetConfig): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  if (config.experiences.length === 0) {
    warnings.push({
      code: "empty_experiences",
      message: "No experiences are defined in facet.yaml.",
    });
    return warnings;
  }

  for (const exp of config.experiences) {
    if (!exp.enabled) {
      warnings.push({
        code: "disabled_experience",
        experienceId: exp.id,
        message: `Experience "${exp.id}" is disabled (enabled: false).`,
      });
    }

    if (exp.holdout === 1) {
      warnings.push({
        code: "full_holdout",
        experienceId: exp.id,
        message: `Experience "${exp.id}" has holdout: 1 (100% control) and will never serve its variant.`,
      });
    }

    for (const change of exp.changes) {
      const check = checkCssSelector(change.selector);
      if (!check.valid) {
        warnings.push({
          code: "invalid_selector",
          experienceId: exp.id,
          selector: change.selector,
          message: `Experience "${exp.id}" has an invalid or unsupported CSS selector "${change.selector}"${check.reason ? ` (${check.reason})` : ""}.`,
        });
      }
    }
  }

  const enabledOrdered = config.experiences
    .map((experience, index) => ({
      experience,
      index,
      canonicalMatch: canonicalizeMatch(experience.match),
      wildcard: isWildcardMatch(experience.match),
    }))
    .filter(({ experience }) => experience.enabled)
    .sort((a, b) => {
      if (b.experience.priority !== a.experience.priority) {
        return b.experience.priority - a.experience.priority;
      }
      return a.index - b.index;
    });

  for (let i = 0; i < enabledOrdered.length; i++) {
    const current = enabledOrdered[i];
    if (!current) continue;

    for (let j = 0; j < i; j++) {
      const earlier = enabledOrdered[j];
      if (!earlier) continue;

      const sameMatch = earlier.canonicalMatch === current.canonicalMatch;
      const samePriority = earlier.experience.priority === current.experience.priority;

      if (earlier.experience.stopOnMatch && (earlier.wildcard || sameMatch)) {
        const reason = earlier.wildcard
          ? `matches all requests`
          : samePriority
            ? `has identical match conditions and the same priority (${earlier.experience.priority})`
            : `has identical match conditions with higher priority (${earlier.experience.priority} > ${current.experience.priority})`;
        warnings.push({
          code: "shadowed_experience",
          experienceId: current.experience.id,
          message: `Experience "${current.experience.id}" is shadowed by "${earlier.experience.id}" (stopOnMatch: true, ${reason}).`,
        });
        break;
      }

      if (samePriority && sameMatch) {
        warnings.push({
          code: "duplicate_priority_match",
          experienceId: current.experience.id,
          message: `Experience "${current.experience.id}" shares priority ${current.experience.priority} and identical match conditions with "${earlier.experience.id}".`,
        });
        break;
      }
    }
  }

  return warnings;
}

export function formatValidationError(error: FacetValidationError): string {
  const location =
    error.line !== undefined
      ? `Line ${error.line}${error.column !== undefined ? `, col ${error.column}` : ""}`
      : "Config";
  return `  - ${location} [${error.path}]: ${error.message}`;
}

export async function validateConfigFile(configPath: string): Promise<ValidateResult> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      exitCode: 1,
      configPath,
      errors: [
        {
          path: "$",
          code: "file_read_error",
          message: `Unable to read "${configPath}": ${message}`,
        },
      ],
      warnings: [],
    };
  }

  const parsed = parseFacetYaml(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      exitCode: 1,
      configPath,
      errors: parsed.errors,
      warnings: [],
    };
  }

  const warnings = collectConfigWarnings(parsed.config);
  return {
    ok: true,
    exitCode: 0,
    configPath,
    config: parsed.config,
    errors: [],
    warnings,
  };
}

export async function runValidateCommand(
  configArg?: string,
  ioOverrides?: Partial<CliIO>,
): Promise<ValidateResult> {
  const io = resolveCliIO(ioOverrides);
  const resolvedPath = path.resolve(io.cwd, configArg ?? "facet.yaml");
  const result = await validateConfigFile(resolvedPath);

  if (!result.ok) {
    io.stderr(`Invalid Facet configuration: ${resolvedPath}\n`);
    for (const err of result.errors) {
      io.stderr(`${formatValidationError(err)}\n`);
    }
    return result;
  }

  const config = result.config;
  const total = config?.experiences.length ?? 0;
  const enabledCount = config?.experiences.filter((exp) => exp.enabled).length ?? 0;
  const providers = config?.settings.analytics.providers ?? [];
  const slotCount = Object.keys(config?.settings.slots ?? {}).length;

  io.stdout(`Valid Facet configuration: ${resolvedPath}\n`);
  io.stdout(
    `  Experiences: ${total} total (${enabledCount} enabled), Slots: ${slotCount}, Analytics: ${providers.length > 0 ? providers.join(", ") : "none"}\n`,
  );

  if (result.warnings.length > 0) {
    io.stdout(`Warnings (${result.warnings.length}):\n`);
    for (const warning of result.warnings) {
      io.stdout(`  ! [${warning.code}] ${warning.message}\n`);
    }
  }

  return result;
}
