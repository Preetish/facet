import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePreviewParams, verifyPreviewToken } from "@facet/core";
import { runCli, runPreviewLinkCommand } from "../src/index.js";

function createTestIO(
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): {
  stdout: string[];
  stderr: string[];
  io: {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    cwd: string;
    env: NodeJS.ProcessEnv;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
      cwd,
      env,
    },
  };
}

describe("facet preview-link", () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "facet-cli-link-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("generates a signed preview URL verifiable with verifyPreviewToken", async () => {
    const cwd = await makeTempDir();
    const { stdout, stderr, io } = createTestIO(cwd);
    const secret = "super-secret-key-123";

    const exitCode = await runCli(
      [
        "preview-link",
        "fintech-abm",
        "--url",
        "https://acme.com/pricing?utm_source=slack",
        "--secret",
        secret,
        "--bucket",
        "control",
        "--ttl",
        "3600",
      ],
      { io },
    );

    expect(exitCode).toBe(0);
    expect(stderr.join("")).toBe("");

    const generatedUrl = stdout.join("").trim();
    const parsedUrl = new URL(generatedUrl);
    expect(parsedUrl.origin).toBe("https://acme.com");
    expect(parsedUrl.pathname).toBe("/pricing");
    expect(parsedUrl.searchParams.get("utm_source")).toBe("slack");

    const previewParams = parsePreviewParams(parsedUrl);
    expect(previewParams).not.toBeNull();
    expect(previewParams?.experienceId).toBe("fintech-abm");
    expect(previewParams?.bucket).toBe("control");
    expect(previewParams?.signature).toBeTruthy();

    const verified = await verifyPreviewToken({
      experienceId: previewParams!.experienceId!,
      token: previewParams!.signature!,
      secret,
      bucket: previewParams!.bucket,
    });
    expect(verified.valid).toBe(true);
    if (verified.valid) {
      expect(verified.experienceId).toBe("fintech-abm");
      expect(verified.bucket).toBe("control");
      expect(verified.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }

    // Verify expiration enforcement when clock advances past expiresAt
    if (verified.valid && verified.expiresAt !== undefined) {
      const expired = await verifyPreviewToken({
        experienceId: "fintech-abm",
        token: previewParams!.signature!,
        secret,
        bucket: "control",
        now: verified.expiresAt + 10,
      });
      expect(expired).toEqual({ valid: false, reason: "expired" });
    }
  });

  it("falls back to FACET_PREVIEW_SECRET env var and errors clearly if secret is missing", async () => {
    const cwd = await makeTempDir();

    const missingSecret = createTestIO(cwd, {});
    const failCode = await runCli(["preview-link", "exp-1", "--url", "https://acme.com"], {
      io: missingSecret.io,
    });
    expect(failCode).toBe(1);
    expect(missingSecret.stderr.join("")).toContain("FACET_PREVIEW_SECRET");

    const withEnv = createTestIO(cwd, { FACET_PREVIEW_SECRET: "env-secret-xyz" });
    const okCode = await runCli(["preview-link", "exp-1", "--url", "https://acme.com"], {
      io: withEnv.io,
    });
    expect(okCode).toBe(0);

    const url = withEnv.stdout.join("").trim();
    const params = parsePreviewParams(url);
    expect(params?.experienceId).toBe("exp-1");
    const verified = await verifyPreviewToken({
      experienceId: "exp-1",
      token: params!.signature!,
      secret: "env-secret-xyz",
    });
    expect(verified.valid).toBe(true);
  });

  it("checks experience existence in --config and respects custom preview params", async () => {
    const cwd = await makeTempDir();
    const configPath = path.join(cwd, "custom.yaml");
    await writeFile(
      configPath,
      `version: 1
settings:
  previewParam: "__p"
  previewSigParam: "__s"
experiences:
  - id: known-exp
    name: "Known Experience"
    match:
      path: "/"
    changes:
      - selector: "h1"
        text: "Hi"
`,
      "utf8",
    );

    const missingRun = createTestIO(cwd);
    const missingRes = await runPreviewLinkCommand(
      {
        experienceId: "unknown-exp",
        url: "https://acme.com",
        secret: "s3cr3t",
        configPath,
        configExplicit: true,
      },
      missingRun.io,
    );
    expect(missingRes.exitCode).toBe(1);
    expect(missingRun.stderr.join("")).toContain('Experience "unknown-exp" was not found');
    expect(missingRun.stderr.join("")).toContain("known-exp");

    const okRun = createTestIO(cwd);
    const okRes = await runPreviewLinkCommand(
      {
        experienceId: "known-exp",
        url: "https://acme.com",
        secret: "s3cr3t",
        configPath,
        configExplicit: true,
      },
      okRun.io,
    );
    expect(okRes.exitCode).toBe(0);
    const parsedUrl = new URL(okRes.url!);
    expect(parsedUrl.searchParams.get("__p")).toBe("known-exp");
    expect(parsedUrl.searchParams.get("__s")).toBeTruthy();
  });
});
