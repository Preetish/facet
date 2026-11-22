import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseFacetYaml } from "@facet/core";
import { collectConfigWarnings, runCli, runValidateCommand } from "../src/index.js";

function createTestIO(cwd: string): {
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
      env: {},
    },
  };
}

describe("facet validate", () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "facet-cli-validate-"));
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

  it("validates a clean config file and prints summary", async () => {
    const cwd = await makeTempDir();
    const configPath = path.join(cwd, "facet.yaml");
    await writeFile(
      configPath,
      `version: 1
settings:
  analytics:
    providers: ["ga4"]
experiences:
  - id: fintech
    name: "Fintech"
    match:
      utm_campaign: "fintech"
    changes:
      - selector: "h1"
        text: "Hello Fintech"
`,
      "utf8",
    );

    const { stdout, stderr, io } = createTestIO(cwd);
    const exitCode = await runCli(["validate"], { io });
    expect(exitCode).toBe(0);
    expect(stderr.join("")).toBe("");
    expect(stdout.join("")).toContain("Valid Facet configuration");
    expect(stdout.join("")).toContain("1 total (1 enabled)");
    expect(stdout.join("")).toContain("ga4");
  });

  it("reports clear line and path diagnostics on invalid YAML and schema errors", async () => {
    const cwd = await makeTempDir();

    const badSchemaPath = path.join(cwd, "bad-schema.yaml");
    await writeFile(
      badSchemaPath,
      `version: 1
experiences:
  - id: bad-holdout
    name: "Bad Holdout"
    holdout: 1.5
    match:
      path: "/"
    changes:
      - selector: "h1"
        text: "Test"
`,
      "utf8",
    );

    const run1 = createTestIO(cwd);
    const res1 = await runValidateCommand(badSchemaPath, run1.io);
    expect(res1.ok).toBe(false);
    expect(res1.exitCode).toBe(1);
    expect(run1.stderr.join("")).toMatch(/Line \d+/);
    expect(run1.stderr.join("")).toContain("experiences[0].holdout");

    const badYamlPath = path.join(cwd, "bad-syntax.yaml");
    await writeFile(badYamlPath, "version: 1\nexperiences:\n  - [unclosed\n", "utf8");

    const run2 = createTestIO(cwd);
    const res2 = await runValidateCommand(badYamlPath, run2.io);
    expect(res2.ok).toBe(false);
    expect(res2.exitCode).toBe(1);
    expect(run2.stderr.join("")).toMatch(/Line \d+/);
  });

  it("returns exit code 1 when file does not exist", async () => {
    const cwd = await makeTempDir();
    const { stderr, io } = createTestIO(cwd);
    const res = await runValidateCommand("missing.yaml", io);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(stderr.join("")).toContain("Unable to read");
  });

  it("emits sanity warnings for empty experiences, disabled rules, holdout=1, invalid selectors, and shadowing", async () => {
    const emptyParsed = parseFacetYaml("version: 1\nexperiences: []\n");
    expect(emptyParsed.ok).toBe(true);
    if (!emptyParsed.ok) return;
    const emptyWarnings = collectConfigWarnings(emptyParsed.config);
    expect(emptyWarnings.some((w) => w.code === "empty_experiences")).toBe(true);

    const cwd = await makeTempDir();
    const noisyPath = path.join(cwd, "noisy.yaml");
    await writeFile(
      noisyPath,
      `version: 1
experiences:
  - id: disabled-exp
    name: "Disabled"
    enabled: false
    match:
      path: "/"
    changes:
      - selector: "h1"
        text: "Nope"
  - id: full-holdout
    name: "All Control"
    priority: 10
    holdout: 1
    stopOnMatch: true
    match:
      utm_campaign: "same"
    changes:
      - selector: "div[data-broken="
        text: "Broken selector"
  - id: shadowed-exp
    name: "Shadowed"
    priority: 10
    match:
      utm_campaign: "same"
    changes:
      - selector: "h1"
        text: "Never reached"
`,
      "utf8",
    );

    const { stdout, io } = createTestIO(cwd);
    const result = await runValidateCommand(noisyPath, io);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);

    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("disabled_experience");
    expect(codes).toContain("full_holdout");
    expect(codes).toContain("invalid_selector");
    expect(codes).toContain("shadowed_experience");
    expect(stdout.join("")).toContain("Warnings");
  });
});
