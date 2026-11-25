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

  it("reports validation errors on invalid template syntax across originPath, lookup.key, changes, and settings.slots", async () => {
    const cwd = await makeTempDir();
    const badTplPath = path.join(cwd, "bad-templates.yaml");
    await writeFile(
      badTplPath,
      `version: 1
settings:
  slots:
    broken-slot: "<div>{{unknown.field}}</div>"
data:
  accounts:
    stripe:
      name: "Stripe"
experiences:
  - id: tpl-errors
    name: "Template Errors"
    originPath: "/landing/{{unclosed"
    match:
      path: "/for/:acct"
    lookup:
      table: "accounts"
      key: "{{}}"
    changes:
      - selector: "h1"
        text: "Hello {{data.name | badfilter('x')}}"
      - selector: "#box"
        html: "<strong>{{data.__proto__}}</strong>"
      - selector: "#extra"
        prepend: "<span>{{query.x | default(unquoted)}}</span>"
        append: "<span>extra }}</span>"
        attrs:
          href: "/demo?acct={{params.acct"
`,
      "utf8",
    );

    const { stderr, io } = createTestIO(cwd);
    const result = await runValidateCommand(badTplPath, io);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.errors.every((e) => e.code === "invalid_template_syntax")).toBe(true);

    const paths = result.errors.map((e) => e.path);
    expect(paths).toContain("settings.slots.broken-slot");
    expect(paths).toContain("experiences[0].originPath");
    expect(paths).toContain("experiences[0].lookup.key");
    expect(paths).toContain("experiences[0].changes[0].text");
    expect(paths).toContain("experiences[0].changes[1].html");
    expect(paths).toContain("experiences[0].changes[2].prepend");
    expect(paths).toContain("experiences[0].changes[2].append");
    expect(paths).toContain("experiences[0].changes[2].attrs.href");
    expect(stderr.join("")).toContain("Invalid template syntax");
  });

  it("warns on missing data table, unreferenced {{params.*}}, and suspicious originPath", async () => {
    const cwd = await makeTempDir();
    const warnPath = path.join(cwd, "v02-warnings.yaml");
    await writeFile(
      warnPath,
      `version: 1
data:
  accounts:
    stripe:
      name: "Stripe"
experiences:
  - id: missing-table-and-param
    name: "Missing table and param"
    originPath: "/%2e%2e/secret"
    match:
      path: "/for/:acct"
    lookup:
      table: "nonexistent"
      key: "{{params.acct}}"
    changes:
      - selector: "h1"
        text: "Hi {{params.missingParam}}"
  - id: leading-template-origin
    name: "Leading template origin"
    originPath: "/{{params.slug}}"
    match:
      path: "/p/:slug"
    changes:
      - selector: "h1"
        text: "Slug {{params.slug}}"
`,
      "utf8",
    );

    const { io } = createTestIO(cwd);
    const result = await runValidateCommand(warnPath, io);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);

    expect(
      result.warnings.some(
        (w) => w.code === "missing_data_table" && w.experienceId === "missing-table-and-param",
      ),
    ).toBe(true);
    expect(
      result.warnings.some(
        (w) =>
          w.code === "unreferenced_path_param" &&
          w.experienceId === "missing-table-and-param" &&
          w.message.includes("params.missingParam"),
      ),
    ).toBe(true);
    // Declared :acct should NOT warn as unreferenced
    expect(
      result.warnings.some(
        (w) => w.code === "unreferenced_path_param" && w.message.includes("params.acct"),
      ),
    ).toBe(false);
    expect(
      result.warnings.some(
        (w) => w.code === "suspicious_origin_path" && w.experienceId === "missing-table-and-param",
      ),
    ).toBe(true);
    expect(
      result.warnings.some(
        (w) => w.code === "suspicious_origin_path" && w.experienceId === "leading-template-origin",
      ),
    ).toBe(true);
  });

  it("does not trigger false shadowed_experience warnings for experiences with distinct required lookup tables or keys", async () => {
    const cwd = await makeTempDir();
    const lookupPath = path.join(cwd, "lookup-shadowing.yaml");
    await writeFile(
      lookupPath,
      `version: 1
data:
  enterprise:
    stripe:
      name: "Stripe"
  smb:
    acme:
      name: "Acme"
experiences:
  - id: wildcard-enterprise
    name: "Enterprise Lookup"
    priority: 100
    stopOnMatch: true
    match: {}
    lookup:
      table: "enterprise"
      key: "{{query.acct}}"
      required: true
    changes:
      - selector: "h1"
        text: "Enterprise: {{data.name}}"
  - id: wildcard-smb
    name: "SMB Lookup"
    priority: 90
    stopOnMatch: true
    match: {}
    lookup:
      table: "smb"
      key: "{{query.acct}}"
      required: true
    changes:
      - selector: "h1"
        text: "SMB: {{data.name}}"
  - id: path-table-a
    name: "Path Table A"
    priority: 80
    stopOnMatch: true
    match:
      path: "/for/:acct"
    lookup:
      table: "enterprise"
      key: "{{params.acct}}"
    changes:
      - selector: "h1"
        text: "A: {{data.name}}"
  - id: path-table-b
    name: "Path Table B"
    priority: 70
    stopOnMatch: true
    match:
      path: "/for/:acct"
    lookup:
      table: "smb"
      key: "{{params.acct}}"
    changes:
      - selector: "h1"
        text: "B: {{data.name}}"
  - id: path-fallback
    name: "Path Fallback (no lookup)"
    priority: 60
    stopOnMatch: true
    match:
      path: "/for/:acct"
    changes:
      - selector: "h1"
        text: "Fallback for {{params.acct}}"
  - id: path-actually-shadowed
    name: "Shadowed by fallback"
    priority: 50
    stopOnMatch: true
    match:
      path: "/for/:acct"
    lookup:
      table: "enterprise"
      key: "{{params.acct}}"
    changes:
      - selector: "h1"
        text: "Unreachable"
`,
      "utf8",
    );

    const { io } = createTestIO(cwd);
    const result = await runValidateCommand(lookupPath, io);
    expect(result.ok).toBe(true);

    const shadowedIds = result.warnings
      .filter((w) => w.code === "shadowed_experience")
      .map((w) => w.experienceId);
    expect(shadowedIds).toEqual(["path-actually-shadowed"]);
  });
});
