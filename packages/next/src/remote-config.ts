import {
  parseFacetYaml,
  validateFacetConfig,
  type ConfigStore,
  type FacetConfig,
} from "@facet/core";

export const DEFAULT_REMOTE_CONFIG_TTL_MS = 30_000;
export const DEFAULT_REMOTE_CONFIG_TIMEOUT_MS = 1_500;

export interface RemoteConfigLoaderOptions {
  url?: string;
  headers?: Record<string, string>;
  store?: ConfigStore;
  fetcher?: () => Promise<string | FacetConfig | null>;
  ttlMs?: number;
  timeoutMs?: number;
  fallback?: FacetConfig | string;
  fetchFn?: typeof fetch;
  now?: () => number;
  onError?: (err: unknown) => void;
}

function createEmptyFailOpenConfig(): FacetConfig {
  const parsed = validateFacetConfig({ version: 1, experiences: [] });
  if (!parsed.ok) {
    throw new Error("Failed to construct default empty Facet config");
  }
  return parsed.config;
}

function safeNotifyError(onError: ((err: unknown) => void) | undefined, err: unknown): void {
  if (!onError) {
    return;
  }
  try {
    onError(err);
  } catch {
    // Never let an error reporter break fail-open behavior.
  }
}

function resolveTtlMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_REMOTE_CONFIG_TTL_MS;
  }
  return Math.floor(value);
}

function resolveTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_REMOTE_CONFIG_TIMEOUT_MS;
  }
  return Math.floor(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseOrValidateConfig(
  raw: string | FacetConfig,
  onError?: (err: unknown) => void,
): FacetConfig | null {
  const result = typeof raw === "string" ? parseFacetYaml(raw) : validateFacetConfig(raw);
  if (!result.ok) {
    safeNotifyError(onError, result.errors);
    return null;
  }
  return result.config;
}

function parseHttpBody(
  bodyText: string,
  contentType: string | null,
  onError?: (err: unknown) => void,
): FacetConfig | null {
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const isJsonContentType =
    contentType !== null && contentType.toLowerCase().includes("application/json");
  if (isJsonContentType || trimmed.startsWith("{")) {
    try {
      const parsedJson: unknown = JSON.parse(trimmed);
      if (isPlainObject(parsedJson) && typeof parsedJson["yaml"] === "string") {
        return parseOrValidateConfig(parsedJson["yaml"], onError);
      }
      const validated = validateFacetConfig(parsedJson);
      if (validated.ok) {
        return validated.config;
      }
      safeNotifyError(onError, validated.errors);
      return null;
    } catch {
      // Fall through to YAML parser when body is not valid JSON.
    }
  }

  return parseOrValidateConfig(bodyText, onError);
}

export function createRemoteConfigLoader(
  options: RemoteConfigLoaderOptions,
): () => Promise<FacetConfig> {
  const ttlMs = resolveTtlMs(options.ttlMs);
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const fetchFn = options.fetchFn ?? fetch;
  const nowFn = options.now ?? (() => Date.now());
  const emptyFailOpenConfig = createEmptyFailOpenConfig();

  let parsedFallback: FacetConfig | null | undefined;
  let cachedConfig: FacetConfig | null = null;
  let expiresAt = 0;
  let inFlightRefresh: Promise<FacetConfig | null> | null = null;

  function resolveFallbackConfig(): FacetConfig {
    if (parsedFallback === undefined) {
      if (options.fallback !== undefined) {
        parsedFallback = parseOrValidateConfig(options.fallback, options.onError);
      } else {
        parsedFallback = null;
      }
    }
    return parsedFallback ?? emptyFailOpenConfig;
  }

  async function fetchFromSource(signal: AbortSignal): Promise<FacetConfig | null> {
    if (options.fetcher !== undefined) {
      const raw = await options.fetcher();
      if (raw === null) {
        return null;
      }
      return parseOrValidateConfig(raw, options.onError);
    }

    if (options.store !== undefined) {
      const snapshot = await options.store.getLive();
      if (snapshot === null) {
        return null;
      }
      return parseOrValidateConfig(snapshot.yaml, options.onError);
    }

    if (options.url !== undefined && options.url.trim().length > 0) {
      const headers = new Headers(options.headers);
      if (!headers.has("accept")) {
        headers.set("Accept", "application/yaml, text/yaml, application/json, text/plain");
      }

      const response = await fetchFn(options.url, {
        method: "GET",
        headers,
        signal,
      });

      if (!response.ok) {
        throw new Error(`Remote Facet config fetch failed with HTTP ${response.status}`);
      }

      const text = await response.text();
      return parseHttpBody(text, response.headers.get("content-type"), options.onError);
    }

    return null;
  }

  async function fetchWithTimeout(): Promise<FacetConfig | null> {
    const controller = new AbortController();
    let timerId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    const timeoutPromise = new Promise<null>((resolve) => {
      timerId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        safeNotifyError(
          options.onError,
          new Error(`Remote Facet config load timed out after ${timeoutMs}ms`),
        );
        resolve(null);
      }, timeoutMs);
    });

    const loadPromise = Promise.resolve()
      .then(() => fetchFromSource(controller.signal))
      .catch((error: unknown) => {
        if (!timedOut) {
          safeNotifyError(options.onError, error);
        }
        return null;
      });

    try {
      return await Promise.race([loadPromise, timeoutPromise]);
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  }

  function triggerRefresh(): Promise<FacetConfig | null> {
    if (inFlightRefresh !== null) {
      return inFlightRefresh;
    }

    const promise = fetchWithTimeout()
      .then((fresh) => {
        if (fresh !== null) {
          cachedConfig = fresh;
          expiresAt = nowFn() + ttlMs;
          return fresh;
        }
        return null;
      })
      .finally(() => {
        inFlightRefresh = null;
      });

    inFlightRefresh = promise;
    return promise;
  }

  return async function remoteConfigLoader(): Promise<FacetConfig> {
    const now = nowFn();

    if (cachedConfig !== null) {
      if (now < expiresAt) {
        return cachedConfig;
      }

      // Warm stale cache: return last-known-good immediately and refresh in background.
      void triggerRefresh();
      return cachedConfig;
    }

    // Cold load: enforce hard timeout and fail open to fallback (or empty valid config).
    const fresh = await triggerRefresh();
    if (fresh !== null) {
      return fresh;
    }
    return cachedConfig ?? resolveFallbackConfig();
  };
}
