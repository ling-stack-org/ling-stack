import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonTransportError, LingDaemonError } from "@ling-stack/api-client";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";

// R02: a lost accepted stream left a permanent composer error after Host recovery.
// Real packaged failure: output/e6-20260928/r02-dual-stream-transport-20261026/live-findings.md.
// Actual controllers and merge/error stores, synthetic API/SSE and deterministic hooks;
// these regressions do not replace packaged transport or execution evidence.
const cwd = "/isolated/r02";
const timestamp = "2026-10-26T00:00:00Z";
const thread = (id = "thread-r02", status = "running") => ({ id, workspaceId: "workspace-r02", kind: "conversation",
  title: id, objective: id, status, createdAt: timestamp, updatedAt: timestamp });
const message = (id, role, threadId = "thread-r02") => ({ id, role, threadId, turnId: `turn-${id}`,
  content: id, status: "completed", createdAt: timestamp, updatedAt: timestamp });
const ready = { thread: thread(), turn: { id: "turn-r02" }, userMessage: message("user-r02", "user"),
  assistantMessage: message("assistant-r02", "assistant"), runId: "run-r02" };
function detail(id = "thread-r02", status = "running", messages = [ready.userMessage, ready.assistantMessage]) {
  return { cwd, thread: { ...thread(id, status), updatedAt: status === "running" ? timestamp : "2026-10-26T00:00:01Z" }, turns: [], conversationItems: [], userInputs: [],
    supersessionTombstones: { turnIds: [], runIds: [], responseMessageIds: [] }, runLinks: [], runs: [],
    reasoningSummaries: [], executionActions: [], approvals: [], approvalCheckpoints: [], interventions: [],
    terminalReports: [], artifacts: [], messages, generatedMedia: [], defaults: {} };
}
async function fixture(t) {
  const port = catalogHookPort(), calls = [], failures = [];
  const journalCalls = [];
  let currentDetail = detail(), readFailure, readOverride, streamOverride, listFailure, pendingKey, receiptOverride;
  const apiNames = ["archiveLingThread", "getConversation", "getConversationSubmission", "listLingThreads", "streamConversation"];
  const api = Object.fromEntries(apiNames.map(name => [name, async (...args) => {
    calls.push({ name, args });
    if (name === "getConversation") {
      if (readOverride) return readOverride(...args);
      if (readFailure) throw readFailure;
      return currentDetail;
    }
    if (name === "listLingThreads") { if (listFailure) throw listFailure; return { threads: [currentDetail.thread] }; }
    if (name === "getConversationSubmission" && receiptOverride) return receiptOverride(...args);
    if (name === "streamConversation") return { ok: true, body: {} };
    throw new Error(`unexpected test IO ${name}`);
  }]));
  const hooksTransform = anchor => ({ anchor, replace: key =>
    `const ${anchor.slice(anchor.indexOf("{") , anchor.indexOf("}") + 1)} = globalThis[${JSON.stringify(key)}].ports.hooks;` });
  const h = await catalogConsumerHarness(t, {
    exports: { "domains/conversations/use-conversation-domain.ts": ["useConversationDomain"] },
    ports: { hooks: port.hooks, api,
      journal: { read: () => pendingKey, remember() {}, forget(...args) { journalCalls.push(args); pendingKey = undefined; } },
      readSseResponse: async (_response, receive) => {
        if (streamOverride) return streamOverride(receive);
        receive({ event: "ready", data: JSON.stringify(ready) });
        throw new TypeError("network error");
      } },
    transforms: {
      "domains/conversations/use-conversation-domain.ts": [
        hooksTransform('import { useCallback, useEffect, useRef, useState } from "react";'),
        { anchor: `import { ${apiNames.join(", ")} } from "../../api.js";`, replace: key =>
          `const { ${apiNames.join(", ")} } = globalThis[${JSON.stringify(key)}].ports.api;` },
        { anchor: 'import { readSseResponse } from "../../sse.js";', replace: key =>
          `const { readSseResponse } = globalThis[${JSON.stringify(key)}].ports;` },
        { anchor: 'import { submissionLookupJournal } from "../../shared/conversation/conversation-submission-journal.js";',
          replace: key => `const submissionLookupJournal = globalThis[${JSON.stringify(key)}].ports.journal;` },
      ],
      "domains/conversations/conversation-error-owner.ts": [hooksTransform('import { useCallback, useMemo, useRef, useState } from "react";')],
      "domains/conversations/use-conversation-stream-busy-owner.ts": [hooksTransform('import { useCallback, useEffect, useMemo, useRef, useState } from "react";')],
    },
  });
  let input = { cwd, translate: text => text };
  const render = () => port.render(h.module.useConversationDomain, input);
  render(); await port.flush();
  t.after(() => port.unmount());
  return { render, calls, failures, journalCalls, port,
    send: (handlers = {}) => render().actions.sendConversationMessage({ message: "R02 original" }, { onError: text => failures.push(text), ...handlers }),
    setDetail(value) { currentDetail = value; readFailure = undefined; readOverride = undefined; },
    failReads(error = new Error("offline")) { readFailure = error; },
    overrideRead(callback) { readOverride = callback; },
    setPendingKey(key) { pendingKey = key; },
    overrideReceipt(callback) { receiptOverride = callback; },
    overrideStream(callback) { streamOverride = callback; },
    failList(error = new Error("list offline")) { listFailure = error; },
    async observe(observation) { input = { ...input, observation }; render(); await port.flush(); },
    async switchCwd(next) { input = { ...input, cwd: next }; render(); await port.flush(); },
  };
}

