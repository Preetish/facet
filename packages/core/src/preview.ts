import type { PreviewBucket } from "./evaluator.js";
import {
  DEFAULT_PREVIEW_BUCKET_PARAM,
  DEFAULT_PREVIEW_PARAM,
  DEFAULT_PREVIEW_SIG_PARAM,
} from "./schema.js";

export interface SignPreviewTokenOptions {
  experienceId: string;
  secret: string;
  expiresAt?: number;
  bucket?: PreviewBucket;
}

export interface VerifyPreviewTokenOptions {
  experienceId: string;
  token: string;
  secret: string;
  bucket?: PreviewBucket;
  now?: number;
}

export type VerifyPreviewTokenFailureReason =
  "empty_secret" | "invalid_format" | "expired" | "invalid_signature";

export type VerifyPreviewTokenResult =
  | {
      valid: true;
      experienceId: string;
      expiresAt?: number;
      bucket?: PreviewBucket;
    }
  | {
      valid: false;
      reason: VerifyPreviewTokenFailureReason;
    };

export interface BuildPreviewUrlOptions {
  baseUrl: string;
  experienceId: string;
  secret: string;
  expiresAt?: number;
  bucket?: PreviewBucket;
  previewParam?: string;
  previewSigParam?: string;
  previewBucketParam?: string;
}

export interface ParsePreviewParamsOptions {
  previewParam?: string;
  previewSigParam?: string;
  previewBucketParam?: string;
}

export interface ParsedPreviewParams {
  experienceId?: string;
  signature?: string;
  bucket?: PreviewBucket;
}

const textEncoder = new TextEncoder();
const TOKEN_VERSION = "v1";
const HMAC_SHA256_BYTES = 32;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte !== undefined) {
      binary += String.fromCharCode(byte);
    }
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(encoded: string): Uint8Array | null {
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
    return bytes;
  } catch {
    return null;
  }
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

async function computeHmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return new Uint8Array(signature);
}

function buildCanonicalPayload(
  experienceId: string,
  bucket: PreviewBucket | undefined,
  expiresAt: number | undefined,
): string {
  return `${TOKEN_VERSION}|${experienceId}|${bucket ?? ""}|${expiresAt ?? ""}`;
}

export async function signPreviewToken(options: SignPreviewTokenOptions): Promise<string> {
  if (!options.secret) {
    throw new Error("Preview signing secret must be non-empty");
  }
  if (!options.experienceId) {
    throw new Error("Experience id must be non-empty");
  }
  if (
    options.expiresAt !== undefined &&
    (!Number.isInteger(options.expiresAt) || options.expiresAt < 0)
  ) {
    throw new Error("expiresAt must be a non-negative integer unix timestamp in seconds");
  }

  const payload = buildCanonicalPayload(options.experienceId, options.bucket, options.expiresAt);
  const digest = await computeHmacSha256(options.secret, payload);
  const mac = base64UrlEncode(digest);

  return options.expiresAt !== undefined ? `${options.expiresAt}.${mac}` : mac;
}

