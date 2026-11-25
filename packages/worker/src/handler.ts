import {
  PERSONALIZED_CACHE_CONTROL,
  buildAnalyticsSnippet,
  buildContextFromRequest,
  evaluate,
  normalizeNowSeconds,
  parseFacetYaml,
  parsePreviewParams,
  toAnalyticsExposures,
  validateFacetConfig,
  verifyPreviewToken,
  type EvaluateOptions,
  type FacetConfig,
  type GeoContext,
  type ParseFacetResult,
  type StickyCookieDirective,
} from "@facet/core";
import { runEnrichment, type EnrichmentAdapter, type EnrichmentCacheStore } from "./enrichment.js";
import { rewriteHtmlResponse, type CreateRewriterFn } from "./rewriter.js";

export type FacetWorkerEnv = Record<string, unknown>;

export type FacetErrorStage = "config" | "preview" | "enrichment" | "evaluate" | "rewrite";

export type FacetConfigSource<Env extends FacetWorkerEnv = FacetWorkerEnv> =
  | FacetConfig
  | string
  | ((request: Request, env?: Env) => FacetConfig | string | Promise<FacetConfig | string>);

export interface FacetWorkerOptions<Env extends FacetWorkerEnv = FacetWorkerEnv> {
  origin: string | ((request: Request, env?: Env) => string | Promise<string>);
  config: FacetConfigSource<Env>;
  previewSecret?: string | ((env?: Env) => string | undefined);
  enrichment?: EnrichmentAdapter;
  kv?:
    | KVNamespace
    | EnrichmentCacheStore
    | ((env?: Env) => KVNamespace | EnrichmentCacheStore | undefined);
  fetchFn?: typeof fetch;
  createRewriter?: CreateRewriterFn;
  includeAnalyticsInPreview?: boolean;
  generateVisitorId?: () => string;
  now?: () => number;
  onError?: (error: unknown, stage: FacetErrorStage) => void;
}

export interface FacetWorkerHandler<Env extends FacetWorkerEnv = FacetWorkerEnv> {
  fetch(request: Request, env?: Env, ctx?: ExecutionContext): Promise<Response>;
}

export const STATIC_ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js",
  ".mjs",
  ".css",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".map",
  ".json",
  ".xml",
  ".pdf",
  ".mp4",
  ".webm",
]);

const VISITOR_COOKIE_MAX_AGE_SECONDS = 31536000;

export function isStaticAssetPath(pathname: string): boolean {
  const lastSlash = pathname.lastIndexOf("/");
  const lastSegment = lastSlash >= 0 ? pathname.slice(lastSlash + 1) : pathname;
  const lastDot = lastSegment.lastIndexOf(".");
  if (lastDot <= 0) {
    return false;
  }
  const ext = lastSegment.slice(lastDot).toLowerCase();
  return STATIC_ASSET_EXTENSIONS.has(ext);
}

export function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hasUnsafePathTraversal(pathname: string): boolean {
  return (
    pathname.startsWith("//") ||
    pathname.includes("\\") ||
    /[\r\n]/.test(pathname) ||
    /(^|\/)\.\.(\/|$)/.test(pathname)
  );
}

