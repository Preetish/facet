import { parseFacetYaml, type FacetConfig } from "@facet/core";
import { base64ToUtf8, hashYaml, utf8ToBase64 } from "./utils.js";

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

export interface SyncSnapshotMeta {
  id: string;
  publishedAt: string;
  author?: string;
  note?: string;
  hash: string;
  experienceCount: number;
}

export interface SyncSnapshot extends SyncSnapshotMeta {
  yaml: string;
}

export interface PublishPayload {
  yaml: string;
  config: FacetConfig;
  hash: string;
  author?: string;
  note?: string;
  now?: Date;
}

export interface SyncTargetPublishResult {
  target: string;
  changed: boolean;
  hash: string;
  snapshotId?: string;
  url?: string;
  prNumber?: number;
  branchName?: string;
  commitSha?: string;
}

export interface SyncTarget {
  readonly name: string;
  getCurrentHash?(): Promise<string | null>;
  publish(payload: PublishPayload): Promise<SyncTargetPublishResult>;
}

export interface CloudflareKvTargetOptions {
  accountId?: string;
  namespaceId?: string;
  apiToken?: string;
  kv?: KVLike;
  keyPrefix?: string;
  maxSnapshots?: number;
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface GitHubPrTargetOptions {
  owner: string;
  repo: string;
  token: string;
  filePath?: string;
  baseBranch?: string;
  branchName?: string;
  prTitle?: string;
  prBody?: string;
  commitMessage?: string;
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
}

const DEFAULT_KV_KEY_PREFIX = "facet:config:";
const DEFAULT_MAX_SNAPSHOTS = 20;
const DEFAULT_CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_GITHUB_API_BASE = "https://api.github.com";

function resolveFetch(fetchFn?: typeof fetch): typeof fetch {
  if (fetchFn) return fetchFn;
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }
  throw new Error("No fetch implementation available; pass fetchFn in options");
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
  } catch {
    return "";
  }
}

