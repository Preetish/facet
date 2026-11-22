import {
  ANALYTICS_PROVIDERS,
  type AnalyticsProvider,
  type Bucket,
  type EvaluationResult,
  type ResolvedChange,
} from "@facet/core";

export const FACET_STATE_HEADER = "x-facet-state";
export const MAX_FACET_STATE_HEADER_BYTES = 32_768;

export interface FacetMatchedSummary {
  experienceId: string;
  bucket: Bucket;
}

export interface FacetRequestState {
  visitorId: string;
  matched: FacetMatchedSummary[];
  changes: ResolvedChange[];
  personalized: boolean;
  previewMode: boolean;
  analyticsProviders: AnalyticsProvider[];
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const VALID_PROVIDERS = new Set<string>(ANALYTICS_PROVIDERS);
const FORBIDDEN_RECORD_KEYS = new Set<string>(["__proto__", "constructor", "prototype"]);
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isBucket(value: unknown): value is Bucket {
  return value === "variant" || value === "control";
}

function isAnalyticsProvider(value: unknown): value is AnalyticsProvider {
  return typeof value === "string" && VALID_PROVIDERS.has(value);
}

function utf8ToBase64Url(input: string): string {
  const bytes = textEncoder.encode(input);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, bytes.length);
    for (let j = i; j < end; j++) {
      const byte = bytes[j];
      if (byte !== undefined) {
        binary += String.fromCharCode(byte);
      }
    }
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToUtf8(encoded: string): string | null {
  if (
    encoded.length === 0 ||
    encoded.length > MAX_FACET_STATE_HEADER_BYTES ||
    !BASE64URL_PATTERN.test(encoded)
  ) {
    return null;
  }

  const padded =
    encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (encoded.length % 4)) % 4);

  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return textDecoder.decode(bytes);
  } catch {
    return null;
  }
}

function sanitizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return undefined;
    }
    if (item.length > 0) {
      result.push(item);
    }
  }
  return result.length > 0 ? result : undefined;
}

function sanitizeAttrs(value: unknown): Record<string, string | null> | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const attrs: Record<string, string | null> = {};
  let count = 0;
  for (const key of Object.keys(value)) {
    if (!hasOwn(value, key) || FORBIDDEN_RECORD_KEYS.has(key) || key.length === 0) {
      continue;
    }
    const rawVal = value[key];
    if (typeof rawVal === "string" || rawVal === null) {
      attrs[key] = rawVal;
      count++;
    } else {
      return undefined;
    }
  }
  return count > 0 ? attrs : undefined;
}

function sanitizeChange(raw: unknown): ResolvedChange | null {
  if (!isPlainRecord(raw)) {
    return null;
  }
  if (typeof raw.experienceId !== "string" || raw.experienceId.length === 0) {
    return null;
  }
  if (typeof raw.selector !== "string" || raw.selector.trim().length === 0) {
    return null;
  }

  const change: ResolvedChange = {
    experienceId: raw.experienceId,
    selector: raw.selector,
  };

  if (raw.text !== undefined) {
    if (typeof raw.text !== "string") return null;
    change.text = raw.text;
  }
  if (raw.html !== undefined) {
    if (typeof raw.html !== "string") return null;
    change.html = raw.html;
  }
  if (raw.slot !== undefined) {
    if (typeof raw.slot !== "string" || raw.slot.length === 0) return null;
    change.slot = raw.slot;
  }
  if (raw.attrs !== undefined) {
    const attrs = sanitizeAttrs(raw.attrs);
    if (attrs === undefined) return null;
    change.attrs = attrs;
  }
  if (raw.addClass !== undefined) {
    const addClass = sanitizeStringArray(raw.addClass);
    if (addClass === undefined && (!Array.isArray(raw.addClass) || raw.addClass.length > 0)) {
      return null;
    }
    if (addClass !== undefined) {
      change.addClass = addClass;
    }
  }
  if (raw.removeClass !== undefined) {
    const removeClass = sanitizeStringArray(raw.removeClass);
    if (
      removeClass === undefined &&
      (!Array.isArray(raw.removeClass) || raw.removeClass.length > 0)
    ) {
      return null;
    }
    if (removeClass !== undefined) {
      change.removeClass = removeClass;
    }
  }
  if (raw.remove !== undefined) {
    if (typeof raw.remove !== "boolean") return null;
    if (raw.remove) {
      change.remove = true;
    }
  }
  if (raw.prepend !== undefined) {
    if (typeof raw.prepend !== "string") return null;
    change.prepend = raw.prepend;
  }
  if (raw.append !== undefined) {
    if (typeof raw.append !== "string") return null;
    change.append = raw.append;
  }

  return change;
}

function sanitizeMatched(raw: unknown): FacetMatchedSummary[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const result: FacetMatchedSummary[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) {
      return null;
    }
    if (typeof item.experienceId !== "string" || item.experienceId.length === 0) {
      return null;
    }
    if (!isBucket(item.bucket)) {
      return null;
    }
    result.push({
      experienceId: item.experienceId,
      bucket: item.bucket,
    });
  }
  return result;
}

