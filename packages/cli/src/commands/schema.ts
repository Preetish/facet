import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { exportFacetJsonSchema, type JsonSchemaObject } from "@facet/core";
import { resolveCliIO, type CliIO } from "../io.js";

export interface SchemaCommandOptions {
  out?: string;
}

export interface SchemaCommandResult {
  exitCode: number;
  schema: JsonSchemaObject;
  outPath?: string;
}

export async function runSchemaCommand(
  options?: SchemaCommandOptions,
  ioOverrides?: Partial<CliIO>,
): Promise<SchemaCommandResult> {
  const io = resolveCliIO(ioOverrides);
  const schema = exportFacetJsonSchema();
  const formatted = `${JSON.stringify(schema, null, 2)}\n`;

  if (options?.out) {
    const outPath = path.resolve(io.cwd, options.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, formatted, "utf8");
    io.stdout(`Wrote JSON Schema to ${outPath}\n`);
    return { exitCode: 0, schema, outPath };
  }

  io.stdout(formatted);
  return { exitCode: 0, schema };
}
