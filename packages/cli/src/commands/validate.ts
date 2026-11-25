import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseFacetYaml,
  validateTemplateSyntax,
  type FacetConfig,
  type FacetExperience,
  type FacetValidationError,
  type MatchCondition,
  type MatchValue,
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
    | "duplicate_priority_match"
    | "missing_data_table"
    | "unreferenced_path_param"
    | "suspicious_origin_path";
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

function hasRequiredLookup(lookup: FacetExperience["lookup"]): boolean {
  return lookup !== undefined && lookup.required !== false;
}

function canonicalizeExperienceMatch(experience: FacetExperience): string {
  return JSON.stringify(
    canonicalizeValue({
      match: experience.match,
      lookup: hasRequiredLookup(experience.lookup)
        ? { table: experience.lookup?.table, key: experience.lookup?.key }
        : null,
    }),
  );
}

function isWildcardMatch(
  match: FacetExperience["match"],
  lookup?: FacetExperience["lookup"],
): boolean {
  if (hasRequiredLookup(lookup)) {
    return false;
  }
  return Object.keys(match).length === 0;
}

const PARAM_SEGMENT_PATTERN = /^:([a-zA-Z_][a-zA-Z0-9_]*)$/;

function extractParamsFromPathPattern(pattern: string, out: Set<string>): void {
  for (const seg of pattern.split("/")) {
    const match = PARAM_SEGMENT_PATTERN.exec(seg);
    if (match?.[1] !== undefined) {
      out.add(match[1]);
    }
  }
}

function extractParamsFromMatchValue(value: MatchValue, out: Set<string>): void {
  if (typeof value === "string") {
    extractParamsFromPathPattern(value, out);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        extractParamsFromPathPattern(item, out);
      }
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    if (typeof value.equals === "string") {
      extractParamsFromPathPattern(value.equals, out);
    }
    if (Array.isArray(value.in)) {
      for (const item of value.in) {
        if (typeof item === "string") {
          extractParamsFromPathPattern(item, out);
        }
      }
    }
  }
}

function extractDeclaredPathParams(
  condition: MatchCondition,
  out: Set<string> = new Set(),
): Set<string> {
  if (condition.path !== undefined) {
    extractParamsFromMatchValue(condition.path, out);
  }
  if (condition.all !== undefined) {
    for (const sub of condition.all) {
      extractDeclaredPathParams(sub, out);
    }
  }
  if (condition.any !== undefined) {
    for (const sub of condition.any) {
      extractDeclaredPathParams(sub, out);
    }
  }
  return out;
}

function findPipeOutsideQuotes(inner: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === undefined) break;
    if (quote !== null) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "|") {
      return i;
    }
  }
  return -1;
}

