import { watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  PERSONALIZED_CACHE_CONTROL,
  buildAnalyticsSnippet,
  buildContextFromRequest,
  evaluate,
  parseFacetYaml,
  toAnalyticsExposures,
  type EvaluateOptions,
  type FacetConfig,
} from "@facet/core";
import {
  LOCAL_MODE_COOKIE_NAME,
  buildPreviewBarHtml,
  resolveLocalPreviewMode,
} from "./preview-bar.js";
import { rewriteHtml } from "./rewriter.js";

export interface PreviewLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface PreviewServerOptions {
  target: string;
  configPath: string;
  port?: number;
  host?: string;
  injectPreviewBar?: boolean;
  logger?: Partial<PreviewLogger>;
}

export interface PreviewServerAddress {
  host: string;
  port: number;
  url: string;
}

export type LoadedConfigState =
  | {
      ok: true;
      config: FacetConfig;
      mtimeMs: number;
      ctimeMs: number;
      size: number;
    }
  | {
      ok: false;
      error: string;
      mtimeMs?: number;
      ctimeMs?: number;
      size?: number;
    };

export interface PreviewServer {
  readonly server: http.Server;
  start(): Promise<PreviewServerAddress>;
  close(): Promise<void>;
  reloadConfig(): Promise<LoadedConfigState>;
  address(): PreviewServerAddress | null;
}

const STATIC_ASSET_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".map",
  ".json",
  ".xml",
  ".txt",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".avif",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".pdf",
  ".zip",
  ".gz",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".wasm",
]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const DEFAULT_LOGGER: PreviewLogger = {
  info: (msg: string): void => {
    process.stdout.write(`${msg}\n`);
  },
  warn: (msg: string): void => {
    process.stderr.write(`${msg}\n`);
  },
  error: (msg: string): void => {
    process.stderr.write(`${msg}\n`);
  },
};

export function isStaticAssetPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  const lastSlash = lower.lastIndexOf("/");
  const basename = lastSlash >= 0 ? lower.slice(lastSlash + 1) : lower;
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0) {
    return false;
  }
  const ext = basename.slice(dotIndex);
  return STATIC_ASSET_EXTENSIONS.has(ext);
}

function isHtmlContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }
  return contentType.toLowerCase().includes("text/html");
}

function buildWebHeaders(nodeHeaders: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function buildUpstreamRequestHeaders(
  req: IncomingMessage,
  targetUrl: URL,
  forceIdentityEncoding: boolean,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "host") {
      continue;
    }
    if (forceIdentityEncoding && lower === "accept-encoding") {
      continue;
    }
    out[key] = value;
  }
  out.host = targetUrl.host;
  if (forceIdentityEncoding) {
    out["accept-encoding"] = "identity";
  }
  return out;
}

function rewriteRedirectLocation(location: string, targetOrigin: URL, proxyOrigin: string): string {
  try {
    const resolved = new URL(location, targetOrigin);
    if (resolved.origin === targetOrigin.origin) {
      const proxyBase = new URL(proxyOrigin);
      resolved.protocol = proxyBase.protocol;
      resolved.host = proxyBase.host;
      return resolved.toString();
    }
  } catch {
    // Keep untouched if Location is malformed.
  }
  return location;
}

function copyUpstreamHeaders(
  upstreamHeaders: http.IncomingHttpHeaders,
  targetUrl: URL,
  proxyOrigin: string,
  stripLengthAndEncoding: boolean,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) {
      continue;
    }
    if (stripLengthAndEncoding && (lower === "content-length" || lower === "content-encoding")) {
      continue;
    }
    if (lower === "location" && typeof value === "string") {
      out[key] = rewriteRedirectLocation(value, targetUrl, proxyOrigin);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function appendSetCookie(headers: http.OutgoingHttpHeaders, cookie: string): void {
  const existing = headers["set-cookie"];
  if (existing === undefined) {
    headers["set-cookie"] = [cookie];
  } else if (Array.isArray(existing)) {
    headers["set-cookie"] = [...existing, cookie];
  } else {
    headers["set-cookie"] = [String(existing), cookie];
  }
}

function readStreamToBuffer(stream: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    stream.on("error", reject);
  });
}

