import type { ContextPrimitive, RequestContext } from "./context.js";

export const TEMPLATE_NAMESPACES = ["data", "company", "query", "geo", "params"] as const;
export type TemplateNamespace = (typeof TEMPLATE_NAMESPACES)[number];

export const TEMPLATE_TOP_LEVEL_VARS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;
export type TemplateTopLevelVar = (typeof TEMPLATE_TOP_LEVEL_VARS)[number];

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const NAMESPACE_SET = new Set<string>(TEMPLATE_NAMESPACES);
const TOP_LEVEL_VAR_SET = new Set<string>(TEMPLATE_TOP_LEVEL_VARS);
const FIELD_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

export function isForbiddenTemplateKey(key: string): boolean {
  if (FORBIDDEN_KEYS.has(key)) {
    return true;
  }
  if (key.includes(".")) {
    return key.split(".").some((part) => FORBIDDEN_KEYS.has(part));
  }
  return false;
}

export interface TemplateContext {
  data?: Readonly<Record<string, ContextPrimitive | undefined>>;
  company?: Readonly<Record<string, ContextPrimitive | undefined>>;
  query?: Readonly<Record<string, string | undefined>>;
  geo?: Readonly<Record<string, ContextPrimitive | undefined>>;
  params?: Readonly<Record<string, string | undefined>>;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
}

export interface BuildTemplateContextExtras {
  params?: Readonly<Record<string, string>>;
  data?: Readonly<Record<string, ContextPrimitive>>;
}

export interface InterpolateOptions {
  escapeHtml?: boolean;
}

export interface TemplateSyntaxError {
  message: string;
  index: number;
  expression: string;
}

export interface TemplateValidationResult {
  valid: boolean;
  errors: TemplateSyntaxError[];
}

interface ParsedPlaceholder {
  namespace?: TemplateNamespace;
  field?: string;
  topLevelVar?: TemplateTopLevelVar;
  defaultValue?: string;
}

type ParsePlaceholderResult =
  { ok: true; parsed: ParsedPlaceholder } | { ok: false; error: string };

interface TokenMatch {
  start: number;
  end: number;
  raw: string;
  inner: string;
}

function parseQuotedString(
  input: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const quote = input[0];
  if (quote !== '"' && quote !== "'") {
    return {
      ok: false,
      error: 'default() argument must be a quoted string (e.g. default("fallback"))',
    };
  }
  if (input.length < 2 || input[input.length - 1] !== quote) {
    return { ok: false, error: "Unterminated quoted string in default() filter" };
  }

  let out = "";
  let i = 1;
  const end = input.length - 1;
  while (i < end) {
    const ch = input[i];
    if (ch === undefined) break;
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === undefined || i + 1 >= end) {
        return { ok: false, error: "Invalid trailing escape in default() string" };
      }
      if (next === "n") {
        out += "\n";
      } else if (next === "t") {
        out += "\t";
      } else if (next === "r") {
        out += "\r";
      } else {
        out += next;
      }
      i += 2;
      continue;
    }
    if (ch === quote) {
      return { ok: false, error: "Unescaped quote inside default() string" };
    }
    out += ch;
    i += 1;
  }

  return { ok: true, value: out };
}

function parseDefaultFilter(
  filterRaw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = filterRaw.trim();
  const match = /^default\s*\(([\s\S]*)\)$/.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      error: `Unsupported template filter "${trimmed}". Only default("...") is supported`,
    };
  }
  const arg = (match[1] ?? "").trim();
  return parseQuotedString(arg);
}

function findPipeIndex(inner: string): number {
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

function parsePlaceholderExpression(inner: string): ParsePlaceholderResult {
  const trimmed = inner.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Empty template placeholder {{}}" };
  }

  const pipeIdx = findPipeIndex(trimmed);
  const varExpr = (pipeIdx === -1 ? trimmed : trimmed.slice(0, pipeIdx)).trim();
  const filterExpr = pipeIdx === -1 ? undefined : trimmed.slice(pipeIdx + 1).trim();

  if (varExpr.length === 0) {
    return { ok: false, error: "Missing variable expression before '|'" };
  }

  if (isForbiddenTemplateKey(varExpr)) {
    return { ok: false, error: `Forbidden prototype key in template expression "${varExpr}"` };
  }

  let parsed: ParsedPlaceholder;

  if (TOP_LEVEL_VAR_SET.has(varExpr)) {
    parsed = { topLevelVar: varExpr as TemplateTopLevelVar };
  } else {
    const dotIdx = varExpr.indexOf(".");
    if (dotIdx <= 0 || dotIdx === varExpr.length - 1) {
      return {
        ok: false,
        error: `Unknown or invalid template variable "${varExpr}". Allowed roots: data.*, company.*, query.*, geo.*, params.*, utm_source, utm_medium, utm_campaign, utm_term, utm_content`,
      };
    }

    const namespace = varExpr.slice(0, dotIdx);
    const field = varExpr.slice(dotIdx + 1);

    if (!NAMESPACE_SET.has(namespace)) {
      return {
        ok: false,
        error: `Unsupported template namespace "${namespace}" in "${varExpr}"`,
      };
    }

    if (isForbiddenTemplateKey(field)) {
      return { ok: false, error: `Forbidden prototype key in template expression "${varExpr}"` };
    }

    if (!FIELD_PATTERN.test(field) || field.endsWith(".") || field.includes("..")) {
      return { ok: false, error: `Invalid template field name "${field}" in "${varExpr}"` };
    }

    parsed = {
      namespace: namespace as TemplateNamespace,
      field,
    };
  }

  if (filterExpr !== undefined) {
    if (filterExpr.length === 0) {
      return { ok: false, error: "Missing filter after '|'" };
    }
    const filterResult = parseDefaultFilter(filterExpr);
    if (!filterResult.ok) {
      return filterResult;
    }
    parsed.defaultValue = filterResult.value;
  }

  return { ok: true, parsed };
}

