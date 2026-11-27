import {
  DEFAULT_MAX_SNAPSHOTS,
  generateSnapshotId,
  hashConfigYaml,
  normalizeMaxSnapshots,
  parseFacetYaml,
  validateFacetConfig,
  type ConfigSnapshot,
  type ConfigSnapshotMeta,
  type ConfigStore,
  type FacetConfig,
  type PublishOptions,
  type PublishResult,
  type SaveDraftResult,
} from "@facet/core";
import type { EnrichmentCacheStore } from "./enrichment.js";
import type { FacetWorkerEnv } from "./handler.js";

export const DEFAULT_KV_CONFIG_KEY_PREFIX = "facet:config";
export const DEFAULT_CONFIG_CACHE_TTL_MS = 30_000;

export interface KvConfigStoreOptions {
  keyPrefix?: string;
  maxSnapshots?: number;
  now?: () => number;
}

export interface CachedConfigLoaderOptions {
  ttlMs?: number;
  fallback?: FacetConfig | string;
  onError?: (err: unknown) => void;
  now?: () => number;
  waitUntil?: (p: Promise<unknown>) => void;
}

type KvWithOptionalDelete = (KVNamespace | EnrichmentCacheStore) & {
  delete?: (key: string) => Promise<void>;
};

function normalizeKeyPrefix(prefix: string | undefined): string {
  if (prefix === undefined) {
    return DEFAULT_KV_CONFIG_KEY_PREFIX;
  }
  return prefix.trim().replace(/:+$/, "");
}

function formatKey(prefix: string, suffix: string): string {
  return prefix.length > 0 ? `${prefix}:${suffix}` : suffix;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSnapshotMeta(raw: unknown): ConfigSnapshotMeta | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const id = raw["id"];
  const publishedAt = raw["publishedAt"];
  const hash = raw["hash"];
  const experienceCount = raw["experienceCount"];
  const author = raw["author"];
  const note = raw["note"];

  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof publishedAt !== "string" ||
    publishedAt.length === 0 ||
    typeof hash !== "string" ||
    hash.length === 0 ||
    typeof experienceCount !== "number" ||
    !Number.isInteger(experienceCount) ||
    experienceCount < 0
  ) {
    return null;
  }

  if (author !== undefined && typeof author !== "string") {
    return null;
  }
  if (note !== undefined && typeof note !== "string") {
    return null;
  }

  const meta: ConfigSnapshotMeta = {
    id,
    publishedAt,
    hash,
    experienceCount,
  };
  if (author !== undefined) {
    meta.author = author;
  }
  if (note !== undefined) {
    meta.note = note;
  }
  return meta;
}

function parseSnapshot(raw: unknown): ConfigSnapshot | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const meta = parseSnapshotMeta(raw);
  const yaml = raw["yaml"];
  if (meta === null || typeof yaml !== "string") {
    return null;
  }
  return {
    ...meta,
    yaml,
  };
}

function parseHistoryJson(raw: string | null): ConfigSnapshotMeta[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const items: ConfigSnapshotMeta[] = [];
    for (const entry of parsed) {
      const meta = parseSnapshotMeta(entry);
      if (meta !== null) {
        items.push(meta);
      }
    }
    return items;
  } catch {
    return [];
  }
}

