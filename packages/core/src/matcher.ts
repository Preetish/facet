import type { ContextPrimitive, RequestContext } from "./context.js";
import type { MatchCondition, MatchOperator, MatchScalar, MatchValue } from "./schema.js";

const FORBIDDEN_PARAM_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const PARAM_SEGMENT_PATTERN = /^:([a-zA-Z_][a-zA-Z0-9_]*)$/;

export interface PathMatchResult {
  matched: boolean;
  params: Record<string, string>;
}

export interface ConditionMatchResult {
  matched: boolean;
  params: Record<string, string>;
}

function escapeRegExpChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeDecodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function globSegmentToRegexSource(segment: string): string {
  let regexSource = "";
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i];
    if (ch === undefined) break;

    if (ch === "*") {
      if (segment[i + 1] === "*") {
        regexSource += ".*";
        i += 2;
      } else {
        regexSource += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regexSource += "[^/]";
      i += 1;
    } else {
      regexSource += escapeRegExpChar(ch);
      i += 1;
    }
  }
  return regexSource;
}

export function matchGlob(pattern: string, value: string): boolean {
  const regexSource = `^${globSegmentToRegexSource(pattern)}$`;
  return new RegExp(regexSource).test(value);
}

/**
 * Matches a URL path against a pattern supporting exact paths, globs (`*`, `**`, `?`),
 * and named `:param` segments (e.g. `/for/:acct`, `/:locale/pricing/**`).
 * Extracted parameter values are safely URL-decoded and guarded against prototype pollution.
 */
export function matchPathPattern(pattern: string, path: string): PathMatchResult {
  if (!pattern.includes("*") && !pattern.includes("?") && !pattern.includes(":")) {
    return { matched: pattern === path, params: {} };
  }

  const segments = pattern.split("/");
  const paramNames: string[] = [];
  let regexSource = "^";

  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      regexSource += "/";
    }
    const seg = segments[i] ?? "";
    const paramMatch = PARAM_SEGMENT_PATTERN.exec(seg);
    if (paramMatch && paramMatch[1] !== undefined) {
      paramNames.push(paramMatch[1]);
      regexSource += "([^/]+)";
    } else {
      regexSource += globSegmentToRegexSource(seg);
    }
  }
  regexSource += "$";

  const match = new RegExp(regexSource).exec(path);
  if (!match) {
    return { matched: false, params: {} };
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < paramNames.length; i++) {
    const name = paramNames[i];
    const rawValue = match[i + 1];
    if (name !== undefined && rawValue !== undefined && !FORBIDDEN_PARAM_NAMES.has(name)) {
      params[name] = safeDecodePathSegment(rawValue);
    }
  }

  return { matched: true, params };
}

function isMatchOperator(value: MatchValue): value is MatchOperator {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: ContextPrimitive): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function matchScalarWithParams(
  actual: ContextPrimitive | undefined,
  expected: MatchScalar,
  allowPathPattern: boolean,
): PathMatchResult {
  if (actual === undefined) {
    return { matched: false, params: {} };
  }
  if (allowPathPattern && typeof expected === "string") {
    return matchPathPattern(expected, String(actual));
  }
  return { matched: actual === expected, params: {} };
}

function matchOperatorWithParams(
  actual: ContextPrimitive | undefined,
  operator: MatchOperator,
  allowPathPattern: boolean,
): PathMatchResult {
  if (operator.exists !== undefined) {
    const doesExist = actual !== undefined;
    if (doesExist !== operator.exists) {
      return { matched: false, params: {} };
    }
  }

  const hasNonExistsOp =
    operator.equals !== undefined ||
    operator.in !== undefined ||
    operator.contains !== undefined ||
    operator.startsWith !== undefined ||
    operator.endsWith !== undefined ||
    operator.regex !== undefined ||
    operator.gt !== undefined ||
    operator.gte !== undefined ||
    operator.lt !== undefined ||
    operator.lte !== undefined;

  if (!hasNonExistsOp) {
    return { matched: true, params: {} };
  }

  if (actual === undefined) {
    return { matched: false, params: {} };
  }

  if (operator.equals !== undefined && actual !== operator.equals) {
    return { matched: false, params: {} };
  }

  let capturedParams: Record<string, string> = {};
  if (operator.in !== undefined) {
    let matchedIn = false;
    for (const candidate of operator.in) {
      const res = matchScalarWithParams(actual, candidate, allowPathPattern);
      if (res.matched) {
        matchedIn = true;
        capturedParams = res.params;
        break;
      }
    }
    if (!matchedIn) {
      return { matched: false, params: {} };
    }
  }

  if (operator.contains !== undefined && !String(actual).includes(operator.contains)) {
    return { matched: false, params: {} };
  }

  if (operator.startsWith !== undefined && !String(actual).startsWith(operator.startsWith)) {
    return { matched: false, params: {} };
  }

  if (operator.endsWith !== undefined && !String(actual).endsWith(operator.endsWith)) {
    return { matched: false, params: {} };
  }

  if (operator.regex !== undefined) {
    try {
      if (!new RegExp(operator.regex).test(String(actual))) {
        return { matched: false, params: {} };
      }
    } catch {
      return { matched: false, params: {} };
    }
  }

  if (
    operator.gt !== undefined ||
    operator.gte !== undefined ||
    operator.lt !== undefined ||
    operator.lte !== undefined
  ) {
    const numeric = toFiniteNumber(actual);
    if (numeric === undefined) {
      return { matched: false, params: {} };
    }
    if (operator.gt !== undefined && !(numeric > operator.gt))
      return { matched: false, params: {} };
    if (operator.gte !== undefined && !(numeric >= operator.gte))
      return { matched: false, params: {} };
    if (operator.lt !== undefined && !(numeric < operator.lt))
      return { matched: false, params: {} };
    if (operator.lte !== undefined && !(numeric <= operator.lte))
      return { matched: false, params: {} };
  }

  return { matched: true, params: capturedParams };
}