function extractReferencedParamsFromTemplate(template: string, out: Set<string>): void {
  if (!template.includes("{{")) {
    return;
  }
  let i = 0;
  while (i < template.length) {
    if (template[i] === "{" && template[i + 1] === "{") {
      let j = i + 2;
      let quote: '"' | "'" | null = null;
      let endIdx = -1;
      while (j < template.length) {
        const ch = template[j];
        const nxt = template[j + 1];
        if (quote !== null) {
          if (ch === "\\") {
            j += 2;
            continue;
          }
          if (ch === quote) {
            quote = null;
          }
          j += 1;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          j += 1;
          continue;
        }
        if (ch === "}" && nxt === "}") {
          endIdx = j;
          break;
        }
        j += 1;
      }
      if (endIdx === -1) {
        break;
      }
      const inner = template.slice(i + 2, endIdx).trim();
      const pipeIdx = findPipeOutsideQuotes(inner);
      const varExpr = (pipeIdx === -1 ? inner : inner.slice(0, pipeIdx)).trim();
      if (varExpr.startsWith("params.") && varExpr.length > "params.".length) {
        out.add(varExpr.slice("params.".length));
      }
      i = endIdx + 2;
      continue;
    }
    i += 1;
  }
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function checkSuspiciousOriginPath(originPath: string): string | null {
  if (!originPath.startsWith("/")) {
    return 'does not start with "/"';
  }
  if (originPath.startsWith("//")) {
    return 'starts with "//" (protocol-relative path)';
  }
  if (originPath.includes("://")) {
    return 'contains "://" (full URL scheme is not allowed)';
  }
  if (/[\r\n]/.test(originPath)) {
    return "contains newline characters";
  }
  if (originPath.includes("\\") || /%5c/i.test(originPath)) {
    return "contains backslash characters";
  }
  const pathnamePart = originPath.split(/[?#]/, 1)[0] ?? "";
  const decodedPathname = safeDecodeUri(pathnamePart);
  if (/(^|\/)\.\.(\/|$)/.test(pathnamePart) || /(^|\/)\.\.(\/|$)/.test(decodedPathname)) {
    return 'contains ".." path traversal segment';
  }
  if (originPath.includes("#")) {
    return 'contains "#" URL fragment (fragments are not sent to origin servers)';
  }
  if (originPath.startsWith("/{{")) {
    return 'starts with "/{{...}}" which may resolve to a protocol-relative path if the variable begins with "/"';
  }
  return null;
}

function validateTemplateField(
  value: string,
  fieldPath: string,
  errors: FacetValidationError[],
): void {
  const result = validateTemplateSyntax(value);
  if (!result.valid) {
    for (const err of result.errors) {
      errors.push({
        path: fieldPath,
        code: "invalid_template_syntax",
        message: `Invalid template syntax: ${err.message} (${err.expression})`,
      });
    }
  }
}

export function collectTemplateErrors(config: FacetConfig): FacetValidationError[] {
  const errors: FacetValidationError[] = [];

  for (const [slotName, slotHtml] of Object.entries(config.settings.slots)) {
    validateTemplateField(slotHtml, `settings.slots.${slotName}`, errors);
  }

  for (let i = 0; i < config.experiences.length; i++) {
    const exp = config.experiences[i];
    if (!exp) continue;

    if (exp.originPath !== undefined) {
      validateTemplateField(exp.originPath, `experiences[${i}].originPath`, errors);
    }

    if (exp.lookup !== undefined) {
      validateTemplateField(exp.lookup.key, `experiences[${i}].lookup.key`, errors);
    }

    for (let j = 0; j < exp.changes.length; j++) {
      const change = exp.changes[j];
      if (!change) continue;
      const basePath = `experiences[${i}].changes[${j}]`;

      if (change.text !== undefined) {
        validateTemplateField(change.text, `${basePath}.text`, errors);
      }
      if (change.html !== undefined) {
        validateTemplateField(change.html, `${basePath}.html`, errors);
      }
      if (change.slot !== undefined) {
        validateTemplateField(change.slot, `${basePath}.slot`, errors);
      }
      if (change.prepend !== undefined) {
        validateTemplateField(change.prepend, `${basePath}.prepend`, errors);
      }
      if (change.append !== undefined) {
        validateTemplateField(change.append, `${basePath}.append`, errors);
      }
      if (change.attrs !== undefined) {
        for (const [attrName, attrValue] of Object.entries(change.attrs)) {
          if (typeof attrValue === "string") {
            validateTemplateField(attrValue, `${basePath}.attrs.${attrName}`, errors);
          }
        }
      }
    }
  }

  return errors;
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

    if (exp.originPath !== undefined) {
      const suspiciousReason = checkSuspiciousOriginPath(exp.originPath);
      if (suspiciousReason !== null) {
        warnings.push({
          code: "suspicious_origin_path",
          experienceId: exp.id,
          message: `Experience "${exp.id}" has suspicious originPath "${exp.originPath}" (${suspiciousReason}).`,
        });
      }
    }

    if (exp.lookup !== undefined) {
      const hasTable =
        config.data !== undefined &&
        Object.prototype.hasOwnProperty.call(config.data, exp.lookup.table);
      if (!hasTable) {
        warnings.push({
          code: "missing_data_table",
          experienceId: exp.id,
          message: `Experience "${exp.id}" lookup references table "${exp.lookup.table}", which is not defined in top-level "data".`,
        });
      }
    }

    const declaredParams = extractDeclaredPathParams(exp.match);
    const referencedParams = new Set<string>();
    if (exp.originPath !== undefined) {
      extractReferencedParamsFromTemplate(exp.originPath, referencedParams);
    }
    if (exp.lookup !== undefined) {
      extractReferencedParamsFromTemplate(exp.lookup.key, referencedParams);
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

      if (change.text !== undefined) {
        extractReferencedParamsFromTemplate(change.text, referencedParams);
      }
      if (change.html !== undefined) {
        extractReferencedParamsFromTemplate(change.html, referencedParams);
      }
      if (change.slot !== undefined) {
        extractReferencedParamsFromTemplate(change.slot, referencedParams);
        if (
          !change.slot.includes("{{") &&
          Object.prototype.hasOwnProperty.call(config.settings.slots, change.slot)
        ) {
          const slotBody = config.settings.slots[change.slot];
          if (slotBody !== undefined) {
            extractReferencedParamsFromTemplate(slotBody, referencedParams);
          }
        }
      }
      if (change.prepend !== undefined) {
        extractReferencedParamsFromTemplate(change.prepend, referencedParams);
      }
      if (change.append !== undefined) {
        extractReferencedParamsFromTemplate(change.append, referencedParams);
      }
      if (change.attrs !== undefined) {
        for (const attrValue of Object.values(change.attrs)) {
          if (typeof attrValue === "string") {
            extractReferencedParamsFromTemplate(attrValue, referencedParams);
          }
        }
      }
    }

    for (const paramName of referencedParams) {
      if (!declaredParams.has(paramName)) {
        warnings.push({
          code: "unreferenced_path_param",
          experienceId: exp.id,
          message: `Experience "${exp.id}" references "{{params.${paramName}}}", but no ":${paramName}" parameter is declared in its path matcher.`,
        });
      }
    }
  }

  const enabledOrdered = config.experiences
    .map((experience, index) => ({
      experience,
      index,
      canonicalMatchOnly: canonicalizeMatch(experience.match),
      canonicalEffectiveMatch: canonicalizeExperienceMatch(experience),
      hasRequiredLookup: hasRequiredLookup(experience.lookup),
      wildcard: isWildcardMatch(experience.match, experience.lookup),
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

      const sameEffectiveMatch =
        earlier.canonicalEffectiveMatch === current.canonicalEffectiveMatch;
      const earlierSubsumesMatch =
        earlier.canonicalMatchOnly === current.canonicalMatchOnly && !earlier.hasRequiredLookup;
      const samePriority = earlier.experience.priority === current.experience.priority;

      if (
        earlier.experience.stopOnMatch &&
        (earlier.wildcard || sameEffectiveMatch || earlierSubsumesMatch)
      ) {
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

      if (samePriority && sameEffectiveMatch) {
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

  const templateErrors = collectTemplateErrors(parsed.config);
  if (templateErrors.length > 0) {
    return {
      ok: false,
      exitCode: 1,
      configPath,
      config: parsed.config,
      errors: templateErrors,
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
