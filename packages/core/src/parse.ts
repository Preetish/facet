import { LineCounter, isMap, isNode, isSeq, parseDocument, type Document, type Node } from "yaml";
import type { ZodIssue } from "zod";
import { facetConfigSchema, type FacetConfig } from "./schema.js";

export interface FacetValidationError {
  path: string;
  message: string;
  code: string;
  line?: number;
  column?: number;
}

export type ParseFacetResult =
  { ok: true; config: FacetConfig } | { ok: false; errors: FacetValidationError[] };

function formatIssuePath(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) return "$";
  let result = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      result += `[${segment}]`;
    } else if (result.length === 0) {
      result = segment;
    } else if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(segment)) {
      result += `.${segment}`;
    } else {
      result += `[${JSON.stringify(segment)}]`;
    }
  }
  return result;
}

function findYamlNodeByPath(doc: Document, path: ReadonlyArray<string | number>): Node | undefined {
  let current: unknown = doc.contents;
  let lastValidNode: Node | undefined = isNode(current) ? current : undefined;

  for (const segment of path) {
    if (isMap(current)) {
      const next = current.get(String(segment), true);
      if (isNode(next)) {
        current = next;
        lastValidNode = next;
        continue;
      }
      return lastValidNode;
    }
    if (isSeq(current) && typeof segment === "number") {
      const next = current.items[segment];
      if (isNode(next)) {
        current = next;
        lastValidNode = next;
        continue;
      }
      return lastValidNode;
    }
    return lastValidNode;
  }

  return lastValidNode;
}

function mapZodIssue(
  issue: ZodIssue,
  doc?: Document,
  lineCounter?: LineCounter,
): FacetValidationError {
  const error: FacetValidationError = {
    path: formatIssuePath(issue.path),
    message: issue.message,
    code: issue.code,
  };

  if (doc && lineCounter) {
    const node = findYamlNodeByPath(doc, issue.path);
    const rangeStart = node?.range?.[0];
    if (rangeStart !== undefined) {
      const pos = lineCounter.linePos(rangeStart);
      error.line = pos.line;
      error.column = pos.col;
    }
  }

  return error;
}

export function validateFacetConfig(input: unknown): ParseFacetResult {
  const parsed = facetConfigSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, config: parsed.data };
  }
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => mapZodIssue(issue)),
  };
}

export function parseFacetYaml(source: string): ParseFacetResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter });

  if (doc.errors.length > 0) {
    const errors: FacetValidationError[] = doc.errors.map((err) => {
      const pos = err.linePos?.[0];
      const out: FacetValidationError = {
        path: "$",
        message: err.message,
        code: "yaml_syntax_error",
      };
      if (pos) {
        out.line = pos.line;
        out.column = pos.col;
      }
      return out;
    });
    return { ok: false, errors };
  }

  const raw: unknown = doc.toJS();
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        {
          path: "$",
          message: "Facet configuration must be a YAML mapping/object at the top level",
          code: "invalid_type",
          line: 1,
          column: 1,
        },
      ],
    };
  }

  const parsed = facetConfigSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, config: parsed.data };
  }

  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => mapZodIssue(issue, doc, lineCounter)),
  };
}