test("a fresh Host snapshot recovers an accepted stream without a second send or false execution failure", async t => {
  const f = await fixture(t);
  await f.send();
  assert.equal(f.render().state.conversationComposerError, "");
  assert.deepEqual(f.failures, [], "transport loss is not an assistant failure");
  assert.equal(f.render().state.selectedConversationDetail.thread.status, "running");
  assert.equal(f.calls.filter(c => c.name === "streamConversation").length, 1);
});

test("offline errors persist until a fresh exact-source snapshot; Host failure remains a Host failure", async t => {
  const f = await fixture(t); f.failReads();
  await f.send();
  assert.equal(f.render().state.conversationComposerError, "network error");
  f.setDetail(detail("thread-r02", "failed", [ready.userMessage, { ...ready.assistantMessage, status: "failed", errorMessage: "command failed", updatedAt: "2026-10-26T00:00:01Z" }]));
  await f.render().actions.refreshSelectedConversation();
  assert.equal(f.render().state.conversationComposerError, "");
  assert.equal(f.render().state.selectedConversationDetail.thread.status, "failed");
  assert.equal(f.render().state.selectedConversationDetail.messages.find(m => m.role === "assistant").errorMessage, "command failed");
});

test("a successful but source-missing or foreign-workspace detail cannot clear the recovery error", async t => {
  const f = await fixture(t); f.failReads(); await f.send();
  for (const snapshot of [detail("thread-r02", "succeeded", []), { ...detail(), cwd: "/foreign" }]) {
    f.setDetail(snapshot); await f.render().actions.refreshSelectedConversation();
    assert.equal(f.render().state.conversationComposerError, "network error");
  }
  f.setDetail(detail("thread-r02", "succeeded")); await f.render().actions.refreshSelectedConversation();
  assert.equal(f.render().state.conversationComposerError, "");
});

test("selecting another thread does not clear Alpha's error, reopening Alpha can reconcile it", async t => {
  const f = await fixture(t); f.failReads(); await f.send();
  f.setDetail(detail("thread-beta", "succeeded", [message("user-beta", "user", "thread-beta")]));
  await f.render().actions.selectConversationThread("thread-beta");
  assert.equal(f.render().state.conversationComposerError, "");
  f.setDetail(detail("thread-r02", "succeeded"));
  await f.render().actions.selectConversationThread("thread-r02");
  assert.equal(f.render().state.conversationComposerError, "");
});

