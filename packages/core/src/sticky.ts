import type { StickyDuration } from "./schema.js";

export const STICKY_SIGNAL_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "acct",
] as const;

export type StickySignalKey = (typeof STICKY_SIGNAL_KEYS)[number];

export interface StickyExperienceEntry {
  exp?: number;
  dataKey?: string;
}

export interface StickySignals {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  acct?: string;
  exp?: number;
}

export interface StickyState {
  v: 1;
  experiences: Record<string, StickyExperienceEntry>;
  signals: StickySignals;
}

export interface StickyCookieDirective {
  name: string;
  value: string;
  maxAgeSeconds: number | null;
}

export const MAX_STICKY_COOKIE_BYTES = 2048;
export const MAX_STICKY_EXPERIENCES = 20;
export const MAX_STICKY_VALUE_LENGTH = 128;

const MAX_INCOMING_COOKIE_LENGTH = 4096;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const DURATION_PATTERN = /^([1-9]\d*)([mhd])$/;

const UNIT_SECONDS: Record<string, number> = {
  m: 60,
  h: 3600,
  d: 86400,
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

function base64UrlEncodeUtf8(input: string): string {
  const bytes = textEncoder.encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte !== undefined) {
      binary += String.fromCharCode(byte);
    }
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeUtf8(encoded: string): string | null {
  if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
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

/**
 * Normalizes a timestamp to Unix seconds.
 * Values >= 1e12 are treated as milliseconds (e.g. `Date.now()`) and converted to seconds.
 */
export function normalizeNowSeconds(now?: number): number {
  if (now === undefined || !Number.isFinite(now)) {
    return Math.floor(Date.now() / 1000);
  }
  if (now >= 1_000_000_000_000) {
    return Math.floor(now / 1000);
  }
  return Math.floor(now);
}

/**
 * Parses an experience's `sticky` duration setting into seconds.
 * - `false` or `undefined` (or invalid): returns `undefined` (sticky disabled)
 * - `true` or `"session"`: returns `null` (session-scoped, no fixed Max-Age)
 * - `"30m"` / `"24h"` / `"7d"`: returns positive integer seconds
 */
export function parseStickyDurationSeconds(
  sticky: StickyDuration | string | boolean | undefined,
): number | null | undefined {
  if (sticky === undefined || sticky === false) {
    return undefined;
  }
  if (sticky === true || sticky === "session") {
    return null;
  }
  if (typeof sticky !== "string") {
    return undefined;
  }
  const match = DURATION_PATTERN.exec(sticky.trim());
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit !== undefined ? UNIT_SECONDS[unit] : undefined;
  if (!Number.isSafeInteger(amount) || amount <= 0 || multiplier === undefined) {
    return undefined;
  }
  return amount * multiplier;
}

export function createEmptyStickyState(): StickyState {
  return {
    v: 1,
    experiences: {},
    signals: {},
  };
}

function clampString(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function parseFiniteNonNegInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return undefined;
}

interface WireStickyEntry {
  exp?: number;
  k?: string;
}

interface WireStickyPayload {
  v: 1;
  e?: Record<string, WireStickyEntry>;
  s?: StickySignals;
}

/**
 * Parses a sticky cookie value into a sanitized `StickyState`.
 * Always fails safe to an empty state on corrupt, oversized, or tampered input.
 * When `now` is provided, expired experience entries and expired signals are omitted.
 */
export function parseStickyCookie(raw: string | null | undefined, now?: number): StickyState {
  const empty = createEmptyStickyState();
  if (!raw || typeof raw !== "string" || raw.length > MAX_INCOMING_COOKIE_LENGTH) {
    return empty;
  }

  const decoded = base64UrlDecodeUtf8(raw.trim());
  if (decoded === null) {
    return empty;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return empty;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return empty;
  }

  const obj = parsed as Record<string, unknown>;
  if (obj["v"] !== 1) {
    return empty;
  }

  const nowSec = now !== undefined ? normalizeNowSeconds(now) : undefined;
  const experiences: Record<string, StickyExperienceEntry> = {};

  const rawExps = obj["e"] ?? obj["experiences"];
  if (rawExps !== null && typeof rawExps === "object" && !Array.isArray(rawExps)) {
    let count = 0;
    for (const [expId, rawEntry] of Object.entries(rawExps as Record<string, unknown>)) {
      if (count >= MAX_STICKY_EXPERIENCES) break;
      if (expId.length === 0 || expId.length > MAX_STICKY_VALUE_LENGTH || isForbiddenKey(expId)) {
        continue;
      }
      if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        continue;
      }
      const entryObj = rawEntry as Record<string, unknown>;
      const exp = parseFiniteNonNegInt(entryObj["exp"]);
      if (exp !== undefined && nowSec !== undefined && nowSec > exp) {
        continue;
      }

      const rawDataKey = entryObj["k"] ?? entryObj["dataKey"];
      const dataKey =
        typeof rawDataKey === "string" && rawDataKey.length > 0
          ? clampString(rawDataKey, MAX_STICKY_VALUE_LENGTH)
          : undefined;

      const entry: StickyExperienceEntry = {};
      if (exp !== undefined) entry.exp = exp;
      if (dataKey !== undefined) entry.dataKey = dataKey;
      experiences[expId] = entry;
      count += 1;
    }
  }

  const signals: StickySignals = {};
  const rawSignals = obj["s"] ?? obj["signals"];
  if (rawSignals !== null && typeof rawSignals === "object" && !Array.isArray(rawSignals)) {
    const sigObj = rawSignals as Record<string, unknown>;
    const sigExp = parseFiniteNonNegInt(sigObj["exp"]);
    const signalsExpired = sigExp !== undefined && nowSec !== undefined && nowSec > sigExp;

    if (!signalsExpired) {
      let hasAnySignal = false;
      for (const key of STICKY_SIGNAL_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(sigObj, key)) {
          continue;
        }
        const val = sigObj[key];
        if (typeof val === "string" && val.length > 0) {
          signals[key] = clampString(val, MAX_STICKY_VALUE_LENGTH);
          hasAnySignal = true;
        }
      }
      if (hasAnySignal && sigExp !== undefined) {
        signals.exp = sigExp;
      }
    }
  }

  return {
    v: 1,
    experiences,
    signals,
  };
}

