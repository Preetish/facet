import type { ContextPrimitive, RequestContext } from "./context.js";
import type { MatchCondition, MatchOperator, MatchScalar, MatchValue } from "./schema.js";

function escapeRegExpChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchGlob(pattern: string, value: string): boolean {
  let regexSource = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === undefined) break;

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
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
  regexSource += "$";
  return new RegExp(regexSource).test(value);
}

function isGlobPattern(value: string): boolean {
  return value.includes("*") || value.includes("?");
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

function matchScalar(
  actual: ContextPrimitive | undefined,
  expected: MatchScalar,
  allowGlob: boolean,
): boolean {
  if (actual === undefined) {
    return false;
  }
  if (allowGlob && typeof expected === "string" && isGlobPattern(expected)) {
    return matchGlob(expected, String(actual));
  }
  return actual === expected;
}

function matchOperator(
  actual: ContextPrimitive | undefined,
  operator: MatchOperator,
  allowGlob: boolean,
): boolean {
  if (operator.exists !== undefined) {
    const doesExist = actual !== undefined;
    if (doesExist !== operator.exists) {
      return false;
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
    return true;
  }

  if (actual === undefined) {
    return false;
  }

  if (operator.equals !== undefined && actual !== operator.equals) {
    return false;
  }

  if (operator.in !== undefined) {
    const matchedIn = operator.in.some((candidate) => matchScalar(actual, candidate, allowGlob));
    if (!matchedIn) {
      return false;
    }
  }

  if (operator.contains !== undefined && !String(actual).includes(operator.contains)) {
    return false;
  }

  if (operator.startsWith !== undefined && !String(actual).startsWith(operator.startsWith)) {
    return false;
  }

  if (operator.endsWith !== undefined && !String(actual).endsWith(operator.endsWith)) {
    return false;
  }

  if (operator.regex !== undefined) {
    try {
      if (!new RegExp(operator.regex).test(String(actual))) {
        return false;
      }
    } catch {
      return false;
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
      return false;
    }
    if (operator.gt !== undefined && !(numeric > operator.gt)) return false;
    if (operator.gte !== undefined && !(numeric >= operator.gte)) return false;
    if (operator.lt !== undefined && !(numeric < operator.lt)) return false;
    if (operator.lte !== undefined && !(numeric <= operator.lte)) return false;
  }

  return true;
}

function matchesValue(
  actual: ContextPrimitive | undefined,
  expected: MatchValue,
  allowGlob: boolean,
): boolean {
  if (Array.isArray(expected)) {
    return expected.some((item) => matchScalar(actual, item, allowGlob));
  }
  if (isMatchOperator(expected)) {
    return matchOperator(actual, expected, allowGlob);
  }
  return matchScalar(actual, expected, allowGlob);
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

export function matchesCondition(condition: MatchCondition, context: RequestContext): boolean {
  for (const [key, rawValue] of Object.entries(condition)) {
    if (rawValue === undefined) {
      continue;
    }

    if (key === "all") {
      const subConditions = rawValue as MatchCondition[];
      if (!subConditions.every((sub) => matchesCondition(sub, context))) {
        return false;
      }
      continue;
    }

    if (key === "any") {
      const subConditions = rawValue as MatchCondition[];
      if (!subConditions.some((sub) => matchesCondition(sub, context))) {
        return false;
      }
      continue;
    }

    if (key === "not") {
      const subCondition = rawValue as MatchCondition;
      if (matchesCondition(subCondition, context)) {
        return false;
      }
      continue;
    }

    if (isNestedRecordKey(key)) {
      const nestedMap = rawValue as Record<string, MatchValue>;
      for (const [subKey, expected] of Object.entries(nestedMap)) {
        const actual = resolveFieldValue(context, `${key}.${subKey}`);
        if (!matchesValue(actual, expected, false)) {
          return false;
        }
      }
      continue;
    }

    const actual = resolveFieldValue(context, key);
    const allowGlob = key === "path";
    if (!matchesValue(actual, rawValue as MatchValue, allowGlob)) {
      return false;
    }
  }

  return true;
}