test("a read started before the failed accepted stream cannot clear its later recovery error", async t => {
  const f = await fixture(t); f.failReads(); await f.send();
  let resolveOld;
  f.overrideRead(() => new Promise(resolve => { resolveOld = resolve; }));
  const oldRead = f.render().actions.refreshSelectedConversation();
  await f.port.flush();
  f.failReads(); f.overrideRead(undefined);
  f.overrideStream(receive => { receive({ event: "ready", data: JSON.stringify({ ...ready, userMessage: message("user-second", "user") }) });
    throw new TypeError("second network error"); });
  await f.send();
  resolveOld(detail("thread-r02", "succeeded", [ready.userMessage, message("user-second", "user"), ready.assistantMessage])); await oldRead;
  assert.equal(f.render().state.conversationComposerError, "second network error");
});

test("workspace navigation fences a delayed recovery read and preserves the original scoped error", async t => {
  const f = await fixture(t); f.failReads(); await f.send();
  let resolveOld;
  f.overrideRead(() => new Promise(resolve => { resolveOld = resolve; }));
  const pending = f.render().actions.refreshSelectedConversation(); await f.port.flush();
  await f.switchCwd("/isolated/other"); resolveOld(detail()); await pending;
  assert.equal(f.render().state.selectedConversationDetail, undefined);
  assert.equal(f.render().state.conversationComposerError, "");
  await f.switchCwd(cwd);
  f.failReads(); f.overrideRead(undefined);
  await f.render().actions.selectConversationThread("thread-r02");
  assert.equal(f.render().state.conversationComposerError, "network error", "late old read did not erase scoped feedback");
});

test("control-plane strict list refresh rejects failure; existing non-strict callers retain owned error feedback", async t => {
  const f = await fixture(t); f.failList();
  await f.render().actions.refreshConversationThreads();
  assert.equal(f.render().state.conversationSidebarError, "list offline");
  await assert.rejects(f.render().actions.refreshConversationThreads(cwd, { throwOnError: true }), /list offline/);
  assert.equal(f.render().state.conversationThreadsLoading, false);
});

// Regression: R03-OBS — trusted Host stop must defer observation, not replay accepted input.
// Found by /qa on 2026-10-26
// Report: output/e6-20260928/r03-packaging-retry-20261026/live-findings.md
test("Host pause defers list/detail refresh without clearing canonical running or resending", async t => {
  const f = await fixture(t); await f.send();
  const snapshot = f.render().state.selectedConversationDetail;
  await f.observe({ paused: true, workspaceCwd: cwd, epoch: 2, baseUrl: "http://127.0.0.1:17928" });
  f.calls.length = 0;
  await f.render().actions.refreshConversationThreads();
  await f.render().actions.refreshSelectedConversation();
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.render().actions.refreshConversationThreads(cwd, { throwOnError: true }),
    { name: "DaemonObservationDeferredError" });
  assert.equal(f.render().state.selectedConversationDetail, snapshot);
  assert.equal(snapshot.thread.status, "running");
});

test("a read started before Host pause cannot publish a late success as current observation", async t => {
  const f = await fixture(t); await f.send();
  let resolve;
  f.overrideRead(() => new Promise(done => { resolve = done; }));
  const pending = f.render().actions.refreshSelectedConversation(); await f.port.flush();
  await f.observe({ paused: true, workspaceCwd: cwd, epoch: 2, baseUrl: "http://127.0.0.1:17928" });
  resolve(detail("thread-r02", "succeeded")); await pending;
  assert.equal(f.render().state.selectedConversationDetail.thread.status, "running");
});

