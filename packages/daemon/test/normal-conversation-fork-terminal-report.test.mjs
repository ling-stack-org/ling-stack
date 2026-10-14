import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createSqliteRunStore, resolveRuntimePaths } from "@ling-stack/core";
import {
  configureTerminalReportStore,
  processTurnTerminalReport,
} from "../dist/features/channels/terminal-report-coordinator.js";
import { prepareNormalConversationInput } from "../dist/features/conversations/normal-conversation-input.js";
import { validateNormalForkContextPayload } from "../dist/features/conversations/normal-conversation-fork-history.js";
import { handleLingThreadItem } from "../dist/features/runs/thread-routes.js";

const at = minute => new Date(Date.UTC(2026, 8, 1, 0, minute)).toISOString();
const userPayload = body => ({ body, format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] });

/** Isolated SQLite only; the real report coordinator has no model runner configured. */
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-fork-terminal-report-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  f.database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => {
    f.database.close();
    f.store.close();
    if (process.env.LING_A14_KEEP_FIXTURES === "1") t.diagnostic(`A14 fixture preserved: ${cwd}`);
    else await rm(cwd, { recursive: true, force: true });
  });
  configureTerminalReportStore(f.store, { enabled: true });
  f.backingChannel = f.store.createChannel({ name: "Task storage only", boundPath: cwd }, at(0));
  f.thread = f.store.createLingThread({
    kind: "conversation", teammateId: "ling_agent", title: "Report parent", objective: "Frozen report history",
  }, at(0));
  return f;
}

/** Use public Turn/Run/event producers, including a settled real tool fact. */
function completedTurn(f, number, { thread = f.thread, text = `ANSWER_${number}`, request = {} } = {}) {
  const task = f.store.createTask({
    channelId: f.backingChannel.id, title: `Turn ${number}`, prompt: `USER_${number}`,
  }, at(number));
  const input = f.store.appendConversationUserTurn({
    threadId: thread.id, title: task.title, userInstruction: task.prompt,
    idempotencyKey: `report-user-${number}`, payload: userPayload(task.prompt),
  }, at(number));
  const run = f.store.createRun({
    id: `report-run-${number}`, cwd: f.cwd, taskId: task.id, threadId: thread.id, turnId: input.turnId,
    teammateId: "ling_agent", providerName: "fixture", providerModel: "fixture", providerPresetId: "fixture",
    taskSnapshot: { id: task.id, title: task.title, prompt: task.prompt }, providerSnapshot: {},
    requestSnapshot: { providerPresetId: "fixture", tools: ["edit"], cwd: f.cwd, responseLanguage: "zh-CN", ...request },
    createdAt: at(number),
  });
  f.store.appendEvent(run.id, "tool_start", { toolCallId: `edit-${number}`, toolName: "edit", args: { path: `src/file-${number}.ts` } });
  f.store.appendEvent(run.id, "tool_end", { toolCallId: `edit-${number}`, toolName: "edit", isError: false });
  f.store.appendEvent(run.id, "message_end", { role: "assistant", text });
  f.store.markRunSucceeded(run.id, at(number));
  if (f.store.getLingTurn(input.turnId).status !== "succeeded") {
    assert.equal(f.store.transitionLingTurnStatus({ turnId: input.turnId, event: "succeed", actor: "system", now: at(number) }).ok, true);
  }
  return { ...input, task, run: f.store.getRun(run.id) };
}

async function publishedHistoryReport(f, historyOptions) {
  const history = completedTurn(f, 1, historyOptions);
  const published = await processTurnTerminalReport(f.store, history.turnId, { now: at(2) });
  assert.ok(published?.record.resultItemId, "the real Host report coordinator must publish the history report");
  const item = f.store.getConversationItem(published.record.resultItemId);
  assert.equal(item.kind, "terminal_report", "an assistant execution_summary is not a TerminalReport fixture");
  assert.equal(item.threadId, f.thread.id);
  assert.equal(item.turnId, history.turnId);
  assert.equal(published.record.resultItemId, item.id);
  assert.equal(published.record.evidenceSnapshot.surface, "normal_conversation");
  assert.equal(published.record.evidenceFingerprint, item.payload.evidenceFingerprint);
  return { history, published, item };
}

class Response extends EventEmitter {
  statusCode = 200;
  body = "";
  writeHead(status) { this.statusCode = status; }
  setHeader() {}
  end(chunk = "") { this.body += chunk; }
}

