import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteRunStore, resolveRuntimePaths } from "@ling-stack/core";
import { resolveConfig } from "../../../packages/daemon/dist/config.js";
import { RunStoreRegistry } from "../../../packages/daemon/dist/runtime/store-registry.js";
import { handleTeammateDirectMessagesCollection, handleTeammateDirectMessageStream, handleTeammateDirectThread } from "../../../packages/daemon/dist/features/teammates/direct-messages.js";
import { mockDaemon, cwd } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate } from "./support/mock-state";

const teammateId = "teammate_builtin_engineer";
const evidenceDir = process.env.LING_P2_EVIDENCE_DIR ?? fileURLToPath(new URL("../../../.ling-stack/acceptance/p2-ux1-surfaces-20261014/", import.meta.url));

for (const theme of ["light", "dark"] as const) {
  test(`private ${theme} lost confirmation recovers through actual HTTP handlers and isolated SQLite`, async ({ page }) => {
    const root = await mkdtemp(join(tmpdir(), "ling-browser-input-"));
    // Keep the browser fixture's logical cwd; all physical storage stays in this owned temp directory.
    const store = createSqliteRunStore(cwd, { ...resolveRuntimePaths(root), cwd });
    let dispatches = 0;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    const config = resolveConfig({ host: "127.0.0.1", port: 0, maxBodyBytes: 1024 * 1024 });
    const registry = new RunStoreRegistry(workspace => { expect(workspace).toBe(cwd); return store; });
    const reply: Parameters<typeof handleTeammateDirectMessageStream>[5] = async input => {
      dispatches++;
      const message = store.createTeammateDirectMessage({ id: input.replyMessageId, threadId: input.thread.id,
        teammateId, authorType: "ai-teammate", authorId: teammateId, body: "Native receipt controlled reply", status: "ready" }, new Date().toISOString());
      input.stream?.onReady(message); input.stream?.onDone(message);
      return message;
    };
    const server = createServer((request, response) => {
      if (request.url?.split("?")[0].endsWith("/direct-thread")) {
        void handleTeammateDirectThread(request, response, config, registry, teammateId);
      } else {
        void (request.url?.split("?")[0].endsWith("/stream") ? handleTeammateDirectMessageStream : handleTeammateDirectMessagesCollection)(request, response, config, registry, teammateId, reply);
      }
    });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No isolated HTTP port");
      const base = `http://127.0.0.1:${address.port}`;
      const state = createBaseState({ approvalStatus: "expired" });
      state.runs = []; state.tasks = []; state.approvals = []; state.teammateDirectMessages = [];
      const provider = createChatProvider({ id: "native-receipt-provider", lastCheck: { ok: true,
        checkedAt: "2026-10-14T00:00:00.000Z", summary: "Controlled, no model call" } });
      state.providers = [provider];
      state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Native Recovery", providerPresetId: provider.id })];
      state.teammateDirectThreads[teammateId] = store.getOrCreateTeammateDirectThread(teammateId, new Date().toISOString());
      await mockDaemon(page, state);
      await page.route(new RegExp(`/teammates/${teammateId}/direct-`), async route => {
        const request = route.request();
        const original = new URL(request.url());
        if (!/\/direct-(thread|messages(?:\/stream)?)$/.test(original.pathname)) { await route.fallback(); return; }
        const result = await fetch(`${base}${original.pathname}${original.search}`, {
          method: request.method(), headers: { "Content-Type": "application/json" }, body: request.postData() || undefined,
        });
        await route.fulfill({ status: result.status, contentType: result.headers.get("content-type") || "application/json", body: await result.text() });
      });
      await page.addInitScript(theme => {
        localStorage.setItem("ling-stack.locale", "en-US");
        const selection = JSON.stringify({ themeId: `ling-${theme}`, mode: "fixed" });
        localStorage.setItem("ling-stack.themeSelection", selection);
        localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
        localStorage.setItem("ling-stack.themePreference", theme);
        localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          if (!String(args[0]).includes("/direct-messages/stream")) return response;
          await response.text();
          return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("Native fixture receiver lost all confirmation")); } }), {
            status: response.status, headers: response.headers,
          });
        };
      }, theme);
      await page.goto("/");
      await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Native Recovery", exact: true }).click();
      const input = page.getByLabel("Private chat composer", { exact: true }).getByRole("textbox");
      const body = "P2 source HTTP accepted input?";
      await input.fill(body); await input.press("Enter");
      await expect.poll(() => dispatches).toBe(1);
      const feed = page.getByLabel("Private message feed", { exact: true });
      await expect(feed.getByText(body, { exact: true })).toHaveCount(1);
      await expect(feed).toContainText("Native receipt controlled reply");
      await expect(input).toHaveAttribute("data-value", "");
      await expect(page.locator("body")).toHaveCSS("background-color", theme === "dark" ? "rgb(31, 31, 31)" : "rgb(255, 255, 255)");
      expect(dispatches).toBe(1);
      expect(store.listTeammateDirectMessages({ teammateId })).toHaveLength(2);
      expect(errors).toEqual([]);
      await mkdir(evidenceDir, { recursive: true });
      await page.screenshot({ path: `${evidenceDir}private-${theme}-native-http-recovery.png`, animations: "disabled" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close(); await rm(root, { recursive: true, force: true });
    }
  });
}