export async function verifyPreviewToken(
  options: VerifyPreviewTokenOptions,
): Promise<VerifyPreviewTokenResult> {
  if (!options.secret) {
    return { valid: false, reason: "empty_secret" };
  }
  if (!options.experienceId || !options.token) {
    return { valid: false, reason: "invalid_format" };
  }

  let expiresAt: number | undefined;
  let macPart: string;

  const dotIndex = options.token.indexOf(".");
  if (dotIndex !== -1) {
    if (options.token.indexOf(".", dotIndex + 1) !== -1) {
      return { valid: false, reason: "invalid_format" };
    }
    const expStr = options.token.slice(0, dotIndex);
    macPart = options.token.slice(dotIndex + 1);
    if (!/^\d+$/.test(expStr)) {
      return { valid: false, reason: "invalid_format" };
    }
    const parsedExp = Number(expStr);
    if (!Number.isSafeInteger(parsedExp)) {
      return { valid: false, reason: "invalid_format" };
    }
    expiresAt = parsedExp;
  } else {
    macPart = options.token;
  }

  const providedMac = base64UrlDecode(macPart);
  if (!providedMac || providedMac.length !== HMAC_SHA256_BYTES) {
    return { valid: false, reason: "invalid_format" };
  }

  const payload = buildCanonicalPayload(options.experienceId, options.bucket, expiresAt);
  const expectedMac = await computeHmacSha256(options.secret, payload);

  if (!timingSafeEqual(providedMac, expectedMac)) {
    return { valid: false, reason: "invalid_signature" };
  }

  if (expiresAt !== undefined) {
    const nowSec = options.now ?? Math.floor(Date.now() / 1000);
    if (nowSec > expiresAt) {
      return { valid: false, reason: "expired" };
    }
  }

  const result: VerifyPreviewTokenResult = {
    valid: true,
    experienceId: options.experienceId,
  };
  if (expiresAt !== undefined) {
    result.expiresAt = expiresAt;
  }
  if (options.bucket !== undefined) {
    result.bucket = options.bucket;
  }
  return result;
}

export async function buildPreviewUrl(options: BuildPreviewUrlOptions): Promise<string> {
  const url = new URL(options.baseUrl);
  const previewParam = options.previewParam ?? DEFAULT_PREVIEW_PARAM;
  const previewSigParam = options.previewSigParam ?? DEFAULT_PREVIEW_SIG_PARAM;
  const previewBucketParam = options.previewBucketParam ?? DEFAULT_PREVIEW_BUCKET_PARAM;

  const token = await signPreviewToken({
    experienceId: options.experienceId,
    secret: options.secret,
    ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
    ...(options.bucket !== undefined ? { bucket: options.bucket } : {}),
  });

  url.searchParams.set(previewParam, options.experienceId);
  url.searchParams.set(previewSigParam, token);
  if (options.bucket !== undefined) {
    url.searchParams.set(previewBucketParam, options.bucket);
  }

  return url.toString();
}

function isPreviewBucket(value: string | null): value is PreviewBucket {
  return value === "variant" || value === "control" || value === "default";
}

export function parsePreviewParams(
  urlOrParams: string | URL | URLSearchParams,
  options?: ParsePreviewParamsOptions,
): ParsedPreviewParams | null {
  const previewParam = options?.previewParam ?? DEFAULT_PREVIEW_PARAM;
  const previewSigParam = options?.previewSigParam ?? DEFAULT_PREVIEW_SIG_PARAM;
  const previewBucketParam = options?.previewBucketParam ?? DEFAULT_PREVIEW_BUCKET_PARAM;

  let params: URLSearchParams;
  if (urlOrParams instanceof URLSearchParams) {
    params = urlOrParams;
  } else if (urlOrParams instanceof URL) {
    params = urlOrParams.searchParams;
  } else {
    try {
      params = new URL(urlOrParams).searchParams;
    } catch {
      params = new URLSearchParams(urlOrParams);
    }
  }

  const rawExpId = params.get(previewParam);
  const rawSig = params.get(previewSigParam);
  const rawBucket = params.get(previewBucketParam);

  const experienceId = rawExpId && rawExpId.trim().length > 0 ? rawExpId.trim() : undefined;
  const signature = rawSig && rawSig.trim().length > 0 ? rawSig.trim() : undefined;
  const bucket = isPreviewBucket(rawBucket) ? rawBucket : undefined;

  if (experienceId === undefined && bucket !== "default") {
    return null;
  }

  const parsed: ParsedPreviewParams = {};
  if (experienceId !== undefined) parsed.experienceId = experienceId;
  if (signature !== undefined) parsed.signature = signature;
  if (bucket !== undefined) parsed.bucket = bucket;

  return parsed;
}