function scanPlaceholders(template: string): {
  tokens: TokenMatch[];
  errors: TemplateSyntaxError[];
} {
  const tokens: TokenMatch[] = [];
  const errors: TemplateSyntaxError[] = [];
  let i = 0;

  while (i < template.length) {
    const ch = template[i];
    const next = template[i + 1];

    if (ch === "}" && next === "}") {
      errors.push({
        message: 'Unmatched closing "}}" in template',
        index: i,
        expression: "}}",
      });
      i += 2;
      continue;
    }

    if (ch === "{" && next === "{") {
      const start = i;
      let j = i + 2;
      let quote: '"' | "'" | null = null;
      let foundEnd = -1;
      let nestedIndex = -1;

      while (j < template.length) {
        const cur = template[j];
        const nxt = template[j + 1];

        if (quote !== null) {
          if (cur === "\\") {
            j += 2;
            continue;
          }
          if (cur === quote) {
            quote = null;
          }
          j += 1;
          continue;
        }

        if (cur === '"' || cur === "'") {
          quote = cur;
          j += 1;
          continue;
        }

        if (cur === "{" && nxt === "{") {
          nestedIndex = j;
          break;
        }

        if (cur === "}" && nxt === "}") {
          foundEnd = j + 2;
          break;
        }

        j += 1;
      }

      if (nestedIndex !== -1) {
        errors.push({
          message: 'Nested "{{" inside template placeholder is not allowed',
          index: nestedIndex,
          expression: template.slice(start, nestedIndex + 2),
        });
        i = nestedIndex;
        continue;
      }

      if (foundEnd === -1) {
        errors.push({
          message: 'Unclosed "{{" template placeholder',
          index: start,
          expression: template.slice(start),
        });
        break;
      }

      tokens.push({
        start,
        end: foundEnd,
        raw: template.slice(start, foundEnd),
        inner: template.slice(start + 2, foundEnd - 2),
      });
      i = foundEnd;
      continue;
    }

    i += 1;
  }

  return { tokens, errors };
}

function getOwnValue(
  record: Readonly<Record<string, ContextPrimitive | undefined>> | undefined,
  key: string,
): ContextPrimitive | undefined {
  if (!record || isForbiddenTemplateKey(key)) {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function resolveParsedPlaceholder(parsed: ParsedPlaceholder, context: TemplateContext): string {
  let rawValue: ContextPrimitive | undefined;

  if (parsed.topLevelVar !== undefined) {
    rawValue = context[parsed.topLevelVar];
  } else if (parsed.namespace !== undefined && parsed.field !== undefined) {
    switch (parsed.namespace) {
      case "data":
        rawValue = getOwnValue(context.data, parsed.field);
        break;
      case "company":
        rawValue = getOwnValue(context.company, parsed.field);
        break;
      case "query":
        rawValue = getOwnValue(context.query, parsed.field);
        break;
      case "geo":
        rawValue = getOwnValue(context.geo, parsed.field);
        break;
      case "params":
        rawValue = getOwnValue(context.params, parsed.field);
        break;
    }
  }

  if (rawValue === undefined || rawValue === "") {
    return parsed.defaultValue ?? "";
  }

  return String(rawValue);
}

export function buildTemplateContext(
  context: RequestContext,
  extras?: BuildTemplateContextExtras,
): TemplateContext {
  const result: TemplateContext = {
    query: context.query,
    geo: context.geo,
    company: context.company,
  };
  if (extras?.params !== undefined) result.params = extras.params;
  if (extras?.data !== undefined) result.data = extras.data;
  if (context.utm_source !== undefined) result.utm_source = context.utm_source;
  if (context.utm_medium !== undefined) result.utm_medium = context.utm_medium;
  if (context.utm_campaign !== undefined) result.utm_campaign = context.utm_campaign;
  if (context.utm_term !== undefined) result.utm_term = context.utm_term;
  if (context.utm_content !== undefined) result.utm_content = context.utm_content;
  return result;
}

export function validateTemplateSyntax(template: string): TemplateValidationResult {
  const { tokens, errors } = scanPlaceholders(template);

  for (const token of tokens) {
    const parsed = parsePlaceholderExpression(token.inner);
    if (!parsed.ok) {
      errors.push({
        message: parsed.error,
        index: token.start,
        expression: token.raw,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function interpolateTemplate(
  template: string,
  context: TemplateContext,
  options?: InterpolateOptions,
): string {
  if (!template.includes("{{")) {
    return template;
  }

  const { tokens } = scanPlaceholders(template);
  if (tokens.length === 0) {
    return template;
  }

  const shouldEscape = options?.escapeHtml === true;
  let result = "";
  let cursor = 0;

  for (const token of tokens) {
    result += template.slice(cursor, token.start);
    const parsed = parsePlaceholderExpression(token.inner);
    if (parsed.ok) {
      const resolved = resolveParsedPlaceholder(parsed.parsed, context);
      result += shouldEscape ? escapeHtml(resolved) : resolved;
    } else {
      // Fail-open on malformed placeholder at runtime: never throw or resolve forbidden keys
      result += "";
    }
    cursor = token.end;
  }

  result += template.slice(cursor);
  return result;
}