function requestUpstream(
  upstreamUrl: URL,
  method: string,
  headers: http.OutgoingHttpHeaders,
  bodyStream: IncomingMessage | null,
): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const transport = upstreamUrl.protocol === "https:" ? https : http;
    const upstreamReq = transport.request(
      upstreamUrl,
      {
        method,
        headers,
      },
      (upstreamRes) => {
        resolve(upstreamRes);
      },
    );

    upstreamReq.on("error", reject);

    if (bodyStream !== null && method !== "GET" && method !== "HEAD") {
      bodyStream.pipe(upstreamReq);
    } else {
      upstreamReq.end();
    }
  });
}

export function createPreviewServer(options: PreviewServerOptions): PreviewServer {
  let targetUrl: URL;
  try {
    targetUrl = new URL(options.target);
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
      throw new Error("Target protocol must be http: or https:");
    }
  } catch (err) {
    throw new Error(
      `Invalid target URL "${options.target}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 8787;
  const configPath = path.resolve(options.configPath);
  const injectPreviewBar = options.injectPreviewBar ?? true;
  const logger: PreviewLogger = {
    info: options.logger?.info ?? DEFAULT_LOGGER.info,
    warn: options.logger?.warn ?? DEFAULT_LOGGER.warn,
    error: options.logger?.error ?? DEFAULT_LOGGER.error,
  };

  let configState: LoadedConfigState = {
    ok: false,
    error: "Configuration not loaded yet",
  };
  let watcher: FSWatcher | null = null;
  let boundAddress: PreviewServerAddress | null = null;

  async function loadConfigFromDisk(announceReload: boolean): Promise<LoadedConfigState> {
    let fileMtimeMs: number | undefined;
    let fileCtimeMs: number | undefined;
    let fileSize: number | undefined;
    try {
      const info = await stat(configPath);
      fileMtimeMs = info.mtimeMs;
      fileCtimeMs = info.ctimeMs;
      fileSize = info.size;
      const raw = await readFile(configPath, "utf8");
      const parsed = parseFacetYaml(raw);
      if (!parsed.ok) {
        const details = parsed.errors
          .map((e) => `${e.line ? `L${e.line} ` : ""}[${e.path}]: ${e.message}`)
          .join("; ");
        configState = {
          ok: false,
          error: details,
          mtimeMs: fileMtimeMs,
          ctimeMs: fileCtimeMs,
          size: fileSize,
        };
        logger.warn(
          `[facet] Warning: failed to validate ${configPath} (passing through untouched): ${details}`,
        );
        return configState;
      }

      configState = {
        ok: true,
        config: parsed.config,
        mtimeMs: fileMtimeMs,
        ctimeMs: fileCtimeMs,
        size: fileSize,
      };
      if (announceReload) {
        logger.info(
          `[facet] Reloaded ${configPath} (${parsed.config.experiences.length} experience(s)).`,
        );
      }
      return configState;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      configState = {
        ok: false,
        error: message,
        ...(fileMtimeMs !== undefined ? { mtimeMs: fileMtimeMs } : {}),
        ...(fileCtimeMs !== undefined ? { ctimeMs: fileCtimeMs } : {}),
        ...(fileSize !== undefined ? { size: fileSize } : {}),
      };
      logger.warn(
        `[facet] Warning: unable to read ${configPath} (passing through untouched): ${message}`,
      );
      return configState;
    }
  }

  async function ensureFreshConfig(): Promise<LoadedConfigState> {
    try {
      const info = await stat(configPath);
      if (
        configState.mtimeMs === info.mtimeMs &&
        configState.ctimeMs === info.ctimeMs &&
        configState.size === info.size
      ) {
        return configState;
      }
    } catch {
      // File may have been deleted or become unreadable; reload to update state and warn.
    }
    return loadConfigFromDisk(true);
  }

  function getProxyOrigin(req: IncomingMessage): string {
    const reqHost =
      req.headers.host ??
      (boundAddress ? `${boundAddress.host}:${boundAddress.port}` : `${host}:${requestedPort}`);
    return `http://${reqHost}`;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const rawUrl = req.url ?? "/";
    const proxyOrigin = getProxyOrigin(req);
    const incomingUrl = new URL(rawUrl, proxyOrigin);
    const upstreamUrl = new URL(rawUrl, targetUrl.origin);
    const staticAsset = isStaticAssetPath(incomingUrl.pathname);
    const mayRewrite = method === "GET" && !staticAsset;

    const upstreamHeaders = buildUpstreamRequestHeaders(req, targetUrl, mayRewrite);

    let upstreamRes: IncomingMessage;
    try {
      upstreamRes = await requestUpstream(
        upstreamUrl,
        method,
        upstreamHeaders,
        method === "GET" || method === "HEAD" ? null : req,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[facet] Upstream fetch failed for ${upstreamUrl.toString()}: ${message}`);
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Facet preview proxy could not reach ${upstreamUrl.toString()}: ${message}`);
      return;
    }

    const statusCode = upstreamRes.statusCode ?? 200;
    const contentType =
      typeof upstreamRes.headers["content-type"] === "string"
        ? upstreamRes.headers["content-type"]
        : undefined;
    const isRedirect = statusCode >= 300 && statusCode < 400;
    const isNoBodyStatus = statusCode < 200 || statusCode === 204 || statusCode === 304;
    const shouldRewriteHtml =
      mayRewrite && !isRedirect && !isNoBodyStatus && isHtmlContentType(contentType);

    if (!shouldRewriteHtml) {
      const passthroughHeaders = copyUpstreamHeaders(
        upstreamRes.headers,
        targetUrl,
        proxyOrigin,
        false,
      );
      res.writeHead(statusCode, passthroughHeaders);
      upstreamRes.pipe(res);
      return;
    }

    let originBody: Buffer;
    try {
      originBody = await readStreamToBuffer(upstreamRes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[facet] Failed reading upstream HTML body: ${message}`);
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Facet preview proxy failed reading upstream response: ${message}`);
      return;
    }

    const currentConfigState = await ensureFreshConfig();
    if (!currentConfigState.ok) {
      // Fail-open: return untouched origin HTML immediately.
      const failOpenHeaders = copyUpstreamHeaders(
        upstreamRes.headers,
        targetUrl,
        proxyOrigin,
        true,
      );
      failOpenHeaders["content-length"] = String(originBody.byteLength);
      failOpenHeaders["cache-control"] = PERSONALIZED_CACHE_CONTROL;
      failOpenHeaders["x-facet-status"] = "fail-open";
      res.writeHead(statusCode, failOpenHeaders);
      res.end(originBody);
      return;
    }

    const config = currentConfigState.config;

    try {
      const webRequest = new Request(incomingUrl.toString(), {
        method,
        headers: buildWebHeaders(req.headers),
      });
      const context = buildContextFromRequest(webRequest, {
        cookieName: config.settings.cookieName,
      });

      const resolvedMode = resolveLocalPreviewMode(incomingUrl, context.cookies, {
        previewParam: config.settings.previewParam,
      });

      const evalOptions: EvaluateOptions = {};
      if (resolvedMode.mode.kind === "default") {
        evalOptions.previewBucket = "default";
      } else if (resolvedMode.mode.kind === "experience") {
        evalOptions.previewExperienceId = resolvedMode.mode.experienceId;
        evalOptions.previewBucket = resolvedMode.mode.bucket;
      }

      const evaluation = evaluate(config, context, evalOptions);

      const analyticsSnippet =
        evaluation.matched.length > 0 && config.settings.analytics.providers.length > 0
          ? buildAnalyticsSnippet(
              toAnalyticsExposures(evaluation.matched),
              config.settings.analytics.providers,
            )
          : "";

      const previewBarHtml = injectPreviewBar
        ? buildPreviewBarHtml({
            config,
            evaluation,
            mode: resolvedMode.mode,
          })
        : "";

      const rewrittenBody = await rewriteHtml({
        html: originBody,
        changes: evaluation.activeChanges,
        analyticsSnippet,
        previewBarHtml,
      });

      const outHeaders = copyUpstreamHeaders(upstreamRes.headers, targetUrl, proxyOrigin, true);
      outHeaders["content-length"] = String(rewrittenBody.byteLength);
      outHeaders["cache-control"] = evaluation.cacheControl ?? PERSONALIZED_CACHE_CONTROL;
      outHeaders["x-facet-status"] = evaluation.personalized
        ? "personalized"
        : evaluation.matched.length > 0
          ? "control"
          : "default";

      if (evaluation.isNewVisitor) {
        appendSetCookie(
          outHeaders,
          `${encodeURIComponent(config.settings.cookieName)}=${encodeURIComponent(evaluation.visitorId)}; Path=/; SameSite=Lax; Max-Age=31536000`,
        );
      }

      if (resolvedMode.setCookieValue !== undefined) {
        appendSetCookie(
          outHeaders,
          `${LOCAL_MODE_COOKIE_NAME}=${encodeURIComponent(resolvedMode.setCookieValue)}; Path=/; SameSite=Lax`,
        );
      }

      res.writeHead(statusCode, outHeaders);
      res.end(rewrittenBody);
    } catch (err) {
      // Fail-open on any unexpected rewrite/evaluation error.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[facet] Warning: error rewriting HTML for ${incomingUrl.pathname} (passing through untouched): ${message}`,
      );
      const failOpenHeaders = copyUpstreamHeaders(
        upstreamRes.headers,
        targetUrl,
        proxyOrigin,
        true,
      );
      failOpenHeaders["content-length"] = String(originBody.byteLength);
      failOpenHeaders["cache-control"] = PERSONALIZED_CACHE_CONTROL;
      failOpenHeaders["x-facet-status"] = "fail-open";
      res.writeHead(statusCode, failOpenHeaders);
      res.end(originBody);
    }
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  function startWatcher(): void {
    if (watcher !== null) {
      return;
    }
    const dir = path.dirname(configPath);
    const targetName = path.basename(configPath);
    try {
      watcher = watch(dir, (_eventType, filename) => {
        if (!filename || filename === targetName) {
          void loadConfigFromDisk(true);
        }
      });
      watcher.on("error", (err) => {
        logger.warn(`[facet] Config watcher warning: ${err.message}`);
      });
    } catch (err) {
      logger.warn(
        `[facet] Could not watch ${configPath} for live reloads: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    server,
    async start(): Promise<PreviewServerAddress> {
      await loadConfigFromDisk(false);
      startWatcher();

      return new Promise<PreviewServerAddress>((resolve, reject) => {
        const onError = (err: Error): void => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = (): void => {
          server.off("error", onError);
          const addr = server.address() as AddressInfo | null;
          const actualPort = addr ? addr.port : requestedPort;
          const actualHost = addr && addr.address !== "::" ? addr.address : host;
          boundAddress = {
            host: actualHost,
            port: actualPort,
            url: `http://${actualHost}:${actualPort}`,
          };
          resolve(boundAddress);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(requestedPort, host);
      });
    },
    async close(): Promise<void> {
      if (watcher !== null) {
        watcher.close();
        watcher = null;
      }
      if (!server.listening) {
        boundAddress = null;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          boundAddress = null;
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
    async reloadConfig(): Promise<LoadedConfigState> {
      return loadConfigFromDisk(true);
    },
    address(): PreviewServerAddress | null {
      return boundAddress;
    },
  };
}