function matchesValueWithParams(
  actual: ContextPrimitive | undefined,
  expected: MatchValue,
  allowPathPattern: boolean,
): PathMatchResult {
  if (Array.isArray(expected)) {
    for (const item of expected) {
      const res = matchScalarWithParams(actual, item, allowPathPattern);
      if (res.matched) {
        return res;
      }
    }
    return { matched: false, params: {} };
  }
  if (isMatchOperator(expected)) {
    return matchOperatorWithParams(actual, expected, allowPathPattern);
  }
  return matchScalarWithParams(actual, expected, allowPathPattern);
}

export function matchesPathValue(expected: MatchValue, path: string): PathMatchResult {
  return matchesValueWithParams(path, expected, true);
}

function getOwnField(
  record: Record<string, ContextPrimitive | undefined>,
  key: string,
): ContextPrimitive | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function resolveFieldValue(context: RequestContext, key: string): ContextPrimitive | undefined {
  switch (key) {
    case "path":
      return context.path;
    case "host":
      return context.host;
    case "utm_source":
      return context.utm_source;
    case "utm_medium":
      return context.utm_medium;
    case "utm_campaign":
      return context.utm_campaign;
    case "utm_term":
      return context.utm_term;
    case "utm_content":
      return context.utm_content;
    case "referrer":
      return context.referrer;
    case "returning":
      return context.returning;
    default:
      break;
  }

  const dotIndex = key.indexOf(".");
  if (dotIndex <= 0) {
    return undefined;
  }

  const prefix = key.slice(0, dotIndex);
  const subKey = key.slice(dotIndex + 1);
  if (subKey.length === 0) {
    return undefined;
  }

  switch (prefix) {
    case "query":
      return getOwnField(context.query, subKey);
    case "cookie":
      return getOwnField(context.cookies, subKey);
    case "header":
      return getOwnField(context.headers, subKey.toLowerCase());
    case "geo":
      return getOwnField(context.geo, subKey);
    case "company":
      return getOwnField(context.company, subKey);
    default:
      return undefined;
  }
}

function isNestedRecordKey(key: string): key is "query" | "cookie" | "header" | "geo" | "company" {
  return (
    key === "query" || key === "cookie" || key === "header" || key === "geo" || key === "company"
  );
}

function mergeParams(
  target: Record<string, string>,
  source: Readonly<Record<string, string>>,
): void {
  for (const [k, v] of Object.entries(source)) {
    if (!FORBIDDEN_PARAM_NAMES.has(k)) {
      target[k] = v;
    }
  }
}

export function matchesConditionWithParams(
  condition: MatchCondition,
  context: RequestContext,
): ConditionMatchResult {
  const params: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(condition)) {
    if (rawValue === undefined) {
      continue;
    }

    if (key === "all") {
      const subConditions = rawValue as MatchCondition[];
      for (const sub of subConditions) {
        const subResult = matchesConditionWithParams(sub, context);
        if (!subResult.matched) {
          return { matched: false, params: {} };
        }
        mergeParams(params, subResult.params);
      }
      continue;
    }

    if (key === "any") {
      const subConditions = rawValue as MatchCondition[];
      let anyMatched = false;
      for (const sub of subConditions) {
        const subResult = matchesConditionWithParams(sub, context);
        if (subResult.matched) {
          anyMatched = true;
          mergeParams(params, subResult.params);
          break;
        }
      }
      if (!anyMatched) {
        return { matched: false, params: {} };
      }
      continue;
    }

    if (key === "not") {
      const subCondition = rawValue as MatchCondition;
      if (matchesConditionWithParams(subCondition, context).matched) {
        return { matched: false, params: {} };
      }
      continue;
    }

    if (isNestedRecordKey(key)) {
      const nestedMap = rawValue as Record<string, MatchValue>;
      for (const [subKey, expected] of Object.entries(nestedMap)) {
        const actual = resolveFieldValue(context, `${key}.${subKey}`);
        if (!matchesValueWithParams(actual, expected, false).matched) {
          return { matched: false, params: {} };
        }
      }
      continue;
    }

    const actual = resolveFieldValue(context, key);
    const allowPathPattern = key === "path";
    const fieldResult = matchesValueWithParams(actual, rawValue as MatchValue, allowPathPattern);
    if (!fieldResult.matched) {
      return { matched: false, params: {} };
    }
    if (allowPathPattern) {
      mergeParams(params, fieldResult.params);
    }
  }

  return { matched: true, params };
}

export function matchesCondition(condition: MatchCondition, context: RequestContext): boolean {
  return matchesConditionWithParams(condition, context).matched;
}

/**
 * Best-effort extraction of named `:param` path parameters from a `MatchCondition`
 * against a path, ignoring non-path predicates (used for preview mode).
 */
export function extractPathParams(condition: MatchCondition, path: string): Record<string, string> {
  const params: Record<string, string> = {};

  if (condition.path !== undefined) {
    const res = matchesPathValue(condition.path, path);
    if (res.matched) {
      mergeParams(params, res.params);
    }
  }

  if (condition.all !== undefined) {
    for (const sub of condition.all) {
      mergeParams(params, extractPathParams(sub, path));
    }
  }

  if (condition.any !== undefined) {
    for (const sub of condition.any) {
      const subParams = extractPathParams(sub, path);
      if (Object.keys(subParams).length > 0) {
        mergeParams(params, subParams);
        break;
      }
    }
  }

  return params;
}
