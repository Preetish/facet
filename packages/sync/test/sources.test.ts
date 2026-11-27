import { describe, expect, it, vi } from "vitest";
import {
  createAirtableSource,
  createGoogleSheetsSource,
  createNotionSource,
} from "../src/index.js";

describe("createGoogleSheetsSource", () => {
  it("fetches and parses published CSV URL with UTF-8 BOM, quotes, commas, and multiline cells", async () => {
    const csv =
      "\uFEFFid,name,status,utm_campaign,headline,__proto__\r\n" +
      'fintech-q4,"Fintech, ""Q4""",live,"fintech-q4, abm","Built for\nFintech",ignored\r\n' +
      "saas-q4,SaaS Q4,paused,saas-q4,Scale SaaS,ignored\r\n";

    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(csv, {
        status: 200,
        headers: { "Content-Type": "text/csv; charset=utf-8" },
      }),
    );

    const source = createGoogleSheetsSource({
      csvUrl: "https://docs.google.com/spreadsheets/d/abc123/export?format=csv",
      fetchFn,
    });

    const rows = await source.fetchRows();
    expect(source.name).toBe("google-sheets-csv");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "fintech-q4",
      name: 'Fintech, "Q4"',
      status: "live",
      utm_campaign: "fintech-q4, abm",
      headline: "Built for\nFintech",
    });
    expect(Object.prototype.hasOwnProperty.call(rows[0] ?? {}, "__proto__")).toBe(false);
    expect(rows[1]?.status).toBe("paused");
  });

  it("fetches and maps Google Sheets API v4 values response with apiKey and accessToken", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          range: "Campaigns!A1:E3",
          values: [
            ["id", "name", "status", "priority", "headline", "constructor"],
            ["hero-1", "Hero 1", "live", 10, "Welcome", "bad"],
            ["hero-2", "Hero 2"],
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const source = createGoogleSheetsSource({
      spreadsheetId: "sheet-id-42",
      range: "Campaigns!A1:F100",
      apiKey: "test-api-key",
      accessToken: "oauth-token",
      fetchFn,
    });

    const rows = await source.fetchRows();
    expect(source.name).toBe("google-sheets-api");
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const [calledUrl, calledInit] = fetchFn.mock.calls[0] ?? [];
    expect(String(calledUrl)).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sheet-id-42/values/Campaigns!A1%3AF100?key=test-api-key",
    );
    expect((calledInit?.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer oauth-token",
    );

    expect(rows).toEqual([
      { id: "hero-1", name: "Hero 1", status: "live", priority: 10, headline: "Welcome" },
      { id: "hero-2", name: "Hero 2", status: "", priority: "", headline: "" },
    ]);
    expect(Object.prototype.hasOwnProperty.call(rows[0] ?? {}, "constructor")).toBe(false);
  });

  it("throws when neither csvUrl nor spreadsheetId is provided", () => {
    expect(() => createGoogleSheetsSource({})).toThrow(/csvUrl or spreadsheetId/);
  });
});

describe("createAirtableSource", () => {
  it("paginates through offset responses and flattens records[].fields safely", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            records: [
              {
                id: "rec1",
                fields: {
                  id: "exp-1",
                  name: "Exp 1",
                  utm_campaign: ["q4", "abm"],
                  headline: "Hello 1",
                },
              },
            ],
            offset: "itrPage2",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            records: [
              {
                id: "rec2",
                fields: JSON.parse('{"id":"exp-2","headline":"Hello 2","__proto__":"bad"}'),
              },
            ],
          }),
          { status: 200 },
        ),
      );

    const source = createAirtableSource({
      apiKey: "pat_secret",
      baseId: "appBase123",
      table: "Campaigns",
      view: "Published",
      pageSize: 50,
      fetchFn,
    });

    const rows = await source.fetchRows();
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const firstUrl = String(fetchFn.mock.calls[0]?.[0]);
    const secondUrl = String(fetchFn.mock.calls[1]?.[0]);
    expect(firstUrl).toContain("/appBase123/Campaigns");
    expect(firstUrl).toContain("view=Published");
    expect(firstUrl).toContain("pageSize=50");
    expect(secondUrl).toContain("offset=itrPage2");
    expect((fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer pat_secret",
    );

    expect(rows).toEqual([
      { id: "exp-1", name: "Exp 1", utm_campaign: ["q4", "abm"], headline: "Hello 1" },
      { id: "exp-2", headline: "Hello 2" },
    ]);
    expect(Object.prototype.hasOwnProperty.call(rows[1] ?? {}, "__proto__")).toBe(false);
  });

  it("throws on repeated offset pagination loop", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ records: [], offset: "same-offset" }), { status: 200 }),
      );

    const source = createAirtableSource({
      apiKey: "pat",
      baseId: "app1",
      table: "tbl1",
      fetchFn,
    });

    await expect(source.fetchRows()).rejects.toThrow(/pagination loop/i);
  });
});

describe("createNotionSource", () => {
  it("paginates Notion database queries and extracts all standard property types", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                id: "page-1",
                properties: {
                  id: {
                    type: "title",
                    title: [{ plain_text: "notion-" }, { plain_text: "exp-1" }],
                  },
                  headline: { type: "rich_text", rich_text: [{ plain_text: "Enterprise Ready" }] },
                  status: { type: "status", status: { name: "live" } },
                  utm_source: { type: "select", select: { name: "linkedin" } },
                  utm_campaign: {
                    type: "multi_select",
                    multi_select: [{ name: "abm-q4" }, { name: "exec-outreach" }],
                  },
                  priority: { type: "number", number: 25 },
                  sticky: { type: "checkbox", checkbox: true },
                  cta_href: { type: "url", url: "https://example.com/demo" },
                  owner_email: { type: "email", email: "growth@example.com" },
                },
              },
            ],
            has_more: true,
            next_cursor: "cursor-2",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                id: "page-2",
                properties: {
                  id: { type: "title", title: [{ plain_text: "notion-exp-2" }] },
                  status: { type: "select", select: { name: "paused" } },
                  priority: { type: "number", number: null },
                  sticky: { type: "checkbox", checkbox: false },
                  cta_href: { type: "url", url: null },
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
          { status: 200 },
        ),
      );

    const filter = { property: "status", status: { does_not_equal: "draft" } };
    const source = createNotionSource({
      token: "secret_notion_token",
      databaseId: "db-1234",
      filter,
      fetchFn,
    });

    const rows = await source.fetchRows();
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const [firstUrl, firstInit] = fetchFn.mock.calls[0] ?? [];
    expect(String(firstUrl)).toBe("https://api.notion.com/v1/databases/db-1234/query");
    expect(firstInit?.method).toBe("POST");
    expect((firstInit?.headers as Record<string, string>)?.["Notion-Version"]).toBe("2022-06-28");
    expect(JSON.parse(String(firstInit?.body))).toEqual({ filter });

    const secondInit = fetchFn.mock.calls[1]?.[1];
    expect(JSON.parse(String(secondInit?.body))).toEqual({
      filter,
      start_cursor: "cursor-2",
    });

    expect(rows).toEqual([
      {
        id: "notion-exp-1",
        headline: "Enterprise Ready",
        status: "live",
        utm_source: "linkedin",
        utm_campaign: ["abm-q4", "exec-outreach"],
        priority: 25,
        sticky: true,
        cta_href: "https://example.com/demo",
        owner_email: "growth@example.com",
      },
      {
        id: "notion-exp-2",
        status: "paused",
        priority: null,
        sticky: false,
        cta_href: null,
      },
    ]);
  });
});