async function fork(f, body, { kind = "fork", start = async () => assert.fail("fork-only cannot execute a Run") } = {}) {
  const request = Readable.from([JSON.stringify(body)]);
  request.method = "POST";
  request.headers = {};
  const response = new Response();
  await handleLingThreadItem(request, response,
    new URL(`http://fixture/threads/fork?cwd=${encodeURIComponent(f.cwd)}`),
    { getStore: () => f.store }, { kind, threadId: f.thread.id },
    { maxBodyBytes: 100_000, startForkRun: start });
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

function forkCounts(f) {
  return {
    children: f.store.listLingThreads({ kind: "conversation" }).filter(thread => thread.parentThreadId).length,
    seeds: f.database.prepare("SELECT COUNT(*) AS n FROM conversation_context_snapshots WHERE snapshot_use='normal_conversation_fork_seed'").get().n,
  };
}

test("a published historical TerminalReport remains context in a normal fork; a rejected capture leaves no child or seed", async t => {
  const f = await fixture(t);
  const { history, published, item } = await publishedHistoryReport(f);
  const anchor = completedTurn(f, 3);
  const before = forkCounts(f);
  const result = await fork(f, { turnId: anchor.turnId, sourceRunId: anchor.run.id, idempotencyKey: "published-history" });
  if (result.status !== 201) {
    const after = forkCounts(f);
    assert.deepEqual(after, before, "a failed report capture must atomically roll back both branch and frozen seed");
    t.diagnostic(`A14 rejected fork atomicity: ${JSON.stringify({ before, after, status: result.status })}`);
  }
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.deepEqual(forkCounts(f), { children: before.children + 1, seeds: before.seeds + 1 });
  const child = result.body.childThread;
  const prepared = prepareNormalConversationInput({
    store: f.store, thread: child, title: "Child", message: "CHILD_INPUT", attachmentIds: [], fileRefs: [],
    idempotencyKey: "child-input", now: at(4),
  });
  const entries = prepared.context.forkHistory.groups.flatMap(group => group.entries);
  const reports = entries.filter(entry => entry.origin === "terminal_report");
  assert.equal(reports.length, 1);
  const publicUnresolvedRisks = published.record.evidenceSnapshot.risks.filter(risk => risk.status === "unresolved" &&
    risk.sourceRefs.some(ref => ref.visibility === "conversation" && ref.sensitivity !== "secret_adjacent") &&
    risk.sourceRefs.every(ref => ref.visibility !== "developer_only" && ref.sensitivity !== "secret_adjacent"))
    .slice(0, 8).map(risk => risk.summary.slice(0, 512));
  assert.deepEqual(reports[0], {
    origin: "terminal_report", role: "context", turnId: history.turnId, reportId: published.record.id,
    text: JSON.stringify({ hostTerminalOutcome: published.record.outcomeStatus, unresolvedRisksAtCompletion: publicUnresolvedRisks }),
    sourceRefs: [{ kind: "conversation_item", id: item.id, sequence: item.sequence, revision: item.revision }],
  });
  assert.notEqual(reports[0].reportId, item.id, "report identity is distinct from its canonical publication Item");
  assert.deepEqual(entries.filter(entry => entry.role === "assistant").map(entry => entry.text), ["ANSWER_1", "ANSWER_3"]);
  assert.equal(prepared.context.projection.threadId, child.id);
  assert.equal(prepared.context.hydration.source.itemId, prepared.turn.sourceItemId);
});

function accept(f, thread, key, minute = 20) {
  return prepareNormalConversationInput({
    store: f.store, thread, title: key, message: `CHILD_${key}`, attachmentIds: [], fileRefs: [],
    idempotencyKey: key, now: at(minute),
  });
}

function inheritedEntries(context) {
  return context.forkHistory.groups.flatMap(group => group.entries);
}

async function reportFork(t, { historyOptions, anchorOptions, key = "report-matrix" } = {}) {
  const f = await fixture(t);
  const report = await publishedHistoryReport(f, historyOptions);
  const anchor = completedTurn(f, 3, anchorOptions);
  const result = await fork(f, { turnId: anchor.turnId, sourceRunId: anchor.run.id, idempotencyKey: key });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const child = result.body.childThread;
  const seed = f.store.getNormalConversationForkSeed(child.id);
  assert.ok(seed);
  return { f, ...report, anchor, child, seed };
}

test("the frozen TerminalReport variant rejects malformed fields, roles, identities and source refs", async t => {
  const { seed } = await reportFork(t);
  const cases = [
    ...["origin", "role", "turnId", "reportId", "text", "sourceRefs"].map(key => [`missing ${key}`, entry => { delete entry[key]; }]),
    ["unknown variant field", entry => { entry.unverified = true; }],
    ["unknown origin", entry => { entry.origin = "unverified_report"; }],
    ["assistant role", entry => { entry.role = "assistant"; }],
    ["user role", entry => { entry.role = "user"; }],
    ["coercible context role", entry => { entry.role = ["context"]; }],
    ["empty turn identity", entry => { entry.turnId = ""; }],
    ["non-string turn identity", entry => { entry.turnId = 1; }],
    ["mismatched Turn group", entry => { entry.turnId = "other-turn"; }],
    ["empty report identity", entry => { entry.reportId = ""; }],
    ["array report identity", entry => { entry.reportId = [entry.reportId]; }],
    ["object report identity", entry => { entry.reportId = { id: entry.reportId }; }],
    ["numeric report identity", entry => { entry.reportId = 1; }],
    ["non-string report text", entry => { entry.text = { hostTerminalOutcome: "succeeded" }; }],
    ["empty source refs", entry => { entry.sourceRefs = []; }],
    ["non-array source refs", entry => { entry.sourceRefs = entry.sourceRefs[0]; }],
    ["null source ref", entry => { entry.sourceRefs = [null]; }],
    ["multiple canonical refs", entry => { entry.sourceRefs.push(structuredClone(entry.sourceRefs[0])); }],
    ["run ref instead of canonical Item", entry => { entry.sourceRefs = [{ kind: "run", id: "not-a-publication-item" }]; }],
    ["Turn ref instead of canonical Item", entry => { entry.sourceRefs = [{ kind: "turn", id: entry.turnId, updatedAt: at(1) }]; }],
    ["empty canonical Item identity", entry => { entry.sourceRefs[0].id = ""; }],
    ["non-string canonical Item identity", entry => { entry.sourceRefs[0].id = 1; }],
    ["missing canonical Item revision", entry => { delete entry.sourceRefs[0].revision; }],
    ["extra canonical ref field", entry => { entry.sourceRefs[0].reportId = entry.reportId; }],
    ["zero canonical Item sequence", entry => { entry.sourceRefs[0].sequence = 0; }],
    ["fractional canonical Item sequence", entry => { entry.sourceRefs[0].sequence = 1.5; }],
    ["unsafe canonical Item sequence", entry => { entry.sourceRefs[0].sequence = Number.MAX_SAFE_INTEGER + 1; }],
    ["negative canonical Item revision", entry => { entry.sourceRefs[0].revision = -1; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const payload = structuredClone(seed.payload);
    const entry = payload.groups.flatMap(group => group.entries).find(candidate => candidate.origin === "terminal_report");
    assert.ok(entry, "each negative case starts from the real published report's frozen entry");
    mutate(entry);
    assert.throws(() => validateNormalForkContextPayload(payload), /Invalid normal fork context payload/);
  });
  assert.deepEqual(validateNormalForkContextPayload(structuredClone(seed.payload)), seed.payload,
    "rejection must not mutate or weaken the original valid capture");
});

test("a fenced active summary covering the published report stays a summary in the frozen fork", async t => {
  const f = await fixture(t);
  const { history, item } = await publishedHistoryReport(f);
  const assignment = f.store.getEffectiveTurnContextAssignment(history.turnId);
  assert.ok(assignment);
  const covered = f.store.listConversationItemsForSegment({
    threadId: f.thread.id, segmentId: assignment.segmentId, throughSequence: item.sequence, order: "oldest", limit: 500,
  }).filter(row => row.visibility === "thread_participants" || row.visibility === "channel");
  assert.ok(covered.some(row => row.id === item.id));
  const committed = f.store.commitConversationContextSummary({
    threadId: f.thread.id, segmentId: assignment.segmentId, scope: "segment",
    coveredFromSequence: covered[0].sequence, coveredThroughSequence: item.sequence,
    objective: "SUMMARY_REPORT_HISTORY", decisions: [], constraints: [], openQuestions: [], activeWorkRefs: [],
    sourceRefs: [...covered.map(row => ({ type: "conversation_item", id: row.id })),
      { type: "turn", id: history.turnId }, { type: "run", id: history.run.id }],
    policyVersion: "continuity-v2-summary-v1", projectionVersion: "ctxv2_a14_summary_report",
    visibilityFingerprint: "visibility_a14_thread_participants", expectedActiveSummaryId: null,
    sourceFence: covered.map(row => {
      const owner = f.store.getEffectiveTurnContextAssignment(row.turnId);
      assert.equal(owner.segmentId, assignment.segmentId);
      return { itemId: row.id, sequence: row.sequence, revision: row.revision, updatedAt: row.updatedAt,
        visibility: row.visibility, visibilityOwnerId: row.visibilityOwnerId, turnId: row.turnId,
        assignmentId: owner.id, assignmentRevision: owner.revision };
    }),
  }, new Date(Date.parse(at(2)) + 1_000).toISOString());
  assert.equal(committed.status, "committed");
  const anchor = completedTurn(f, 3);
  const result = await fork(f, { turnId: anchor.turnId, idempotencyKey: "summarized-report" });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const context = accept(f, result.body.childThread, "summary").context;
  const entries = inheritedEntries(context);
  assert.ok(entries.some(entry => entry.origin === "context_summary" && entry.summaryId === committed.summary.id && entry.text.includes("SUMMARY_REPORT_HISTORY")));
  assert.equal(entries.some(entry => entry.origin === "terminal_report"), false);
  assert.equal(entries.some(entry => entry.sourceRefs.some(ref => ref.kind === "conversation_item" && ref.id === item.id)), false);
  assert.equal(context.renderedHistory.includes("ANSWER_1"), false, "summary-covered Run narration cannot revive through event fallback");
  assert.ok(context.renderedHistory.includes("ANSWER_3"));
});

test("the report and its Turn are omitted together when the frozen fork's whole-group budget excludes them", async t => {
  const { f, history, published, anchor, child, seed } = await reportFork(t, {
    historyOptions: { text: `EARLY_REPORT_TURN_${"a".repeat(18_000)}` },
    anchorOptions: { text: `ANCHOR_TURN_${"b".repeat(18_000)}` }, key: "report-budget",
  });
  const historyKey = JSON.stringify([f.thread.id, "turn", history.turnId]);
  assert.ok(seed.payload.omittedGroups.includes(historyKey));
  assert.equal(seed.payload.groups.some(group => group.key === historyKey), false);
  assert.equal(seed.payload.groups.flatMap(group => group.entries).some(entry => entry.reportId === published.record.id), false);
  const context = accept(f, child, "budget").context;
  assert.equal(inheritedEntries(context).some(entry => entry.turnId === history.turnId), false);
  assert.ok(inheritedEntries(context).some(entry => entry.turnId === anchor.turnId));
  assert.equal(context.renderedHistory.includes("EARLY_REPORT_TURN_"), false);
  assert.ok(context.renderedHistory.includes("ANCHOR_TURN_"));
});

test("nested forks retain the original report owner once across reopen and newer parent activity", async t => {
  const { f, history, published, child, seed } = await reportFork(t, { key: "first-generation" });
  const parent = f.thread;
  const frozen = structuredClone(seed);
  const childAnchor = completedTurn(f, 5, { thread: child });
  f.thread = child;
  const second = await fork(f, { turnId: childAnchor.turnId, idempotencyKey: "second-generation" });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const secondSeed = structuredClone(f.store.getNormalConversationForkSeed(second.body.childThread.id));
  f.store.appendEvent(history.run.id, "message_end", { role: "assistant", text: "LATE_PARENT_NARRATION" });
  completedTurn(f, 6, { thread: parent, text: "NEW_PARENT_ANSWER" });
  f.store.updateLingThread(parent.id, { status: "archived", archivedAt: at(7) }, at(7));
  f.store.close();
  f.store = createSqliteRunStore(f.cwd);
  assert.deepEqual(f.store.getNormalConversationForkSeed(child.id), frozen);
  assert.deepEqual(f.store.getNormalConversationForkSeed(second.body.childThread.id), secondSeed);
  const context = accept(f, second.body.childThread, "nested-reopened").context;
  const reports = inheritedEntries(context).filter(entry => entry.origin === "terminal_report");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reportId, published.record.id);
  assert.equal(reports[0].turnId, history.turnId);
  const owner = context.forkHistory.groups.find(group => group.entries.some(entry => entry === reports[0]));
  assert.equal(owner.threadId, parent.id, "inherited report provenance is not relabelled as either descendant");
  for (const text of ["ANSWER_1", "ANSWER_3", "ANSWER_5"]) assert.equal(context.renderedHistory.split(text).length - 1, 1);
  for (const text of ["LATE_PARENT_NARRATION", "NEW_PARENT_ANSWER"]) assert.equal(context.renderedHistory.includes(text), false);
});

test("a repeated fork key reads its frozen report without recapturing changed parent history", async t => {
  const { f, child, seed } = await reportFork(t, { key: "stable-report" });
  const frozen = structuredClone(seed);
  const newer = completedTurn(f, 6);
  f.store.updateLingThread(f.thread.id, { status: "archived", archivedAt: at(7) }, at(7));
  f.store.close();
  f.store = createSqliteRunStore(f.cwd);
  const original = f.store.listConversationItemsForTurn;
  f.store.listConversationItemsForTurn = () => assert.fail("replaying the existing key cannot recapture parent text");
  try {
    const replay = await fork(f, { idempotencyKey: "stable-report" });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.childThread.id, child.id);
    assert.deepEqual(f.store.getNormalConversationForkSeed(child.id), frozen);
    const conflict = await fork(f, { idempotencyKey: "stable-report", turnId: newer.turnId });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "fork_idempotency_conflict");
    assert.deepEqual(forkCounts(f), { children: 1, seeds: 1 });
  } finally {
    f.store.listConversationItemsForTurn = original;
  }
});

