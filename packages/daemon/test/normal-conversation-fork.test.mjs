import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createSqliteRunStore, resolveRuntimePaths } from "@ling-stack/core";
import { restorePreparedInlineProvider } from "../dist/features/conversations/normal-conversation-prepared-provider.js";
import { userInputTranscriptFixture, now as transcriptNow } from "../../core/test/support/user-input-transcript-fixture.mjs";
import { handleLingThreadItem } from "../dist/features/runs/thread-routes.js";
import { prepareNormalConversationInput } from "../dist/features/conversations/normal-conversation-input.js";
import { readNormalConversationContext } from "../dist/features/conversations/normal-conversation-context.js";

const at = n => new Date(Date.UTC(2026, 8, 1, 0, n)).toISOString();
const payload = body => ({ body, format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] });
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-n03-fork-test-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  f.database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => { f.database.close(); f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  f.thread = f.store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "Parent", objective: "Frozen branch" }, at(0));
  return f;
}
function completedTurn(f, n, { thread = f.thread, text = `ANSWER_${n}`, request = {}, canonical = false, role = "narration", canonicalText = text, preset = "fixture" } = {}) {
  const input = f.store.appendConversationUserTurn({ threadId: thread.id, title: `Turn ${n}`, userInstruction: `USER_${n}`,
    payload: payload(`USER_${n}`), idempotencyKey: `user-${n}` }, at(n));
  const run = f.store.createRun({ id: `run-${n}`, cwd: f.cwd, taskId: `task-${n}`, threadId: thread.id, turnId: input.turnId,
    teammateId: "ling_agent", providerName: "openai", providerModel: "fixture", providerPresetId: preset,
    taskSnapshot: { id: `task-${n}`, title: `Turn ${n}`, prompt: `USER_${n}` }, providerSnapshot: {},
    requestSnapshot: { providerPresetId: preset, tools: ["read"], ...request }, createdAt: at(n) });
  f.store.appendEvent(run.id, "tool_end", { toolName: "read", result: "NOT_NARRATION" });
  f.store.appendEvent(run.id, "message_end", { role: "assistant", text });
  if (canonical) f.store.appendConversationItem({ id: `answer-${n}`, threadId: thread.id, turnId: input.turnId,
    kind: "assistant_message", actorType: "ling_agent", actorId: "ling_agent", visibility: "thread_participants",
    payload: { body: canonicalText, format: "markdown", streaming: false, deliveryStatus: "ready", presentationRole: role },
    domainRefs: [{ type: "run", id: run.id }] }, at(n));
  assert.equal(f.store.transitionRunStatus({ runId: run.id, event: "runner_started", actor: "runner", now: at(n) }).ok, true);
  assert.equal(f.store.transitionRunStatus({ runId: run.id, event: "runner_succeeded", actor: "runner", now: at(n) }).ok, true);
  if (f.store.getLingTurn(input.turnId).status !== "succeeded") f.store.transitionLingTurnStatus({ turnId: input.turnId, event: "succeed", actor: "system", now: at(n) });
  return { ...input, run: f.store.getRun(run.id) };
}
class Response extends EventEmitter {
  statusCode = 200; body = "";
  writeHead(status) { this.statusCode = status; } setHeader() {} end(chunk = "") { this.body += chunk; }
}
async function route(f, kind, body, start = async () => "unused") {
  const request = Readable.from([JSON.stringify(body)]); request.method = "POST"; request.headers = {};
  const response = new Response();
  await handleLingThreadItem(request, response, new URL(`http://fixture/threads/fork?cwd=${encodeURIComponent(f.cwd)}`),
    { getStore: () => f.store }, { kind, threadId: f.thread.id }, { maxBodyBytes: 100_000, startForkRun: start });
  return { status: response.statusCode, body: JSON.parse(response.body) };
}
function accept(f, thread, key = "next") {
  return prepareNormalConversationInput({ store: f.store, thread, title: "Child", message: `CHILD_${key}`, attachmentIds: [],
    fileRefs: [], idempotencyKey: key, now: at(50) });
}
test("fork-only freezes the selected answer, then gives a later child input its own accepted scope", async t => {
  const f = await fixture(t); completedTurn(f, 1, { canonical: true }); const source = completedTurn(f, 2);
  const first = await route(f, "fork", { turnId: source.turnId, idempotencyKey: "fork-only" });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const child = first.body.childThread;
  assert.ok(child.forkContextSnapshotId, "normal fork must persist a frozen seed");
  f.store.appendEvent(source.run.id, "message_end", { role: "assistant", text: "LATE_PARENT" });
  completedTurn(f, 3);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  const next = accept(f, child), context = next.context;
  assert.equal(context.projection.threadId, child.id);
  assert.equal(context.hydration.source.itemId, next.turn.sourceItemId);
  assert.notEqual(context.hydration.source.itemId, source.item.id);
  assert.equal(f.store.getConversationAcceptedInputSnapshot(next.turn.sourceItemId).threadId, child.id);
  for (const text of ["USER_1", "ANSWER_1", "USER_2", "ANSWER_2"]) assert.equal(context.renderedHistory.split(text).length - 1, 1, text);
  for (const text of ["LATE_PARENT", "USER_3", "NOT_NARRATION", "CHILD_next"]) assert.equal(context.renderedHistory.includes(text), false, text);
  assert.equal(context.forkHistory.seedId, child.forkContextSnapshotId);
  assert.equal(context.forkHistory.groups.every(group => group.threadId === f.thread.id), true);
  assert.deepEqual(readNormalConversationContext(JSON.parse(JSON.stringify(context))), context);
});
test("omitted fork anchor is stable across newer parent turns and archive; explicit drift conflicts", async t => {
  const f = await fixture(t), source = completedTurn(f, 1);
  const first = await route(f, "fork", { idempotencyKey: "stable" });
  assert.equal(first.status, 201);
  const later = completedTurn(f, 2);
  f.store.updateLingThread(f.thread.id, { status: "archived", archivedAt: at(20) }, at(20));
  const retry = await route(f, "fork", { idempotencyKey: "stable" });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.childThread.id, first.body.childThread.id);
  assert.equal(retry.body.childThread.parentTurnId, source.turnId);
  assert.equal((await route(f, "fork", { idempotencyKey: "stable", turnId: later.turnId })).status, 409);
});
test("normal fork-run no-Run replay reuses the child prepared request after reopen and parent drift", async t => {
  const f = await fixture(t); completedTurn(f, 1);
  let first;
  const failed = await route(f, "fork-run", { idempotencyKey: "dispatch", instruction: "CHILD_TASK" }, async request => { first = request; throw new Error("STOP_BEFORE_RUN"); });
  assert.equal(failed.status, 500);
  assert.ok(first?.normalConversationPreparedRequestRef);
  assert.ok(first.normalConversationAcceptedSnapshotId);
  assert.equal(first.threadId, failed.body.childThread.id);
  assert.ok(first.task.prompt.includes("ANSWER_1"));
  assert.equal(first.task.prompt.split("CHILD_TASK").length - 1, 1);
  completedTurn(f, 2, { request: { tools: ["bash"] } });
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  let replay;
  const result = await route(f, "fork-run", { idempotencyKey: "dispatch", instruction: "CHILD_TASK", providerPresetId: "changed" }, async request => { replay = request; return "unused"; });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.deepEqual(replay, first);
  assert.equal(f.store.listLingTurns({ threadId: first.threadId }).length, 1);
  assert.equal((await route(f, "fork-run", { idempotencyKey: "dispatch", instruction: "CHANGED" }, () => assert.fail("must reject"))).status, 409);
});
test("nested fork preserves ancestor groups without relabelling or duplicating messages", async t => {
  const f = await fixture(t); completedTurn(f, 1);
  const first = await route(f, "fork", { idempotencyKey: "first" });
  const child = first.body.childThread; completedTurn(f, 2, { thread: child });
  f.thread = child;
  const second = await route(f, "fork", { idempotencyKey: "second" });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const context = accept(f, second.body.childThread).context;
  for (const text of ["USER_1", "ANSWER_1", "USER_2", "ANSWER_2"]) assert.equal(context.renderedHistory.split(text).length - 1, 1);
  assert.equal(new Set(context.forkHistory.groups.map(group => group.threadId)).size, 2);
});
test("an oversized selected answer refuses fork atomically rather than silently cutting Markdown", async t => {
  const f = await fixture(t); completedTurn(f, 1, { text: "```js\n" + "x".repeat(33_000) + "\n```" });
  const result = await route(f, "fork", { idempotencyKey: "oversized" });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(f.store.listLingThreads({ kind: "conversation" }).length, 1);
});
test("terminal report text never substitutes for selected agent narration", async t => {
  const f = await fixture(t); completedTurn(f, 1, { canonical: true, role: "execution_summary", text: "REAL_NARRATION", canonicalText: "REPORT_ONLY" });
  const result = await route(f, "fork", { idempotencyKey: "report" });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const context = accept(f, result.body.childThread).context;
  assert.ok(context.renderedHistory.includes("REAL_NARRATION"));
  assert.equal(context.renderedHistory.includes("REPORT_ONLY"), false);
});
test("prior execution summaries are neither repeated nor allowed to suppress real run narration", async t => {
  const f = await fixture(t);
  completedTurn(f, 1, { canonical: true, role: "execution_summary", canonicalText: "OLD_REPORT" });
  completedTurn(f, 2);
  const result = await route(f, "fork", { idempotencyKey: "old-report" });
  assert.equal(result.status, 201);
  const context = accept(f, result.body.childThread).context;
  assert.equal(context.renderedHistory.includes("OLD_REPORT"), false);
  assert.ok(context.renderedHistory.includes("ANSWER_1"));
});
test("hidden canonical narration refuses fork and cannot fall back to its visible run events", async t => {
  const f = await fixture(t); completedTurn(f, 1, { canonical: true });
  f.database.prepare("UPDATE conversation_items SET visibility='operator' WHERE id='answer-1'").run();
  const result = await route(f, "fork", { idempotencyKey: "hidden" });
  assert.equal(result.status, 409);
  assert.equal(f.store.listLingThreads({ kind: "conversation" }).length, 1);
});
test("new child input fails atomically on missing or malformed fork seed instead of accepting empty history", async t => {
  for (const corruption of ["missing", "payload"]) {
    const f = await fixture(t); completedTurn(f, 1);
    const result = await route(f, "fork", { idempotencyKey: corruption });
    const child = result.body.childThread;
    if (corruption === "missing") f.database.prepare("DELETE FROM conversation_context_snapshots WHERE id=?").run(child.forkContextSnapshotId);
    else f.database.prepare("UPDATE conversation_context_snapshots SET payload_json='{}' WHERE id=?").run(child.forkContextSnapshotId);
    assert.throws(() => accept(f, child), /invalid|missing/);
    assert.equal(f.store.listLingTurns({ threadId: child.id }).length, 0);
    assert.equal(f.store.getLingThread(child.id).nextItemSequence, 1);
  }
});
test("a fork's new inputs retain frozen text after parent edits and archive", async t => {
  const f = await fixture(t), source = completedTurn(f, 1, { canonical: true });
  const result = await route(f, "fork", { idempotencyKey: "freeze-edit" });
  f.database.prepare("UPDATE conversation_items SET payload_json=json_set(payload_json, '$.body', 'CHANGED_PARENT'), revision=revision+1 WHERE id IN (?, ?)")
    .run(source.item.id, "answer-1");
  f.store.updateLingThread(f.thread.id, { status: "archived", archivedAt: at(30) }, at(30));
  const context = accept(f, result.body.childThread).context;
  assert.ok(context.renderedHistory.includes("USER_1"));
  assert.ok(context.renderedHistory.includes("ANSWER_1"));
  assert.equal(context.renderedHistory.includes("CHANGED_PARENT"), false);
});
test("fork context has one shared text budget and records whole-group omissions", async t => {
  const f = await fixture(t);
  completedTurn(f, 1, { text: "EARLY_" + "a".repeat(18_000) });
  completedTurn(f, 2, { text: "ANCHOR_" + "b".repeat(18_000) });
  const result = await route(f, "fork", { idempotencyKey: "budget" });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const child = result.body.childThread, first = accept(f, child, "first");
  assert.ok(first.context.renderedHistory.includes("ANCHOR_"));
  assert.equal(first.context.renderedHistory.includes("EARLY_"), false);
  assert.ok(first.context.forkHistory.omittedGroups.length);
  completedTurn(f, 3, { thread: child, text: "LOCAL_" + "c".repeat(20_000) });
  const next = accept(f, child, "second").context;
  const inherited = next.forkHistory.groups.flatMap(group => group.entries).reduce((sum, entry) => sum + entry.text.length, 0);
  assert.ok(inherited + next.hydration.usedTextChars <= 32_768);
  assert.equal(next.renderedHistory.includes("ANCHOR_"), false);
  assert.ok(next.renderedHistory.includes("LOCAL_"));
  assert.ok(next.forkHistory.omittedGroups.length > first.context.forkHistory.omittedGroups.length);
});
test("fork-run Run replay returns the original child's prepared request, not new parent options", async t => {
  const f = await fixture(t); completedTurn(f, 1);
  let first;
  const result = await route(f, "fork-run", { idempotencyKey: "with-run", instruction: "CHILD" }, async request => {
    first = request;
    f.store.createRun({ id: "child-run", cwd: f.cwd, taskId: request.task.id, threadId: request.threadId, turnId: request.turnId,
      teammateId: request.teammateId, providerPresetId: "fixture", providerName: "openai", providerModel: "fixture",
      taskSnapshot: request.task, providerSnapshot: {}, requestSnapshot: request, createdAt: at(50) });
    return "child-run";
  });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  let replay;
  const retry = await route(f, "fork-run", { idempotencyKey: "with-run", instruction: "CHILD", providerPresetId: "changed" }, async request => { replay = request; return "child-run"; });
  assert.equal(retry.status, 202, JSON.stringify(retry.body));
  assert.deepEqual(replay, first);
});
test("inline fork inheritance requires the exact frozen source run, never just a parentRunId", async t => {
  const f = await fixture(t);
  const source = completedTurn(f, 1, { preset: null, request: { provider: { provider: "openai", model: "fixture" } } });
  let captured;
  const result = await route(f, "fork-run", { idempotencyKey: "inline", instruction: "CHILD" }, async request => { captured = request; return "unused"; });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.deepEqual(captured.provider, { provider: "openai", model: "fixture" });
  const saved = f.store.getConversationPreparedInput(captured.sourceMessageId, "request");
  assert.equal(saved.payload.inlineProviderSourceRunId, source.run.id);
  assert.equal(Object.hasOwn(saved.payload.request.provider, "apiKey"), false);
  const other = completedTurn(f, 2, { preset: null, request: { provider: { provider: "openai", model: "fixture" } } });
  assert.throws(() => restorePreparedInlineProvider(f.store, { ...captured, parentRunId: other.run.id }, other.run.id), /scope mismatch/);
  const outsider = f.store.createLingThread({ kind: "conversation", title: "Other", objective: "Other" }, at(1));
  assert.throws(() => restorePreparedInlineProvider(f.store, { ...captured, threadId: outsider.id }, source.run.id), /scope mismatch/);
});
test("redacted inline credentials remain an explicit refusal and never enter prepared evidence", async t => {
  const f = await fixture(t);
  completedTurn(f, 1, { preset: null, request: { provider: { provider: "openai", model: "fixture", apiKey: "synthetic-not-a-real-credential" } } });
  const result = await route(f, "fork-run", { idempotencyKey: "redacted", instruction: "CHILD" }, () => assert.fail("must not dispatch"));
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "prepared_inline_credentials_unavailable");
  const child = f.store.listLingThreads({ kind: "conversation" }).find(thread => thread.parentThreadId === f.thread.id);
  const turn = f.store.listLingTurns({ threadId: child.id })[0];
  assert.equal(f.store.getConversationPreparedInput(turn.sourceItemId, "request"), undefined);
});
test("published canonical narration retains message boundaries and the frozen run watermark in a fork", async t => {
  const f = await userInputTranscriptFixture(t);
  f.store.appendEvent(f.run.id, "run_created", { workUnitId: f.unit.id, attemptId: f.attempt.id, threadId: f.thread.id, teammateId: f.participantId });
  const first = f.store.appendEvent(f.run.id, "message_end", { role: "assistant", text: "FIRST_MESSAGE\n\n```js\nconst n = 1;\n```" });
  f.store.appendEvent(f.run.id, "tool_end", { toolCallId: "read", toolName: "read", output: "NOT_NARRATION" });
  const last = f.store.appendEvent(f.run.id, "message_end", { role: "assistant", text: "FINAL_MESSAGE" });
  f.store.transitionRunStatus({ runId: f.run.id, event: "runner_succeeded", actor: "runner", now: transcriptNow });
  if (f.store.getLingTurn(f.turn.turnId).status !== "succeeded") f.store.transitionLingTurnStatus({ turnId: f.turn.turnId, event: "succeed", actor: "system", now: transcriptNow });
  const published = f.store.publishNormalRunNarration(f.run.id, transcriptNow);
  assert.equal(published.ok, true);
  f.store.appendEvent(f.run.id, "message_end", { role: "assistant", text: "LATE_AFTER_PUBLICATION" });
  const result = await route(f, "fork", { idempotencyKey: "published" });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const context = accept(f, result.body.childThread).context;
  const entries = context.forkHistory.groups.flatMap(group => group.entries).filter(entry => entry.role === "assistant");
  assert.deepEqual(entries.map(entry => entry.text), ["FIRST_MESSAGE\n\n```js\nconst n = 1;\n```", "FINAL_MESSAGE"]);
  assert.ok(entries[0].sourceRefs.some(ref => ref.kind === "run_event" && ref.id === first.id));
  assert.ok(entries[1].sourceRefs.some(ref => ref.kind === "run_event" && ref.id === last.id));
  assert.deepEqual(context.forkHistory.runEventWatermarks, [{ runId: f.run.id,
    throughEventId: published.item.payload.runNarration.throughEventId, throughEventSequence: published.item.payload.runNarration.throughEventSequence }]);
  assert.equal(context.renderedHistory.includes("LATE_AFTER_PUBLICATION"), false);
});