function sanitizeProviders(raw: unknown): AnalyticsProvider[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const seen = new Set<AnalyticsProvider>();
  const result: AnalyticsProvider[] = [];
  for (const item of raw) {
    if (!isAnalyticsProvider(item)) {
      return null;
    }
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

export function createEmptyFacetState(): FacetRequestState {
  return {
    visitorId: "",
    matched: [],
    changes: [],
    personalized: false,
    previewMode: false,
    analyticsProviders: [],
  };
}

export function createFacetStateFromEvaluation(
  result: EvaluationResult,
  analyticsProviders: readonly AnalyticsProvider[] = [],
): FacetRequestState {
  const matched: FacetMatchedSummary[] = result.matched.map((item) => ({
    experienceId: item.experienceId,
    bucket: item.bucket,
  }));

  const changes: ResolvedChange[] = [];
  for (const rawChange of result.activeChanges) {
    const sanitized = sanitizeChange(rawChange);
    if (sanitized !== null) {
      changes.push(sanitized);
    }
  }

  const providers = sanitizeProviders([...analyticsProviders]) ?? [];

  return {
    visitorId: result.visitorId,
    matched,
    changes,
    personalized: result.personalized,
    previewMode: result.previewMode,
    analyticsProviders: providers,
  };
}

export function serializeFacetState(state: FacetRequestState): string {
  const matched: FacetMatchedSummary[] = [];
  for (const item of state.matched) {
    if (
      typeof item.experienceId === "string" &&
      item.experienceId.length > 0 &&
      isBucket(item.bucket)
    ) {
      matched.push({
        experienceId: item.experienceId,
        bucket: item.bucket,
      });
    }
  }

  const changes: ResolvedChange[] = [];
  for (const rawChange of state.changes) {
    const sanitized = sanitizeChange(rawChange);
    if (sanitized !== null) {
      changes.push(sanitized);
    }
  }

  const providers: AnalyticsProvider[] = [];
  const seenProviders = new Set<AnalyticsProvider>();
  for (const provider of state.analyticsProviders) {
    if (isAnalyticsProvider(provider) && !seenProviders.has(provider)) {
      seenProviders.add(provider);
      providers.push(provider);
    }
  }

  const wirePayload: FacetRequestState = {
    visitorId: typeof state.visitorId === "string" ? state.visitorId : "",
    matched,
    changes,
    personalized: Boolean(state.personalized),
    previewMode: Boolean(state.previewMode),
    analyticsProviders: providers,
  };

  return utf8ToBase64Url(JSON.stringify(wirePayload));
}

export function deserializeFacetState(headerValue: string | null | undefined): FacetRequestState {
  if (typeof headerValue !== "string") {
    return createEmptyFacetState();
  }

  const trimmed = headerValue.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FACET_STATE_HEADER_BYTES) {
    return createEmptyFacetState();
  }

  const json = base64UrlToUtf8(trimmed);
  if (json === null) {
    return createEmptyFacetState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return createEmptyFacetState();
  }

  if (!isPlainRecord(parsed)) {
    return createEmptyFacetState();
  }

  if (
    typeof parsed.visitorId !== "string" ||
    typeof parsed.personalized !== "boolean" ||
    typeof parsed.previewMode !== "boolean"
  ) {
    return createEmptyFacetState();
  }

  const matched = sanitizeMatched(parsed.matched);
  if (matched === null) {
    return createEmptyFacetState();
  }

  if (!Array.isArray(parsed.changes)) {
    return createEmptyFacetState();
  }
  const changes: ResolvedChange[] = [];
  for (const rawChange of parsed.changes) {
    const sanitized = sanitizeChange(rawChange);
    if (sanitized === null) {
      return createEmptyFacetState();
    }
    changes.push(sanitized);
  }

  const analyticsProviders = sanitizeProviders(parsed.analyticsProviders);
  if (analyticsProviders === null) {
    return createEmptyFacetState();
  }

  return {
    visitorId: parsed.visitorId,
    matched,
    changes,
    personalized: parsed.personalized,
    previewMode: parsed.previewMode,
    analyticsProviders,
  };
}

export function resolveSlotChange(
  state: FacetRequestState,
  id: string,
): ResolvedChange | undefined {
  if (id.length === 0 || state.changes.length === 0) {
    return undefined;
  }

  const idSelector = `#${id}`;
  const doubleQuotedAttr = `[data-facet-slot="${id}"]`;
  const singleQuotedAttr = `[data-facet-slot='${id}']`;

  for (const change of state.changes) {
    if (change.slot === id) {
      return change;
    }
    const selector = change.selector.trim();
    if (
      selector === id ||
      selector === idSelector ||
      selector === doubleQuotedAttr ||
      selector === singleQuotedAttr
    ) {
      return change;
    }
  }

  return undefined;
}
