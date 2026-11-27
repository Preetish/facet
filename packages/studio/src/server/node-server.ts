import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createStudioHandler,
  type StudioAsset,
  type StudioAssetResolver,
  type StudioHandlerOptions,
} from "./handler.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

export function createStaticUiAssetResolver(uiDir?: string): StudioAssetResolver {
  const defaultDir = fileURLToPath(new URL("../ui", import.meta.url));
  const rootDir = resolve(uiDir ?? defaultDir);

  return async function resolveAsset(pathname: string): Promise<StudioAsset | null> {
    const cleanRel = pathname.replace(/^\/+/, "");
    const candidate = resolve(join(rootDir, cleanRel));
    if (candidate !== rootDir && !candidate.startsWith(rootDir + "/")) {
      return null;
    }

    try {
      const bytes = await readFile(candidate);
      const ext = extname(candidate).toLowerCase();
      return {
        body: bytes,
        contentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
      };
    } catch {
      return null;
    }
  };
}

async function readIncomingBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  if (chunks.length === 0) return undefined;
  return new Uint8Array(Buffer.concat(chunks));
}

function incomingToRequest(req: IncomingMessage, host: string, body?: Uint8Array): Request {
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  const init: RequestInit = {
    method: req.method ?? "GET",
    headers,
  };
  if (body !== undefined) {
    init.body = new Uint8Array(body);
  }
  return new Request(url.toString(), init);
}

async function writeWebResponse(res: ServerResponse, webRes: Response): Promise<void> {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const arrayBuffer = await webRes.arrayBuffer();
  res.end(Buffer.from(arrayBuffer));
}

export interface StartStudioServerOptions extends StudioHandlerOptions {
  port?: number;
  host?: string;
  uiDir?: string;
}

export interface RunningStudioServer {
  server: Server;
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

export async function startStudioServer(
  options: StartStudioServerOptions,
): Promise<RunningStudioServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4174;
  const assets = options.assets ?? createStaticUiAssetResolver(options.uiDir);
  const handler = createStudioHandler({
    ...options,
    assets,
  });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const body = await readIncomingBody(req);
        const hostHeader = req.headers.host ?? `${host}:${port}`;
        const webReq = incomingToRequest(req, hostHeader, body);
        const webRes = await handler(webReq);
        await writeWebResponse(res, webRes);
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : "Internal Studio server error",
          }),
        );
      }
    })();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}`;

  return {
    server,
    url,
    port: actualPort,
    host,
    close(): Promise<void> {
      return new Promise((resolveClose, rejectClose) => {
        server.close((err) => {
          if (err) rejectClose(err);
          else resolveClose();
        });
      });
    },
  };
}
