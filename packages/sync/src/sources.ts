import { hasOwn, isForbiddenKey, parseCsvRecords } from "./utils.js";

export type SyncRow = Record<string, unknown>;

export interface SyncSource {
  readonly name: string;
  fetchRows(): Promise<SyncRow[]>;
}

export interface GoogleSheetsSourceOptions {
  csvUrl?: string;
  spreadsheetId?: string;
  range?: string;
  apiKey?: string;
  accessToken?: string;
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface AirtableSourceOptions {
  apiKey: string;
  baseId: string;
  table: string;
  view?: string;
  pageSize?: number;
  maxPages?: number;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface NotionSourceOptions {
  token: string;
  databaseId: string;
  filter?: Record<string, unknown>;
  sorts?: Record<string, unknown>[];
  pageSize?: number;
  maxPages?: number;
  notionVersion?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

const DEFAULT_GOOGLE_SHEETS_API_BASE = "https://sheets.googleapis.com/v4";
const DEFAULT_AIRTABLE_API_BASE = "https://api.airtable.com/v0";
const DEFAULT_NOTION_API_BASE = "https://api.notion.com/v1";
const DEFAULT_NOTION_VERSION = "2022-06-28";
const DEFAULT_MAX_PAGES = 100;

function resolveFetch(fetchFn?: typeof fetch): typeof fetch {
  if (fetchFn) return fetchFn;
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }
  throw new Error("No fetch implementation available; pass fetchFn in options");
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
  } catch {
    return "";
  }
}

function sanitizeFlatRecord(input: Record<string, unknown>): SyncRow {
  const out: SyncRow = {};
  for (const key of Object.keys(input)) {
    if (!hasOwn(input, key) || isForbiddenKey(key)) {
      continue;
    }
    const trimmed = key.trim();
    if (trimmed.length === 0 || isForbiddenKey(trimmed)) {
      continue;
    }
    out[trimmed] = input[key];
  }
  return out;
}

interface GoogleSheetsValuesResponse {
  values?: unknown[][];
}

function parseSheetsMatrix(values: readonly unknown[][]): SyncRow[] {
  if (values.length === 0) {
    return [];
  }
  const rawHeaders = values[0] ?? [];
  const headers = rawHeaders.map((cell) =>
    cell === null || cell === undefined ? "" : String(cell).trim(),
  );
  const rows: SyncRow[] = [];

  for (let r = 1; r < values.length; r++) {
    const cells = values[r];
    if (!cells) continue;

    const record: SyncRow = {};
    for (let c = 0; c < headers.length; c++) {
      const col = headers[c];
      if (!col || col.length === 0 || isForbiddenKey(col)) {
        continue;
      }
      const cell = cells[c];
      record[col] = cell === undefined || cell === null ? "" : cell;
    }
    rows.push(record);
  }

  return rows;
}

/**
 * Creates a Google Sheets sync source supporting either:
 * 1. Zero-auth published CSV URL (`csvUrl`) parsed with a pure RFC-4180 CSV parser, or
 * 2. Google Sheets API v4 (`spreadsheetId` + optional `range`, `apiKey`, or `accessToken`).
 */
export function createGoogleSheetsSource(options: GoogleSheetsSourceOptions): SyncSource {
  const csvUrl = options.csvUrl?.trim();
  const spreadsheetId = options.spreadsheetId?.trim();

  if (!csvUrl && !spreadsheetId) {
    throw new Error("createGoogleSheetsSource requires either csvUrl or spreadsheetId");
  }

  const fetchFn = resolveFetch(options.fetchFn);

  return {
    name: csvUrl ? "google-sheets-csv" : "google-sheets-api",
    async fetchRows(): Promise<SyncRow[]> {
      if (csvUrl) {
        const response = await fetchFn(csvUrl, {
          method: "GET",
          headers: {
            Accept: "text/csv, text/plain;q=0.9, */*;q=0.8",
          },
        });
        if (!response.ok) {
          const detail = await readErrorBody(response);
          throw new Error(
            `Google Sheets CSV request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
          );
        }
        const csvText = await response.text();
        return parseCsvRecords(csvText);
      }

      const apiBase = (options.apiBaseUrl ?? DEFAULT_GOOGLE_SHEETS_API_BASE).replace(/\/+$/, "");
      const range = options.range?.trim() || "Sheet1";
      const url = new URL(
        `${apiBase}/spreadsheets/${encodeURIComponent(spreadsheetId ?? "")}/values/${encodeURIComponent(range)}`,
      );
      if (options.apiKey) {
        url.searchParams.set("key", options.apiKey);
      }

      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (options.accessToken) {
        headers.Authorization = `Bearer ${options.accessToken}`;
      }

      const response = await fetchFn(url.toString(), {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new Error(
          `Google Sheets API v4 request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
        );
      }

      const data = (await response.json()) as GoogleSheetsValuesResponse;
      if (!data || !Array.isArray(data.values)) {
        return [];
      }

      return parseSheetsMatrix(data.values);
    },
  };
}

interface AirtableRecord {
  id?: string;
  fields?: Record<string, unknown>;
}

interface AirtableListResponse {
  records?: AirtableRecord[];
  offset?: string;
}

/**
 * Creates a paginated Airtable REST API source that flattens `records[].fields`.
 */
export function createAirtableSource(options: AirtableSourceOptions): SyncSource {
  const apiKey = options.apiKey.trim();
  const baseId = options.baseId.trim();
  const table = options.table.trim();

  if (apiKey.length === 0) {
    throw new Error("createAirtableSource requires a non-empty apiKey");
  }
  if (baseId.length === 0) {
    throw new Error("createAirtableSource requires a non-empty baseId");
  }
  if (table.length === 0) {
    throw new Error("createAirtableSource requires a non-empty table");
  }

  const fetchFn = resolveFetch(options.fetchFn);
  const baseUrl = (options.baseUrl ?? DEFAULT_AIRTABLE_API_BASE).replace(/\/+$/, "");
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  return {
    name: "airtable",
    async fetchRows(): Promise<SyncRow[]> {
      const rows: SyncRow[] = [];
      const seenOffsets = new Set<string>();
      let offset: string | undefined;
      let page = 0;

      while (page < maxPages) {
        page += 1;
        const url = new URL(
          `${baseUrl}/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}`,
        );
        if (options.view) {
          url.searchParams.set("view", options.view);
        }
        if (options.pageSize !== undefined) {
          url.searchParams.set("pageSize", String(options.pageSize));
        }
        if (offset) {
          url.searchParams.set("offset", offset);
        }

        const response = await fetchFn(url.toString(), {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          const detail = await readErrorBody(response);
          throw new Error(
            `Airtable API request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
          );
        }

        const data = (await response.json()) as AirtableListResponse;
        const records = Array.isArray(data.records) ? data.records : [];
        for (const record of records) {
          if (record && record.fields && typeof record.fields === "object") {
            rows.push(sanitizeFlatRecord(record.fields));
          }
        }

        if (!data.offset || typeof data.offset !== "string") {
          break;
        }
        if (seenOffsets.has(data.offset)) {
          throw new Error(`Airtable pagination loop detected for offset "${data.offset}"`);
        }
        seenOffsets.add(data.offset);
        offset = data.offset;
      }

      return rows;
    },
  };
}

interface NotionRichTextPart {
  plain_text?: string;
}

interface NotionSelectOption {
  name?: string;
}

interface NotionFormulaValue {
  type?: string;
  string?: string | null;
  number?: number | null;
  boolean?: boolean | null;
  date?: { start?: string | null } | null;
}

interface NotionProperty {
  type?: string;
  title?: NotionRichTextPart[];
  rich_text?: NotionRichTextPart[];
  select?: NotionSelectOption | null;
  multi_select?: NotionSelectOption[];
  number?: number | null;
  checkbox?: boolean;
  url?: string | null;
  email?: string | null;
  status?: NotionSelectOption | null;
  phone_number?: string | null;
  date?: { start?: string | null } | null;
  formula?: NotionFormulaValue | null;
  unique_id?: { prefix?: string | null; number?: number | null } | null;
}

interface NotionPage {
  id?: string;
  properties?: Record<string, NotionProperty>;
}

interface NotionQueryResponse {
  results?: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
}

function joinRichText(parts: readonly NotionRichTextPart[] | undefined): string {
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => part?.plain_text ?? "").join("");
}

/**
 * Extracts a plain JS value from a Notion database page property object.
 */
export function extractNotionPropertyValue(property: unknown): unknown {
  if (!property || typeof property !== "object") {
    return null;
  }

  const prop = property as NotionProperty;
  switch (prop.type) {
    case "title":
      return joinRichText(prop.title);
    case "rich_text":
      return joinRichText(prop.rich_text);
    case "select":
      return prop.select?.name ?? null;
    case "multi_select":
      if (!Array.isArray(prop.multi_select)) return [];
      return prop.multi_select
        .map((opt) => opt?.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0);
    case "number":
      return typeof prop.number === "number" && Number.isFinite(prop.number) ? prop.number : null;
    case "checkbox":
      return Boolean(prop.checkbox);
    case "url":
      return typeof prop.url === "string" ? prop.url : null;
    case "email":
      return typeof prop.email === "string" ? prop.email : null;
    case "status":
      return prop.status?.name ?? null;
    case "phone_number":
      return typeof prop.phone_number === "string" ? prop.phone_number : null;
    case "date":
      return typeof prop.date?.start === "string" ? prop.date.start : null;
    case "formula": {
      const f = prop.formula;
      if (!f) return null;
      if (f.type === "string") return f.string ?? null;
      if (f.type === "number") return typeof f.number === "number" ? f.number : null;
      if (f.type === "boolean") return typeof f.boolean === "boolean" ? f.boolean : null;
      if (f.type === "date") return f.date?.start ?? null;
      return null;
    }
    case "unique_id": {
      const uid = prop.unique_id;
      if (!uid || typeof uid.number !== "number") return null;
      return uid.prefix ? `${uid.prefix}-${uid.number}` : String(uid.number);
    }
    default:
      return null;
  }
}

/**
 * Creates a paginated Notion Databases Query API source extracting standard Notion property types.
 */
export function createNotionSource(options: NotionSourceOptions): SyncSource {
  const token = options.token.trim();
  const databaseId = options.databaseId.trim();

  if (token.length === 0) {
    throw new Error("createNotionSource requires a non-empty token");
  }
  if (databaseId.length === 0) {
    throw new Error("createNotionSource requires a non-empty databaseId");
  }

  const fetchFn = resolveFetch(options.fetchFn);
  const baseUrl = (options.baseUrl ?? DEFAULT_NOTION_API_BASE).replace(/\/+$/, "");
  const notionVersion = options.notionVersion ?? DEFAULT_NOTION_VERSION;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  return {
    name: "notion",
    async fetchRows(): Promise<SyncRow[]> {
      const rows: SyncRow[] = [];
      const seenCursors = new Set<string>();
      let startCursor: string | undefined;
      let page = 0;

      while (page < maxPages) {
        page += 1;
        const body: Record<string, unknown> = {};
        if (options.filter) body.filter = options.filter;
        if (options.sorts) body.sorts = options.sorts;
        if (options.pageSize !== undefined) body.page_size = options.pageSize;
        if (startCursor) body.start_cursor = startCursor;

        const response = await fetchFn(
          `${baseUrl}/databases/${encodeURIComponent(databaseId)}/query`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Notion-Version": notionVersion,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(body),
          },
        );

        if (!response.ok) {
          const detail = await readErrorBody(response);
          throw new Error(
            `Notion API request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
          );
        }

        const data = (await response.json()) as NotionQueryResponse;
        const results = Array.isArray(data.results) ? data.results : [];

        for (const pageObj of results) {
          if (!pageObj || !pageObj.properties || typeof pageObj.properties !== "object") {
            continue;
          }
          const row: SyncRow = {};
          for (const propName of Object.keys(pageObj.properties)) {
            if (!hasOwn(pageObj.properties, propName) || isForbiddenKey(propName)) {
              continue;
            }
            const trimmed = propName.trim();
            if (trimmed.length === 0 || isForbiddenKey(trimmed)) {
              continue;
            }
            row[trimmed] = extractNotionPropertyValue(pageObj.properties[propName]);
          }
          rows.push(row);
        }

        if (!data.has_more || !data.next_cursor) {
          break;
        }
        if (seenCursors.has(data.next_cursor)) {
          throw new Error(`Notion pagination loop detected for cursor "${data.next_cursor}"`);
        }
        seenCursors.add(data.next_cursor);
        startCursor = data.next_cursor;
      }

      return rows;
    },
  };
}
