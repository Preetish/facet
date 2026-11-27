import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePreviewParams, verifyPreviewToken } from "@facet/core";
import {
  DEFAULT_PR_PREVIEW_TTL_SECONDS,
  PR_COMMENT_MARKER,
  generatePrCommentMarkdown,
  runCli,
  runPrCommentCommand,
  type PrCommentReport,
} from "../src/index.js";

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

const BASE_YAML = `version: 1
settings:
  slots:
    fintech-logos: "<div>Base Fintech Logos</div>"
data:
  accounts:
    stripe:
      name: "Stripe"
experiences:
  - id: unchanged-exp
    name: "Unchanged Hero"
    priority: 5
    holdout: 0.1
    match:
      path: "/"
      utm_source: "google"
    changes:
      - selector: "h1"
        text: "Same headline"
  - id: modified-exp
    name: "Pricing Promo"
    priority: 10
    holdout: 0
    match:
      path: "/pricing"
      utm_campaign: "q3"
    changes:
      - selector: "h1"
        text: "Old pricing headline"
  - id: slot-modified-exp
    name: "Fintech Logos"
    priority: 8
    holdout: 0
    match:
      path: "/"
      utm_campaign: "fintech"
    changes:
      - selector: "#logos"
        slot: "fintech-logos"
  - id: data-modified-exp
    name: "ABM Account Lookup"
    priority: 7
    holdout: 0
    lookup:
      table: "accounts"
      key: "{{query.acct}}"
    match:
      path: "/for/:acct"
    changes:
      - selector: "h1"
        text: "Hello {{data.name}}"
  - id: removed-exp
    name: "Legacy Campaign"
    priority: 1
    holdout: 0.25
    match:
      path: "/"
      utm_campaign: "old-2025"
    changes:
      - selector: "h1"
        text: "Legacy copy"
`;

const HEAD_YAML = `version: 1
settings:
  slots:
    fintech-logos: "<div>Updated Fintech Logos</div>"
data:
  accounts:
    stripe:
      name: "Stripe Inc."
experiences:
  - id: unchanged-exp
    priority: 5
    name: "Unchanged Hero"
    holdout: 0.1
    match:
      utm_source: "google"
      path: "/"
    changes:
      - text: "Same headline"
        selector: "h1"
  - id: modified-exp
    name: "Pricing Promo"
    priority: 10
    holdout: 0
    match:
      path: "/pricing"
      utm_campaign: "q4"
    changes:
      - selector: "h1"
        text: "New Q4 pricing headline"
  - id: slot-modified-exp
    name: "Fintech Logos"
    priority: 8
    holdout: 0
    match:
      path: "/"
      utm_campaign: "fintech"
    changes:
      - selector: "#logos"
        slot: "fintech-logos"
  - id: data-modified-exp
    name: "ABM Account Lookup"
    priority: 7
    holdout: 0
    lookup:
      table: "accounts"
      key: "{{query.acct}}"
    match:
      path: "/for/:acct"
    changes:
      - selector: "h1"
        text: "Hello {{data.name}}"
  - id: added-exp
    name: "Fintech ABM"
    priority: 20
    holdout: 0.2
    match:
      path: "/enterprise"
      query.acct: "stripe"
    changes:
      - selector: "h1"
        text: "Built for fintech teams"
      - selector: "[data-cta='hero']"
        text: "Book fintech demo"
  - id: added-disabled-exp
    name: "Draft Healthcare"
    enabled: false
    priority: 15
    holdout: 0.5
    match:
      path: "/"
      utm_campaign: "health"
    changes:
      - selector: "h1"
        text: "HIPAA ready"
`;

