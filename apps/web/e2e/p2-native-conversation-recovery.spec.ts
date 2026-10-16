import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteRunStore, resolveRuntimePaths } from "@ling-stack/core";
import { resolveConfig } from "../../../packages/daemon/dist/config.js";
import { RunStoreRegistry } from "../../../packages/daemon/dist/runtime/store-registry.js";
import { createRunnerRegistry } from "../../../packages/daemon/dist/runtime/runners.js";
import { RuntimeSupervisor } from "../../../packages/daemon/dist/runtime/supervisor.js";
import { ChannelTurnDispatchWorkerRegistry } from "../../../packages/daemon/dist/features/channels/channel-turn-dispatch-worker.js";
import { appendChannelAssistantMessage } from "../../../packages/daemon/dist/features/channels/conversation-item-messages.js";
import { handleChannelItemsCollection, handleChannelTurnStream } from "../../../packages/daemon/dist/features/channels/messages.js";
import { handleConversationDetail, handleConversationStream } from "../../../packages/daemon/dist/features/conversations/routes.js";
import { handleConversationSubmissionReceipt } from "../../../packages/daemon/dist/features/conversations/submission-receipts.js";
import { handleLingThreadItem } from "../../../packages/daemon/dist/features/runs/thread-routes.js";
import { mockDaemon, cwd } from "./support/mock-daemon";
import { createBaseState, createChatProvider } from "./support/mock-state";

const evidenceDir = process.env.LING_P2_EVIDENCE_DIR ?? fileURLToPath(new URL("../../../.ling-stack/acceptance/p2-ux1-surfaces-20261014/", import.meta.url));

