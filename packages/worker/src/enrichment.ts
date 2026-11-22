import {
  DEFAULT_ENRICHMENT_CACHE_TTL_SECONDS,
  DEFAULT_ENRICHMENT_TIMEOUT_MS,
  type CompanyContext,
  type ContextPrimitive,
  type RequestContext,
} from "@facet/core";

export interface EnrichmentAdapter {
  readonly name: string;
  enrich(
    request: Request,
    context: RequestContext,
    signal: AbortSignal,
  ): Promise<CompanyContext | undefined>;
}

export interface EnrichmentCacheStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface RunEnrichmentOptions {
  timeoutMs?: number;
  cacheTtlSeconds?: number;
  kv?: KVNamespace | EnrichmentCacheStore;
  keyPrefix?: string;
  cacheKey?: (request: Request, context: RequestContext) => string | undefined;
  waitUntil?: (promise: Promise<unknown>) => void;
  onError?: (error: unknown) => void;
}

export interface IpinfoAdapterOptions {
  token: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface WebhookEnrichmentAdapterOptions {
  url: string;
  method?: "POST" | "GET";
  headers?: Readonly<Record<string, string>>;
  fetchFn?: typeof fetch;
  buildPayload?: (request: Request, context: RequestContext) => Record<string, unknown>;
}

const DEFAULT_CACHE_KEY_PREFIX = "facet:enrich";
const MIN_KV_TTL_SECONDS = 60;
const NEGATIVE_CACHE_VALUE = "null";
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isContextPrimitive(value: unknown): value is ContextPrimitive {
  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizeCompanyContext(input: unknown): CompanyContext | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const sanitized: CompanyContext = {};
  let hasField = false;

  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key)) {
      continue;
    }
    const value = record[key];
    if (isContextPrimitive(value)) {
      if (typeof value === "string" && value.trim().length === 0) {
        continue;
      }
      sanitized[key] = value;
      hasField = true;
    }
  }

  return hasField ? sanitized : undefined;
}

export function extractClientIp(request: Request): string | undefined {
  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp && cfIp.length > 0) {
    return cfIp;
  }

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first && first.length > 0) {
      return first;
    }
  }

  return undefined;
}

function resolveTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_ENRICHMENT_TIMEOUT_MS;
  }
  return Math.floor(value);
}

function resolveCacheTtl(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_ENRICHMENT_CACHE_TTL_SECONDS;
  }
  return Math.floor(value);
}

async function readFromKv(
  kv: KVNamespace | EnrichmentCacheStore,
  key: string,
  onError?: (error: unknown) => void,
): Promise<{ hit: true; company: CompanyContext | undefined } | { hit: false }> {
  try {
    const raw = await kv.get(key);
    if (raw === null) {
      return { hit: false };
    }
    if (raw === NEGATIVE_CACHE_VALUE) {
      return { hit: true, company: undefined };
    }
    const parsed: unknown = JSON.parse(raw);
    return { hit: true, company: sanitizeCompanyContext(parsed) };
  } catch (error: unknown) {
    onError?.(error);
    return { hit: false };
  }
}

export async function runEnrichment(
  adapter: EnrichmentAdapter,
  request: Request,
  context: RequestContext,
  options?: RunEnrichmentOptions,
): Promise<CompanyContext | undefined> {
  const timeoutMs = resolveTimeoutMs(options?.timeoutMs);
  const cacheTtlSeconds = resolveCacheTtl(options?.cacheTtlSeconds);
  const kv = options?.kv;
  const prefix = options?.keyPrefix ?? DEFAULT_CACHE_KEY_PREFIX;

  let cacheKey: string | undefined;
  if (kv && cacheTtlSeconds > 0) {
    const rawKey = options?.cacheKey
      ? options.cacheKey(request, context)
      : extractClientIp(request);
    if (rawKey && rawKey.trim().length > 0) {
      cacheKey = `${prefix}:${adapter.name}:${rawKey.trim()}`;
    }
  }

  if (kv && cacheKey !== undefined) {
    const cached = await readFromKv(kv, cacheKey, options?.onError);
    if (cached.hit) {
      return cached.company;
    }
  }

  const controller = new AbortController();
  let timerId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const timeoutPromise = new Promise<undefined>((resolve) => {
    timerId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve(undefined);
    }, timeoutMs);
  });

  let failed = false;
  const enrichPromise = Promise.resolve()
    .then(() => adapter.enrich(request, context, controller.signal))
    .then((result) => sanitizeCompanyContext(result))
    .catch((error: unknown) => {
      failed = true;
      if (!timedOut) {
        options?.onError?.(error);
      }
      return undefined;
    });

  let company: CompanyContext | undefined;
  try {
    company = await Promise.race([enrichPromise, timeoutPromise]);
  } finally {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
  }

  if (timedOut) {
    options?.onError?.(
      new Error(`Enrichment adapter "${adapter.name}" timed out after ${timeoutMs}ms`),
    );
    return undefined;
  }

  if (!failed && kv && cacheKey !== undefined) {
    const serialized = company !== undefined ? JSON.stringify(company) : NEGATIVE_CACHE_VALUE;
    const expirationTtl = Math.max(MIN_KV_TTL_SECONDS, cacheTtlSeconds);
    const putPromise = Promise.resolve()
      .then(() => kv.put(cacheKey, serialized, { expirationTtl }))
      .catch((error: unknown) => {
        options?.onError?.(error);
      });

    if (options?.waitUntil) {
      options.waitUntil(putPromise);
    } else {
      await putPromise;
    }
  }

  return company;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripAsnPrefix(org: string): string {
  return org.replace(/^AS\d+\s+/i, "").trim();
}