test("pause does not hide an existing untyped business failure or affect another workspace", async t => {
  const f = await fixture(t); f.failList(); await f.render().actions.refreshConversationThreads();
  await f.observe({ paused: true, workspaceCwd: cwd, epoch: 2, baseUrl: "http://127.0.0.1:17928" });
  assert.equal(f.render().state.conversationSidebarError, "list offline");
  await f.observe({ paused: true, workspaceCwd: "/foreign", epoch: 3, baseUrl: "http://127.0.0.1:17928" });
  f.calls.length = 0; await f.render().actions.refreshConversationThreads();
  assert.equal(f.calls[0].name, "listLingThreads");
});

test("only typed observation errors coalesce under Host pause; HTTP business errors stay visible", async t => {
  const f = await fixture(t);
  f.failList(new LingDaemonTransportError("fetch", new TypeError("Failed to fetch")));
  await f.render().actions.refreshConversationThreads();
  assert.equal(f.render().state.conversationSidebarError, "Failed to fetch");
  await f.observe({ paused: true, workspaceCwd: cwd, epoch: 2, baseUrl: "http://127.0.0.1:17928" });
  assert.equal(f.render().state.conversationSidebarError, "");
  await f.observe({ paused: false, workspaceCwd: cwd, epoch: 3, baseUrl: "http://127.0.0.1:17928" });
  f.failList(new LingDaemonError("Failed to fetch", 403, "Forbidden", "workspace_denied"));
  await f.render().actions.refreshConversationThreads();
  await f.observe({ paused: true, workspaceCwd: cwd, epoch: 4, baseUrl: "http://127.0.0.1:17928" });
  assert.equal(f.render().state.conversationSidebarError, "Failed to fetch");
});

test("an accepted stream lost after pause performs no extra read or send and recovers its exact source later", async t => {
  const f = await fixture(t);
  let disconnect;
  f.overrideStream(receive => {
    receive({ event: "ready", data: JSON.stringify(ready) });
    return new Promise((_, reject) => { disconnect = reject; });
  });
  const sending = f.send(); await f.port.flush();
  await f.observe({ paused: true, workspaceCwd: cwd, epoch: 2, baseUrl: "http://127.0.0.1:17928" });
  const priorCalls = f.calls.length;
  disconnect(new LingDaemonTransportError("stream-read", new TypeError("stream lost")));
  await sending;
  assert.equal(f.calls.length, priorCalls);
  assert.equal(f.render().state.conversationComposerError, "");
  assert.deepEqual(f.failures, []);
  await f.observe({ paused: false, workspaceCwd: cwd, epoch: 3, baseUrl: "http://127.0.0.1:17928" });
  await f.render().actions.refreshSelectedConversation();
  assert.equal(f.render().state.conversationComposerError, "");
  assert.equal(f.calls.filter(call => call.name === "streamConversation").length, 1);
});

function acceptedReceipt(idempotencyKey) {
  return { status: "accepted", cwd, idempotencyKey, threadId: ready.thread.id, turnId: "turn-r02",
    sourceItemId: ready.userMessage.id, sourceItem: { kind: "user_message", id: ready.userMessage.id,
      threadId: ready.thread.id, turnId: "turn-r02" } };
}

test("a pending journal receipt cannot publish its late detail across Host pause", async t => {
  const f = await fixture(t);
  await f.render().actions.selectConversationThread(ready.thread.id);
  f.setPendingKey("pending-r03");
  f.overrideReceipt((_cwd, query) => acceptedReceipt(query.idempotencyKey));
  let resolve;
  f.overrideRead(() => new Promise(done => { resolve = done; }));
  const sending = f.send(); await f.port.flush();
  assert.equal(typeof resolve, "function");
  await f.observe({ paused: true, workspaceCwd: cwd, epoch: 2, baseUrl: "http://127.0.0.1:17928" });
  resolve(detail(ready.thread.id, "succeeded")); await sending;
  assert.equal(f.render().state.selectedConversationDetail.thread.status, "running", "late snapshot is not current observation");
  assert.equal(f.calls.filter(call => call.name === "streamConversation").length, 0, "pending input is not resent");
});

