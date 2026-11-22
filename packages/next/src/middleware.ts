import {
  DEFAULT_ENRICHMENT_TIMEOUT_MS,
  PERSONALIZED_CACHE_CONTROL,
  buildContextFromRequest,
  evaluate,
  parseFacetYaml,
  parsePreviewParams,
  validateFacetConfig,
  verifyPreviewToken,
  type CompanyContext,
  type EvaluateOptions,
  type FacetConfig,
  type GeoContext,
  type RequestContext,
} from "@facet/core";
import { NextResponse, type NextRequest } from "next/server.js";
import {
  FACET_STATE_HEADER,
  MAX_FACET_STATE_HEADER_BYTES,
  createFacetStateFromEvaluation,
  serializeFacetState,
} from "./state.js";

export type FacetConfigSource =
  FacetConfig | string | (() => FacetConfig | string | Promise<FacetConfig | string>);

export type FacetEnrichCallback = (
  request: NextRequest,
  context: RequestContext,
  signal: AbortSignal,
) => Promise<CompanyContext | null | undefined> | CompanyContext | null | undefined;

export interface FacetCookieOptions {
  maxAge?: number;
  path?: string;
  sameSite?: "lax" | "strict" | "none";
  secure?: boolean;
  httpOnly?: boolean;
  domain?: string;
}

export interface FacetMiddlewareOptions {
  config: FacetConfigSource;
  previewSecret?: string;
  enrich?: FacetEnrichCallback;
  enrichmentTimeoutMs?: number;
  bypassPaths?: readonly (string | RegExp)[];
  bypassApi?: boolean;
  cookieOptions?: FacetCookieOptions;
  generateVisitorId?: () => string;
  onError?: (error: unknown, request: NextRequest) => void;
}

export type FacetNextMiddleware = (request: NextRequest) => Promise<NextResponse>;

const DEFAULT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const STATIC_ASSET_EXTENSION_PATTERN =
  /\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|pdf|xml|txt|json|webmanifest|mp4|webm|mp3|wav|ogg|zip|gz|br)$/i;

interface LegacyGeoShape {
  country?: unknown;
  region?: unknown;
  city?: unknown;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function readLegacyRequestGeo(request: NextRequest): GeoContext {
  const geo: GeoContext = {};
  const maybeGeo: unknown = (request as { geo?: unknown }).geo;
  if (!isPlainRecord(maybeGeo)) {
    return geo;
  }
  const candidate = maybeGeo as LegacyGeoShape;
  if (typeof candidate.country === "string" && candidate.country.length > 0) {
    geo.country = candidate.country;
  }
  if (typeof candidate.region === "string" && candidate.region.length > 0) {
    geo.region = candidate.region;
  }
  if (typeof candidate.city === "string" && candidate.city.length > 0) {
    geo.city = candidate.city;
  }
  return geo;
}

function firstNonEmptyHeader(headers: Headers, names: readonly string[]): string | undefined {
  for (const name of names) {
    const raw = headers.get(name);
    if (raw !== null) {
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        return safeDecodeURIComponent(trimmed);
      }
    }
  }
  return undefined;
}

function extractGeoContext(request: NextRequest): GeoContext {
  const geo = readLegacyRequestGeo(request);
  const headers = request.headers;

  if (geo.country === undefined) {
    const country = firstNonEmptyHeader(headers, ["x-vercel-ip-country", "cf-ipcountry"]);
    if (country !== undefined) geo.country = country;
  }
  if (geo.region === undefined) {
    const region = firstNonEmptyHeader(headers, ["x-vercel-ip-country-region", "cf-region"]);
    if (region !== undefined) geo.region = region;
  }
  if (geo.city === undefined) {
    const city = firstNonEmptyHeader(headers, ["x-vercel-ip-city", "cf-ipcity"]);
    if (city !== undefined) geo.city = city;
  }
  if (geo.continent === undefined) {
    const continent = firstNonEmptyHeader(headers, ["x-vercel-ip-continent", "cf-ipcontinent"]);
    if (continent !== undefined) geo.continent = continent;
  }
  if (geo.timezone === undefined) {
    const timezone = firstNonEmptyHeader(headers, ["x-vercel-ip-timezone", "cf-timezone"]);
    if (timezone !== undefined) geo.timezone = timezone;
  }

  return geo;
}

