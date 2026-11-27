import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryConfigStore as createCoreMemoryConfigStore,
  parsePreviewParams,
  verifyPreviewToken,
} from "@facet/core";
import { describe, expect, it } from "vitest";
import { createFileConfigStore } from "../src/server/file-store.js";
import { createStudioHandler } from "../src/server/handler.js";
import { createMemoryConfigStore } from "../src/server/store.js";
import { DEFAULT_STARTER_YAML } from "../src/shared/defaults.js";
import type {
  StudioImportCsvResponse,
  StudioPreviewLinkResponse,
  StudioPublishResponse,
  StudioRollbackResponse,
  StudioStateResponse,
  StudioValidateResponse,
} from "../src/shared/types.js";

function jsonReq(
  path: string,
  method: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  return new Request(`http://studio.local${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("Studio Web Standard API Server", () => {
  describe("Fail-closed authentication", () => {
    it("returns 401 when requireAuth is true and no authenticate callback is supplied", async () => {
      const handler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
        requireAuth: true,
      });

      const res = await handler(new Request("http://studio.local/api/state"));
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    });

    it("returns 401 when authenticate returns false or throws", async () => {
      const denyHandler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
        requireAuth: true,
        authenticate: () => false,
      });
      expect((await denyHandler(new Request("http://studio.local/api/state"))).status).toBe(401);

      const throwHandler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
        requireAuth: true,
        authenticate: () => {
          throw new Error("Identity provider unreachable");
        },
      });
      expect((await throwHandler(new Request("http://studio.local/api/state"))).status).toBe(401);
    });

    it("authorizes user identity and uses it as default publish author", async () => {
      const store = createMemoryConfigStore(DEFAULT_STARTER_YAML);
      const handler = createStudioHandler({
        store,
        requireAuth: true,
        authenticate: (req) => {
          const email = req.headers.get("cf-access-authenticated-user-email");
          return email ? { user: email } : false;
        },
      });

      const unauthRes = await handler(new Request("http://studio.local/api/state"));
      expect(unauthRes.status).toBe(401);

      const stateRes = await handler(
        new Request("http://studio.local/api/state", {
          headers: { "cf-access-authenticated-user-email": "maya@company.com" },
        }),
      );
      expect(stateRes.status).toBe(200);
      const state = (await stateRes.json()) as StudioStateResponse;
      expect(state.capabilities.user).toBe("maya@company.com");
      expect(state.capabilities.authRequired).toBe(true);
      expect(state.capabilities.isDemoMode).toBe(false);
      expect(state.capabilities.storageLabel).toBe("Custom store");
      expect(state.capabilities.canLivePreview).toBe(true);

      const pubRes = await handler(
        jsonReq(
          "/api/publish",
          "POST",
          { yaml: DEFAULT_STARTER_YAML, note: "SSO publish" },
          { "cf-access-authenticated-user-email": "maya@company.com" },
        ),
      );
      expect(pubRes.status).toBe(200);
      const pubData = (await pubRes.json()) as StudioPublishResponse;
      expect(pubData.snapshot?.author).toBe("maya@company.com");
      expect(pubData.snapshot?.note).toBe("SSO publish");
    });
  });

  describe("Validation, draft, publish, and rollback lifecycle", () => {
    it("validates YAML schema and template syntax via @facet/core", async () => {
      const handler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
      });

      const okRes = await handler(jsonReq("/api/validate", "POST", { yaml: DEFAULT_STARTER_YAML }));
      expect(okRes.status).toBe(200);
      const okData = (await okRes.json()) as StudioValidateResponse;
      expect(okData.ok).toBe(true);
      expect(okData.config?.experiences.length).toBe(2);

      // Invalid template syntax
      const badTemplateYaml = DEFAULT_STARTER_YAML.replace("{{params.acct}}", "{{params.acct");
      const badTplRes = await handler(jsonReq("/api/validate", "POST", { yaml: badTemplateYaml }));
      expect(badTplRes.status).toBe(400);
      const badTplData = (await badTplRes.json()) as StudioValidateResponse;
      expect(badTplData.ok).toBe(false);
      expect(badTplData.errors.some((e) => e.code === "invalid_template_syntax")).toBe(true);

      // Invalid schema (missing version)
      const badSchemaRes = await handler(
        jsonReq("/api/validate", "POST", { yaml: "experiences: []\n" }),
      );
      expect(badSchemaRes.status).toBe(400);
      const badSchemaData = (await badSchemaRes.json()) as StudioValidateResponse;
      expect(badSchemaData.ok).toBe(false);
      expect(badSchemaData.errors.length).toBeGreaterThan(0);
    });

    it("saves drafts, publishes snapshots, and rolls back in one click", async () => {
      const store = createMemoryConfigStore(DEFAULT_STARTER_YAML);
      const handler = createStudioHandler({ store });

      const initialState = (await (
        await handler(new Request("http://studio.local/api/state"))
      ).json()) as StudioStateResponse;
      const initialSnapId = initialState.live?.id;
      expect(initialSnapId).toBeTruthy();

      // Reject invalid draft
      const badDraft = await handler(jsonReq("/api/draft", "POST", { yaml: "version: 99\n" }));
      expect(badDraft.status).toBe(400);

      // Save valid draft
      const updatedYaml = DEFAULT_STARTER_YAML.replace(
        "Fintech Paid Search",
        "Fintech Paid Search v2",
      );
      const draftRes = await handler(jsonReq("/api/draft", "POST", { yaml: updatedYaml }));
      expect(draftRes.status).toBe(200);

      const midState = (await (
        await handler(new Request("http://studio.local/api/state"))
      ).json()) as StudioStateResponse;
      expect(midState.draft).toBe(updatedYaml);
      expect(midState.live?.yaml).toBe(DEFAULT_STARTER_YAML);

      // Publish updated config
      const pubRes = await handler(
        jsonReq("/api/publish", "POST", {
          yaml: updatedYaml,
          author: "growth-lead",
          note: "Updated campaign title",
        }),
      );
      expect(pubRes.status).toBe(200);
      const pubData = (await pubRes.json()) as StudioPublishResponse;
      expect(pubData.ok).toBe(true);
      expect(pubData.snapshot?.note).toBe("Updated campaign title");

      // Draft cleared after publish
      const afterPubState = (await (
        await handler(new Request("http://studio.local/api/state"))
      ).json()) as StudioStateResponse;
      expect(afterPubState.draft).toBeNull();
      expect(afterPubState.snapshots.length).toBe(2);

      // Rollback to initial snapshot
      const rbRes = await handler(
        jsonReq("/api/rollback", "POST", {
          snapshotId: initialSnapId,
          author: "ops",
        }),
      );
      expect(rbRes.status).toBe(200);
      const rbData = (await rbRes.json()) as StudioRollbackResponse;
      expect(rbData.ok).toBe(true);
      expect(rbData.snapshot?.yaml).toBe(DEFAULT_STARTER_YAML);
      expect(rbData.snapshot?.id).not.toBe(initialSnapId);

      // Unknown snapshot returns 404
      const missingRb = await handler(
        jsonReq("/api/rollback", "POST", { snapshotId: "snap_does_not_exist" }),
      );
      expect(missingRb.status).toBe(404);
    });

    it("works seamlessly with @facet/core createMemoryConfigStore", async () => {
      const coreStore = createCoreMemoryConfigStore(DEFAULT_STARTER_YAML);
      const handler = createStudioHandler({ store: coreStore });

      const stateRes = await handler(new Request("http://studio.local/api/state"));
      expect(stateRes.status).toBe(200);
      const state = (await stateRes.json()) as StudioStateResponse;
      expect(state.live?.experienceCount).toBe(2);
      expect(state.config?.experiences.length).toBe(2);
    });
  });

  describe("HMAC-SHA256 Signed Preview Links", () => {
    it("generates a verifiable HMAC-SHA256 preview URL and never leaks the secret", async () => {
      const secret = "super-secret-signing-key-2026";
      const handler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
        targetUrl: "https://marketing.example.com",
        previewSecret: secret,
      });

      const stateText = await (await handler(new Request("http://studio.local/api/state"))).text();
      expect(stateText).not.toContain(secret);

      const res = await handler(
        jsonReq("/api/preview-link", "POST", {
          experienceId: "fintech-paid-search",
          bucket: "control",
          ttlSeconds: 3600,
        }),
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as StudioPreviewLinkResponse;
      expect(data.ok).toBe(true);
      expect(data.url).toBeTruthy();

      const parsed = parsePreviewParams(data.url!);
      expect(parsed?.experienceId).toBe("fintech-paid-search");
      expect(parsed?.bucket).toBe("control");
      expect(parsed?.signature).toBeTruthy();

      const verified = await verifyPreviewToken({
        experienceId: parsed!.experienceId!,
        token: parsed!.signature!,
        bucket: parsed!.bucket,
        secret,
      });
      expect(verified.valid).toBe(true);
    });

    it("rejects preview-link requests when secret is missing or baseUrl is unsafe", async () => {
      const noSecretHandler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
        targetUrl: "https://marketing.example.com",
      });
      const res1 = await noSecretHandler(
        jsonReq("/api/preview-link", "POST", { experienceId: "fintech-paid-search" }),
      );
      expect(res1.status).toBe(400);

      const secretHandler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
        previewSecret: "secret-123",
      });
      const res2 = await secretHandler(
        jsonReq("/api/preview-link", "POST", {
          experienceId: "fintech-paid-search",
          baseUrl: "javascript:alert(1)",
        }),
      );
      expect(res2.status).toBe(400);
    });
  });

  describe("CSV Account Table Import", () => {
    it("parses CSV via @facet/core and merges into config.data[tableName]", async () => {
      const handler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
      });

      const csv = [
        "slug,name,team,headline",
        'northstar,Northstar Labs,security,"Zero-flicker edge routing for Northstar Labs"',
        'solstice,Solstice Pay,payments,"PCI-ready edge pages for Solstice Pay"',
      ].join("\n");

      const res = await handler(
        jsonReq("/api/import-csv", "POST", {
          csv,
          tableName: "accounts",
          keyColumn: "slug",
          mergeMode: "merge",
        }),
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as StudioImportCsvResponse;
      expect(data.ok).toBe(true);
      expect(data.tableName).toBe("accounts");
      expect(data.rowCount).toBe(4); // 2 existing + 2 new
      expect(data.table?.["northstar"]?.["name"]).toBe("Northstar Labs");
      expect(data.table?.["meridian"]?.["name"]).toBe("Meridian Cloud");
      expect(data.yaml).toContain("northstar:");

      // Replace mode overwrites table
      const replaceRes = await handler(
        jsonReq("/api/import-csv", "POST", {
          csv,
          tableName: "accounts",
          keyColumn: "slug",
          mergeMode: "replace",
        }),
      );
      expect(replaceRes.status).toBe(200);
      const replaceData = (await replaceRes.json()) as StudioImportCsvResponse;
      expect(replaceData.rowCount).toBe(2);
      expect(replaceData.table?.["meridian"]).toBeUndefined();
    });

    it("blocks prototype-pollution table and column names", async () => {
      const handler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
      });

      const res = await handler(
        jsonReq("/api/import-csv", "POST", {
          csv: "slug,name\nacme,Acme",
          tableName: "__proto__",
          keyColumn: "slug",
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("Static assets & security headers", () => {
    it("serves UI assets, applies SPA fallback, and blocks traversal", async () => {
      const handler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
        assets: async (pathname) => {
          if (pathname === "/index.html") {
            return { body: "<!doctype html><div id='root'></div>", contentType: "text/html" };
          }
          return null;
        },
      });

      const rootRes = await handler(new Request("http://studio.local/"));
      expect(rootRes.status).toBe(200);
      expect(rootRes.headers.get("x-frame-options")).toBe("DENY");
      expect(rootRes.headers.get("x-content-type-options")).toBe("nosniff");

      const spaRes = await handler(new Request("http://studio.local/campaigns"));
      expect(spaRes.status).toBe(200);

      const traversalRes = await handler(new Request("http://studio.local/assets/%2e%2e%5csecret"));
      expect(traversalRes.status).toBe(400);
    });

    it("returns 400 on malformed snapshot percent-encoding and omits unsafe targetUrl", async () => {
      const handler = createStudioHandler({
        store: createMemoryConfigStore(DEFAULT_STARTER_YAML),
        targetUrl: "javascript:alert(1)",
      });

      const badSnapRes = await handler(new Request("http://studio.local/api/snapshots/%E0%A4%A"));
      expect(badSnapRes.status).toBe(400);

      const stateRes = await handler(new Request("http://studio.local/api/state"));
      expect(stateRes.status).toBe(200);
      const state = (await stateRes.json()) as StudioStateResponse;
      expect(state.capabilities.targetUrl).toBeNull();
    });
  });

  describe("FileConfigStore", () => {
    it("persists live YAML, drafts, snapshots, and rollbacks on disk", async () => {
      const dir = await mkdtemp(join(tmpdir(), "facet-studio-test-"));
      try {
        const configPath = join(dir, "facet.yaml");
        const store = createFileConfigStore(configPath);

        const pub1 = await store.publish(DEFAULT_STARTER_YAML, {
          author: "tester",
          note: "First publish",
        });
        expect(pub1.ok).toBe(true);

        const onDisk = await readFile(configPath, "utf8");
        expect(onDisk).toBe(DEFAULT_STARTER_YAML);

        const v2 = DEFAULT_STARTER_YAML.replace("Fintech Paid Search", "Fintech Paid Search v2");
        const draftRes = await store.saveDraft(v2);
        expect(draftRes.ok).toBe(true);
        expect(await store.getDraft()).toBe(v2);

        const pub2 = await store.publish(v2, { note: "Second publish" });
        expect(pub2.ok).toBe(true);
        expect(await store.getDraft()).toBeNull();

        const list = await store.listSnapshots();
        expect(list.length).toBe(2);

        if (pub1.ok) {
          const rb = await store.rollback(pub1.snapshot.id);
          expect(rb.ok).toBe(true);
          expect(await readFile(configPath, "utf8")).toBe(DEFAULT_STARTER_YAML);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