test("pending receipt retries perform no new GET after Host pause and keep the lookup journal", async t => {
  const f = await fixture(t);
  f.setPendingKey("pending-r03");
  f.overrideReceipt((_cwd, query) => ({ status: "unknown", cwd, idempotencyKey: query.idempotencyKey }));
  const sending = f.send(); await f.port.flush();
  assert.equal(f.calls.filter(call => call.name === "getConversationSubmission").length, 1);
  await f.observe({ paused: true, workspaceCwd: cwd, epoch: 2, baseUrl: "http://127.0.0.1:17928" });
  await sending;
  assert.equal(f.calls.filter(call => call.name === "getConversationSubmission").length, 1, "each retry rechecks observation admission");
  assert.equal(f.calls.filter(call => call.name === "streamConversation").length, 0);
  assert.equal(f.journalCalls.length, 0, "unknown input remains query-only after resume");
});

test("an unacknowledged send stops receipt retries at pause without forgetting or resending", async t => {
  const f = await fixture(t);
  f.overrideStream(() => { throw new LingDaemonTransportError("stream-read", new TypeError("stream lost")); });
  f.overrideReceipt((_cwd, query) => ({ status: "unknown", cwd, idempotencyKey: query.idempotencyKey }));
  const sending = f.send(); await f.port.flush();
  assert.equal(f.calls.filter(call => call.name === "getConversationSubmission").length, 1);
  await f.observe({ paused: true, workspaceCwd: cwd, epoch: 2, baseUrl: "http://127.0.0.1:17928" });
  await sending;
  assert.equal(f.calls.filter(call => call.name === "getConversationSubmission").length, 1);
  assert.equal(f.calls.filter(call => call.name === "streamConversation").length, 1);
  assert.equal(f.journalCalls.length, 0);
});

test("a receipt accepted after pause records acceptance without starting detail reads", async t => {
  const f = await fixture(t);
  await f.render().actions.selectConversationThread(ready.thread.id);
  f.overrideStream(() => { throw new LingDaemonTransportError("stream-read", new TypeError("stream lost")); });
  let resolve;
  f.overrideReceipt((_cwd, query) => new Promise(done => { resolve = () => done(acceptedReceipt(query.idempotencyKey)); }));
  const sending = f.send(); await f.port.flush();
  await f.port.flush();
  assert.equal(typeof resolve, "function");
  const readsBeforePause = f.calls.filter(call => call.name === "getConversation").length;
  await f.observe({ paused: true, workspaceCwd: cwd, epoch: 2, baseUrl: "http://127.0.0.1:17928" });
  f.setDetail(detail(ready.thread.id, "succeeded"));
  resolve(); await sending;
  assert.equal(f.render().state.selectedConversationDetail.thread.status, "running");
  assert.equal(f.calls.filter(call => call.name === "getConversation").length, readsBeforePause);
  assert.equal(f.calls.filter(call => call.name === "streamConversation").length, 1);
  assert.equal(f.journalCalls.length, 1, "real accepted receipt is retained even while observation is paused");
});

test("strict background refresh defers during a navigation read instead of certifying an unread snapshot", async t => {
  const f = await fixture(t);
  let resolve;
  f.overrideRead(() => new Promise(done => { resolve = done; }));
  const selection = f.render().actions.selectConversationThread(ready.thread.id); await f.port.flush();
  try {
    await assert.rejects(f.render().actions.refreshSelectedConversation(cwd, { throwOnError: true }),
      { name: "DaemonObservationDeferredError" });
  } finally {
    resolve(detail()); await selection;
  }
});