export function createIpinfoAdapter(options: IpinfoAdapterOptions): EnrichmentAdapter {
  const baseUrl = (options.baseUrl ?? "https://ipinfo.io").replace(/\/+$/, "");
  const fetchFn = options.fetchFn ?? fetch;

  return {
    name: "ipinfo",
    async enrich(
      request: Request,
      _context: RequestContext,
      signal: AbortSignal,
    ): Promise<CompanyContext | undefined> {
      const ip = extractClientIp(request);
      if (!ip) {
        return undefined;
      }

      const headers = new Headers({
        Accept: "application/json",
      });
      if (options.token.trim().length > 0) {
        headers.set("Authorization", `Bearer ${options.token.trim()}`);
      }

      const response = await fetchFn(`${baseUrl}/${encodeURIComponent(ip)}`, {
        method: "GET",
        headers,
        signal,
      });

      if (!response.ok) {
        return undefined;
      }

      const data: unknown = await response.json();
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        return undefined;
      }

      const record = data as Record<string, unknown>;
      const nestedCompany =
        record["company"] !== null &&
        typeof record["company"] === "object" &&
        !Array.isArray(record["company"])
          ? (record["company"] as Record<string, unknown>)
          : undefined;

      const company: CompanyContext = {};

      const companyName = asNonEmptyString(nestedCompany?.["name"]);
      const rawOrg = asNonEmptyString(record["org"]);
      if (companyName !== undefined) {
        company.name = companyName;
      } else if (rawOrg !== undefined) {
        const cleaned = stripAsnPrefix(rawOrg);
        if (cleaned.length > 0) {
          company.name = cleaned;
        }
      }

      const domain = asNonEmptyString(nestedCompany?.["domain"]);
      if (domain !== undefined) {
        company.domain = domain;
      }

      const industry =
        asNonEmptyString(nestedCompany?.["industry"]) ?? asNonEmptyString(nestedCompany?.["type"]);
      if (industry !== undefined) {
        company.industry = industry;
      }

      const size = asNonEmptyString(nestedCompany?.["size"]);
      if (size !== undefined) {
        company.size = size;
      }

      const employees = nestedCompany?.["employees"];
      if (typeof employees === "number" && Number.isFinite(employees)) {
        company.employees = employees;
      }

      const revenue = asNonEmptyString(nestedCompany?.["revenue"]);
      if (revenue !== undefined) {
        company.revenue = revenue;
      }

      return sanitizeCompanyContext(company);
    },
  };
}

export function createWebhookEnrichmentAdapter(
  options: WebhookEnrichmentAdapterOptions,
): EnrichmentAdapter {
  const method = options.method ?? "POST";
  const fetchFn = options.fetchFn ?? fetch;

  return {
    name: "webhook",
    async enrich(
      request: Request,
      context: RequestContext,
      signal: AbortSignal,
    ): Promise<CompanyContext | undefined> {
      const headers = new Headers({
        Accept: "application/json",
      });
      if (options.headers !== undefined) {
        for (const [key, value] of Object.entries(options.headers)) {
          headers.set(key, value);
        }
      }

      const ip = extractClientIp(request);
      let targetUrl = options.url;
      let body: string | undefined;

      if (method === "GET") {
        const parsed = new URL(options.url);
        if (ip !== undefined) {
          parsed.searchParams.set("ip", ip);
        }
        parsed.searchParams.set("host", context.host);
        parsed.searchParams.set("path", context.path);
        targetUrl = parsed.toString();
      } else {
        if (!headers.has("content-type")) {
          headers.set("Content-Type", "application/json");
        }
        const payload = options.buildPayload
          ? options.buildPayload(request, context)
          : {
              ip,
              host: context.host,
              path: context.path,
              query: context.query,
              geo: context.geo,
            };
        body = JSON.stringify(payload);
      }

      const init: RequestInit = {
        method,
        headers,
        signal,
      };
      if (body !== undefined) {
        init.body = body;
      }

      const response = await fetchFn(targetUrl, init);
      if (!response.ok) {
        return undefined;
      }

      const data: unknown = await response.json();
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        return undefined;
      }

      const record = data as Record<string, unknown>;
      const nested = record["company"];
      if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
        return sanitizeCompanyContext(nested);
      }

      return sanitizeCompanyContext(record);
    },
  };
}
