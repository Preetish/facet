import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { exportFacetJsonSchema } from "@facet/core";
import { resolveCliIO, type CliIO } from "../io.js";

export interface InitCommandOptions {
  out?: string;
  schema?: boolean;
  force?: boolean;
}

export interface InitCommandResult {
  exitCode: number;
  configPath: string;
  schemaPath?: string;
}

export interface StarterYamlOptions {
  includeSchemaComment?: boolean;
  schemaFilename?: string;
}

export function buildStarterFacetYaml(options?: StarterYamlOptions): string {
  const schemaFilename = options?.schemaFilename ?? "facet.schema.json";
  const schemaHeader = options?.includeSchemaComment
    ? `# yaml-language-server: $schema=./${schemaFilename}\n`
    : "";

  return `${schemaHeader}# Facet edge personalization & ad message-match configuration
# Docs & validation: npx facet validate ./facet.yaml
version: 1

settings:
  cookieName: "__facet_vid"
  previewParam: "__facet_preview"
  analytics:
    providers: ["ga4", "umami", "posthog"]
  slots:
    fintech-logos: >-
      <div class="facet-logo-strip" data-segment="fintech">
        <span>Trusted by Stripe, Plaid, Ramp &amp; Mercury</span>
      </div>

experiences:
  # 1. 1:1 ABM links (?acct=stripe or /for/stripe) — 100% match rate, zero API keys
  - id: abm-stripe
    name: "ABM — Stripe"
    priority: 30
    holdout: 0
    match:
      any:
        - query.acct: ["stripe"]
        - path: "/for/stripe"
    changes:
      - selector: "h1"
        text: "Zero-flicker edge personalization built for Stripe's growth team"
      - selector: "[data-cta='hero']"
        text: "Book a tailored Stripe walkthrough"
        attrs:
          href: "/demo?acct=stripe"

  # 2. Paid search & social ad message-match via UTM parameters
  - id: fintech-paid-search
    name: "Fintech Paid Search"
    priority: 20
    holdout: 0.2 # deterministic 20% sticky control group for lift measurement
    match:
      path: "/"
      any:
        - utm_campaign: ["fintech-q4", "fintech-search"]
        - utm_term:
            contains: "fintech"
    changes:
      - selector: "h1"
        text: "Compliance-ready infrastructure for fintech teams"
      - selector: "[data-cta='hero']"
        text: "See the fintech demo"
        attrs:
          href: "/demo?segment=fintech"
      - selector: "#logo-strip"
        slot: "fintech-logos"

  # 3. Returning visitor & geo-targeted experience (uses built-in edge signals)
  - id: returning-us-visitor
    name: "Returning North America Visitor"
    priority: 10
    holdout: 0.1
    match:
      path: "/"
      returning: true
      geo.country: ["US", "CA"]
    changes:
      - selector: "[data-cta='hero']"
        text: "Welcome back — start your free pilot"
        attrs:
          href: "/signup?source=returning"
`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function runInitCommand(
  options?: InitCommandOptions,
  ioOverrides?: Partial<CliIO>,
): Promise<InitCommandResult> {
  const io = resolveCliIO(ioOverrides);
  const outArg = options?.out ?? "facet.yaml";
  const includeSchema = options?.schema === true;
  const force = options?.force === true;

  const configPath = path.resolve(io.cwd, outArg);
  const configDir = path.dirname(configPath);
  const schemaFilename = "facet.schema.json";
  const schemaPath = includeSchema ? path.join(configDir, schemaFilename) : undefined;

  if (!force) {
    if (await fileExists(configPath)) {
      io.stderr(
        `Error: ${configPath} already exists. Pass --force to overwrite or choose another path with --out.\n`,
      );
      return { exitCode: 1, configPath };
    }
    if (schemaPath && (await fileExists(schemaPath))) {
      io.stderr(`Error: ${schemaPath} already exists. Pass --force to overwrite.\n`);
      return { exitCode: 1, configPath, schemaPath };
    }
  }

  await mkdir(configDir, { recursive: true });

  const yamlContent = buildStarterFacetYaml({
    includeSchemaComment: includeSchema,
    schemaFilename,
  });
  await writeFile(configPath, yamlContent, "utf8");
  io.stdout(`Created ${configPath}\n`);

  if (schemaPath) {
    const schema = exportFacetJsonSchema();
    await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
    io.stdout(`Created ${schemaPath}\n`);
  }

  io.stdout(
    `Next steps:\n  npx facet validate ${outArg}\n  npx facet preview --target https://yoursite.com --config ${outArg}\n`,
  );

  return schemaPath ? { exitCode: 0, configPath, schemaPath } : { exitCode: 0, configPath };
}
