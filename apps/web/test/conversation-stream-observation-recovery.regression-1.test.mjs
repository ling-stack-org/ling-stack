import assert from "node:assert/strict";
import test from "node:test";
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
  let currentDetail = detail(), readFailure, readOverride, streamOverride, listFailure;
  const apiNames = ["archiveLingThread", "getConversation", "getConversationSubmission", "listLingThreads", "streamConversation"];
  const api = Object.fromEntries(apiNames.map(name => [name, async (...args) => {
    calls.push({ name, args });
    if (name === "getConversation") {
      if (readOverride) return readOverride(...args);
      if (readFailure) throw readFailure;
      return currentDetail;
    }
    if (name === "listLingThreads") { if (listFailure) throw listFailure; return { threads: [currentDetail.thread] }; }
    if (name === "streamConversation") return { ok: true, body: {} };
    throw new Error(`unexpected test IO ${name}`);
  }]));
  const hooksTransform = anchor => ({ anchor, replace: key =>
    `const ${anchor.slice(anchor.indexOf("{") , anchor.indexOf("}") + 1)} = globalThis[${JSON.stringify(key)}].ports.hooks;` });
  const h = await catalogConsumerHarness(t, {
    exports: { "domains/conversations/use-conversation-domain.ts": ["useConversationDomain"] },
    ports: { hooks: port.hooks, api,
      journal: { read: () => undefined, remember() {}, forget() {} },
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
  return { render, calls, failures, port,
    send: () => render().actions.sendConversationMessage({ message: "R02 original" }, { onError: text => failures.push(text) }),
    setDetail(value) { currentDetail = value; readFailure = undefined; readOverride = undefined; },
    failReads() { readFailure = new Error("offline"); },
    overrideRead(callback) { readOverride = callback; },
    overrideStream(callback) { streamOverride = callback; },
    failList() { listFailure = new Error("list offline"); },
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