function isBypassedRequest(
  request: NextRequest,
  pathname: string,
  options: FacetMiddlewareOptions,
): boolean {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return true;
  }

  if (
    pathname === "/_next" ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    STATIC_ASSET_EXTENSION_PATTERN.test(pathname)
  ) {
    return true;
  }

  if (options.bypassApi !== false && (pathname === "/api" || pathname.startsWith("/api/"))) {
    return true;
  }

  if (options.bypassPaths !== undefined) {
    for (const rule of options.bypassPaths) {
      if (typeof rule === "string") {
        if (rule.length > 0 && (pathname === rule || pathname.startsWith(rule))) {
          return true;
        }
      } else {
        if (rule.global || rule.sticky) {
          rule.lastIndex = 0;
        }
        if (rule.test(pathname)) {
          return true;
        }
      }
    }
  }

  return false;
}

function appendVaryHeader(headers: Headers, value: string): void {
  const existing = headers.get("Vary");
  if (!existing) {
    headers.set("Vary", value);
    return;
  }
  const parts = existing
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (!parts.some((part) => part.toLowerCase() === value.toLowerCase())) {
    parts.push(value);
    headers.set("Vary", parts.join(", "));
  }
}

function parseOrValidateConfig(raw: FacetConfig | string): FacetConfig {
  if (typeof raw === "string") {
    const parsed = parseFacetYaml(raw);
    if (!parsed.ok) {
      const firstError = parsed.errors[0];
      throw new Error(
        `Invalid Facet YAML config: ${firstError ? firstError.message : "unknown validation error"}`,
      );
    }
    return parsed.config;
  }

  const validated = validateFacetConfig(raw);
  if (!validated.ok) {
    const firstError = validated.errors[0];
    throw new Error(
      `Invalid Facet config: ${firstError ? firstError.message : "unknown validation error"}`,
    );
  }
  return validated.config;
}

function safeNotifyError(
  onError: FacetMiddlewareOptions["onError"],
  error: unknown,
  request: NextRequest,
): void {
  if (!onError) {
    return;
  }
  try {
    onError(error, request);
  } catch {
    // Never let an error reporter break fail-open behavior.
  }
}

async function runEnrichmentWithTimeout(
  enrich: FacetEnrichCallback,
  request: NextRequest,
  context: RequestContext,
  timeoutMs: number,
  onError: FacetMiddlewareOptions["onError"],
): Promise<CompanyContext | null> {
  const effectiveTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_ENRICHMENT_TIMEOUT_MS;
  const controller = new AbortController();
  let timerId: ReturnType<typeof setTimeout> | undefined;

  const enrichPromise = Promise.resolve()
    .then(() => enrich(request, context, controller.signal))
    .catch((error: unknown) => {
      safeNotifyError(onError, error, request);
      return null;
    });

  const timeoutPromise = new Promise<null>((resolve) => {
    timerId = setTimeout(() => {
      controller.abort();
      safeNotifyError(
        onError,
        new Error(`Facet enrichment timed out after ${effectiveTimeout}ms`),
        request,
      );
      resolve(null);
    }, effectiveTimeout);
  });

  try {
    const result = await Promise.race([enrichPromise, timeoutPromise]);
    if (result && isPlainRecord(result)) {
      return result as CompanyContext;
    }
    return null;
  } finally {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
  }
}

