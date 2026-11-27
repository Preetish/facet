#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_STARTER_YAML } from "./shared/defaults.js";
import { createFileConfigStore } from "./server/file-store.js";
import { startStudioServer } from "./server/node-server.js";
import { createMemoryConfigStore } from "./server/store.js";

interface CliFlags {
  configPath?: string;
  port: number;
  host: string;
  targetUrl?: string;
  previewSecret?: string;
  memory: boolean;
  help: boolean;
}

function printHelp(): void {
  console.log(`Facet Studio — Self-hosted marketer personalization workspace

Usage:
  facet-studio [options]

Options:
  --config <path>          Path to facet.yaml (default: ./facet.yaml if present, else in-memory demo)
  --port <port>            Port to listen on (default: 4174)
  --host <host>            Host interface to bind (default: 127.0.0.1)
  --target <url>           Live marketing site URL for shareable preview links
  --preview-secret <sec>   HMAC signing secret (or set FACET_PREVIEW_SECRET)
  --memory                 Run with an ephemeral in-memory demo store
  -h, --help               Show this help message
`);
}

function parseArgs(argv: readonly string[]): CliFlags {
  const flags: CliFlags = {
    port: 4174,
    host: "127.0.0.1",
    memory: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
    } else if (arg === "--memory") {
      flags.memory = true;
    } else if (arg === "--config" && argv[i + 1]) {
      flags.configPath = argv[++i];
    } else if (arg === "--port" && argv[i + 1]) {
      const parsed = Number(argv[++i]);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
        flags.port = parsed;
      }
    } else if (arg === "--host" && argv[i + 1]) {
      flags.host = argv[++i] ?? flags.host;
    } else if (arg === "--target" && argv[i + 1]) {
      flags.targetUrl = argv[++i];
    } else if (arg === "--preview-secret" && argv[i + 1]) {
      flags.previewSecret = argv[++i];
    }
  }

  return flags;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return;
  }

  const previewSecret = flags.previewSecret ?? process.env["FACET_PREVIEW_SECRET"];
  const targetUrl = flags.targetUrl ?? process.env["FACET_TARGET_URL"];

  let store;
  let modeLabel: string;
  let isDemoMode: boolean;
  let storageLabel: string;

  if (flags.memory) {
    store = createMemoryConfigStore(DEFAULT_STARTER_YAML, {
      initialAuthor: "Studio Demo",
      initialNote: "Starter example configuration",
    });
    modeLabel = "in-memory demo store";
    isDemoMode = true;
    storageLabel = "In-memory demo";
  } else {
    const candidatePath = resolve(flags.configPath ?? "facet.yaml");
    if (flags.configPath || existsSync(candidatePath)) {
      store = createFileConfigStore(candidatePath);
      modeLabel = candidatePath;
      isDemoMode = false;
      storageLabel = `Local file: ${flags.configPath ?? "facet.yaml"}`;
    } else {
      store = createMemoryConfigStore(DEFAULT_STARTER_YAML, {
        initialAuthor: "Studio Demo",
        initialNote: "Starter example configuration",
      });
      modeLabel = "in-memory demo store (no ./facet.yaml found)";
      isDemoMode = true;
      storageLabel = "In-memory demo";
    }
  }

  const running = await startStudioServer({
    store,
    host: flags.host,
    port: flags.port,
    isDemoMode,
    storageLabel,
    allowLocalTarget: isLoopbackHost(flags.host),
    ...(targetUrl ? { targetUrl } : {}),
    ...(previewSecret ? { previewSecret } : {}),
  });

  console.log(`Facet Studio running at ${running.url}`);
  console.log(`  Config source:   ${modeLabel}`);
  if (targetUrl) {
    console.log(`  Target site URL: ${targetUrl}`);
  }
  console.log(
    `  Preview signing: ${previewSecret ? "enabled (HMAC-SHA256)" : "not configured (pass --preview-secret or FACET_PREVIEW_SECRET)"}`,
  );

  const shutdown = (): void => {
    void running.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