function createRestKvAdapter(options: {
  accountId: string;
  namespaceId: string;
  apiToken: string;
  apiBaseUrl: string;
  fetchFn: typeof fetch;
}): KVLike {
  const base = `${options.apiBaseUrl.replace(/\/+$/, "")}/accounts/${encodeURIComponent(options.accountId)}/storage/kv/namespaces/${encodeURIComponent(options.namespaceId)}/values`;
  const authHeader = `Bearer ${options.apiToken}`;

  return {
    async get(key: string): Promise<string | null> {
      const response = await options.fetchFn(`${base}/${encodeURIComponent(key)}`, {
        method: "GET",
        headers: {
          Authorization: authHeader,
        },
      });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new Error(
          `Cloudflare KV GET "${key}" failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
        );
      }
      return response.text();
    },
    async put(key: string, value: string): Promise<void> {
      const response = await options.fetchFn(`${base}/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": "text/plain; charset=utf-8",
        },
        body: value,
      });
      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new Error(
          `Cloudflare KV PUT "${key}" failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
        );
      }
    },
    async delete(key: string): Promise<void> {
      const response = await options.fetchFn(`${base}/${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: {
          Authorization: authHeader,
        },
      });
      if (response.status === 404) {
        return;
      }
      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new Error(
          `Cloudflare KV DELETE "${key}" failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
        );
      }
    },
  };
}

function buildSnapshotId(now: Date, hash: string): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  return `${stamp}-${hash.slice(0, 8)}`;
}

function parseSnapshotHistory(raw: string | null): SyncSnapshotMeta[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SyncSnapshotMeta =>
        Boolean(entry) &&
        typeof entry === "object" &&
        typeof (entry as SyncSnapshotMeta).id === "string" &&
        typeof (entry as SyncSnapshotMeta).hash === "string" &&
        typeof (entry as SyncSnapshotMeta).publishedAt === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Creates a Cloudflare KV publish target that writes validated Facet YAML plus bounded
 * snapshot history (`live`, `history`, `snap:<id>`). Works with either a direct Worker
 * `KVNamespace` binding (`kv`) or the Cloudflare REST API (`accountId`, `namespaceId`, `apiToken`).
 */
export function createCloudflareKvTarget(options: CloudflareKvTargetOptions): SyncTarget {
  let kvStore: KVLike;
  if (options.kv) {
    kvStore = options.kv;
  } else {
    const accountId = options.accountId?.trim();
    const namespaceId = options.namespaceId?.trim();
    const apiToken = options.apiToken?.trim();
    if (!accountId || !namespaceId || !apiToken) {
      throw new Error(
        "createCloudflareKvTarget requires either a kv binding or accountId, namespaceId, and apiToken",
      );
    }
    kvStore = createRestKvAdapter({
      accountId,
      namespaceId,
      apiToken,
      apiBaseUrl: options.apiBaseUrl ?? DEFAULT_CLOUDFLARE_API_BASE,
      fetchFn: resolveFetch(options.fetchFn),
    });
  }

  const keyPrefix = options.keyPrefix ?? DEFAULT_KV_KEY_PREFIX;
  const maxSnapshots = Math.max(1, Math.floor(options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS));

  const liveKey = `${keyPrefix}live`;
  const historyKey = `${keyPrefix}history`;
  const snapKey = (id: string): string => `${keyPrefix}snap:${id}`;

  return {
    name: options.kv ? "cloudflare-kv-binding" : "cloudflare-kv-rest",
    async getCurrentHash(): Promise<string | null> {
      const raw = await kvStore.get(liveKey);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as Partial<SyncSnapshot>;
        if (typeof parsed.hash === "string" && parsed.hash.length > 0) {
          return parsed.hash;
        }
        if (typeof parsed.yaml === "string") {
          return hashYaml(parsed.yaml);
        }
      } catch {
        // Fallback if live key stores raw YAML directly
        return hashYaml(raw);
      }
      return null;
    },
    async publish(payload: PublishPayload): Promise<SyncTargetPublishResult> {
      const validated = parseFacetYaml(payload.yaml);
      if (!validated.ok) {
        const details = validated.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
        throw new Error(`Refusing to publish invalid Facet YAML to Cloudflare KV: ${details}`);
      }

      const now = payload.now ?? new Date();
      const hash = payload.hash || (await hashYaml(payload.yaml));
      const snapshotId = buildSnapshotId(now, hash);

      const meta: SyncSnapshotMeta = {
        id: snapshotId,
        publishedAt: now.toISOString(),
        hash,
        experienceCount: validated.config.experiences.length,
      };
      if (payload.author !== undefined) meta.author = payload.author;
      if (payload.note !== undefined) meta.note = payload.note;

      const snapshot: SyncSnapshot = {
        ...meta,
        yaml: payload.yaml,
      };

      const existingHistory = parseSnapshotHistory(await kvStore.get(historyKey));
      const updatedHistory = [meta, ...existingHistory.filter((item) => item.id !== snapshotId)];
      const keptHistory = updatedHistory.slice(0, maxSnapshots);
      const prunedHistory = updatedHistory.slice(maxSnapshots);

      // Write snapshot first, then live pointer and history index
      await kvStore.put(snapKey(snapshotId), JSON.stringify(snapshot));
      await kvStore.put(liveKey, JSON.stringify(snapshot));
      await kvStore.put(historyKey, JSON.stringify(keptHistory));

      if (kvStore.delete && prunedHistory.length > 0) {
        for (const old of prunedHistory) {
          try {
            await kvStore.delete(snapKey(old.id));
          } catch {
            // Best-effort pruning; live config is already updated
          }
        }
      }

      return {
        target: options.kv ? "cloudflare-kv-binding" : "cloudflare-kv-rest",
        changed: true,
        hash,
        snapshotId,
      };
    },
  };
}

function encodePathSegments(filePath: string): string {
  return filePath
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function encodeRefPath(branch: string): string {
  return branch
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

interface GitHubRefResponse {
  object?: { sha?: string };
}

interface GitHubContentResponse {
  sha?: string;
  content?: string;
  encoding?: string;
}

interface GitHubPutContentResponse {
  commit?: { sha?: string };
}

interface GitHubPullRequest {
  number: number;
  html_url: string;
}

/**
 * Creates a GitHub REST API publish target that creates or updates a branch, commits
 * validated `facet.yaml`, and opens or updates a Pull Request (zero git binary required).
 */
export function createGitHubPrTarget(options: GitHubPrTargetOptions): SyncTarget {
  const owner = options.owner.trim();
  const repo = options.repo.trim();
  const token = options.token.trim();

  if (owner.length === 0) {
    throw new Error("createGitHubPrTarget requires a non-empty owner");
  }
  if (repo.length === 0) {
    throw new Error("createGitHubPrTarget requires a non-empty repo");
  }
  if (token.length === 0) {
    throw new Error("createGitHubPrTarget requires a non-empty token");
  }

  const filePath = (options.filePath ?? "facet.yaml").replace(/^\/+/, "");
  const baseBranch = options.baseBranch?.trim() || "main";
  const branchName = options.branchName?.trim() || "facet/sync-config";
  const prTitle = options.prTitle?.trim() || "chore(facet): sync personalization config";
  const apiBase = (options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE).replace(/\/+$/, "");
  const fetchFn = resolveFetch(options.fetchFn);

  const repoBase = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const encodedFilePath = encodePathSegments(filePath);

  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "facet-sync/0.1.0",
  };

  async function githubRequest(url: string, init: RequestInit = {}): Promise<Response> {
    const mergedHeaders: Record<string, string> = {
      ...baseHeaders,
    };
    if (init.headers) {
      const incoming = new Headers(init.headers);
      incoming.forEach((value, key) => {
        mergedHeaders[key] = value;
      });
    }
    return fetchFn(url, {
      ...init,
      headers: mergedHeaders,
    });
  }

  async function getFileOnBranch(ref: string): Promise<{ sha: string; content: string } | null> {
    const response = await githubRequest(
      `${repoBase}/contents/${encodedFilePath}?ref=${encodeURIComponent(ref)}`,
      { method: "GET" },
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw new Error(
        `GitHub GET contents (${filePath}@${ref}) failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
      );
    }
    const data = (await response.json()) as GitHubContentResponse;
    if (!data.sha) {
      return null;
    }
    const content =
      data.encoding === "base64" && typeof data.content === "string"
        ? base64ToUtf8(data.content)
        : typeof data.content === "string"
          ? data.content
          : "";
    return { sha: data.sha, content };
  }

  function buildPrBody(payload: PublishPayload, hash: string): string {
    if (options.prBody !== undefined) {
      return options.prBody;
    }
    const lines = [
      "Automated Facet configuration sync.",
      "",
      `- **File:** \`${filePath}\``,
      `- **Experiences:** ${payload.config.experiences.length}`,
      `- **Content SHA-256:** \`${hash.slice(0, 12)}\``,
    ];
    if (payload.author) {
      lines.push(`- **Author:** ${payload.author}`);
    }
    if (payload.note) {
      lines.push(`- **Note:** ${payload.note}`);
    }
    return lines.join("\n");
  }

  return {
    name: "github-pr",
    async getCurrentHash(): Promise<string | null> {
      const onTargetBranch = await getFileOnBranch(branchName);
      if (onTargetBranch) {
        return hashYaml(onTargetBranch.content);
      }
      if (branchName !== baseBranch) {
        const onBaseBranch = await getFileOnBranch(baseBranch);
        if (onBaseBranch) {
          return hashYaml(onBaseBranch.content);
        }
      }
      return null;
    },
    async publish(payload: PublishPayload): Promise<SyncTargetPublishResult> {
      const validated = parseFacetYaml(payload.yaml);
      if (!validated.ok) {
        const details = validated.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
        throw new Error(`Refusing to publish invalid Facet YAML to GitHub: ${details}`);
      }

      const hash = payload.hash || (await hashYaml(payload.yaml));

      // 1. Ensure target branch exists (creating it from baseBranch if needed)
      const branchRefRes = await githubRequest(
        `${repoBase}/git/ref/heads/${encodeRefPath(branchName)}`,
        { method: "GET" },
      );

      if (branchRefRes.status === 404) {
        const baseRefRes = await githubRequest(
          `${repoBase}/git/ref/heads/${encodeRefPath(baseBranch)}`,
          { method: "GET" },
        );
        if (!baseRefRes.ok) {
          const detail = await readErrorBody(baseRefRes);
          throw new Error(
            `GitHub GET base ref "${baseBranch}" failed (${baseRefRes.status} ${baseRefRes.statusText})${detail ? `: ${detail}` : ""}`,
          );
        }
        const baseRefData = (await baseRefRes.json()) as GitHubRefResponse;
        const baseSha = baseRefData.object?.sha;
        if (!baseSha) {
          throw new Error(`GitHub base branch "${baseBranch}" did not return a commit SHA`);
        }

        const createRefRes = await githubRequest(`${repoBase}/git/refs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ref: `refs/heads/${branchName}`,
            sha: baseSha,
          }),
        });
        if (!createRefRes.ok) {
          const detail = await readErrorBody(createRefRes);
          throw new Error(
            `GitHub create branch "${branchName}" failed (${createRefRes.status} ${createRefRes.statusText})${detail ? `: ${detail}` : ""}`,
          );
        }
      } else if (!branchRefRes.ok) {
        const detail = await readErrorBody(branchRefRes);
        throw new Error(
          `GitHub GET branch "${branchName}" failed (${branchRefRes.status} ${branchRefRes.statusText})${detail ? `: ${detail}` : ""}`,
        );
      }

      // 2. Check existing file on target branch and commit updated YAML
      const existingFile = await getFileOnBranch(branchName);
      let commitSha: string | undefined;
      let changed = true;

      if (existingFile && (await hashYaml(existingFile.content)) === hash) {
        changed = false;
      } else {
        const commitMessage =
          options.commitMessage ??
          `chore(facet): sync ${filePath} (${validated.config.experiences.length} experiences)`;
        const putBody: Record<string, unknown> = {
          message: commitMessage,
          content: utf8ToBase64(payload.yaml),
          branch: branchName,
        };
        if (existingFile?.sha) {
          putBody.sha = existingFile.sha;
        }

        const putRes = await githubRequest(`${repoBase}/contents/${encodedFilePath}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(putBody),
        });
        if (!putRes.ok) {
          const detail = await readErrorBody(putRes);
          throw new Error(
            `GitHub commit "${filePath}" on "${branchName}" failed (${putRes.status} ${putRes.statusText})${detail ? `: ${detail}` : ""}`,
          );
        }
        const putData = (await putRes.json()) as GitHubPutContentResponse;
        commitSha = putData.commit?.sha;
      }

      const result: SyncTargetPublishResult = {
        target: "github-pr",
        changed,
        hash,
        branchName,
      };
      if (commitSha !== undefined) {
        result.commitSha = commitSha;
      }

      if (branchName === baseBranch) {
        return result;
      }

      // 3. Create or update the Pull Request for branchName -> baseBranch
      const prBody = buildPrBody(payload, hash);
      const listPrUrl = `${repoBase}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branchName}`)}&base=${encodeURIComponent(baseBranch)}`;
      const listPrRes = await githubRequest(listPrUrl, { method: "GET" });
      if (!listPrRes.ok) {
        const detail = await readErrorBody(listPrRes);
        throw new Error(
          `GitHub list PRs failed (${listPrRes.status} ${listPrRes.statusText})${detail ? `: ${detail}` : ""}`,
        );
      }

      const existingPrs = (await listPrRes.json()) as GitHubPullRequest[];
      const openPr = Array.isArray(existingPrs) ? existingPrs[0] : undefined;

      if (openPr) {
        if (changed) {
          const updatePrRes = await githubRequest(`${repoBase}/pulls/${openPr.number}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: prTitle,
              body: prBody,
            }),
          });
          if (!updatePrRes.ok) {
            const detail = await readErrorBody(updatePrRes);
            throw new Error(
              `GitHub update PR #${openPr.number} failed (${updatePrRes.status} ${updatePrRes.statusText})${detail ? `: ${detail}` : ""}`,
            );
          }
          const updatedPr = (await updatePrRes.json()) as GitHubPullRequest;
          result.prNumber = updatedPr.number;
          result.url = updatedPr.html_url;
        } else {
          result.prNumber = openPr.number;
          result.url = openPr.html_url;
        }
      } else if (changed) {
        const createPrRes = await githubRequest(`${repoBase}/pulls`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: prTitle,
            head: branchName,
            base: baseBranch,
            body: prBody,
          }),
        });
        if (!createPrRes.ok) {
          const detail = await readErrorBody(createPrRes);
          throw new Error(
            `GitHub create PR failed (${createPrRes.status} ${createPrRes.statusText})${detail ? `: ${detail}` : ""}`,
          );
        }
        const createdPr = (await createPrRes.json()) as GitHubPullRequest;
        result.prNumber = createdPr.number;
        result.url = createdPr.html_url;
      }

      return result;
    },
  };
}