describe("facet pr-comment", () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "facet-cli-pr-comment-"));
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

  it("detects added, modified (including slot/data changes), removed, and unchanged experiences with verifiable HMAC URLs", async () => {
    const cwd = await makeTempDir();
    const basePath = path.join(cwd, "base.yaml");
    const headPath = path.join(cwd, "head.yaml");
    await writeFile(basePath, BASE_YAML, "utf8");
    await writeFile(headPath, HEAD_YAML, "utf8");

    const secret = "pr-preview-secret-123";
    const fixedNow = 1_750_000_000;
    const { stdout, stderr, io } = createTestIO(cwd);

    const result = await runPrCommentCommand(
      {
        configPath: headPath,
        baseConfigPath: basePath,
        url: "https://acme.com",
        secret,
        now: fixedNow,
      },
      io,
    );

    expect(result.exitCode).toBe(0);
    expect(stderr.join("")).toBe("");
    expect(result.report).toBeDefined();
    expect(result.markdown).toBeDefined();

    const report = result.report!;
    expect(report.hasBase).toBe(true);
    expect(report.ttlSeconds).toBe(DEFAULT_PR_PREVIEW_TTL_SECONDS);
    expect(report.expiresAt).toBe(fixedNow + DEFAULT_PR_PREVIEW_TTL_SECONDS);
    expect(report.summary).toEqual({
      total: 6,
      enabled: 5,
      added: 2,
      modified: 3,
      removed: 1,
      unchanged: 1,
    });

    const byId = new Map(report.experiences.map((entry) => [entry.id, entry]));

    // Unchanged despite YAML key reordering -> no signed links in diff mode
    const unchanged = byId.get("unchanged-exp")!;
    expect(unchanged.status).toBe("unchanged");
    expect(unchanged.changedFields).toEqual([]);
    expect(unchanged.variantUrl).toBeUndefined();
    expect(unchanged.controlUrl).toBeUndefined();

    // Added enabled with holdout 0.2 -> both variant and control links, resolved to /enterprise
    const added = byId.get("added-exp")!;
    expect(added.status).toBe("added");
    expect(added.previewPath).toBe("/enterprise");
    expect(added.variantUrl).toBeDefined();
    expect(added.controlUrl).toBeDefined();

    const addedVariantUrl = new URL(added.variantUrl!);
    expect(addedVariantUrl.origin).toBe("https://acme.com");
    expect(addedVariantUrl.pathname).toBe("/enterprise");
    const addedVariantParams = parsePreviewParams(addedVariantUrl);
    expect(addedVariantParams?.experienceId).toBe("added-exp");
    expect(addedVariantParams?.bucket).toBe("variant");
    const verifiedVariant = await verifyPreviewToken({
      experienceId: addedVariantParams!.experienceId!,
      token: addedVariantParams!.signature!,
      secret,
      bucket: addedVariantParams!.bucket,
      now: fixedNow + 100,
    });
    expect(verifiedVariant).toEqual({
      valid: true,
      experienceId: "added-exp",
      bucket: "variant",
      expiresAt: fixedNow + DEFAULT_PR_PREVIEW_TTL_SECONDS,
    });

    // Expired after TTL
    const expiredVariant = await verifyPreviewToken({
      experienceId: addedVariantParams!.experienceId!,
      token: addedVariantParams!.signature!,
      secret,
      bucket: addedVariantParams!.bucket,
      now: fixedNow + DEFAULT_PR_PREVIEW_TTL_SECONDS + 1,
    });
    expect(expiredVariant).toEqual({ valid: false, reason: "expired" });

    // Control link verified
    const addedControlParams = parsePreviewParams(added.controlUrl!);
    expect(addedControlParams?.bucket).toBe("control");
    const verifiedControl = await verifyPreviewToken({
      experienceId: addedControlParams!.experienceId!,
      token: addedControlParams!.signature!,
      secret,
      bucket: addedControlParams!.bucket,
      now: fixedNow + 100,
    });
    expect(verifiedControl).toEqual({
      valid: true,
      experienceId: "added-exp",
      bucket: "control",
      expiresAt: fixedNow + DEFAULT_PR_PREVIEW_TTL_SECONDS,
    });

    // Added disabled -> no signed links
    const addedDisabled = byId.get("added-disabled-exp")!;
    expect(addedDisabled.status).toBe("added");
    expect(addedDisabled.enabled).toBe(false);
    expect(addedDisabled.variantUrl).toBeUndefined();
    expect(addedDisabled.controlUrl).toBeUndefined();

    // Modified with holdout 0 -> variant only, resolved to /pricing
    const modified = byId.get("modified-exp")!;
    expect(modified.status).toBe("modified");
    expect(modified.changedFields).toEqual(["match", "changes"]);
    expect(modified.previewPath).toBe("/pricing");
    expect(modified.variantUrl).toBeDefined();
    expect(modified.controlUrl).toBeUndefined();
    const modParams = parsePreviewParams(modified.variantUrl!);
    const modVerified = await verifyPreviewToken({
      experienceId: modParams!.experienceId!,
      token: modParams!.signature!,
      secret,
      bucket: modParams!.bucket,
      now: fixedNow,
    });
    expect(modVerified.valid).toBe(true);

    // Slot body change detected as modified
    const slotMod = byId.get("slot-modified-exp")!;
    expect(slotMod.status).toBe("modified");
    expect(slotMod.changedFields).toEqual(["slot"]);
    expect(slotMod.variantUrl).toBeDefined();

    // Referenced data table change detected as modified, param path stays on /
    const dataMod = byId.get("data-modified-exp")!;
    expect(dataMod.status).toBe("modified");
    expect(dataMod.changedFields).toEqual(["data"]);
    expect(dataMod.previewPath).toBe("/");
    expect(dataMod.variantUrl).toBeDefined();

    // Removed experience -> no links
    const removed = byId.get("removed-exp")!;
    expect(removed.status).toBe("removed");
    expect(removed.variantUrl).toBeUndefined();
    expect(removed.controlUrl).toBeUndefined();

    // Verify Markdown stdout structure
    const markdown = stdout.join("");
    expect(markdown.startsWith(`${PR_COMMENT_MARKER}\n`)).toBe(true);
    expect(markdown).toContain("## Facet Preview Links");
    expect(markdown).toContain("**Summary:** 2 added · 3 modified · 1 removed · 1 unchanged");
    expect(markdown).toContain("`Added`");
    expect(markdown).toContain("`Added (disabled)`");
    expect(markdown).toContain("`Modified`");
    expect(markdown).toContain("`Removed`");
    expect(markdown).toContain("[Variant](");
    expect(markdown).toContain("[Control](");
    expect(markdown).toContain("<summary>Unchanged experiences (1)</summary>");
    expect(markdown).toContain("TTL: 7d");
  });

  it("generates signed links for all enabled experiences when --base is omitted and respects custom preview params", async () => {
    const cwd = await makeTempDir();
    await writeFile(
      path.join(cwd, "facet.yaml"),
      `version: 1
settings:
  previewParam: "__p"
  previewSigParam: "__s"
experiences:
  - id: exp-a
    name: "Alpha"
    holdout: 0.25
    match:
      path: "/"
    changes:
      - selector: "h1"
        text: "Alpha copy"
  - id: exp-b
    name: "Beta"
    enabled: false
    holdout: 0.5
    match:
      path: "/"
    changes:
      - selector: "h1"
        text: "Beta copy"
`,
      "utf8",
    );

    const secret = "env-preview-secret";
    const { stdout, stderr, io } = createTestIO(cwd, { FACET_PREVIEW_SECRET: secret });

    const exitCode = await runCli(
      ["pr-comment", "--url", "https://acme.com/landing", "--ttl", "3600"],
      { io },
    );

    expect(exitCode).toBe(0);
    expect(stderr.join("")).toBe("");

    const output = stdout.join("");
    expect(output).toContain(PR_COMMENT_MARKER);
    expect(output).toContain("**Summary:** 2 experiences (1 enabled)");
    expect(output).toContain("`Enabled`");
    expect(output).toContain("`Disabled`");
    expect(output).toContain("TTL: 1h");

    // Extract URLs from Markdown and verify custom preview params + signature
    const urlMatches = [...output.matchAll(/\[(Variant|Control)\]\((https:\/\/[^)]+)\)/g)];
    expect(urlMatches).toHaveLength(2);

    for (const match of urlMatches) {
      const label = match[1];
      const href = match[2]!;
      const parsed = new URL(href);
      expect(parsed.pathname).toBe("/landing");
      expect(parsed.searchParams.get("__p")).toBe("exp-a");
      expect(parsed.searchParams.get("__s")).toBeTruthy();

      const params = parsePreviewParams(parsed, {
        previewParam: "__p",
        previewSigParam: "__s",
      });
      const expectedBucket = label === "Variant" ? "variant" : "control";
      expect(params?.bucket).toBe(expectedBucket);
      const verified = await verifyPreviewToken({
        experienceId: params!.experienceId!,
        token: params!.signature!,
        secret,
        bucket: params!.bucket,
      });
      expect(verified.valid).toBe(true);
    }
  });

  it("outputs structured JSON including rendered markdown in --json mode", async () => {
    const cwd = await makeTempDir();
    const configPath = path.join(cwd, "facet.yaml");
    await writeFile(
      configPath,
      `version: 1
experiences:
  - id: json-exp
    name: "JSON Test"
    holdout: 0.15
    match:
      path: "/demo"
    changes:
      - selector: "h1"
        text: "Hello"
`,
      "utf8",
    );

    const secret = "json-secret";
    const { stdout, stderr, io } = createTestIO(cwd);

    const exitCode = await runCli(
      ["pr-comment", configPath, "--url", "https://acme.com", "--secret", secret, "--json"],
      { io },
    );

    expect(exitCode).toBe(0);
    expect(stderr.join("")).toBe("");

    const payload = JSON.parse(stdout.join("")) as PrCommentReport & { markdown: string };
    expect(payload.marker).toBe(PR_COMMENT_MARKER);
    expect(payload.hasBase).toBe(false);
    expect(payload.summary).toEqual({
      total: 1,
      enabled: 1,
      added: 0,
      modified: 0,
      removed: 0,
      unchanged: 1,
    });
    expect(payload.experiences).toHaveLength(1);
    const entry = payload.experiences[0]!;
    expect(entry.id).toBe("json-exp");
    expect(entry.previewPath).toBe("/demo");
    expect(entry.variantUrl).toBeTruthy();
    expect(entry.controlUrl).toBeTruthy();
    expect(payload.markdown.startsWith(PR_COMMENT_MARKER)).toBe(true);

    const params = parsePreviewParams(entry.variantUrl!);
    const verified = await verifyPreviewToken({
      experienceId: params!.experienceId!,
      token: params!.signature!,
      secret,
      bucket: params!.bucket,
    });
    expect(verified.valid).toBe(true);
  });

  it("exits non-zero on invalid head config, invalid base config, missing secret, invalid url, or invalid ttl", async () => {
    const cwd = await makeTempDir();
    const invalidPath = path.join(cwd, "invalid.yaml");
    const validPath = path.join(cwd, "valid.yaml");

    await writeFile(
      invalidPath,
      `version: 1
experiences:
  - id: "bad exp id!"
    name: ""
    match: {}
    changes: []
`,
      "utf8",
    );

    await writeFile(
      validPath,
      `version: 1
experiences:
  - id: ok-exp
    name: "OK"
    match:
      path: "/"
    changes:
      - selector: "h1"
        text: "OK"
`,
      "utf8",
    );

    // Invalid head config
    const invalidHead = createTestIO(cwd);
    const invalidHeadCode = await runCli(
      ["pr-comment", invalidPath, "--url", "https://acme.com", "--secret", "s3cr3t"],
      { io: invalidHead.io },
    );
    expect(invalidHeadCode).toBe(1);
    expect(invalidHead.stdout.join("")).toBe("");
    expect(invalidHead.stderr.join("")).toContain("Invalid Facet configuration");

    // Invalid base config
    const invalidBase = createTestIO(cwd);
    const invalidBaseCode = await runCli(
      [
        "pr-comment",
        validPath,
        "--base",
        invalidPath,
        "--url",
        "https://acme.com",
        "--secret",
        "s3cr3t",
      ],
      { io: invalidBase.io },
    );
    expect(invalidBaseCode).toBe(1);
    expect(invalidBase.stderr.join("")).toContain("Invalid base Facet configuration");

    // Missing secret
    const missingSecret = createTestIO(cwd, {});
    const missingSecretCode = await runCli(["pr-comment", validPath, "--url", "https://acme.com"], {
      io: missingSecret.io,
    });
    expect(missingSecretCode).toBe(1);
    expect(missingSecret.stderr.join("")).toContain("FACET_PREVIEW_SECRET");

    // Missing / invalid URL
    const missingUrl = createTestIO(cwd);
    const missingUrlCode = await runCli(["pr-comment", validPath, "--secret", "s3cr3t"], {
      io: missingUrl.io,
    });
    expect(missingUrlCode).toBe(1);
    expect(missingUrl.stderr.join("")).toContain("Invalid --url");

    // Invalid TTL
    const badTtl = createTestIO(cwd);
    const badTtlCode = await runCli(
      ["pr-comment", validPath, "--url", "https://acme.com", "--secret", "s3cr3t", "--ttl", "0"],
      { io: badTtl.io },
    );
    expect(badTtlCode).toBe(1);
    expect(badTtl.stderr.join("")).toContain("Invalid --ttl");
  });

  it("formats pure generatePrCommentMarkdown cleanly, escapes table characters, and handles zero diffs", () => {
    const emptyDiffMarkdown = generatePrCommentMarkdown({
      siteUrl: "https://acme.com",
      hasBase: true,
      ttlSeconds: 604_800,
      expiresAt: 1_750_604_800,
      summary: {
        total: 1,
        enabled: 1,
        added: 0,
        modified: 0,
        removed: 0,
        unchanged: 1,
      },
      experiences: [
        {
          id: "steady",
          name: "Steady | <script>alert(1)</script>\nLine 2",
          status: "unchanged",
          enabled: true,
          priority: 1,
          holdout: 0.125,
          changeCount: 1,
          changedFields: [],
          previewPath: "/",
        },
      ],
      warnings: [
        {
          code: "full_holdout",
          experienceId: "steady",
          message: "Warning with | pipe and <b>tag</b>",
        },
      ],
    });

    expect(emptyDiffMarkdown.startsWith(`${PR_COMMENT_MARKER}\n`)).toBe(true);
    expect(emptyDiffMarkdown).toContain("No experience changes detected compared to base config.");
    expect(emptyDiffMarkdown).toContain("Steady \\| &lt;script&gt;alert(1)&lt;/script&gt; Line 2");
    expect(emptyDiffMarkdown).not.toContain("<script>");
    expect(emptyDiffMarkdown).toContain("12.5%");
    expect(emptyDiffMarkdown).toContain("1 rule");
    expect(emptyDiffMarkdown).toContain("Validation warnings (1)");
    expect(emptyDiffMarkdown).toContain("Warning with \\| pipe and &lt;b&gt;tag&lt;/b&gt;");
  });

  it("exposes pr-comment in CLI help output", async () => {
    const cwd = await makeTempDir();

    const mainHelp = createTestIO(cwd);
    expect(await runCli(["--help"], { io: mainHelp.io })).toBe(0);
    expect(mainHelp.stdout.join("")).toContain("pr-comment");

    const cmdHelp = createTestIO(cwd);
    expect(await runCli(["pr-comment", "--help"], { io: cmdHelp.io })).toBe(0);
    expect(cmdHelp.stdout.join("")).toContain("Usage: facet pr-comment");
    expect(cmdHelp.stdout.join("")).toContain("--base <path>");
    expect(cmdHelp.stdout.join("")).toContain("--json");
  });
});
