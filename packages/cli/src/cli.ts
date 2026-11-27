import { parseArgs } from "node:util";
import { runInitCommand } from "./commands/init.js";
import { runPrCommentCommand } from "./commands/pr-comment.js";
import { isPreviewBucket, runPreviewLinkCommand } from "./commands/preview-link.js";
import { runPreviewCommand } from "./commands/preview.js";
import { runSchemaCommand } from "./commands/schema.js";
import { runValidateCommand } from "./commands/validate.js";
import { CLI_VERSION, resolveCliIO, type CliIO } from "./io.js";

const MAIN_HELP = `Facet CLI v${CLI_VERSION} — Zero-flicker edge website personalization

Usage:
  facet <command> [options]

Commands:
  init            Create a starter facet.yaml (and optional facet.schema.json)
  validate        Validate facet.yaml schema, selectors, and rule sanity
  preview         Start a local reverse proxy with live reload & preview bar
  preview-link    Generate a signed shareable preview URL for an experience
  pr-comment      Generate a GitHub PR comment with signed preview links
  schema          Export the facet.yaml JSON Schema (Draft 2020-12)

Global Options:
  -h, --help      Show help for facet or a specific command
  -v, --version   Print CLI version
`;

const COMMAND_HELP: Record<string, string> = {
  init: `Usage: facet init [options]

Create a well-commented starter facet.yaml configuration.

Options:
  --out <path>    Output path for facet.yaml (default: facet.yaml)
  --schema        Also write facet.schema.json and add YAML language-server header
  --force         Overwrite existing files
  -h, --help      Show this help message
`,
  validate: `Usage: facet validate [configPath]

Validate facet.yaml against the Facet v1 schema and run selector & rule sanity checks.

Arguments:
  configPath      Path to facet.yaml (default: facet.yaml)

Options:
  -h, --help      Show this help message
`,
  preview: `Usage: facet preview --target <url> [options]

Start a local reverse proxy that applies facet.yaml live and injects the Facet Preview Bar.

Options:
  --target <url>     Origin site URL to proxy (required)
  --config <path>    Path to facet.yaml (default: ./facet.yaml)
  --port <number>    Local port to bind (default: 8787)
  --host <host>      Local host to bind (default: 127.0.0.1)
  -h, --help         Show this help message
`,
  "preview-link": `Usage: facet preview-link <experienceId> --url <siteUrl> [options]

Generate an HMAC-SHA256 signed shareable preview link.

Arguments:
  experienceId           ID of the experience to preview

Options:
  --url <siteUrl>        Target site URL (required)
  --secret <secret>      HMAC signing secret (falls back to FACET_PREVIEW_SECRET)
  --bucket <bucket>      Preview bucket: variant | control | default
  --ttl <seconds>        Link expiration TTL in seconds
  --config <path>        Path to facet.yaml for experience lookup (default: ./facet.yaml)
  -h, --help             Show this help message
`,
  "pr-comment": `Usage: facet pr-comment [configPath] --url <siteUrl> [options]

Validate facet.yaml, optionally diff against a base config, and generate a
GitHub PR comment with HMAC-SHA256 signed preview links.

Arguments:
  configPath             Path to facet.yaml (default: facet.yaml)

Options:
  --url <siteUrl>        Target site URL for preview links (required)
  --secret <secret>      HMAC signing secret (falls back to FACET_PREVIEW_SECRET)
  --base <path>          Base branch facet.yaml path to diff against
  --ttl <seconds>        Link expiration TTL in seconds (default: 604800 / 7 days)
  --json                 Output structured JSON (including rendered markdown)
  -h, --help             Show this help message
`,
  schema: `Usage: facet schema [options]

Export the Draft 2020-12 JSON Schema for facet.yaml.

Options:
  --out <path>    Write JSON Schema to a file instead of stdout
  -h, --help      Show this help message
`,
};

export interface RunCliOptions {
  io?: Partial<CliIO>;
  waitForPreviewShutdown?: boolean;
}