function isSafeOriginPath(rawPath: string): boolean {
  if (!rawPath.startsWith("/") || hasUnsafePathTraversal(rawPath)) {
    return false;
  }
  const pathnamePart = rawPath.split(/[?#]/, 1)[0] ?? "";
  if (hasUnsafePathTraversal(pathnamePart)) {
    return false;
  }
  const decoded = safeDecodeUri(pathnamePart);
  if (hasUnsafePathTraversal(decoded)) {
    return false;
  }
  const doubleDecoded = safeDecodeUri(decoded);
  if (hasUnsafePathTraversal(doubleDecoded)) {
    return false;
  }
  return true;
}

export function buildOriginUrl(
  request: Request,
  origin: string,
  originPathOverride?: string | null,
): URL {
  const incomingUrl = new URL(request.url);
  const originUrl = new URL(origin);

  const basePath = originUrl.pathname.replace(/\/+$/, "");
  let targetPathname = incomingUrl.pathname.startsWith("/")
    ? incomingUrl.pathname
    : `/${incomingUrl.pathname}`;
  let targetSearch = incomingUrl.search;

  if (
    typeof originPathOverride === "string" &&
    originPathOverride.length > 0 &&
    isSafeOriginPath(originPathOverride)
  ) {
    const hashIndex = originPathOverride.indexOf("#");
    const withoutHash =
      hashIndex >= 0 ? originPathOverride.slice(0, hashIndex) : originPathOverride;
    const queryIndex = withoutHash.indexOf("?");
    const overridePathname = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
    const overrideQuery = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";

    targetPathname = overridePathname;
    if (overrideQuery.length > 0) {
      const merged = new URLSearchParams(incomingUrl.search);
      const overrideParams = new URLSearchParams(overrideQuery);
      for (const [key, value] of overrideParams.entries()) {
        merged.set(key, value);
      }
      const serialized = merged.toString();
      targetSearch = serialized.length > 0 ? `?${serialized}` : "";
    }
  }

  originUrl.pathname = basePath.length > 0 ? `${basePath}${targetPathname}` : targetPathname;
  originUrl.search = targetSearch;
  originUrl.hash = "";
  return originUrl;
}

export function extractCloudflareGeo(request: Request): GeoContext {
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf;
  if (cf === null || typeof cf !== "object") {
    return {};
  }

  const geo: GeoContext = {};
  const fields = ["country", "region", "city", "continent", "timezone"] as const;
  for (const field of fields) {
    const value = cf[field];
    if (typeof value === "string" && value.trim().length > 0) {
      geo[field] = value;
    }
  }
  return geo;
}

export function formatVisitorCookie(
  cookieName: string,
  visitorId: string,
  secure: boolean,
): string {
  const parts = [
    `${encodeURIComponent(cookieName)}=${encodeURIComponent(visitorId)}`,
    "Path=/",
    "SameSite=Lax",
    "HttpOnly",
    `Max-Age=${VISITOR_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function formatStickyCookie(cookie: StickyCookieDirective, secure: boolean): string {
  const parts = [
    `${encodeURIComponent(cookie.name)}=${encodeURIComponent(cookie.value)}`,
    "Path=/",
    "SameSite=Lax",
    "HttpOnly",
  ];
  if (
    cookie.maxAgeSeconds !== null &&
    Number.isFinite(cookie.maxAgeSeconds) &&
    cookie.maxAgeSeconds > 0
  ) {
    parts.push(`Max-Age=${Math.floor(cookie.maxAgeSeconds)}`);
  }
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function appendVaryHeader(headers: Headers, token: string): void {
  const existing = headers.get("vary");
  if (!existing || existing.trim().length === 0) {
    headers.set("Vary", token);
    return;
  }

  const parts = existing
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.some((part) => part === "*" || part.toLowerCase() === token.toLowerCase())) {
    return;
  }

  headers.set("Vary", `${parts.join(", ")}, ${token}`);
}

function createOriginRequest(request: Request, targetUrl: URL): Request {
  const method = request.method.toUpperCase();
  const headers = new Headers(request.headers);
  headers.set("host", targetUrl.host);

  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    redirect: "manual",
  };

  if (method !== "GET" && method !== "HEAD" && request.body !== null) {
    init.body = request.body;
    init.duplex = "half";
  }

  return new Request(targetUrl.toString(), init);
}

function parseRawConfig(raw: FacetConfig | string): ParseFacetResult {
  if (typeof raw === "string") {
    return parseFacetYaml(raw);
  }
  return validateFacetConfig(raw);
}

async function resolveConfig<Env extends FacetWorkerEnv>(
  source: FacetConfigSource<Env>,
  request: Request,
  env: Env | undefined,
  getCachedStaticConfig: (() => ParseFacetResult | undefined) | undefined,
): Promise<ParseFacetResult> {
  if (getCachedStaticConfig !== undefined) {
    const cached = getCachedStaticConfig();
    if (cached !== undefined) {
      return cached;
    }
  }
  const raw = typeof source === "function" ? await source(request, env) : source;
  return parseRawConfig(raw);
}

async function resolveOrigin<Env extends FacetWorkerEnv>(
  origin: FacetWorkerOptions<Env>["origin"],
  request: Request,
  env: Env | undefined,
): Promise<string> {
  return typeof origin === "function" ? await origin(request, env) : origin;
}

function resolvePreviewSecret<Env extends FacetWorkerEnv>(
  secret: FacetWorkerOptions<Env>["previewSecret"],
  env: Env | undefined,
): string | undefined {
  const value = typeof secret === "function" ? secret(env) : secret;
  return value && value.length > 0 ? value : undefined;
}

function resolveKv<Env extends FacetWorkerEnv>(
  kv: FacetWorkerOptions<Env>["kv"],
  env: Env | undefined,
): KVNamespace | EnrichmentCacheStore | undefined {
  return typeof kv === "function" ? kv(env) : kv;
}

async function handleFacetRequestInternal<Env extends FacetWorkerEnv>(
  request: Request,
  options: FacetWorkerOptions<Env>,
  env: Env | undefined,
  ctx: ExecutionContext | undefined,
  getCachedStaticConfig: (() => ParseFacetResult | undefined) | undefined,
): Promise<Response> {
  const fetchFn = options.fetchFn ?? fetch;
  const originBase = await resolveOrigin(options.origin, request, env);
  const method = request.method.toUpperCase();
  const incomingUrl = new URL(request.url);

  const fetchOriginalFallback = (): Promise<Response> => {
    const fallbackUrl = buildOriginUrl(request, originBase);
    return fetchFn(createOriginRequest(request, fallbackUrl));
  };

  if ((method !== "GET" && method !== "HEAD") || isStaticAssetPath(incomingUrl.pathname)) {
    return fetchOriginalFallback();
  }

  let config: FacetConfig;
  try {
    const parsedConfig = await resolveConfig(options.config, request, env, getCachedStaticConfig);
    if (!parsedConfig.ok) {
      options.onError?.(parsedConfig.errors, "config");
      return fetchOriginalFallback();
    }
    config = parsedConfig.config;
  } catch (error: unknown) {
    options.onError?.(error, "config");
    return fetchOriginalFallback();
  }

  const geo = extractCloudflareGeo(request);
  let context = buildContextFromRequest(request, {
    cookieName: config.settings.cookieName,
    geo,
  });

  let nowValue: number | undefined;
  if (options.now !== undefined) {
    try {
      nowValue = options.now();
    } catch (error: unknown) {
      options.onError?.(error, "evaluate");
      return fetchOriginalFallback();
    }
  }

  const evaluateOptions: EvaluateOptions = {};
  if (options.generateVisitorId !== undefined) {
    evaluateOptions.generateVisitorId = options.generateVisitorId;
  }
  if (nowValue !== undefined) {
    evaluateOptions.now = nowValue;
  }

  let previewVerified = false;
  try {
    const parsedPreview = parsePreviewParams(incomingUrl, {
      previewParam: config.settings.previewParam,
      previewSigParam: config.settings.previewSigParam,
    });
    const secret = resolvePreviewSecret(options.previewSecret, env);

    if (
      parsedPreview !== null &&
      parsedPreview.experienceId !== undefined &&
      parsedPreview.signature !== undefined &&
      secret !== undefined
    ) {
      const verification = await verifyPreviewToken({
        experienceId: parsedPreview.experienceId,
        token: parsedPreview.signature,
        secret,
        ...(parsedPreview.bucket !== undefined ? { bucket: parsedPreview.bucket } : {}),
        ...(nowValue !== undefined ? { now: normalizeNowSeconds(nowValue) } : {}),
      });

      if (verification.valid) {
        previewVerified = true;
        evaluateOptions.previewExperienceId = verification.experienceId;
        if (verification.bucket !== undefined) {
          evaluateOptions.previewBucket = verification.bucket;
        }
      }
    }
  } catch (error: unknown) {
    options.onError?.(error, "preview");
  }

  if (!previewVerified && options.enrichment !== undefined) {
    try {
      const kv = resolveKv(options.kv, env);
      const company = await runEnrichment(options.enrichment, request, context, {
        ...(config.settings.enrichment?.timeoutMs !== undefined
          ? { timeoutMs: config.settings.enrichment.timeoutMs }
          : {}),
        ...(config.settings.enrichment?.cacheTtlSeconds !== undefined
          ? { cacheTtlSeconds: config.settings.enrichment.cacheTtlSeconds }
          : {}),
        ...(kv !== undefined ? { kv } : {}),
        ...(ctx !== undefined
          ? {
              waitUntil(promise: Promise<unknown>): void {
                ctx.waitUntil(promise);
              },
            }
          : {}),
        ...(options.onError !== undefined
          ? {
              onError(error: unknown): void {
                options.onError?.(error, "enrichment");
              },
            }
          : {}),
      });

      if (company !== undefined) {
        context = {
          ...context,
          company,
        };
      }
    } catch (error: unknown) {
      options.onError?.(error, "enrichment");
    }
  }

  let evaluation: ReturnType<typeof evaluate>;
  try {
    evaluation = evaluate(config, context, evaluateOptions);
  } catch (error: unknown) {
    options.onError?.(error, "evaluate");
    return fetchOriginalFallback();
  }

  const targetUrl = buildOriginUrl(request, originBase, evaluation.originPath);
  const originRequest = createOriginRequest(request, targetUrl);
  const originResponse = await fetchFn(originRequest);

  if (
    originResponse.status === 204 ||
    originResponse.status === 205 ||
    (originResponse.status >= 300 && originResponse.status < 400) ||
    !isHtmlContentType(originResponse.headers.get("content-type"))
  ) {
    return originResponse;
  }

  const shouldInjectAnalytics =
    evaluation.matched.length > 0 &&
    config.settings.analytics.providers.length > 0 &&
    (!evaluation.previewMode || options.includeAnalyticsInPreview === true);

  const analyticsSnippet = shouldInjectAnalytics
    ? buildAnalyticsSnippet(
        toAnalyticsExposures(evaluation.matched),
        config.settings.analytics.providers,
      )
    : "";

  const shouldRewriteBody =
    method !== "HEAD" && (evaluation.activeChanges.length > 0 || analyticsSnippet.length > 0);

  let finalResponse: Response = originResponse;

  if (shouldRewriteBody) {
    const fallbackResponse = originResponse.clone();
    try {
      finalResponse = await rewriteHtmlResponse(originResponse, {
        changes: evaluation.activeChanges,
        ...(analyticsSnippet.length > 0 ? { analyticsSnippet } : {}),
        ...(options.createRewriter !== undefined ? { createRewriter: options.createRewriter } : {}),
      });
      fallbackResponse.body?.cancel().catch(() => undefined);
    } catch (error: unknown) {
      options.onError?.(error, "rewrite");
      return fallbackResponse;
    }
  }

  const shouldSetVisitorCookie =
    evaluation.isNewVisitor && !evaluation.previewMode && config.experiences.length > 0;
  const stickyCookieToSet =
    !evaluation.previewMode && evaluation.stickyCookie !== null ? evaluation.stickyCookie : null;
  const shouldSetStickyCookie = stickyCookieToSet !== null;

  const effectiveCacheControl =
    evaluation.cacheControl ??
    (evaluation.personalized ||
    evaluation.previewMode ||
    shouldSetVisitorCookie ||
    shouldSetStickyCookie
      ? PERSONALIZED_CACHE_CONTROL
      : null);

  if (!shouldSetVisitorCookie && !shouldSetStickyCookie && effectiveCacheControl === null) {
    return finalResponse;
  }

  const headers = new Headers(finalResponse.headers);
  if (effectiveCacheControl !== null) {
    headers.set("Cache-Control", effectiveCacheControl);
    appendVaryHeader(headers, "Cookie");
  }

  const isHttps = incomingUrl.protocol === "https:";
  if (shouldSetVisitorCookie) {
    headers.append(
      "Set-Cookie",
      formatVisitorCookie(config.settings.cookieName, evaluation.visitorId, isHttps),
    );
  }
  if (stickyCookieToSet !== null) {
    headers.append("Set-Cookie", formatStickyCookie(stickyCookieToSet, isHttps));
  }

  return new Response(finalResponse.body, {
    status: finalResponse.status,
    statusText: finalResponse.statusText,
    headers,
  });
}

export async function handleFacetRequest<Env extends FacetWorkerEnv = FacetWorkerEnv>(
  request: Request,
  options: FacetWorkerOptions<Env>,
  env?: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  return handleFacetRequestInternal(request, options, env, ctx, undefined);
}

export function createFacetWorker<Env extends FacetWorkerEnv = FacetWorkerEnv>(
  options: FacetWorkerOptions<Env>,
): FacetWorkerHandler<Env> {
  let cachedStaticConfig: ParseFacetResult | undefined;
  let staticConfigResolved = false;

  const getCachedStaticConfig = (): ParseFacetResult | undefined => {
    if (typeof options.config === "function") {
      return undefined;
    }
    if (!staticConfigResolved) {
      const parsed = parseRawConfig(options.config);
      cachedStaticConfig = parsed;
      staticConfigResolved = true;
    }
    return cachedStaticConfig;
  };

  return {
    async fetch(request: Request, env?: Env, ctx?: ExecutionContext): Promise<Response> {
      return handleFacetRequestInternal(request, options, env, ctx, getCachedStaticConfig);
    },
  };
}
