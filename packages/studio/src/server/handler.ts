import {
  buildPreviewUrl,
  isForbiddenTemplateKey,
  parseCsvTable,
  signPreviewToken,
  validateFacetConfig,
  type FacetConfig,
  type FacetDataRow,
  type FacetDataTable,
  type FacetDataTables,
  type PreviewBucket,
} from "@facet/core";
import { DEFAULT_STARTER_YAML } from "../shared/defaults.js";
import type {
  ConfigStore,
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
import { validateFacetYamlFull } from "../shared/validation.js";
import { serializeFacetConfig } from "../shared/yaml-serializer.js";
import { handleLivePreviewRequest } from "./preview-proxy.js";

export type StudioAuthResult = boolean | { user: string };
export type StudioAuthenticator = (
  request: Request,
) => StudioAuthResult | Promise<StudioAuthResult>;

export interface StudioAsset {
  body: Uint8Array | string;
  contentType: string;
  cacheControl?: string;
}

export type StudioAssetResolver = (pathname: string) => Promise<StudioAsset | null>;

export interface StudioHandlerOptions {
  store: ConfigStore;
  targetUrl?: string;
  previewSecret?: string;
  authenticate?: StudioAuthenticator;
  requireAuth?: boolean;
  assets?: StudioAssetResolver;
  maxBodyBytes?: number;
  defaultYaml?: string;
  isDemoMode?: boolean;
  storageLabel?: string;
  allowLocalTarget?: boolean;
  disableLivePreview?: boolean;
  fetchFn?: typeof fetch;
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_PREVIEW_TTL_SECONDS = 604_800; // 7 days
const MAX_PREVIEW_TTL_SECONDS = 31_536_000; // 365 days

const BASE_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      ...BASE_SECURITY_HEADERS,
    },
  });
}

function textResponse(
  body: string,
  status = 200,
  contentType = "text/plain; charset=utf-8",
): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, no-store",
      ...BASE_SECURITY_HEADERS,
    },
  });
}

async function readJsonBody<T>(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsedLen = Number(contentLength);
    if (Number.isFinite(parsedLen) && parsedLen > maxBytes) {
      return { ok: false, status: 413, error: "Request body exceeds maximum allowed size" };
    }
  }

  let rawText: string;
  try {
    rawText = await request.text();
  } catch {
    return { ok: false, status: 400, error: "Unable to read request body" };
  }

  if (new TextEncoder().encode(rawText).byteLength > maxBytes) {
    return { ok: false, status: 413, error: "Request body exceeds maximum allowed size" };
  }

  if (rawText.trim().length === 0) {
    return { ok: false, status: 400, error: "Request body must be valid JSON" };
  }

  try {
    const parsed: unknown = JSON.parse(rawText);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: "Request body must be a JSON object" };
    }
    return { ok: true, data: parsed as T };
  } catch {
    return { ok: false, status: 400, error: "Request body contains invalid JSON" };
  }
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isPreviewBucket(value: unknown): value is PreviewBucket {
  return value === "variant" || value === "control" || value === "default";
}

function hasRawPathTraversal(rawUrl: string): boolean {
  const pathPart =
    rawUrl.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/, "").split(/[?#]/, 1)[0] ?? "";
  if (/(^|\/)\.\.(\/|$)/.test(pathPart)) {
    return true;
  }
  if (/%2e%2e|%5c|\\|%00/i.test(pathPart)) {
    return true;
  }
  return false;
}

function normalizeAssetPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) {
    return null;
  }
  const segments = decoded.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "." || s === "..")) {
    return null;
  }
  return "/" + segments.join("/");
}

function extractColumns(table: FacetDataTable): string[] {
  const cols = new Set<string>();
  for (const row of Object.values(table)) {
    for (const key of Object.keys(row)) {
      cols.add(key);
    }
  }
  return Array.from(cols);
}

