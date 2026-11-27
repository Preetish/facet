import type {
  ConfigSnapshot,
  ConfigSnapshotMeta,
  ConfigStore,
  PublishOptions,
  PublishResult,
  SaveDraftResult,
} from "../shared/types.js";
import { validateFacetYamlFull } from "../shared/validation.js";

const DEFAULT_MAX_SNAPSHOTS = 20;
const textEncoder = new TextEncoder();

export async function hashConfigYaml(yaml: string): Promise<string> {
  const bytes = textEncoder.encode(yaml);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < arr.length; i++) {
    const byte = arr[i];
    if (byte !== undefined) {
      hex += byte.toString(16).padStart(2, "0");
    }
  }
  return hex;
}

function createSnapshotId(counter: number, hash: string): string {
  const ts = Date.now().toString(36);
  const seq = counter.toString(36).padStart(3, "0");
  return `snap_${ts}_${seq}_${hash.slice(0, 8)}`;
}

function toMeta(snapshot: ConfigSnapshot): ConfigSnapshotMeta {
  const meta: ConfigSnapshotMeta = {
    id: snapshot.id,
    publishedAt: snapshot.publishedAt,
    hash: snapshot.hash,
    experienceCount: snapshot.experienceCount,
  };
  if (snapshot.author !== undefined) meta.author = snapshot.author;
  if (snapshot.note !== undefined) meta.note = snapshot.note;
  return meta;
}

export interface MemoryConfigStoreOptions {
  maxSnapshots?: number;
  initialAuthor?: string;
  initialNote?: string;
}

export function createMemoryConfigStore(
  initialYaml?: string,
  options?: MemoryConfigStoreOptions,
): ConfigStore {
  const maxSnapshots = Math.max(1, options?.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS);
  let liveSnapshot: ConfigSnapshot | null = null;
  let draftYaml: string | null = null;
  let snapshots: ConfigSnapshot[] = [];
  let counter = 0;

  let initPromise: Promise<void> | null = null;
  if (initialYaml !== undefined) {
    initPromise = (async () => {
      const validation = validateFacetYamlFull(initialYaml);
      if (validation.ok && validation.config) {
        counter += 1;
        const hash = await hashConfigYaml(initialYaml);
        const snap: ConfigSnapshot = {
          id: createSnapshotId(counter, hash),
          publishedAt: new Date().toISOString(),
          hash,
          experienceCount: validation.config.experiences.length,
          yaml: initialYaml,
          ...(options?.initialAuthor ? { author: options.initialAuthor } : {}),
          ...(options?.initialNote
            ? { note: options.initialNote }
            : { note: "Initial configuration" }),
        };
        liveSnapshot = snap;
        snapshots = [snap];
      }
    })();
  }

  async function ensureInit(): Promise<void> {
    if (initPromise) {
      await initPromise;
      initPromise = null;
    }
  }

  return {
    async getLive(): Promise<ConfigSnapshot | null> {
      await ensureInit();
      return liveSnapshot ? { ...liveSnapshot } : null;
    },

    async getDraft(): Promise<string | null> {
      await ensureInit();
      return draftYaml;
    },

    async saveDraft(yaml: string): Promise<SaveDraftResult> {
      await ensureInit();
      const validation = validateFacetYamlFull(yaml);
      if (!validation.ok) {
        return { ok: false, errors: validation.errors };
      }
      draftYaml = yaml;
      return { ok: true };
    },

    async publish(yaml: string, publishOptions?: PublishOptions): Promise<PublishResult> {
      await ensureInit();
      const validation = validateFacetYamlFull(yaml);
      if (!validation.ok || !validation.config) {
        return { ok: false, errors: validation.errors };
      }

      counter += 1;
      const hash = await hashConfigYaml(yaml);
      const snapshot: ConfigSnapshot = {
        id: createSnapshotId(counter, hash),
        publishedAt: new Date().toISOString(),
        hash,
        experienceCount: validation.config.experiences.length,
        yaml,
      };
      if (publishOptions?.author !== undefined && publishOptions.author.trim().length > 0) {
        snapshot.author = publishOptions.author.trim();
      }
      if (publishOptions?.note !== undefined && publishOptions.note.trim().length > 0) {
        snapshot.note = publishOptions.note.trim();
      }

      liveSnapshot = snapshot;
      draftYaml = null;
      const limit = Math.max(1, publishOptions?.maxSnapshots ?? maxSnapshots);
      snapshots = [snapshot, ...snapshots].slice(0, limit);

      return {
        ok: true,
        snapshot: { ...snapshot },
        config: validation.config,
      };
    },

    async listSnapshots(limit?: number): Promise<ConfigSnapshotMeta[]> {
      await ensureInit();
      const slice = limit !== undefined && limit >= 0 ? snapshots.slice(0, limit) : snapshots;
      return slice.map(toMeta);
    },

    async getSnapshot(id: string): Promise<ConfigSnapshot | null> {
      await ensureInit();
      const found = snapshots.find((item) => item.id === id);
      return found ? { ...found } : null;
    },

    async rollback(snapshotId: string, publishOptions?: PublishOptions): Promise<PublishResult> {
      await ensureInit();
      const target = snapshots.find((item) => item.id === snapshotId);
      if (!target) {
        return {
          ok: false,
          errors: [
            {
              path: "snapshotId",
              message: `Snapshot "${snapshotId}" was not found`,
              code: "snapshot_not_found",
            },
          ],
        };
      }

      const note =
        publishOptions?.note?.trim() ||
        `Rolled back to snapshot ${target.id.slice(-8)} (${target.hash.slice(0, 8)})`;

      return this.publish(target.yaml, {
        ...publishOptions,
        note,
      });
    },
  };
}
