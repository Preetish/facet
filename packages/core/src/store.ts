import { parseFacetYaml, type FacetValidationError } from "./parse.js";
import type { FacetConfig } from "./schema.js";

export const DEFAULT_MAX_SNAPSHOTS = 20;

export interface ConfigSnapshotMeta {
  id: string;
  publishedAt: string;
  author?: string;
  note?: string;
  hash: string;
  experienceCount: number;
}

export type ConfigSnapshot = ConfigSnapshotMeta & {
  yaml: string;
};

export interface PublishOptions {
  author?: string;
  note?: string;
  maxSnapshots?: number;
}

export type SaveDraftResult = { ok: true } | { ok: false; errors: FacetValidationError[] };

export type PublishResult =
  | { ok: true; snapshot: ConfigSnapshot; config: FacetConfig }
  | { ok: false; errors: FacetValidationError[] };

export interface ConfigStore {
  getLive(): Promise<ConfigSnapshot | null>;
  getDraft(): Promise<string | null>;
  saveDraft(yaml: string): Promise<SaveDraftResult>;
  publish(yaml: string, options?: PublishOptions): Promise<PublishResult>;
  listSnapshots(limit?: number): Promise<ConfigSnapshotMeta[]>;
  getSnapshot(id: string): Promise<ConfigSnapshot | null>;
  rollback(snapshotId: string, options?: PublishOptions): Promise<PublishResult>;
}

export interface MemoryConfigStoreOptions {
  maxSnapshots?: number;
  now?: () => number;
  author?: string;
  note?: string;
}

const textEncoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte !== undefined) {
      out += byte.toString(16).padStart(2, "0");
    }
  }
  return out;
}

export async function hashConfigYaml(yaml: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", textEncoder.encode(yaml));
  return bytesToHex(new Uint8Array(digest));
}

export function generateSnapshotId(now?: () => number): string {
  const timestampMs = Math.max(0, Math.floor((now ?? Date.now)()));
  const tsPart = timestampMs.toString(36);
  const randBytes = new Uint8Array(4);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(randBytes);
  } else {
    for (let i = 0; i < randBytes.length; i++) {
      randBytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return `snap_${tsPart}_${bytesToHex(randBytes)}`;
}

export function normalizeMaxSnapshots(value: number | undefined, fallback?: number): number {
  const defaultLimit =
    fallback !== undefined && Number.isFinite(fallback) && fallback >= 1
      ? Math.floor(fallback)
      : DEFAULT_MAX_SNAPSHOTS;
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return defaultLimit;
  }
  return Math.floor(value);
}

function toSnapshotMeta(snapshot: ConfigSnapshot): ConfigSnapshotMeta {
  const meta: ConfigSnapshotMeta = {
    id: snapshot.id,
    publishedAt: snapshot.publishedAt,
    hash: snapshot.hash,
    experienceCount: snapshot.experienceCount,
  };
  if (snapshot.author !== undefined) {
    meta.author = snapshot.author;
  }
  if (snapshot.note !== undefined) {
    meta.note = snapshot.note;
  }
  return meta;
}

