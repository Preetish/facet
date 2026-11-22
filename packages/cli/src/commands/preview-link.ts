import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildPreviewUrl,
  parseFacetYaml,
  signPreviewToken,
  type FacetConfig,
  type PreviewBucket,
} from "@facet/core";
import { resolveCliIO, type CliIO } from "../io.js";

export interface PreviewLinkCommandOptions {
  experienceId: string;
  url: string;
  secret?: string;
  bucket?: PreviewBucket;
  ttl?: number;
  configPath?: string;
  configExplicit?: boolean;
  now?: number;
}

export interface PreviewLinkCommandResult {
  exitCode: number;
  url?: string;
  token?: string;
  expiresAt?: number;
  error?: string;
}

function isValidHttpUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isPreviewBucket(value: string): value is PreviewBucket {
  return value === "variant" || value === "control" || value === "default";
}

export async function runPreviewLinkCommand(
  options: PreviewLinkCommandOptions,
  ioOverrides?: Partial<CliIO>,
): Promise<PreviewLinkCommandResult> {
  const io = resolveCliIO(ioOverrides);

  const experienceId = options.experienceId.trim();
  if (!experienceId) {
    const error = "Experience ID is required: facet preview-link <experienceId> --url <siteUrl>";
    io.stderr(`Error: ${error}\n`);
    return { exitCode: 1, error };
  }

  if (!options.url || !isValidHttpUrl(options.url)) {
    const error = `Invalid --url "${options.url ?? ""}". Provide a valid http:// or https:// URL.`;
    io.stderr(`Error: ${error}\n`);
    return { exitCode: 1, error };
  }

  const secret = (options.secret ?? io.env.FACET_PREVIEW_SECRET ?? "").trim();
  if (!secret) {
    const error =
      "Missing preview signing secret. Pass --secret <secret> or set FACET_PREVIEW_SECRET.";
    io.stderr(`Error: ${error}\n`);
    return { exitCode: 1, error };
  }

  if (options.bucket !== undefined && !isPreviewBucket(options.bucket)) {
    const error = `Invalid --bucket "${String(options.bucket)}". Expected "variant", "control", or "default".`;
    io.stderr(`Error: ${error}\n`);
    return { exitCode: 1, error };
  }

  let expiresAt: number | undefined;
  if (options.ttl !== undefined) {
    if (!Number.isInteger(options.ttl) || options.ttl <= 0) {
      const error = `Invalid --ttl "${String(options.ttl)}". Expected a positive integer number of seconds.`;
      io.stderr(`Error: ${error}\n`);
      return { exitCode: 1, error };
    }
    const nowSec = options.now ?? Math.floor(Date.now() / 1000);
    expiresAt = nowSec + options.ttl;
  }

  let loadedConfig: FacetConfig | undefined;
  const resolvedConfigPath = path.resolve(io.cwd, options.configPath ?? "facet.yaml");
  const shouldReadConfig =
    options.configExplicit === true || (await fileExists(resolvedConfigPath));

  if (shouldReadConfig) {
    let raw: string;
    try {
      raw = await readFile(resolvedConfigPath, "utf8");
    } catch (err) {
      const error = `Unable to read config "${resolvedConfigPath}": ${err instanceof Error ? err.message : String(err)}`;
      io.stderr(`Error: ${error}\n`);
      return { exitCode: 1, error };
    }

    const parsed = parseFacetYaml(raw);
    if (!parsed.ok) {
      const details = parsed.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
      const error = `Invalid Facet config "${resolvedConfigPath}": ${details}`;
      io.stderr(`Error: ${error}\n`);
      return { exitCode: 1, error };
    }

    loadedConfig = parsed.config;
    const existsInConfig = loadedConfig.experiences.some((exp) => exp.id === experienceId);
    if (!existsInConfig) {
      const available =
        loadedConfig.experiences.length > 0
          ? loadedConfig.experiences.map((exp) => exp.id).join(", ")
          : "(none)";
      const error = `Experience "${experienceId}" was not found in ${resolvedConfigPath}. Available experiences: ${available}`;
      io.stderr(`Error: ${error}\n`);
      return { exitCode: 1, error };
    }
  }

  const token = await signPreviewToken({
    experienceId,
    secret,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(options.bucket !== undefined ? { bucket: options.bucket } : {}),
  });

  const signedUrl = await buildPreviewUrl({
    baseUrl: options.url,
    experienceId,
    secret,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(options.bucket !== undefined ? { bucket: options.bucket } : {}),
    ...(loadedConfig
      ? {
          previewParam: loadedConfig.settings.previewParam,
          previewSigParam: loadedConfig.settings.previewSigParam,
        }
      : {}),
  });

  io.stdout(`${signedUrl}\n`);

  return {
    exitCode: 0,
    url: signedUrl,
    token,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}
