import type {
  StudioDraftResponse,
  StudioImportCsvRequest,
  StudioImportCsvResponse,
  StudioPreviewLinkRequest,
  StudioPreviewLinkResponse,
  StudioPublishResponse,
  StudioRollbackResponse,
  StudioStateResponse,
  StudioValidateResponse,
} from "../shared/types.js";
import type { ConfigSnapshot } from "../shared/types.js";

async function requestJson<T>(
  url: string,
  init?: RequestInit,
  throwOnHttpError = false,
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!text) {
    throw new Error(`Empty response from ${url} (HTTP ${res.status})`);
  }
  const parsed = JSON.parse(text) as T & { error?: unknown };
  if (throwOnHttpError && !res.ok) {
    const msg =
      typeof parsed.error === "string" && parsed.error.trim().length > 0
        ? parsed.error
        : `Request failed (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return parsed;
}

export async function fetchStudioState(): Promise<StudioStateResponse> {
  return requestJson<StudioStateResponse>("/api/state", { method: "GET" }, true);
}

export async function validateYamlApi(yaml: string): Promise<StudioValidateResponse> {
  return requestJson<StudioValidateResponse>("/api/validate", {
    method: "POST",
    body: JSON.stringify({ yaml }),
  });
}

export async function saveDraftApi(yaml: string): Promise<StudioDraftResponse> {
  return requestJson<StudioDraftResponse>("/api/draft", {
    method: "POST",
    body: JSON.stringify({ yaml }),
  });
}

export async function publishConfigApi(payload: {
  yaml: string;
  author?: string;
  note?: string;
}): Promise<StudioPublishResponse> {
  return requestJson<StudioPublishResponse>("/api/publish", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function rollbackSnapshotApi(payload: {
  snapshotId: string;
  author?: string;
  note?: string;
}): Promise<StudioRollbackResponse> {
  return requestJson<StudioRollbackResponse>("/api/rollback", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function createPreviewLinkApi(
  payload: StudioPreviewLinkRequest,
): Promise<StudioPreviewLinkResponse> {
  return requestJson<StudioPreviewLinkResponse>("/api/preview-link", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function importCsvApi(
  payload: StudioImportCsvRequest,
): Promise<StudioImportCsvResponse> {
  return requestJson<StudioImportCsvResponse>("/api/import-csv", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchSnapshotApi(
  snapshotId: string,
): Promise<{ ok: boolean; snapshot?: ConfigSnapshot; error?: string }> {
  return requestJson<{ ok: boolean; snapshot?: ConfigSnapshot; error?: string }>(
    `/api/snapshots/${encodeURIComponent(snapshotId)}`,
    { method: "GET" },
  );
}
