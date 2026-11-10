import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteRunStore, resolveRuntimePaths } from "@ling-stack/core";
import { resolveConfig } from "../../../packages/daemon/dist/config.js";
import { RunStoreRegistry } from "../../../packages/daemon/dist/runtime/store-registry.js";
import { handleConversationAttachmentsCollection } from "../../../packages/daemon/dist/features/conversations/routes.js";
import { handleTeammateDirectAttachments } from "../../../packages/daemon/dist/features/teammates/private-attachments.js";
import { handleChannelAttachmentsCollection, handleChannelAttachmentItem } from "../../../packages/daemon/dist/features/channels/attachments.js";
import { mockDaemon, cwd } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate } from "./support/mock-state";

const evidenceDir = process.env.LING_P2_EVIDENCE_DIR ?? fileURLToPath(new URL("../../../.ling-stack/acceptance/p2-ux2-attachments-20261014/", import.meta.url));

for (const surface of ["normal", "channel", "private"] as const) {
  test(`${surface} source HTTP attachments keep independent outcomes and reconcile a lost delete receipt`, async ({ page }) => {
    const root = await mkdtemp(join(tmpdir(), "ling-native-attachments-"));
    const store = createSqliteRunStore(cwd, { ...resolveRuntimePaths(root), cwd });
    const config = resolveConfig({ host: "127.0.0.1", port: 0 });
    const registry = new RunStoreRegistry(workspace => { expect(workspace).toBe(cwd); return store; });
    const teammateId = "teammate_builtin_engineer";
    expect(store.getAiTeammate(teammateId)).toBeDefined();
    const channel = store.createChannel({ name: "Native Attachments", boundPath: cwd }, new Date().toISOString());
    const endpoint = surface === "normal" ? "/conversations/attachments"
      : surface === "channel" ? `/channels/${channel.id}/attachments` : `/teammates/${teammateId}/direct-attachments`;
    const server = createServer((request, response) => {
      const url = new URL(request.url!, "http://127.0.0.1");
      if (url.pathname === "/conversations/attachments") void handleConversationAttachmentsCollection(request, response, config, registry);
      else if (url.pathname === `/teammates/${teammateId}/direct-attachments`) void handleTeammateDirectAttachments(request, response, config, registry, teammateId);
      else if (url.pathname === `/channels/${channel.id}/attachments`) void handleChannelAttachmentsCollection(request, response, config, registry, channel.id);
      else if (url.pathname.startsWith("/attachments/")) void handleChannelAttachmentItem(request, response, config, registry, {
        attachmentId: url.pathname.split("/")[2], action: url.pathname.endsWith("/content") ? "content" : undefined,
      });
      else response.writeHead(404).end();
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error" && !/^Failed to load resource: the server responded with a status of (400|404|503)\b/.test(message.text())) errors.push(message.text());
    });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No native fixture port");
      const base = `http://127.0.0.1:${address.port}`;
      const state = createBaseState({ approvalStatus: "expired" });
      state.runs = []; state.tasks = []; state.approvals = []; state.threads = []; state.turns = [];
      state.channelMessages = []; state.teammateDirectMessages = [];
      state.channels = [channel];
      state.providers = [createChatProvider({ id: "native-attachment-provider", lastCheck: {
        ok: true, checkedAt: "2026-10-14T00:00:00.000Z", summary: "No model call",
      } })];
      state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Native Attachment Teammate", providerPresetId: state.providers[0].id })];
      state.workspaceSettings.defaultProviderPresetId = state.providers[0].id;
      await mockDaemon(page, state);
      const attempts: string[] = [];
      let deletes = 0;
      await page.route(url => url.pathname === endpoint || /^\/attachments\/[^/]+(?:\/content)?$/.test(url.pathname), async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() === "POST") attempts.push(request.postDataJSON().fileName);
        const response = await fetch(`${base}${url.pathname}${url.search}`, {
          method: request.method(), headers: { "Content-Type": "application/json" }, body: request.postData() || undefined,
        });
        if (request.method() === "DELETE" && ++deletes === 1) {
          expect(response.status).toBe(200);
          return route.fulfill({ status: 503, json: { message: "Native deletion succeeded but its receipt was lost" } });
        }
        await route.fulfill({ status: response.status, contentType: response.headers.get("content-type") || "application/json", body: await response.text() });
      });
      await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
      await page.goto("/");
      if (surface !== "normal") await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", {
        name: surface === "channel" ? "Native Attachments" : "Native Attachment Teammate", exact: true,
      }).click();
      const composer = page.getByLabel(surface === "normal" ? "New conversation composer" : surface === "channel" ? "Channel composer" : "Private chat composer", { exact: true });
      const content = "Native attachment bytes remain intact";
      await expect(composer.locator('input[type="file"]')).toBeEnabled();
      await composer.locator('input[type="file"]').setInputFiles([
        { name: "native-ready.txt", mimeType: "text/plain", buffer: Buffer.from(content) },
        { name: "native-empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
      ]);
      const ready = composer.locator(".composer-preview-card").filter({ hasText: "native-ready.txt" });
      const failed = composer.locator(".composer-preview-card").filter({ hasText: "native-empty.txt" });
      await expect(ready).toHaveClass(/ready/);
      await expect(failed).toHaveClass(/failed/);
      await expect(failed).toContainText("contentBase64 must be a non-empty string");
      await failed.getByRole("button", { name: "Retry upload" }).click();
      await expect(failed).toHaveClass(/failed/);
      expect(attempts.filter(name => name === "native-ready.txt")).toHaveLength(1);
      expect(attempts.filter(name => name === "native-empty.txt")).toHaveLength(2);
      const list = await (await fetch(`${base}${endpoint}?cwd=${encodeURIComponent(cwd)}`)).json();
      expect(list.attachments).toHaveLength(1);
      const contentResponse = await fetch(`${base}/attachments/${list.attachments[0].id}/content?cwd=${encodeURIComponent(cwd)}`);
      expect(contentResponse.status).toBe(200);
      expect(await contentResponse.text()).toBe(content);
      await mkdir(evidenceDir, { recursive: true });
      await page.screenshot({ path: `${evidenceDir}${surface}-native-http-mixed-uploads.png`, animations: "disabled" });
      await failed.getByRole("button", { name: "Remove pending attachment" }).click();
      await ready.getByRole("button", { name: "Remove pending attachment" }).click();
      const cleanup = composer.getByRole("alert").filter({ hasText: "Native deletion succeeded but its receipt was lost" });
      await expect(cleanup).toBeVisible();
      await cleanup.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(cleanup).toHaveCount(0);
      expect(deletes).toBe(2);
      const removed = await fetch(`${base}/attachments/${list.attachments[0].id}?cwd=${encodeURIComponent(cwd)}`);
      expect(removed.status).toBe(404);
      expect((await (await fetch(`${base}${endpoint}?cwd=${encodeURIComponent(cwd)}`)).json()).attachments).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
