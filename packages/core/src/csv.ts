import type { ContextPrimitive } from "./context.js";
import type { FacetDataRow, FacetDataTable } from "./schema.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

/**
 * Parses an RFC-4180 CSV string into rows of string fields.
 * Supports UTF-8 BOM, CRLF/LF/CR line endings, quoted fields with embedded
 * commas/newlines, and doubled quote escaping (`""`).
 */
function parseCsvRows(input: string): string[][] {
  const source = input.startsWith("\uFEFF") ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    if (ch === undefined) break;

    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }

    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      i += 1;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      fieldStarted = false;
      i += 1;
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      row.push(field);
      field = "";
      fieldStarted = false;

      if (row.length > 1 || (row.length === 1 && row[0] !== "")) {
        rows.push(row);
      }
      row = [];

      if (ch === "\r" && source[i + 1] === "\n") {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    field += ch;
    fieldStarted = true;
    i += 1;
  }

  if (inQuotes) {
    throw new Error("Unterminated quoted field in CSV");
  }

  if (fieldStarted || row.length > 0) {
    row.push(field);
    if (row.length > 1 || (row.length === 1 && row[0] !== "")) {
      rows.push(row);
    }
  }

  return rows;
}

/**
 * Pure, zero-I/O RFC-4180 CSV parser that converts a CSV string into a keyed
 * lookup table suitable for `config.data[tableName]`.
 */
export function parseCsvTable(
  csv: string,
  keyColumn: string,
): Record<string, Record<string, ContextPrimitive>> {
  const trimmedKeyCol = keyColumn.trim();
  if (trimmedKeyCol.length === 0) {
    throw new Error("CSV keyColumn must be a non-empty string");
  }
  if (isForbiddenKey(trimmedKeyCol)) {
    throw new Error(`CSV keyColumn "${trimmedKeyCol}" is not allowed`);
  }

  const rows = parseCsvRows(csv);
  if (rows.length === 0) {
    throw new Error(`CSV is missing required key column "${trimmedKeyCol}"`);
  }

  const rawHeaders = rows[0] ?? [];
  const headers = rawHeaders.map((h) => h.trim());
  const keyIndex = headers.indexOf(trimmedKeyCol);
  if (keyIndex === -1) {
    throw new Error(`CSV is missing required key column "${trimmedKeyCol}"`);
  }

  const table: FacetDataTable = {};

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells) continue;

    const rawKey = cells[keyIndex];
    const rowKey = rawKey !== undefined ? rawKey.trim() : "";
    if (rowKey.length === 0 || isForbiddenKey(rowKey)) {
      continue;
    }

    const record: FacetDataRow = {};
    for (let c = 0; c < headers.length; c++) {
      const colName = headers[c];
      if (!colName || colName.length === 0 || isForbiddenKey(colName)) {
        continue;
      }
      record[colName] = cells[c] ?? "";
    }

    table[rowKey] = record;
  }

  return table;
}