export function createStudioHandler(
  options: StudioHandlerOptions,
): (request: Request) => Promise<Response> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const fallbackStarterYaml = options.defaultYaml ?? DEFAULT_STARTER_YAML;

  async function checkAuth(
    request: Request,
  ): Promise<{ authorized: true; user: string | null } | { authorized: false }> {
    const requireAuth = options.requireAuth === true;
    const authenticate = options.authenticate;

    if (requireAuth && !authenticate) {
      return { authorized: false };
    }

    if (!authenticate) {
      return { authorized: true, user: null };
    }

    try {
      const result = await authenticate(request);
      if (result === true) {
        return { authorized: true, user: null };
      }
      if (
        typeof result === "object" &&
        result !== null &&
        typeof result.user === "string" &&
        result.user.trim().length > 0
      ) {
        return { authorized: true, user: result.user.trim() };
      }
      return { authorized: false };
    } catch {
      // Fail-closed on authenticator errors
      return { authorized: false };
    }
  }

  return async function handleStudioRequest(request: Request): Promise<Response> {
    const auth = await checkAuth(request);
    if (!auth.authorized) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
    }

    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();

    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/state" && method === "GET") {
        const [live, draft, snapshots] = await Promise.all([
          options.store.getLive(),
          options.store.getDraft(),
          options.store.listSnapshots(50),
        ]);
        const activeYaml = draft ?? live?.yaml ?? fallbackStarterYaml;
        const validation = validateFacetYamlFull(activeYaml);
        const safeTargetUrl =
          options.targetUrl && isValidHttpUrl(options.targetUrl.trim())
            ? options.targetUrl.trim()
            : null;
        const isDemoMode = options.isDemoMode === true;
        const storageLabel =
          options.storageLabel && options.storageLabel.trim().length > 0
            ? options.storageLabel.trim()
            : isDemoMode
              ? "In-memory demo"
              : "Custom store";
        const canLivePreview = options.disableLivePreview !== true;
        const state: StudioStateResponse = {
          live,
          draft,
          activeYaml,
          config: validation.config ?? null,
          errors: validation.errors,
          warnings: validation.warnings,
          snapshots,
          capabilities: {
            canSignPreview: Boolean(
              options.previewSecret && options.previewSecret.trim().length > 0,
            ),
            targetUrl: safeTargetUrl,
            authRequired: options.requireAuth === true || Boolean(options.authenticate),
            user: auth.user,
            isDemoMode,
            storageLabel,
            canLivePreview,
          },
        };
        return jsonResponse(state, 200);
      }

      if (pathname === "/api/live-preview" && method === "GET") {
        if (options.disableLivePreview === true) {
          return jsonResponse({ ok: false, error: "Live site preview is disabled" }, 403);
        }
        const requestedUrl = url.searchParams.get("url")?.trim() || options.targetUrl?.trim() || "";
        if (!requestedUrl) {
          return jsonResponse(
            {
              ok: false,
              error: "A target URL is required via ?url= or configured targetUrl",
            },
            400,
          );
        }
        return handleLivePreviewRequest(requestedUrl, {
          allowLocalTarget: options.allowLocalTarget === true,
          ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        });
      }

      if (pathname === "/api/validate" && method === "POST") {
        const parsedBody = await readJsonBody<{ yaml?: unknown }>(request, maxBodyBytes);
        if (!parsedBody.ok) {
          return jsonResponse({ ok: false, error: parsedBody.error }, parsedBody.status);
        }
        if (typeof parsedBody.data.yaml !== "string") {
          return jsonResponse(
            {
              ok: false,
              errors: [
                { path: "yaml", message: "Field 'yaml' must be a string", code: "invalid_type" },
              ],
              warnings: [],
            } satisfies StudioValidateResponse,
            400,
          );
        }
        const validation = validateFacetYamlFull(parsedBody.data.yaml);
        const body: StudioValidateResponse = {
          ok: validation.ok,
          ...(validation.config ? { config: validation.config } : {}),
          errors: validation.errors,
          warnings: validation.warnings,
        };
        return jsonResponse(body, validation.ok ? 200 : 400);
      }

      if (pathname === "/api/draft" && method === "POST") {
        const parsedBody = await readJsonBody<{ yaml?: unknown }>(request, maxBodyBytes);
        if (!parsedBody.ok) {
          return jsonResponse({ ok: false, error: parsedBody.error }, parsedBody.status);
        }
        if (typeof parsedBody.data.yaml !== "string") {
          return jsonResponse(
            {
              ok: false,
              errors: [
                { path: "yaml", message: "Field 'yaml' must be a string", code: "invalid_type" },
              ],
            } satisfies StudioDraftResponse,
            400,
          );
        }

        const validation = validateFacetYamlFull(parsedBody.data.yaml);
        if (!validation.ok || !validation.config) {
          return jsonResponse(
            {
              ok: false,
              errors: validation.errors,
              warnings: validation.warnings,
            } satisfies StudioDraftResponse,
            400,
          );
        }

        const saved = await options.store.saveDraft(parsedBody.data.yaml);
        if (!saved.ok) {
          return jsonResponse(
            { ok: false, errors: saved.errors } satisfies StudioDraftResponse,
            400,
          );
        }

        return jsonResponse(
          {
            ok: true,
            config: validation.config,
            warnings: validation.warnings,
          } satisfies StudioDraftResponse,
          200,
        );
      }

      if (pathname === "/api/publish" && method === "POST") {
        const parsedBody = await readJsonBody<{
          yaml?: unknown;
          author?: unknown;
          note?: unknown;
        }>(request, maxBodyBytes);
        if (!parsedBody.ok) {
          return jsonResponse({ ok: false, error: parsedBody.error }, parsedBody.status);
        }
        if (typeof parsedBody.data.yaml !== "string") {
          return jsonResponse(
            {
              ok: false,
              errors: [
                { path: "yaml", message: "Field 'yaml' must be a string", code: "invalid_type" },
              ],
            } satisfies StudioPublishResponse,
            400,
          );
        }

        const validation = validateFacetYamlFull(parsedBody.data.yaml);
        if (!validation.ok) {
          return jsonResponse(
            { ok: false, errors: validation.errors } satisfies StudioPublishResponse,
            400,
          );
        }

        const author =
          typeof parsedBody.data.author === "string" && parsedBody.data.author.trim().length > 0
            ? parsedBody.data.author.trim()
            : (auth.user ?? undefined);
        const note =
          typeof parsedBody.data.note === "string" && parsedBody.data.note.trim().length > 0
            ? parsedBody.data.note.trim()
            : undefined;

        const publishResult = await options.store.publish(parsedBody.data.yaml, {
          ...(author !== undefined ? { author } : {}),
          ...(note !== undefined ? { note } : {}),
        });

        if (!publishResult.ok) {
          return jsonResponse(
            { ok: false, errors: publishResult.errors } satisfies StudioPublishResponse,
            400,
          );
        }

        return jsonResponse(
          {
            ok: true,
            snapshot: publishResult.snapshot,
            config: publishResult.config,
          } satisfies StudioPublishResponse,
          200,
        );
      }

      if (pathname === "/api/rollback" && method === "POST") {
        const parsedBody = await readJsonBody<{
          snapshotId?: unknown;
          author?: unknown;
          note?: unknown;
        }>(request, maxBodyBytes);
        if (!parsedBody.ok) {
          return jsonResponse({ ok: false, error: parsedBody.error }, parsedBody.status);
        }
        if (
          typeof parsedBody.data.snapshotId !== "string" ||
          parsedBody.data.snapshotId.trim().length === 0
        ) {
          return jsonResponse(
            {
              ok: false,
              errors: [
                {
                  path: "snapshotId",
                  message: "Field 'snapshotId' must be a non-empty string",
                  code: "invalid_type",
                },
              ],
            } satisfies StudioRollbackResponse,
            400,
          );
        }

        const author =
          typeof parsedBody.data.author === "string" && parsedBody.data.author.trim().length > 0
            ? parsedBody.data.author.trim()
            : (auth.user ?? undefined);
        const note =
          typeof parsedBody.data.note === "string" && parsedBody.data.note.trim().length > 0
            ? parsedBody.data.note.trim()
            : undefined;

        const result = await options.store.rollback(parsedBody.data.snapshotId.trim(), {
          ...(author !== undefined ? { author } : {}),
          ...(note !== undefined ? { note } : {}),
        });

        if (!result.ok) {
          const notFound = result.errors.some((e) => e.code === "snapshot_not_found");
          return jsonResponse(
            { ok: false, errors: result.errors } satisfies StudioRollbackResponse,
            notFound ? 404 : 400,
          );
        }

        return jsonResponse(
          {
            ok: true,
            snapshot: result.snapshot,
            config: result.config,
          } satisfies StudioRollbackResponse,
          200,
        );
      }

      if (pathname === "/api/preview-link" && method === "POST") {
        const secret = options.previewSecret?.trim();
        if (!secret) {
          return jsonResponse(
            {
              ok: false,
              error:
                "Preview signing secret is not configured. Start Studio with --preview-secret or set FACET_PREVIEW_SECRET.",
            } satisfies StudioPreviewLinkResponse,
            400,
          );
        }

        const parsedBody = await readJsonBody<Partial<StudioPreviewLinkRequest>>(
          request,
          maxBodyBytes,
        );
        if (!parsedBody.ok) {
          return jsonResponse(
            { ok: false, error: parsedBody.error } satisfies StudioPreviewLinkResponse,
            parsedBody.status,
          );
        }

        const experienceId =
          typeof parsedBody.data.experienceId === "string"
            ? parsedBody.data.experienceId.trim()
            : "";
        if (!experienceId) {
          return jsonResponse(
            { ok: false, error: "experienceId is required" } satisfies StudioPreviewLinkResponse,
            400,
          );
        }

        const bucket: PreviewBucket | undefined =
          parsedBody.data.bucket === undefined
            ? "variant"
            : isPreviewBucket(parsedBody.data.bucket)
              ? parsedBody.data.bucket
              : undefined;
        if (!bucket) {
          return jsonResponse(
            {
              ok: false,
              error: 'bucket must be one of "variant", "control", or "default"',
            } satisfies StudioPreviewLinkResponse,
            400,
          );
        }

        const rawBaseUrl =
          typeof parsedBody.data.baseUrl === "string" && parsedBody.data.baseUrl.trim().length > 0
            ? parsedBody.data.baseUrl.trim()
            : (options.targetUrl?.trim() ?? "");

        if (!rawBaseUrl || !isValidHttpUrl(rawBaseUrl)) {
          return jsonResponse(
            {
              ok: false,
              error:
                "A valid http:// or https:// baseUrl (or configured targetUrl) is required to build a shareable preview link.",
            } satisfies StudioPreviewLinkResponse,
            400,
          );
        }

        let ttlSeconds = DEFAULT_PREVIEW_TTL_SECONDS;
        if (parsedBody.data.ttlSeconds !== undefined) {
          if (
            typeof parsedBody.data.ttlSeconds !== "number" ||
            !Number.isInteger(parsedBody.data.ttlSeconds) ||
            parsedBody.data.ttlSeconds <= 0 ||
            parsedBody.data.ttlSeconds > MAX_PREVIEW_TTL_SECONDS
          ) {
            return jsonResponse(
              {
                ok: false,
                error: "ttlSeconds must be a positive integer up to 31536000 (365 days)",
              } satisfies StudioPreviewLinkResponse,
              400,
            );
          }
          ttlSeconds = parsedBody.data.ttlSeconds;
        }

        const live = await options.store.getLive();
        const draft = await options.store.getDraft();
        const activeYaml = draft ?? live?.yaml ?? fallbackStarterYaml;
        const activeValidation = validateFacetYamlFull(activeYaml);
        const previewParam = activeValidation.config?.settings.previewParam;
        const previewSigParam = activeValidation.config?.settings.previewSigParam;

        const targetWithParams = new URL(rawBaseUrl);
        if (
          parsedBody.data.queryParams &&
          typeof parsedBody.data.queryParams === "object" &&
          !Array.isArray(parsedBody.data.queryParams)
        ) {
          for (const [k, v] of Object.entries(parsedBody.data.queryParams)) {
            if (typeof v === "string" && k.trim().length > 0 && !isForbiddenTemplateKey(k)) {
              targetWithParams.searchParams.set(k.trim(), v);
            }
          }
        }

        const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
        const token = await signPreviewToken({
          experienceId,
          secret,
          expiresAt,
          bucket,
        });
        const signedUrl = await buildPreviewUrl({
          baseUrl: targetWithParams.toString(),
          experienceId,
          secret,
          expiresAt,
          bucket,
          ...(previewParam ? { previewParam } : {}),
          ...(previewSigParam ? { previewSigParam } : {}),
        });

        return jsonResponse(
          {
            ok: true,
            url: signedUrl,
            token,
            expiresAt,
          } satisfies StudioPreviewLinkResponse,
          200,
        );
      }

      if (pathname === "/api/import-csv" && method === "POST") {
        const parsedBody = await readJsonBody<Partial<StudioImportCsvRequest>>(
          request,
          maxBodyBytes,
        );
        if (!parsedBody.ok) {
          return jsonResponse(
            { ok: false, error: parsedBody.error } satisfies StudioImportCsvResponse,
            parsedBody.status,
          );
        }

        const csv = typeof parsedBody.data.csv === "string" ? parsedBody.data.csv : "";
        const tableName =
          typeof parsedBody.data.tableName === "string" ? parsedBody.data.tableName.trim() : "";
        const keyColumn =
          typeof parsedBody.data.keyColumn === "string" ? parsedBody.data.keyColumn.trim() : "";
        const mergeMode = parsedBody.data.mergeMode === "replace" ? "replace" : "merge";

        if (!csv.trim()) {
          return jsonResponse(
            { ok: false, error: "CSV content cannot be empty" } satisfies StudioImportCsvResponse,
            400,
          );
        }
        if (
          !tableName ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(tableName) ||
          isForbiddenTemplateKey(tableName)
        ) {
          return jsonResponse(
            {
              ok: false,
              error:
                "tableName must start with an alphanumeric character and contain only letters, digits, '.', '_', or '-'",
            } satisfies StudioImportCsvResponse,
            400,
          );
        }
        if (!keyColumn || isForbiddenTemplateKey(keyColumn)) {
          return jsonResponse(
            {
              ok: false,
              error: "keyColumn must be a valid non-empty column name",
            } satisfies StudioImportCsvResponse,
            400,
          );
        }

        let importedTable: FacetDataTable;
        try {
          importedTable = parseCsvTable(csv, keyColumn) as FacetDataTable;
        } catch (err) {
          return jsonResponse(
            {
              ok: false,
              error: err instanceof Error ? err.message : "Failed to parse CSV",
            } satisfies StudioImportCsvResponse,
            400,
          );
        }

        const baseYaml =
          typeof parsedBody.data.baseYaml === "string" && parsedBody.data.baseYaml.trim().length > 0
            ? parsedBody.data.baseYaml
            : ((await options.store.getDraft()) ??
              (await options.store.getLive())?.yaml ??
              fallbackStarterYaml);

        const baseValidation = validateFacetYamlFull(baseYaml);
        if (!baseValidation.ok || !baseValidation.config) {
          return jsonResponse(
            {
              ok: false,
              error: "Current configuration is invalid; fix YAML errors before importing CSV.",
              errors: baseValidation.errors,
            } satisfies StudioImportCsvResponse,
            400,
          );
        }

        const existingData: FacetDataTables = { ...(baseValidation.config.data ?? {}) };
        const existingTable: FacetDataTable =
          mergeMode === "merge" &&
          Object.prototype.hasOwnProperty.call(existingData, tableName) &&
          existingData[tableName]
            ? { ...existingData[tableName] }
            : {};

        for (const [rowKey, rowVal] of Object.entries(importedTable)) {
          if (!isForbiddenTemplateKey(rowKey)) {
            existingTable[rowKey] = { ...(rowVal as FacetDataRow) };
          }
        }

        const nextData: FacetDataTables = {
          ...existingData,
          [tableName]: existingTable,
        };

        const nextConfigCandidate: FacetConfig = {
          ...baseValidation.config,
          data: nextData,
        };

        const validatedNext = validateFacetConfig(nextConfigCandidate);
        if (!validatedNext.ok) {
          return jsonResponse(
            {
              ok: false,
              error: "Imported CSV table failed Facet schema validation",
              errors: validatedNext.errors,
            } satisfies StudioImportCsvResponse,
            400,
          );
        }

        const nextYaml = serializeFacetConfig(validatedNext.config);
        return jsonResponse(
          {
            ok: true,
            tableName,
            rowCount: Object.keys(existingTable).length,
            columns: extractColumns(existingTable),
            table: existingTable,
            yaml: nextYaml,
            config: validatedNext.config,
          } satisfies StudioImportCsvResponse,
          200,
        );
      }

      if (pathname.startsWith("/api/snapshots/") && method === "GET") {
        let snapshotId: string;
        try {
          snapshotId = decodeURIComponent(pathname.slice("/api/snapshots/".length));
        } catch {
          return jsonResponse({ ok: false, error: "Invalid snapshot ID encoding" }, 400);
        }
        if (!snapshotId) {
          return jsonResponse({ ok: false, error: "Snapshot ID is required" }, 400);
        }
        const snapshot = await options.store.getSnapshot(snapshotId);
        if (!snapshot) {
          return jsonResponse({ ok: false, error: "Snapshot not found" }, 404);
        }
        return jsonResponse({ ok: true, snapshot }, 200);
      }

      return jsonResponse({ ok: false, error: `Unknown API route: ${method} ${pathname}` }, 404);
    }

    // Static UI asset serving
    if (options.assets && (method === "GET" || method === "HEAD")) {
      if (hasRawPathTraversal(request.url)) {
        return textResponse("Bad request", 400);
      }
      const normalized = normalizeAssetPath(pathname);
      if (normalized === null) {
        return textResponse("Bad request", 400);
      }

      const targetPath = normalized === "/" ? "/index.html" : normalized;
      let asset = await options.assets(targetPath);

      // SPA fallback for client routes without a file extension
      if (!asset && !targetPath.includes(".")) {
        asset = await options.assets("/index.html");
      }

      if (asset) {
        const headers: Record<string, string> = {
          "Content-Type": asset.contentType,
          "Cache-Control":
            asset.cacheControl ??
            (targetPath.startsWith("/assets/")
              ? "public, max-age=31536000, immutable"
              : "private, no-cache"),
          ...BASE_SECURITY_HEADERS,
        };
        const responseBody: BodyInit | null =
          method === "HEAD"
            ? null
            : typeof asset.body === "string"
              ? asset.body
              : new Uint8Array(asset.body);
        return new Response(responseBody, { status: 200, headers });
      }
    }

    return textResponse("Not Found", 404);
  };
}