export async function runCli(argv: readonly string[], options?: RunCliOptions): Promise<number> {
  const io = resolveCliIO(options?.io);
  const args = [...argv];

  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    io.stdout(MAIN_HELP);
    return 0;
  }

  if (args[0] === "-v" || args[0] === "--version") {
    io.stdout(`${CLI_VERSION}\n`);
    return 0;
  }

  const command = args[0];
  const rest = args.slice(1);

  if (command === "help") {
    const targetCmd = rest[0];
    if (targetCmd && Object.prototype.hasOwnProperty.call(COMMAND_HELP, targetCmd)) {
      io.stdout(COMMAND_HELP[targetCmd] ?? MAIN_HELP);
      return 0;
    }
    io.stdout(MAIN_HELP);
    return 0;
  }

  switch (command) {
    case "init": {
      let parsed: ReturnType<typeof parseArgs>;
      try {
        parsed = parseArgs({
          args: rest,
          options: {
            out: { type: "string" },
            schema: { type: "boolean", default: false },
            force: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
          },
          allowPositionals: false,
        });
      } catch (err) {
        io.stderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }

      if (parsed.values.help === true) {
        io.stdout(COMMAND_HELP.init ?? MAIN_HELP);
        return 0;
      }

      const result = await runInitCommand(
        {
          ...(typeof parsed.values.out === "string" ? { out: parsed.values.out } : {}),
          schema: parsed.values.schema === true,
          force: parsed.values.force === true,
        },
        io,
      );
      return result.exitCode;
    }

    case "validate": {
      let parsed: ReturnType<typeof parseArgs>;
      try {
        parsed = parseArgs({
          args: rest,
          options: {
            help: { type: "boolean", short: "h", default: false },
          },
          allowPositionals: true,
        });
      } catch (err) {
        io.stderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }

      if (parsed.values.help === true) {
        io.stdout(COMMAND_HELP.validate ?? MAIN_HELP);
        return 0;
      }

      const result = await runValidateCommand(parsed.positionals[0], io);
      return result.exitCode;
    }

    case "schema": {
      let parsed: ReturnType<typeof parseArgs>;
      try {
        parsed = parseArgs({
          args: rest,
          options: {
            out: { type: "string" },
            help: { type: "boolean", short: "h", default: false },
          },
          allowPositionals: false,
        });
      } catch (err) {
        io.stderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }

      if (parsed.values.help === true) {
        io.stdout(COMMAND_HELP.schema ?? MAIN_HELP);
        return 0;
      }

      const result = await runSchemaCommand(
        {
          ...(typeof parsed.values.out === "string" ? { out: parsed.values.out } : {}),
        },
        io,
      );
      return result.exitCode;
    }

    case "preview-link": {
      let parsed: ReturnType<typeof parseArgs>;
      try {
        parsed = parseArgs({
          args: rest,
          options: {
            url: { type: "string" },
            secret: { type: "string" },
            bucket: { type: "string" },
            ttl: { type: "string" },
            config: { type: "string" },
            help: { type: "boolean", short: "h", default: false },
          },
          allowPositionals: true,
        });
      } catch (err) {
        io.stderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }

      if (parsed.values.help === true) {
        io.stdout(COMMAND_HELP["preview-link"] ?? MAIN_HELP);
        return 0;
      }

      const experienceId = parsed.positionals[0] ?? "";
      const url = typeof parsed.values.url === "string" ? parsed.values.url : "";
      const secret = typeof parsed.values.secret === "string" ? parsed.values.secret : undefined;
      const rawBucket = typeof parsed.values.bucket === "string" ? parsed.values.bucket : undefined;
      const rawTtl = typeof parsed.values.ttl === "string" ? parsed.values.ttl : undefined;
      const configPath =
        typeof parsed.values.config === "string" ? parsed.values.config : undefined;

      if (rawBucket !== undefined && !isPreviewBucket(rawBucket)) {
        io.stderr(
          `Error: Invalid --bucket "${rawBucket}". Expected "variant", "control", or "default".\n`,
        );
        return 1;
      }

      let ttl: number | undefined;
      if (rawTtl !== undefined) {
        if (!/^\d+$/.test(rawTtl)) {
          io.stderr(
            `Error: Invalid --ttl "${rawTtl}". Expected a positive integer number of seconds.\n`,
          );
          return 1;
        }
        ttl = Number(rawTtl);
      }

      const result = await runPreviewLinkCommand(
        {
          experienceId,
          url,
          ...(secret !== undefined ? { secret } : {}),
          ...(rawBucket !== undefined ? { bucket: rawBucket } : {}),
          ...(ttl !== undefined ? { ttl } : {}),
          ...(configPath !== undefined ? { configPath, configExplicit: true } : {}),
        },
        io,
      );
      return result.exitCode;
    }

    case "pr-comment": {
      let parsed: ReturnType<typeof parseArgs>;
      try {
        parsed = parseArgs({
          args: rest,
          options: {
            url: { type: "string" },
            secret: { type: "string" },
            base: { type: "string" },
            ttl: { type: "string" },
            json: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
          },
          allowPositionals: true,
        });
      } catch (err) {
        io.stderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }

      if (parsed.values.help === true) {
        io.stdout(COMMAND_HELP["pr-comment"] ?? MAIN_HELP);
        return 0;
      }

      const configPath = parsed.positionals[0];
      const url = typeof parsed.values.url === "string" ? parsed.values.url : "";
      const secret = typeof parsed.values.secret === "string" ? parsed.values.secret : undefined;
      const baseConfigPath =
        typeof parsed.values.base === "string" ? parsed.values.base : undefined;
      const rawTtl = typeof parsed.values.ttl === "string" ? parsed.values.ttl : undefined;

      let ttl: number | undefined;
      if (rawTtl !== undefined) {
        if (!/^\d+$/.test(rawTtl)) {
          io.stderr(
            `Error: Invalid --ttl "${rawTtl}". Expected a positive integer number of seconds.\n`,
          );
          return 1;
        }
        ttl = Number(rawTtl);
      }

      const result = await runPrCommentCommand(
        {
          ...(configPath !== undefined ? { configPath } : {}),
          url,
          ...(secret !== undefined ? { secret } : {}),
          ...(baseConfigPath !== undefined ? { baseConfigPath } : {}),
          ...(ttl !== undefined ? { ttl } : {}),
          json: parsed.values.json === true,
        },
        io,
      );
      return result.exitCode;
    }

    case "preview": {
      let parsed: ReturnType<typeof parseArgs>;
      try {
        parsed = parseArgs({
          args: rest,
          options: {
            target: { type: "string" },
            config: { type: "string" },
            port: { type: "string" },
            host: { type: "string" },
            help: { type: "boolean", short: "h", default: false },
          },
          allowPositionals: false,
        });
      } catch (err) {
        io.stderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }

      if (parsed.values.help === true) {
        io.stdout(COMMAND_HELP.preview ?? MAIN_HELP);
        return 0;
      }

      const target = typeof parsed.values.target === "string" ? parsed.values.target : "";
      const configPath =
        typeof parsed.values.config === "string" ? parsed.values.config : undefined;
      const host = typeof parsed.values.host === "string" ? parsed.values.host : undefined;
      const rawPort = typeof parsed.values.port === "string" ? parsed.values.port : undefined;

      let port: number | undefined;
      if (rawPort !== undefined) {
        if (!/^\d+$/.test(rawPort)) {
          io.stderr(
            `Error: Invalid --port "${rawPort}". Expected an integer between 0 and 65535.\n`,
          );
          return 1;
        }
        port = Number(rawPort);
      }

      const result = await runPreviewCommand(
        {
          target,
          ...(configPath !== undefined ? { configPath } : {}),
          ...(port !== undefined ? { port } : {}),
          ...(host !== undefined ? { host } : {}),
          waitForShutdown: options?.waitForPreviewShutdown ?? true,
        },
        io,
      );
      return result.exitCode;
    }

    default: {
      io.stderr(`Error: Unknown command "${command}". Run "facet --help" for usage.\n`);
      return 1;
    }
  }
}
