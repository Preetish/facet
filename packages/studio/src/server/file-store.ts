import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  ConfigSnapshot,
  ConfigSnapshotMeta,
  ConfigStore,
  PublishOptions,
  PublishResult,
  SaveDraftResult,
} from "../shared/types.js";
import { validateFacetYamlFull } from "../shared/validation.js";
import { hashConfigYaml } from "./store.js";

const DEFAULT_MAX_SNAPSHOTS = 20;

export interface FileConfigStoreOptions {
  stateDir?: string;
  maxSnapshots?: number;
}

interface PersistedSnapshotsFile {
  snapshots: ConfigSnapshot[];
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

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export function createFileConfigStore(
  filePath: string,
  options?: FileConfigStoreOptions,
): ConfigStore {
  const resolvedFile = resolve(filePath);
  const stateDir = resolve(options?.stateDir ?? join(dirname(resolvedFile), ".facet-studio"));
  const draftPath = join(stateDir, "draft.yaml");
  const snapshotsPath = join(stateDir, "snapshots.json");
  const maxSnapshots = Math.max(1, options?.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS);

  async function ensureStateDir(): Promise<void> {
    await mkdir(stateDir, { recursive: true });
    await mkdir(dirname(resolvedFile), { recursive: true });
  }

  async function loadSnapshots(): Promise<ConfigSnapshot[]> {
    const raw = await readTextIfExists(snapshotsPath);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedSnapshotsFile>;
      if (Array.isArray(parsed.snapshots)) {
        return parsed.snapshots;
      }
      return [];
    } catch {
      return [];
    }
  }

  async function saveSnapshots(items: ConfigSnapshot[]): Promise<void> {
    await ensureStateDir();
    const payload: PersistedSnapshotsFile = { snapshots: items };
    await writeFile(snapshotsPath, JSON.stringify(payload, null, 2), "utf8");
  }

  return {
    async getLive(): Promise<ConfigSnapshot | null> {
      const yaml = await readTextIfExists(resolvedFile);
      if (yaml === null) {
        return null;
      }
      const hash = await hashConfigYaml(yaml);
      const snapshots = await loadSnapshots();
      const matching = snapshots.find((snap) => snap.hash === hash);
      if (matching) {
        return { ...matching, yaml };
      }

      const parsed = validateFacetYamlFull(yaml);
      return {
        id: `file_${hash.slice(0, 8)}`,
        publishedAt: new Date().toISOString(),
        hash,
        experienceCount: parsed.config?.experiences.length ?? 0,
        note: "Loaded from disk",
        yaml,
      };
    },

    async getDraft(): Promise<string | null> {
      return readTextIfExists(draftPath);
    },

    async saveDraft(yaml: string): Promise<SaveDraftResult> {
      const validation = validateFacetYamlFull(yaml);
      if (!validation.ok) {
        return { ok: false, errors: validation.errors };
      }
      await ensureStateDir();
      await writeFile(draftPath, yaml, "utf8");
      return { ok: true };
    },

    async publish(yaml: string, publishOptions?: PublishOptions): Promise<PublishResult> {
      const validation = validateFacetYamlFull(yaml);
      if (!validation.ok || !validation.config) {
        return { ok: false, errors: validation.errors };
      }

      await ensureStateDir();
      await writeFile(resolvedFile, yaml, "utf8");

      const hash = await hashConfigYaml(yaml);
      const snapshot: ConfigSnapshot = {
        id: `snap_${Date.now().toString(36)}_${hash.slice(0, 8)}`,
        publishedAt: new Date().toISOString(),
        hash,
        experienceCount: validation.config.experiences.length,
        yaml,
      };
      if (publishOptions?.author?.trim()) {
        snapshot.author = publishOptions.author.trim();
      }
      if (publishOptions?.note?.trim()) {
        snapshot.note = publishOptions.note.trim();
      }

      const existing = await loadSnapshots();
      const limit = Math.max(1, publishOptions?.maxSnapshots ?? maxSnapshots);
      const next = [snapshot, ...existing].slice(0, limit);
      await saveSnapshots(next);

      // Clear draft after publish
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(draftPath);
      } catch {
        // ignore if no draft existed
      }

      return {
        ok: true,
        snapshot,
        config: validation.config,
      };
    },

    async listSnapshots(limit?: number): Promise<ConfigSnapshotMeta[]> {
      const snapshots = await loadSnapshots();
      const slice = limit !== undefined && limit >= 0 ? snapshots.slice(0, limit) : snapshots;
      return slice.map(toMeta);
    },

    async getSnapshot(id: string): Promise<ConfigSnapshot | null> {
      const snapshots = await loadSnapshots();
      const found = snapshots.find((snap) => snap.id === id);
      return found ? { ...found } : null;
    },

    async rollback(snapshotId: string, publishOptions?: PublishOptions): Promise<PublishResult> {
      const snapshots = await loadSnapshots();
      const target = snapshots.find((snap) => snap.id === snapshotId);
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