function buildWirePayload(state: StickyState, nowSec?: number): WireStickyPayload {
  const wireExps: Record<string, WireStickyEntry> = {};
  const expEntries = Object.entries(state.experiences).filter(([id, entry]) => {
    if (id.length === 0 || isForbiddenKey(id)) return false;
    if (entry.exp !== undefined && nowSec !== undefined && nowSec > entry.exp) return false;
    return true;
  });

  // Keep most recent / latest-expiring entries if over the cap
  const cappedEntries = expEntries.slice(-MAX_STICKY_EXPERIENCES);
  for (const [expId, entry] of cappedEntries) {
    const wireEntry: WireStickyEntry = {};
    if (entry.exp !== undefined && Number.isFinite(entry.exp) && entry.exp >= 0) {
      wireEntry.exp = Math.floor(entry.exp);
    }
    if (entry.dataKey !== undefined && entry.dataKey.length > 0) {
      wireEntry.k = clampString(entry.dataKey, MAX_STICKY_VALUE_LENGTH);
    }
    wireExps[clampString(expId, MAX_STICKY_VALUE_LENGTH)] = wireEntry;
  }

  const wireSignals: StickySignals = {};
  const signalsExpired =
    state.signals.exp !== undefined && nowSec !== undefined && nowSec > state.signals.exp;
  let hasSignal = false;

  if (!signalsExpired) {
    for (const key of STICKY_SIGNAL_KEYS) {
      const val = state.signals[key];
      if (typeof val === "string" && val.length > 0) {
        wireSignals[key] = clampString(val, MAX_STICKY_VALUE_LENGTH);
        hasSignal = true;
      }
    }
    if (
      hasSignal &&
      state.signals.exp !== undefined &&
      Number.isFinite(state.signals.exp) &&
      state.signals.exp >= 0
    ) {
      wireSignals.exp = Math.floor(state.signals.exp);
    }
  }

  const payload: WireStickyPayload = { v: 1 };
  if (Object.keys(wireExps).length > 0) {
    payload.e = wireExps;
  }
  if (hasSignal) {
    payload.s = wireSignals;
  }
  return payload;
}

/**
 * Serializes a `StickyState` into a compact, bounded base64url string safe for cookies.
 * Drops oldest experience entries if needed to stay within `MAX_STICKY_COOKIE_BYTES`.
 */
export function serializeStickyCookie(state: StickyState, now?: number): string {
  const nowSec = now !== undefined ? normalizeNowSeconds(now) : undefined;
  const payload = buildWirePayload(state, nowSec);

  let encoded = base64UrlEncodeUtf8(JSON.stringify(payload));
  if (encoded.length <= MAX_STICKY_COOKIE_BYTES) {
    return encoded;
  }

  // Prune oldest experience entries until under size cap
  const exps = payload.e;
  if (exps) {
    const keys = Object.keys(exps);
    while (encoded.length > MAX_STICKY_COOKIE_BYTES && keys.length > 0) {
      const oldest = keys.shift();
      if (oldest !== undefined) {
        delete exps[oldest];
      }
      if (Object.keys(exps).length === 0) {
        delete payload.e;
      }
      encoded = base64UrlEncodeUtf8(JSON.stringify(payload));
    }
  }

  if (encoded.length <= MAX_STICKY_COOKIE_BYTES) {
    return encoded;
  }

  // Last resort: drop signals if still oversized (never exceed cookie bound)
  delete payload.s;
  return base64UrlEncodeUtf8(JSON.stringify(payload));
}