test("fork-run retains report context but drops a historical permission receipt from its new prepared request", async t => {
  const f = await fixture(t);
  const { published } = await publishedHistoryReport(f);
  const receipt = { mode: "full_access", confirmed: true, confirmedAt: at(1), reason: "Historical parent confirmation only" };
  const anchor = completedTurn(f, 3, { request: { permissionMode: "balanced", permissionConfirmation: receipt } });
  assert.deepEqual(f.store.getRun(anchor.run.id).requestSnapshot.permissionConfirmation, receipt);
  let request;
  const result = await fork(f, { turnId: anchor.turnId, idempotencyKey: "new-authority", instruction: "NEW_CHILD_TASK" }, {
    kind: "fork-run", start: async value => { request = value; return "not-dispatched-fixture"; },
  });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.ok(request.normalConversationPreparedRequestRef);
  assert.equal(request.permissionConfirmation, undefined);
  assert.equal(request.threadId, result.body.childThread.id);
  assert.notEqual(request.threadId, f.thread.id);
  assert.equal(request.parentRunId, anchor.run.id);
  assert.ok(inheritedEntries(request.normalConversationContext).some(entry => entry.origin === "terminal_report" && entry.reportId === published.record.id));
  const saved = f.store.getConversationPreparedInput(request.sourceMessageId, "request");
  assert.equal(Object.hasOwn(saved.payload.request, "permissionConfirmation"), false);
  assert.equal(f.store.getRun("not-dispatched-fixture"), undefined, "the test callback records preparation, not actual execution");
});

test("a frozen report and parent full-access receipt cannot authorize a new full-access fork-run", async t => {
  const f = await fixture(t);
  await publishedHistoryReport(f);
  const anchor = completedTurn(f, 3, { request: { permissionMode: "full_access", permissionPreset: "full_access",
    permissionConfirmation: { mode: "full_access", confirmed: true, confirmedAt: at(1), reason: "Only the parent's execution was confirmed" } } });
  const result = await fork(f, { turnId: anchor.turnId, idempotencyKey: "full-access-fence", instruction: "NEW_CHILD_TASK" }, {
    kind: "fork-run", start: async () => assert.fail("historical permission cannot dispatch a new full-access Run"),
  });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.error, "full_access_confirmation_required");
  const child = f.store.listLingThreads({ kind: "conversation" }).find(thread => thread.parentThreadId === f.thread.id);
  assert.ok(child, "the history-only fork is valid even when new execution lacks authority");
  const childTurn = f.store.listLingTurns({ threadId: child.id })[0];
  assert.ok(childTurn);
  assert.equal(f.store.getConversationPreparedInput(childTurn.sourceItemId, "request"), undefined);
  assert.equal(f.store.listLingTurnRuns(childTurn.id).length, 0);
});
