import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLI_VERSION,
  runCli,
  runInitCommand,
  runSchemaCommand,
  runValidateCommand,
} from "../src/index.js";

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

describe("facet init, schema & general CLI flags", () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "facet-cli-init-"));
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

  it("creates a starter facet.yaml that passes validation with zero errors and warnings", async () => {
    const cwd = await makeTempDir();
    const { stdout, stderr, io } = createTestIO(cwd);

    const initResult = await runInitCommand({}, io);
    expect(initResult.exitCode).toBe(0);
    expect(stderr.join("")).toBe("");
    expect(stdout.join("")).toContain("Created");

    const yamlText = await readFile(initResult.configPath, "utf8");
    expect(yamlText).toContain("utm_campaign");
    expect(yamlText).toContain("query.acct");
    expect(yamlText).toContain("geo.country");
    expect(yamlText).toContain("holdout:");
    expect(yamlText).not.toContain("yaml-language-server");

    const validateResult = await runValidateCommand(initResult.configPath, io);
    expect(validateResult.ok).toBe(true);
    expect(validateResult.exitCode).toBe(0);
    expect(validateResult.errors).toEqual([]);
    expect(validateResult.warnings).toEqual([]);
  });

  it("writes facet.schema.json and yaml-language-server comment when --schema is passed", async () => {
    const cwd = await makeTempDir();
    const { io } = createTestIO(cwd);

    const exitCode = await runCli(["init", "--out", "config/facet.yaml", "--schema"], { io });
    expect(exitCode).toBe(0);

    const yamlPath = path.join(cwd, "config", "facet.yaml");
    const schemaPath = path.join(cwd, "config", "facet.schema.json");
    const yamlText = await readFile(yamlPath, "utf8");
    const schemaRaw = await readFile(schemaPath, "utf8");

    expect(yamlText.startsWith("# yaml-language-server: $schema=./facet.schema.json\n")).toBe(true);
    const schema = JSON.parse(schemaRaw) as Record<string, unknown>;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.title).toBe("Facet Configuration (v1)");

    const validateResult = await runValidateCommand(yamlPath, io);
    expect(validateResult.ok).toBe(true);
    expect(validateResult.warnings).toEqual([]);
  });

  it("refuses to overwrite existing facet.yaml unless --force is passed", async () => {
    const cwd = await makeTempDir();
    const existingPath = path.join(cwd, "facet.yaml");
    await writeFile(existingPath, "# existing file\n", "utf8");

    const first = createTestIO(cwd);
    const code1 = await runCli(["init"], { io: first.io });
    expect(code1).toBe(1);
    expect(first.stderr.join("")).toContain("already exists");
    expect(await readFile(existingPath, "utf8")).toBe("# existing file\n");

    const second = createTestIO(cwd);
    const code2 = await runCli(["init", "--force"], { io: second.io });
    expect(code2).toBe(0);
    expect(await readFile(existingPath, "utf8")).toContain("version: 1");
  });

  it("exports JSON Schema to stdout and to a file via facet schema", async () => {
    const cwd = await makeTempDir();
    const toStdout = createTestIO(cwd);
    const codeStdout = await runCli(["schema"], { io: toStdout.io });
    expect(codeStdout).toBe(0);
    const parsedStdout = JSON.parse(toStdout.stdout.join("")) as Record<string, unknown>;
    expect(parsedStdout.$schema).toBe("https://json-schema.org/draft/2020-12/schema");

    const toFile = createTestIO(cwd);
    const outPath = path.join(cwd, "schemas", "facet.schema.json");
    const result = await runSchemaCommand({ out: outPath }, toFile.io);
    expect(result.exitCode).toBe(0);
    const fileContent = JSON.parse(await readFile(outPath, "utf8")) as Record<string, unknown>;
    expect(fileContent.$id).toBe(parsedStdout.$id);
  });

  it("supports --help, --version, subcommand help, and rejects unknown commands", async () => {
    const cwd = await makeTempDir();

    const helpRun = createTestIO(cwd);
    expect(await runCli(["--help"], { io: helpRun.io })).toBe(0);
    expect(helpRun.stdout.join("")).toContain("Facet CLI");

    const versionRun = createTestIO(cwd);
    expect(await runCli(["--version"], { io: versionRun.io })).toBe(0);
    expect(versionRun.stdout.join("").trim()).toBe(CLI_VERSION);

    const subHelpRun = createTestIO(cwd);
    expect(await runCli(["preview-link", "--help"], { io: subHelpRun.io })).toBe(0);
    expect(subHelpRun.stdout.join("")).toContain("--secret");

    const unknownRun = createTestIO(cwd);
    expect(await runCli(["does-not-exist"], { io: unknownRun.io })).toBe(1);
    expect(unknownRun.stderr.join("")).toContain("Unknown command");
  });
});