export function createFacetMiddleware(options: FacetMiddlewareOptions): FacetNextMiddleware {
  let cachedStaticConfig: FacetConfig | null = null;
  const isLoader = typeof options.config === "function";

  async function loadConfig(): Promise<FacetConfig> {
    if (isLoader) {
      const loader = options.config as () => FacetConfig | string | Promise<FacetConfig | string>;
      const raw = await loader();
      return parseOrValidateConfig(raw);
    }
    if (cachedStaticConfig !== null) {
      return cachedStaticConfig;
    }
    cachedStaticConfig = parseOrValidateConfig(options.config as FacetConfig | string);
    return cachedStaticConfig;
  }

  return async function facetMiddleware(request: NextRequest): Promise<NextResponse> {
    // Always strip any client-supplied x-facet-state header first to prevent spoofing.
    const sanitizedHeaders = new Headers(request.headers);
    sanitizedHeaders.delete(FACET_STATE_HEADER);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(request.url);
    } catch (error: unknown) {
      safeNotifyError(options.onError, error, request);
      return NextResponse.next({ request: { headers: sanitizedHeaders } });
    }

    if (isBypassedRequest(request, parsedUrl.pathname, options)) {
      return NextResponse.next({ request: { headers: sanitizedHeaders } });
    }

    try {
      const config = await loadConfig();
      const geo = extractGeoContext(request);
      const context = buildContextFromRequest(request, {
        cookieName: config.settings.cookieName,
        geo,
      });
      delete context.headers[FACET_STATE_HEADER];

      const evaluateOptions: EvaluateOptions = {};
      if (options.generateVisitorId !== undefined) {
        evaluateOptions.generateVisitorId = options.generateVisitorId;
      }

      const previewParams = parsePreviewParams(parsedUrl, {
        previewParam: config.settings.previewParam,
        previewSigParam: config.settings.previewSigParam,
      });

      let verifiedPreview = false;
      if (
        previewParams !== null &&
        previewParams.experienceId !== undefined &&
        previewParams.signature !== undefined &&
        options.previewSecret !== undefined &&
        options.previewSecret.length > 0
      ) {
        const verification = await verifyPreviewToken({
          experienceId: previewParams.experienceId,
          token: previewParams.signature,
          secret: options.previewSecret,
          ...(previewParams.bucket !== undefined ? { bucket: previewParams.bucket } : {}),
        });

        if (verification.valid) {
          verifiedPreview = true;
          evaluateOptions.previewExperienceId = verification.experienceId;
          if (verification.bucket !== undefined) {
            evaluateOptions.previewBucket = verification.bucket;
          }
        }
      }

      if (!verifiedPreview && options.enrich !== undefined) {
        const timeoutMs =
          options.enrichmentTimeoutMs ??
          config.settings.enrichment?.timeoutMs ??
          DEFAULT_ENRICHMENT_TIMEOUT_MS;
        const company = await runEnrichmentWithTimeout(
          options.enrich,
          request,
          context,
          timeoutMs,
          options.onError,
        );
        if (company !== null) {
          context.company = { ...context.company, ...company };
        }
      }

      const result = evaluate(config, context, evaluateOptions);
      const state = createFacetStateFromEvaluation(result, config.settings.analytics.providers);
      const serialized = serializeFacetState(state);

      if (serialized.length <= MAX_FACET_STATE_HEADER_BYTES) {
        sanitizedHeaders.set(FACET_STATE_HEADER, serialized);
      } else {
        safeNotifyError(
          options.onError,
          new Error(
            `Serialized Facet state exceeded maximum header size (${serialized.length} > ${MAX_FACET_STATE_HEADER_BYTES} bytes)`,
          ),
          request,
        );
      }

      const response = NextResponse.next({
        request: { headers: sanitizedHeaders },
      });

      const shouldSetCookie =
        result.isNewVisitor &&
        !result.previewMode &&
        config.experiences.length > 0 &&
        result.visitorId.length > 0;

      if (
        result.cacheControl !== null ||
        result.personalized ||
        result.previewMode ||
        shouldSetCookie
      ) {
        response.headers.set("Cache-Control", PERSONALIZED_CACHE_CONTROL);
        appendVaryHeader(response.headers, "Cookie");
      }

      if (shouldSetCookie) {
        const cookieOpts = options.cookieOptions;
        response.cookies.set(config.settings.cookieName, result.visitorId, {
          path: cookieOpts?.path ?? "/",
          maxAge: cookieOpts?.maxAge ?? DEFAULT_COOKIE_MAX_AGE_SECONDS,
          sameSite: cookieOpts?.sameSite ?? "lax",
          httpOnly: cookieOpts?.httpOnly ?? true,
          secure: cookieOpts?.secure ?? parsedUrl.protocol === "https:",
          ...(cookieOpts?.domain !== undefined ? { domain: cookieOpts.domain } : {}),
        });
      }

      return response;
    } catch (error: unknown) {
      safeNotifyError(options.onError, error, request);
      sanitizedHeaders.delete(FACET_STATE_HEADER);
      return NextResponse.next({
        request: { headers: sanitizedHeaders },
      });
    }
  };
}
