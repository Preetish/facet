const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

export function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Recursively clones plain JSON-compatible values while stripping prototype-pollution keys.
 */
export function sanitizeJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenKey(k)) {
      continue;
    }
    out[k] = sanitizeJsonValue(v);
  }
  return out;
}

/**
 * Computes a lowercase hex SHA-256 digest of a UTF-8 string using Web Crypto.
 */
export async function hashYaml(yaml: string): Promise<string> {
  const data = new TextEncoder().encode(yaml);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Encodes a UTF-8 string to standard Base64 using Web Standard APIs (zero Node Buffer dependency).
 */
export function utf8ToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

/**
 * Decodes a Base64 string (ignoring whitespace/newlines) to UTF-8 using Web Standard APIs.
 */
export function base64ToUtf8(base64: string): string {
  const normalized = base64.replace(/\s+/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Parses an RFC-4180 CSV string into raw string matrix rows.
 * Supports UTF-8 BOM, CRLF/LF/CR line endings, quoted fields with embedded
 * commas/newlines, and doubled quote escaping (`""`).
 */
export function parseCsvMatrix(input: string): string[][] {
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
 * Parses an RFC-4180 CSV string into ordered header-keyed records while stripping
 * empty and prototype-pollution header names.
 */
export function parseCsvRecords(csv: string): Record<string, string>[] {
  const matrix = parseCsvMatrix(csv);
  if (matrix.length === 0) {
    return [];
  }

  const rawHeaders = matrix[0] ?? [];
  const headers = rawHeaders.map((h) => h.trim());
  const records: Record<string, string>[] = [];

  for (let r = 1; r < matrix.length; r++) {
    const cells = matrix[r];
    if (!cells) continue;

    const record: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const col = headers[c];
      if (!col || col.length === 0 || isForbiddenKey(col)) {
        continue;
      }
      record[col] = cells[c] ?? "";
    }
    records.push(record);
  }

  return records;
}