function cloneSnapshot(snapshot: ConfigSnapshot): ConfigSnapshot {
  return {
    ...toSnapshotMeta(snapshot),
    yaml: snapshot.yaml,
  };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createMemoryConfigStore(
  initialYaml?: string,
  options?: MemoryConfigStoreOptions,
): ConfigStore {
  const nowFn = options?.now ?? (() => Date.now());
  const defaultMaxSnapshots = normalizeMaxSnapshots(options?.maxSnapshots);

  let initialParsedConfig: FacetConfig | null = null;
  if (initialYaml !== undefined) {
    const parsed = parseFacetYaml(initialYaml);
    if (!parsed.ok) {
      const first = parsed.errors[0];
      throw new Error(
        `Invalid initial Facet YAML: ${first ? first.message : "unknown validation error"}`,
      );
    }
    initialParsedConfig = parsed.config;
  }

  let live: ConfigSnapshot | null = null;
  let draft: string | null = null;
  let history: ConfigSnapshotMeta[] = [];
  const snapshots = new Map<string, ConfigSnapshot>();
  let initPromise: Promise<void> | null = null;

  async function ensureInitialized(): Promise<void> {
    if (initialYaml === undefined || initialParsedConfig === null) {
      return;
    }
    if (initPromise === null) {
      const seedYaml = initialYaml;
      const seedConfig = initialParsedConfig;
      initPromise = (async (): Promise<void> => {
        const hash = await hashConfigYaml(seedYaml);
        const author = normalizeOptionalString(options?.author);
        const note = normalizeOptionalString(options?.note);
        const snapshot: ConfigSnapshot = {
          id: generateSnapshotId(nowFn),
          publishedAt: new Date(nowFn()).toISOString(),
          ...(author !== undefined ? { author } : {}),
          ...(note !== undefined ? { note } : {}),
          hash,
          experienceCount: seedConfig.experiences.length,
          yaml: seedYaml,
        };
        live = snapshot;
        snapshots.set(snapshot.id, snapshot);
        history = [toSnapshotMeta(snapshot)];
      })();
    }
    await initPromise;
  }

  async function publishInternal(
    yaml: string,
    publishOptions?: PublishOptions,
  ): Promise<PublishResult> {
    await ensureInitialized();

    const parsed = parseFacetYaml(yaml);
    if (!parsed.ok) {
      return { ok: false, errors: parsed.errors };
    }

    const hash = await hashConfigYaml(yaml);
    const author = normalizeOptionalString(publishOptions?.author);
    const note = normalizeOptionalString(publishOptions?.note);
    const maxSnapshots = normalizeMaxSnapshots(publishOptions?.maxSnapshots, defaultMaxSnapshots);

    const snapshot: ConfigSnapshot = {
      id: generateSnapshotId(nowFn),
      publishedAt: new Date(nowFn()).toISOString(),
      ...(author !== undefined ? { author } : {}),
      ...(note !== undefined ? { note } : {}),
      hash,
      experienceCount: parsed.config.experiences.length,
      yaml,
    };

    snapshots.set(snapshot.id, snapshot);
    const nextHistory = [toSnapshotMeta(snapshot), ...history];
    const kept = nextHistory.slice(0, maxSnapshots);
    const evicted = nextHistory.slice(maxSnapshots);

    const keptIds = new Set(kept.map((item) => item.id));
    for (const item of evicted) {
      if (!keptIds.has(item.id)) {
        snapshots.delete(item.id);
      }
    }

    history = kept;
    live = snapshot;
    draft = null;

    return {
      ok: true,
      snapshot: cloneSnapshot(snapshot),
      config: parsed.config,
    };
  }

  return {
    async getLive(): Promise<ConfigSnapshot | null> {
      await ensureInitialized();
      return live !== null ? cloneSnapshot(live) : null;
    },

    async getDraft(): Promise<string | null> {
      await ensureInitialized();
      return draft;
    },

    async saveDraft(yaml: string): Promise<SaveDraftResult> {
      await ensureInitialized();
      const parsed = parseFacetYaml(yaml);
      if (!parsed.ok) {
        return { ok: false, errors: parsed.errors };
      }
      draft = yaml;
      return { ok: true };
    },

    async publish(yaml: string, publishOptions?: PublishOptions): Promise<PublishResult> {
      return publishInternal(yaml, publishOptions);
    },

    async listSnapshots(limit?: number): Promise<ConfigSnapshotMeta[]> {
      await ensureInitialized();
      if (limit !== undefined) {
        if (!Number.isFinite(limit) || limit <= 0) {
          return [];
        }
        return history.slice(0, Math.floor(limit)).map((item) => ({ ...item }));
      }
      return history.map((item) => ({ ...item }));
    },

    async getSnapshot(id: string): Promise<ConfigSnapshot | null> {
      await ensureInitialized();
      const found = snapshots.get(id);
      return found !== undefined ? cloneSnapshot(found) : null;
    },

    async rollback(snapshotId: string, rollbackOptions?: PublishOptions): Promise<PublishResult> {
      await ensureInitialized();
      const target = snapshots.get(snapshotId);
      if (target === undefined) {
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
