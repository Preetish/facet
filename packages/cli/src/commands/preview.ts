import path from "node:path";
import { resolveCliIO, type CliIO } from "../io.js";
import {
  createPreviewServer,
  type PreviewServer,
  type PreviewServerAddress,
} from "../preview/server.js";

export interface PreviewCommandOptions {
  target: string;
  configPath?: string;
  port?: number;
  host?: string;
  waitForShutdown?: boolean;
}

export interface PreviewCommandResult {
  exitCode: number;
  server?: PreviewServer;
  address?: PreviewServerAddress;
  error?: string;
}

export async function runPreviewCommand(
  options: PreviewCommandOptions,
  ioOverrides?: Partial<CliIO>,
): Promise<PreviewCommandResult> {
  const io = resolveCliIO(ioOverrides);

  if (!options.target) {
    const error = "Missing required --target <url> option.";
    io.stderr(`Error: ${error}\n`);
    return { exitCode: 1, error };
  }

  const port = options.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    const error = `Invalid --port "${String(options.port)}". Expected an integer between 0 and 65535.`;
    io.stderr(`Error: ${error}\n`);
    return { exitCode: 1, error };
  }

  const host = options.host ?? "127.0.0.1";
  const configPath = path.resolve(io.cwd, options.configPath ?? "facet.yaml");

  let previewServer: PreviewServer;
  try {
    previewServer = createPreviewServer({
      target: options.target,
      configPath,
      port,
      host,
      logger: {
        info: (msg: string): void => {
          io.stdout(`${msg}\n`);
        },
        warn: (msg: string): void => {
          io.stderr(`${msg}\n`);
        },
        error: (msg: string): void => {
          io.stderr(`${msg}\n`);
        },
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    io.stderr(`Error: ${error}\n`);
    return { exitCode: 1, error };
  }

  let address: PreviewServerAddress;
  try {
    address = await previewServer.start();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    io.stderr(`Error starting preview server: ${error}\n`);
    return { exitCode: 1, error };
  }

  io.stdout(`Facet local preview proxy running at ${address.url}\n`);
  io.stdout(`  Target: ${options.target}\n`);
  io.stdout(`  Config: ${configPath} (watching for changes)\n`);
  io.stdout(`  Press Ctrl+C to stop.\n`);

  if (options.waitForShutdown) {
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        void previewServer.close().finally(resolve);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
  }

  return {
    exitCode: 0,
    server: previewServer,
    address,
  };
}