export function createKvConfigStore(
  kv: KVNamespace | EnrichmentCacheStore,
  options?: KvConfigStoreOptions,
): ConfigStore {
  const prefix = normalizeKeyPrefix(options?.keyPrefix);
  const defaultMaxSnapshots = normalizeMaxSnapshots(options?.maxSnapshots, DEFAULT_MAX_SNAPSHOTS);
  const nowFn = options?.now ?? (() => Date.now());
  const store = kv as KvWithOptionalDelete;

  const liveKey = formatKey(prefix, "live");
  const draftKey = formatKey(prefix, "draft");
  const historyKey = formatKey(prefix, "history");
  const snapshotKey = (id: string): string => formatKey(prefix, `snap:${id}`);

  async function readSnapshotByKey(
    key: string,
    throwOnCorrupt: boolean,
  ): Promise<ConfigSnapshot | null> {
    const raw = await store.get(key);
    if (raw === null) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      if (throwOnCorrupt) {
        throw new Error(
          `Corrupt Facet config snapshot JSON at "${key}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }

    const snapshot = parseSnapshot(parsed);
    if (snapshot === null) {
      if (throwOnCorrupt) {
        throw new Error(`Invalid Facet config snapshot payload at "${key}"`);
      }
      return null;
    }
    return snapshot;
  }

  async function publishInternal(
    yaml: string,
    publishOptions?: PublishOptions,
  ): Promise<PublishResult> {
    const parsed = parseFacetYaml(yaml);
    if (!parsed.ok) {
      return { ok: false, errors: parsed.errors };
    }

    const hash = await hashConfigYaml(yaml);
    const author = normalizeOptionalString(publishOptions?.author);
    const note = normalizeOptionalString(publishOptions?.note);
    const maxSnapshots = normalizeMaxSnapshots(publishOptions?.maxSnapshots, defaultMaxSnapshots);

    const meta: ConfigSnapshotMeta = {
      id: generateSnapshotId(nowFn),
      publishedAt: new Date(nowFn()).toISOString(),
      ...(author !== undefined ? { author } : {}),
      ...(note !== undefined ? { note } : {}),
      hash,
      experienceCount: parsed.config.experiences.length,
    };

    const snapshot: ConfigSnapshot = {
      ...meta,
      yaml,
    };

    const existingHistory = parseHistoryJson(await store.get(historyKey));
    const combined = [meta, ...existingHistory];
    const kept = combined.slice(0, maxSnapshots);
    const evicted = combined.slice(maxSnapshots);

    // Persist snapshot first, then history, then live pointer so live never references a missing snapshot.
    await store.put(snapshotKey(snapshot.id), JSON.stringify(snapshot));
    await store.put(historyKey, JSON.stringify(kept));
    await store.put(liveKey, JSON.stringify(snapshot));

    // Clear any saved draft so consumers (e.g. Studio) don't revert to a stale pre-publish draft.
    if (typeof store.delete === "function") {
      try {
        await store.delete(draftKey);
      } catch {
        try {
          await store.put(draftKey, "");
        } catch {
          // Best-effort draft clear; never fail a completed publish.
        }
      }
    } else {
      try {
        await store.put(draftKey, "");
      } catch {
        // Best-effort draft clear; never fail a completed publish.
      }
    }

    if (evicted.length > 0 && typeof store.delete === "function") {
      const keptIds = new Set(kept.map((item) => item.id));
      for (const item of evicted) {
        if (!keptIds.has(item.id)) {
          try {
            await store.delete(snapshotKey(item.id));
          } catch {
            // Best-effort cleanup; never fail a completed publish.
          }
        }
      }
    }

    return {
      ok: true,
      snapshot,
      config: parsed.config,
    };
  }

  return {
    async getLive(): Promise<ConfigSnapshot | null> {
      return readSnapshotByKey(liveKey, true);
    },

    async getDraft(): Promise<string | null> {
      const raw = await store.get(draftKey);
      return raw !== null && raw.length > 0 ? raw : null;
    },

    async saveDraft(yaml: string): Promise<SaveDraftResult> {
      const parsed = parseFacetYaml(yaml);
      if (!parsed.ok) {
        return { ok: false, errors: parsed.errors };
      }
      await store.put(draftKey, yaml);
      return { ok: true };
    },

    async publish(yaml: string, publishOptions?: PublishOptions): Promise<PublishResult> {
      return publishInternal(yaml, publishOptions);
    },

    async listSnapshots(limit?: number): Promise<ConfigSnapshotMeta[]> {
      const items = parseHistoryJson(await store.get(historyKey));
      if (limit !== undefined) {
        if (!Number.isFinite(limit) || limit <= 0) {
          return [];
        }
        return items.slice(0, Math.floor(limit));
      }
      return items;
    },

    async getSnapshot(id: string): Promise<ConfigSnapshot | null> {
      if (id.trim().length === 0) {
        return null;
      }
      return readSnapshotByKey(snapshotKey(id), false);
    },

    async rollback(snapshotId: string, rollbackOptions?: PublishOptions): Promise<PublishResult> {
      const target = await readSnapshotByKey(snapshotKey(snapshotId), false);
      if (target === null) {
        return {
          ok: false,
          errors: [
            {
              path: "snapshotId",
              message: `Snapshot "${snapshotId}" not found`,
              code: "snapshot_not_found",
            },
          ],
        };
      }

      const note = rollbackOptions?.note ?? `Rollback to ${snapshotId}`;
      return publishInternal(target.yaml, {
        ...rollbackOptions,
        note,
      });
    },
  };
}

function isConfigStore(
  source: ConfigStore | (() => Promise<string | FacetConfig | null>),
): source is ConfigStore {
  return typeof source !== "function" && typeof source.getLive === "function";
}

function createEmptyFailOpenConfig(): FacetConfig {
  const parsed = validateFacetConfig({ version: 1, experiences: [] });
  if (!parsed.ok) {
    throw new Error("Failed to construct default empty Facet config");
  }
  return parsed.config;
}

function parseOrValidateRawConfig(
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
    return DEFAULT_CONFIG_CACHE_TTL_MS;
  }
  return Math.floor(value);
}

export function createCachedConfigLoader(
  source: ConfigStore | (() => Promise<string | FacetConfig | null>),
  options?: CachedConfigLoaderOptions,
): (request: Request, env?: FacetWorkerEnv) => Promise<FacetConfig | string> {
  const ttlMs = resolveTtlMs(options?.ttlMs);
  const nowFn = options?.now ?? (() => Date.now());
  const emptyFailOpenConfig = createEmptyFailOpenConfig();

  let parsedFallback: FacetConfig | null | undefined;
  let cachedConfig: FacetConfig | null = null;
  let expiresAt = 0;
  let inFlightRefresh: Promise<FacetConfig | null> | null = null;

  function resolveFallbackConfig(): FacetConfig {
    if (parsedFallback === undefined) {
      if (options?.fallback !== undefined) {
        parsedFallback = parseOrValidateRawConfig(options.fallback, options.onError);
      } else {
        parsedFallback = null;
      }
    }
    return parsedFallback ?? emptyFailOpenConfig;
  }

  async function fetchFreshConfig(): Promise<FacetConfig | null> {
    try {
      let raw: string | FacetConfig | null;
      if (isConfigStore(source)) {
        const snapshot = await source.getLive();
        raw = snapshot !== null ? snapshot.yaml : null;
      } else {
        raw = await source();
      }

      if (raw === null) {
        return null;
      }

      return parseOrValidateRawConfig(raw, options?.onError);
    } catch (error: unknown) {
      safeNotifyError(options?.onError, error);
      return null;
    }
  }

  function triggerRefresh(): Promise<FacetConfig | null> {
    if (inFlightRefresh !== null) {
      return inFlightRefresh;
    }

    const promise = fetchFreshConfig()
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

  return async function cachedConfigLoader(
    _request: Request,
    _env?: FacetWorkerEnv,
  ): Promise<FacetConfig | string> {
    const now = nowFn();

    if (cachedConfig !== null) {
      if (now < expiresAt) {
        return cachedConfig;
      }

      // Stale-while-revalidate: serve last-known-good immediately and refresh in background.
      const refreshPromise = triggerRefresh().then(() => undefined);
      if (options?.waitUntil !== undefined) {
        try {
          options.waitUntil(refreshPromise);
        } catch (error: unknown) {
          safeNotifyError(options.onError, error);
        }
      }
      return cachedConfig;
    }

    // Cold load: wait for initial refresh, strictly failing open to fallback if unavailable/invalid.
    const fresh = await triggerRefresh();
    if (fresh !== null) {
      return fresh;
    }
    return cachedConfig ?? resolveFallbackConfig();
  };
}