test("pause during receipt retry does not replace the original business error with Pending confirmation", async t => {
  const f = await fixture(t);
  f.overrideStream(() => { throw new LingDaemonError("workspace policy denied", 403, "Forbidden"); });
  f.overrideReceipt((_cwd, query) => ({ status: "unknown", cwd, idempotencyKey: query.idempotencyKey }));
  const sending = f.send(); await f.port.flush();
  await f.observe({ paused: true, workspaceCwd: cwd, epoch: 2, baseUrl: "http://127.0.0.1:17928" });
  await sending;
  assert.equal(f.render().state.conversationComposerError, "workspace policy denied");
  assert.equal(f.journalCalls.length, 0, "a paused lookup cannot certify rejection");
});

test("an old normal run_event cannot overwrite a fresh resumed conversation snapshot", async t => {
  const f = await fixture(t);
  let receive, finish;
  f.overrideStream(callback => {
    receive = callback;
    callback({ event: "ready", data: JSON.stringify(ready) });
    return new Promise(resolve => { finish = resolve; });
  });
  const sending = f.send(); await f.port.flush();
  try {
    await f.observe({ paused: true, workspaceCwd: cwd, epoch: 2, baseUrl: "http://127.0.0.1:17928" });
    await f.observe({ paused: false, workspaceCwd: cwd, epoch: 3, baseUrl: "http://127.0.0.1:17928" });
    const fresh = { ...ready.assistantMessage, content: "fresh-authoritative", updatedAt: "2026-10-26T00:00:02Z" };
    f.setDetail(detail(ready.thread.id, "succeeded", [ready.userMessage, fresh]));
    await f.render().actions.refreshSelectedConversation();
    assert.equal(f.render().state.selectedConversationDetail.messages.find(item => item.role === "assistant").content, fresh.content);
    receive({ event: "run_event", data: JSON.stringify({ threadId: ready.thread.id, turnId: ready.turn.id,
      runId: ready.runId, event: { type: "assistant_text_delta", data: { text: "old" } },
      assistantMessage: { ...ready.assistantMessage, content: "old-pre-pause-snapshot", status: "running" } }) });
    assert.equal(f.render().state.selectedConversationDetail.messages.find(item => item.role === "assistant").content,
      fresh.content, "stale stream projection cannot replace the resumed authoritative message");
  } finally {
    finish(); await sending;
  }
});

for (const crossObservationEpoch of [false, true]) test(`the accepted stream preserves done lifecycle ${crossObservationEpoch ? "across pause/resume without stale presentation" : "and live onDone presentation"}`, async t => {
  const f = await fixture(t), completed = [];
  let receive, finish;
  f.overrideStream(callback => {
    receive = callback;
    callback({ event: "ready", data: JSON.stringify(ready) });
    return new Promise(resolve => { finish = resolve; });
  });
  const sending = f.send({ onDone: event => completed.push(event) }); await f.port.flush();
  assert.equal(f.render().state.conversationStreamBusy, true);
  if (crossObservationEpoch) {
    await f.observe({ paused: true, workspaceCwd: cwd, epoch: 2, baseUrl: "http://127.0.0.1:17928" });
    await f.observe({ paused: false, workspaceCwd: cwd, epoch: 3, baseUrl: "http://127.0.0.1:17928" });
  }
  const done = { thread: { ...ready.thread, status: "succeeded" }, turn: ready.turn,
    run: { id: ready.runId, status: "succeeded" }, assistantMessage: { ...ready.assistantMessage, content: "real terminal answer" } };
  receive({ event: "done", data: JSON.stringify(done) });
  finish(); await sending;
  assert.equal(completed.length, crossObservationEpoch ? 0 : 1, "onDone is presentation; only the live epoch can upsert its snapshot");
  if (!crossObservationEpoch) assert.equal(completed[0].run.id, ready.runId);
  assert.equal(f.render().state.conversationStreamBusy, false);
  assert.equal(f.calls.filter(call => call.name === "streamConversation").length, 1);
  assert.ok(f.journalCalls.length > 0, "acceptance remains acknowledged");
  assert.deepEqual(f.failures, []);
});