for (const surface of ["normal", "channel"] as const) {
for (const theme of ["light", "dark"] as const) {
test(`${surface} ${theme} source HTTP and SQLite recover a lost first confirmation without replay`, async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "ling-native-conversation-"));
  const store = createSqliteRunStore(cwd, { ...resolveRuntimePaths(root), cwd });
  const config = resolveConfig({ host: "127.0.0.1", port: 0 });
  const registry = new RunStoreRegistry(workspace => { expect(workspace).toBe(cwd); return store; });
  const supervisor = new RuntimeSupervisor(config);
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Controlled source fixture", status: "enabled",
    adapter: { runTask: async () => { throw new Error("This fixture must not call an external model"); } } }]);
  let dispatches = 0;
  const replyText = "Controlled native source reply, no external model";
  const worker = new ChannelTurnDispatchWorkerRegistry(supervisor, async input => {
    dispatches++;
    const aiReply = appendChannelAssistantMessage({ store, sourceItemId: input.sourceMessage.id,
      actorId: "ling_agent", body: replyText, now: new Date().toISOString() });
    input.observer.onReplyReady?.(aiReply);
    input.observer.onDone?.(aiReply);
    return { result: { aiReply } };
  });
  worker.start(store);
  const channel = store.createChannel({ name: "Native Channel", boundPath: cwd, autoReplyMode: "default_teammate", defaultTeammateId: "ling_agent" }, new Date().toISOString());
  const startRun: Parameters<typeof handleConversationStream>[5] = async (input, sink) => {
    dispatches++;
    const now = new Date().toISOString();
    const run = store.createRun({ id: "native-browser-run", cwd, taskId: input.task.id, threadId: input.threadId,
      turnId: input.turnId, teammateId: "ling_agent", providerName: "openai", providerModel: "controlled",
      taskSnapshot: input.task, providerSnapshot: { provider: "openai", model: "controlled" }, requestSnapshot: input, createdAt: now });
    store.transitionRunStatus({ runId: run.id, event: "runner_started", actor: "runner", now });
    const event = store.appendEvent(run.id, "message_end", { role: "assistant", text: replyText });
    sink.writeReady({ runId: run.id }); sink.writeEvent("message_end", event);
    store.transitionRunStatus({ runId: run.id, event: "runner_succeeded", actor: "runner", now });
    store.reconcileLingTurnStatus(input.turnId!, now);
    sink.end();
    return run.id;
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/conversations/stream") void handleConversationStream(request, response, config, registry, runners, startRun);
    else if (url.pathname === "/conversation-submissions") handleConversationSubmissionReceipt(response, url, registry);
    else if (url.pathname.startsWith("/threads/")) void handleLingThreadItem(request, response, url, registry,
      { kind: "proposed-plans", threadId: url.pathname.split("/")[2] });
    else if (url.pathname.startsWith("/conversations/")) handleConversationDetail(response, url, registry, url.pathname.split("/")[2]);
    else if (url.pathname.endsWith("/turns/stream")) void handleChannelTurnStream(request, response, config, registry, channel.id, undefined, worker);
    else void handleChannelItemsCollection(request, response, config, registry, channel.id);
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(`${message.text()} (${message.location().url})`); });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No native fixture port");
    const base = `http://127.0.0.1:${address.port}`;
    const state = createBaseState({ approvalStatus: "expired" });
    state.runs = []; state.tasks = []; state.approvals = []; state.threads = []; state.turns = []; state.channelMessages = [];
    state.channels = [channel];
    state.providers = [createChatProvider({ id: "controlled-native-provider", lastCheck: { ok: true, checkedAt: "2026-10-14T00:00:00.000Z", summary: "No model call" } })];
    await mockDaemon(page, state);
    await page.route(url => /^\/(conversation-submissions|conversations\/(?:stream|thread_[^/]+)|threads\/thread_[^/]+\/proposed-plans|channels\/[^/]+\/(?:turns\/stream|items))$/.test(url.pathname), async route => {
      const request = route.request(), url = new URL(request.url());
      const response = await fetch(`${base}${url.pathname}${url.search}`, { method: request.method(), headers: { "Content-Type": "application/json" }, body: request.postData() || undefined });
      await route.fulfill({ status: response.status, contentType: response.headers.get("content-type") || "application/json", body: await response.text() });
    });
    await page.addInitScript(theme => {
      localStorage.setItem("ling-stack.locale", "en-US");
      const selection = JSON.stringify({ themeId: `ling-${theme}`, mode: "fixed" });
      localStorage.setItem("ling-stack.themeSelection", selection);
      localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (!/\/(conversations|turns)\/stream(?:\?|$)/.test(String(args[0]))) return response;
        await response.text();
        return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("Native fixture lost confirmation")); } }), { status: response.status, headers: response.headers });
      };
    }, theme);
    await page.goto("/");
    if (surface === "channel") await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Native Channel", exact: true }).click();
    const input = page.getByLabel(surface === "normal" ? "New conversation composer" : "Channel composer", { exact: true }).getByRole("textbox");
    const body = `Native ${surface} accepted original input?`;
    await input.fill(body); await input.press("Enter");
    const feed = page.getByLabel(surface === "normal" ? "Conversation messages" : "Channel message feed", { exact: true });
    await expect(feed.getByText(body, { exact: true })).toHaveCount(1);
    await expect(feed).toContainText(replyText);
    await expect(input).toHaveAttribute("data-value", "");
    await expect(page.locator("body")).toHaveCSS("background-color", theme === "dark" ? "rgb(31, 31, 31)" : "rgb(255, 255, 255)");
    expect(dispatches).toBe(1);
    const thread = store.listLingThreads({ kind: surface === "normal" ? "conversation" : "channel_discussion", limit: 100 })[0];
    expect(store.listLingTurns({ threadId: thread.id, limit: 100 })).toHaveLength(1);
    expect(errors).toEqual([]);
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({ path: `${evidenceDir}${surface}-${theme}-native-http-recovery.png`, animations: "disabled" });
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await worker.close();
    supervisor.releaseAll();
    store.close(); await rm(root, { recursive: true, force: true });
  }
});
}
}
