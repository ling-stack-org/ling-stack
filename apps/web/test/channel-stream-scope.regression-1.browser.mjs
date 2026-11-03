import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { chromium } from "@playwright/test";

// Regression: C03-STREAM-SCOPE — topic SSE must not mutate the parent viewport.
// Found by /qa on 2026-10-25.
// Report: output/e6-20260928/p3-bash-cwd-contract-live-20261025/c03-scope-findings.md
// Actual React Hook + SSE reader/projections; only HTTP and unrelated refreshes
// are fixtures. This is not packaged GUI or real Provider acceptance.
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const controller = fileURLToPath(new URL("../src/app/use-channel-actions-controller.ts", import.meta.url));
const desktopRequire = createRequire(new URL("../../desktop/package.json", import.meta.url));
const { build } = desktopRequire("esbuild");
let browser, server, baseUrl;

before(async () => {
  const apiNames = ["createChannel", "createChannelContextSummary", "createChannelDecision", "createChannelHandoff",
    "createChannelLinkPreview", "createChannelWorkflowFromHandoff", "createTask", "deleteChannelAttachment",
    "streamChannelTurn", "getConversationSubmission", "updateChannel", "updateChannelBrief",
    "updateChannelCollaborationProtocol", "updateChannelDecision", "updateChannelHandoff", "uploadChannelAttachment",
    "revertChannelCollaborationProtocol"];
  const built = await build({
    stdin: { contents: harnessSource(), resolveDir: webRoot, sourcefile: "channel-stream-scope-fixture.tsx", loader: "tsx" },
    bundle: true, platform: "browser", format: "iife", jsx: "automatic", write: false, logLevel: "silent",
    define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "channel-stream-http-fixture", setup(plugin) {
      plugin.onResolve({ filter: /^\.\.\/api\.js$/ }, args => args.importer === controller
        ? { path: "fixture-api", namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: apiNames.map(name => `export const ${name} = (...args) => window.qa.http(${JSON.stringify(name)}, ...args);`).join("\n"),
        resolveDir: webRoot, loader: "js",
      }));
    } }],
  });
  server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<div id="root"></div><script>${built.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(process.env.LING_WEB_TEST_CHROMIUM_EXECUTABLE
    ? { headless: true, executablePath: process.env.LING_WEB_TEST_CHROMIUM_EXECUTABLE }
    : { headless: true, channel: "chrome" });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

const rootView = { cwd: "/fixture", selectedChannelId: "channel", selectedChannelMessageThreadId: undefined };
function envelope(threadId, surfaceKind = "topic") {
  const item = (id, kind, sequence, body) => ({ schemaVersion: 1, id, workspaceId: "workspace_default", channelId: "channel",
    threadId, turnId: `turn-${threadId}`, sequence, kind, actorType: kind === "user_message" ? "local_user" : "ling_agent",
    actorId: kind === "user_message" ? "local-user" : "ling-agent", status: "committed", visibility: "channel",
    revision: 1, domainRefs: [], createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z",
    payload: { body, format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } });
  return { thread: { id: threadId, surfaceKind, relationKind: surfaceKind === "channel_root" ? "root" : surfaceKind },
    turn: { id: `turn-${threadId}` }, userItem: item(`user-${threadId}`, "user_message", 1, "request"),
    assistantItems: [item(`reply-${threadId}`, "assistant_message", 2, "reply")], decorations: [] };
}

async function fixture(run) {
  const page = await browser.newPage();
  try {
    await page.goto(baseUrl);
    await page.evaluate(view => window.qa.mount(view), rootView);
    await run(page);
  } finally { await page.close(); }
}
async function send(page, threadId) {
  await page.evaluate(thread => window.qa.start(thread), threadId);
  assert.equal(await page.evaluate(() => window.qa.requestCount()), 1);
}
async function emit(page, event, data) {
  await page.evaluate(({ event, data }) => window.qa.emit(event, data), { event, data });
}
async function snapshot(page) { return page.evaluate(() => window.qa.snapshot()); }
const unchanged = { messages: ["existing"], items: ["existing-item"] };

test("topic ready/delta/linked/done acknowledge once without changing parent messages or items", () => fixture(async page => {
  await send(page, "topic");
  const data = envelope("topic");
  for (const [event, payload] of [["ready", data], ["delta", { itemId: "reply-topic", body: "streamed" }],
    ["run_linked", { itemId: "reply-topic", linkedRunId: "run-topic" }], ["done", data]]) {
    await emit(page, event, payload);
    assert.deepEqual((await snapshot(page)).projection, unchanged, event);
  }
  await page.evaluate(() => window.qa.finish());
  assert.equal((await snapshot(page)).accepted, 1);
  assert.equal((await snapshot(page)).error, "");
}));

for (const event of ["blocked", "error"]) {
  test(`topic ${event} preserves parent projection but reports the source submission failure`, () => fixture(async page => {
    await send(page, "topic");
    const data = envelope("topic");
    await emit(page, "ready", data);
    await emit(page, event, { ...data, error: "fixture rejection" });
    await page.evaluate(() => window.qa.finish());
    assert.deepEqual((await snapshot(page)).projection, unchanged);
    assert.equal((await snapshot(page)).accepted, 1);
    assert.equal((await snapshot(page)).result.errorMessage, "fixture rejection");
  }));
}

test("current channel-root and selected-branch streams still update both projections", () => fixture(async page => {
  for (const [threadId, surfaceKind, selected] of [["root", "channel_root", undefined], ["branch", "branch", "branch"]]) {
    await page.evaluate(view => window.qa.mount(view), { ...rootView, selectedChannelMessageThreadId: selected });
    await send(page, selected);
    await emit(page, "ready", envelope(threadId, surfaceKind));
    assert.deepEqual((await snapshot(page)).projection, {
      messages: ["existing", `user-${threadId}`, `reply-${threadId}`], items: ["existing-item", `user-${threadId}`, `reply-${threadId}`],
    });
    await emit(page, "delta", { itemId: `reply-${threadId}`, body: "streamed reply" });
    let state = await snapshot(page);
    assert.equal(state.records.messages.at(-1).body, "streamed reply");
    assert.equal(state.records.items.at(-1).payload.body, "streamed reply");
    await emit(page, "run_linked", { itemId: `reply-${threadId}`, linkedRunId: "fixture-run" });
    state = await snapshot(page);
    assert.equal(state.records.messages.at(-1).linkedRunId, "fixture-run");
    assert.ok(state.records.items.at(-1).domainRefs.some(ref => ref.type === "run" && ref.id === "fixture-run"));
    await emit(page, "done", envelope(threadId, surfaceKind));
    await page.evaluate(() => window.qa.finish());
    assert.equal((await snapshot(page)).accepted, 1);
  }
}));

for (const [name, nextView] of [["workspace", { cwd: "/another" }], ["channel", { selectedChannelId: "another" }],
  ["branch", { selectedChannelMessageThreadId: "branch" }]]) {
  test(`old ${name} stream cannot publish after switch or A-B-A return`, () => fixture(async page => {
    await send(page, undefined);
    await page.evaluate(view => window.qa.change(view), nextView);
    await page.evaluate(view => window.qa.change(view), rootView);
    for (const [event, data] of [["ready", envelope("root", "channel_root")], ["done", envelope("root", "channel_root")]]) {
      await emit(page, event, data);
      assert.deepEqual((await snapshot(page)).projection, unchanged);
    }
    await page.evaluate(() => window.qa.finish());
    assert.equal((await snapshot(page)).accepted, 1, "durable acceptance is not a viewport publication");
  }));
}

test("a switched stream cannot change already-visible bodies, run links or terminal records", () => fixture(async page => {
  await send(page, undefined);
  const data = envelope("root", "channel_root");
  await emit(page, "ready", data);
  const before = (await snapshot(page)).records;
  await page.evaluate(() => window.qa.change({ selectedChannelMessageThreadId: "branch" }));
  await page.evaluate(view => window.qa.change(view), rootView);
  const changed = { ...data, assistantItems: [{ ...data.assistantItems[0], revision: 2,
    payload: { ...data.assistantItems[0].payload, body: "late terminal" } }] };
  for (const [event, payload] of [["ready", changed], ["delta", { itemId: "reply-root", body: "late delta" }],
    ["run_linked", { itemId: "reply-root", linkedRunId: "late-run" }], ["done", changed],
    ["blocked", { ...changed, error: "late blocked" }], ["error", { ...changed, error: "late error" }]]) {
    await emit(page, event, payload);
    assert.deepEqual((await snapshot(page)).records, before, event);
  }
  await page.evaluate(() => window.qa.finish());
  assert.equal((await snapshot(page)).accepted, 1);
  assert.equal((await snapshot(page)).result.errorMessage, "late error");
}));

test("state updaters queued before navigation recheck the owner when React applies them", () => fixture(async page => {
  await send(page, undefined);
  await page.evaluate(() => window.qa.deferPublications());
  await emit(page, "ready", envelope("root", "channel_root"));
  assert.equal((await snapshot(page)).accepted, 1);
  assert.deepEqual((await snapshot(page)).projection, unchanged);
  await page.evaluate(() => window.qa.change({ selectedChannelMessageThreadId: "branch" }));
  await page.evaluate(view => window.qa.change(view), rootView);
  await page.evaluate(() => window.qa.releasePublications());
  assert.deepEqual((await snapshot(page)).projection, unchanged);
  await page.evaluate(() => window.qa.finish());
}));

function harnessSource() {
  return `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { flushSync } from "react-dom";
    import { useChannelActionsController } from ${JSON.stringify(controller)};
    let root, view, api, projection, records, active, pending, requests = 0, accepted = 0, result, error = "";
    let defer = false, publications = [];
    const tick = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
    const noop = async () => {};
    function Harness() {
      const [messages, setChannelMessages] = useState([{ id: "existing" }]);
      const [items, setChannelConversationItems] = useState([{ id: "existing-item", sequence: 0, revision: 1 }]);
      projection = { messages: messages.map(x => x.id), items: items.map(x => x.id) };
      records = { messages, items };
      api = useChannelActionsController({
        ...view, form: { cwd: view.cwd }, channels: [], providers: [], providerTemplates: [], channelDecisions: [],
        // Hold only updater application, then use the real React state setters.
        // This deterministically models deferred scheduling without a production seam.
        setChannelMessages(update) {
          if (defer) publications.push(() => setChannelMessages(update)); else setChannelMessages(update);
        },
        setChannelConversationItems(update) {
          if (defer) publications.push(() => setChannelConversationItems(update)); else setChannelConversationItems(update);
        },
        clearFeedback() {}, reportFeedback() {},
        refreshChannelMessages: noop, refreshChannelExecutionProposals: noop, refreshChannelIntentDecisions: noop,
        refreshChannelMessageRouteDecisions: noop, refreshChannelFiles: noop, refreshUsedMemoryAudit: noop,
        refreshChannelActivity: noop, refreshRuns: noop, refreshRuntimeState: noop,
      });
      return null;
    }
    window.qa = {
      mount(next) {
        flushSync(() => root?.unmount());
        view = { ...next }; requests = 0; accepted = 0; result = undefined; error = ""; defer = false; publications = [];
        root = createRoot(document.getElementById("root"));
        flushSync(() => root.render(<Harness />));
      },
      change(next) { view = { ...view, ...next }; flushSync(() => root.render(<Harness />)); },
      deferPublications() { defer = true; },
      releasePublications() {
        defer = false;
        flushSync(() => { for (const publish of publications.splice(0)) publish(); });
      },
      http(name) {
        if (name !== "streamChannelTurn") throw new Error("Unexpected HTTP: " + name);
        requests++;
        return new Response(new ReadableStream({ start(controller) { active = controller; } }), {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
      start(threadId) {
        pending = api.sendChannelMessage({ threadId, body: "request", mentions: [], attachmentIds: [],
          linkPreviewIds: [], fileRefs: [], requestAiReply: false, onMessageAccepted() { accepted++; } })
          .then(value => { result = value; }, caught => { error = String(caught); });
      },
      async emit(event, data) {
        active.enqueue(new TextEncoder().encode("event: " + event + "\\ndata: " + JSON.stringify(data) + "\\n\\n"));
        await tick();
      },
      async finish() { active.close(); await pending; await tick(); },
      requestCount: () => requests,
      snapshot: () => ({ projection, records, accepted, result, error }),
    };
  `;
}
