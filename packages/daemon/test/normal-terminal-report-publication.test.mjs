import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildDeterministicTerminalReport, captureNormalTerminalReportBasis, createSqliteRunStore, resolveRuntimePaths } from "../../core/dist/index.js";
import { collectTurnTerminalReportEvidence } from "../dist/features/channels/terminal-report-evidence.js";
import {
  configureTerminalReportStore,
  processRunTerminalReport,
  processTurnTerminalReport,
  recoverTerminalReports,
} from "../dist/features/channels/terminal-report-coordinator.js";

const now = "2026-09-06T04:00:00.000Z";
const later = "2026-09-06T04:01:00.000Z";

test("system-origin normal completion publishes and recovers one fact result without a user actor", async (t) => {
  const f = await fixture(t, "system");
  const result = await processTurnTerminalReport(f.store, f.turn.id, { now: later });
  const resultId = result.record.resultItemId;
  assert.ok(resultId);
  assert.equal(f.store.getConversationItem(f.turn.sourceItemId).actorType, "system");
  assert.equal(f.store.getLingTurn(f.turn.id).createdByActor, "system");
  assert.equal(f.store.getConversationItem(resultId).kind, "terminal_report");
  assert.ok(f.store.getConversationItem(resultId).domainRefs.some((ref) => ref.type === "conversation_item" && ref.id === f.turn.sourceItemId));
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  configureTerminalReportStore(f.store, { enabled: true });
  await recoverTerminalReports(f.store);
  assert.equal(f.store.getTerminalReport(result.record.id).resultItemId, resultId);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_items WHERE kind='terminal_report'").get().n, 1);
});

test("normal terminal publication rejects mismatched or unsupported source actors before synthesis", async (t) => {
  for (const actorType of ["system", "local_user", "teammate"]) {
    const f = await fixture(t, actorType === "local_user" ? "system" : "local_user");
    f.database.prepare("UPDATE conversation_items SET actor_type=? WHERE id=?").run(actorType, f.turn.sourceItemId);
    assert.equal(captureNormalTerminalReportBasis(f.store, { kind: "turn", id: f.turn.id }), undefined);
  }
});

for (const sourceKind of ["turn", "run"]) {
  test(`normal ${sourceKind} report publishes one canonical result and durable invalidation without a channel`, async (t) => {
    const f = await fixture(t);
    const events = [];
    configureTerminalReportStore(f.store, { enabled: true, onPublished: ({ event }) => events.push(event) });
    const process = sourceKind === "turn" ? processTurnTerminalReport : processRunTerminalReport;
    const sourceId = sourceKind === "turn" ? f.turn.id : f.run.id;
    const result = await process(f.store, sourceId, { now: later });
    assert.ok(result.record.resultItemId, "a committed normal report must have its canonical result item");
    const item = f.store.getConversationItem(result.record.resultItemId);
    assert.equal(item.kind, "terminal_report");
    assert.equal(item.channelId, undefined);
    assert.equal(item.threadId, f.thread.id);
    assert.equal(item.turnId, f.turn.id);
    assert.equal(item.visibility, "thread_participants");
    assert.equal(item.payload.sourceKind, sourceKind);
    assert.equal(item.payload.sourceId, sourceId);
    assert.equal(item.payload.generation, result.record.generation);
    assert.equal(item.payload.evidenceFingerprint, result.record.evidenceFingerprint);
    assert.ok(item.domainRefs.some((ref) => ref.type === "conversation_item" && ref.id === f.turn.sourceItemId));
    assert.equal(result.message, undefined, "normal publication must not fabricate a ChannelMessage");
    assert.equal(events.length, 1);
    assert.equal(events[0].data.threadId, f.thread.id);
    assert.equal(events[0].data.resultItemId, item.id);
    const repeated = await process(f.store, sourceId, { now: later });
    assert.equal(repeated.record.resultItemId, item.id);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM conversation_items WHERE kind = 'terminal_report'").get().count, 1);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM control_plane_events WHERE action = 'terminal_report.published'").get().count, 1);
  });
}

for (const boundary of ["item", "marker", "invalidation"]) {
  test(`normal publication rolls back the report commit when ${boundary} fails`, async (t) => {
    const f = await fixture(t);
    const trigger = boundary === "item"
      ? "BEFORE INSERT ON conversation_items WHEN NEW.kind = 'terminal_report'"
      : boundary === "marker"
        ? "BEFORE UPDATE OF result_item_id ON ling_terminal_reports WHEN NEW.result_item_id IS NOT NULL"
        : "BEFORE INSERT ON control_plane_events WHEN NEW.action = 'terminal_report.published'";
    f.database.exec(`CREATE TRIGGER fail_normal_publication ${trigger} BEGIN SELECT RAISE(ABORT, 'normal publication crash'); END;`);
    await assert.rejects(processTurnTerminalReport(f.store, f.turn.id, { now: later }), /normal publication crash/);
    const records = f.store.listTerminalReports({ sourceKind: "turn", sourceId: f.turn.id });
    assert.equal(records.length, 1);
    assert.equal(records[0].report, undefined, "report JSON must roll back with the publication transaction");
    assert.equal(records[0].committedAt, undefined);
    assert.equal(records[0].resultItemId, undefined);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM conversation_items WHERE kind = 'terminal_report'").get().count, 0);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM control_plane_events WHERE action = 'terminal_report.published'").get().count, 0);
    assert.equal(f.store.getLingThread(f.thread.id).nextItemSequence, 2);
    f.database.exec("DROP TRIGGER fail_normal_publication;");
    const retry = await processTurnTerminalReport(f.store, f.turn.id, { now: later });
    assert.ok(retry.record.resultItemId);
  });
}

test("normal report recovery survives reopen without duplicating the result", async (t) => {
  const f = await fixture(t);
  const first = await processTurnTerminalReport(f.store, f.turn.id, { now: later });
  assert.ok(first.record.resultItemId);
  f.store.close();
  f.store = createSqliteRunStore(f.cwd);
  configureTerminalReportStore(f.store, { enabled: true });
  await recoverTerminalReports(f.store);
  assert.equal(f.store.getTerminalReport(first.record.id).resultItemId, first.record.resultItemId);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM conversation_items WHERE kind = 'terminal_report'").get().count, 1);
});

test("normal store duplicates the same validating publication callback without a second result", async (t) => {
  const f = await fixture(t);
  const input = candidate(f);
  assert.equal(f.store.commitTerminalReportPublication(input).duplicate, false);
  assert.equal(f.store.commitTerminalReportPublication(input).duplicate, true);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM conversation_items WHERE kind = 'terminal_report'").get().count, 1);
});

for (const change of ["late event", "new retry", "approval", "artifact", "higher generation"]) {
  test(`normal store rejects a stale synthesis basis after ${change}`, async (t) => {
    const f = await fixture(t);
    const input = candidate(f);
    if (change === "late event") f.store.appendEvent(f.run.id, "assistant_text_delta", { text: "Late evidence" });
    if (change === "new retry") {
      const retry = addRun(f, "retry");
      f.store.markRunSucceeded(retry.id, later);
    }
    if (change === "approval") approval(f);
    if (change === "artifact") f.store.createArtifact({ runId: f.run.id, type: "file", path: "src/late.ts", title: "late.ts", createdAt: later });
    if (change === "higher generation") f.store.createTerminalReportDraft({ generation: 2, evidenceSnapshot: f.store.getTerminalReport(input.reportId).evidenceSnapshot }, later);
    assert.deepEqual(f.store.commitTerminalReportPublication(input), { ok: false, code: "stale_completion_basis" });
    assert.equal(f.store.getTerminalReport(input.reportId).status, "validating");
    assert.equal(f.store.getTerminalReport(input.reportId).resultItemId, undefined);
  });
}

for (const change of ["pending approval", "open tool"]) {
  test(`normal completion barrier refuses ${change} even when the Turn says succeeded`, async (t) => {
    const f = await fixture(t);
    if (change === "pending approval") approval(f);
    if (change === "open tool") f.store.appendEvent(f.run.id, "tool_start", { toolCallId: "unfinished", toolName: "bash", args: { command: "sleep 20" } });
    const input = candidate(f);
    assert.equal(f.store.getLingTurn(f.turn.id).status, "succeeded");
    const result = f.store.commitTerminalReportPublication(input);
    assert.equal(result.ok, false);
    assert.ok(["outcome_conflict", "stale_completion_basis"].includes(result.code));
    assert.equal(f.store.getTerminalReport(input.reportId).report, undefined);
  });
}

test("normal independent failed primary and successful validation publish a partial outcome", async (t) => {
  const f = await fixture(t);
  f.store.markRunFailed(f.run.id, later, "Primary failed");
  const validation = addRun(f, "validation");
  f.store.markRunSucceeded(validation.id, later);
  const result = await processTurnTerminalReport(f.store, f.turn.id, { now: later });
  assert.equal(result.record.report.outcome.status, "partially_succeeded");
});

test("normal source/item scope and partial publication lineage fail closed", async (t) => {
  const f = await fixture(t);
  const input = candidate(f);
  for (const changed of [
    { publicationItem: { ...input.publicationItem, threadId: "foreign-thread" } },
    { publicationItem: { ...input.publicationItem, visibility: "channel" } },
    { publicationItem: { ...input.publicationItem, visibilityOwnerId: "foreign-owner" } },
    { publicationItem: { ...input.publicationItem, domainRefs: [...input.publicationItem.domainRefs, { type: "run", id: "foreign-run" }] } },
    { report: { ...input.report, sourceMessageId: "foreign-source" } },
  ]) {
    assert.equal(f.store.commitTerminalReportPublication({ ...input, ...changed }).ok, false);
    assert.equal(f.store.getTerminalReport(input.reportId).report, undefined);
  }
  f.store.appendConversationItem(input.publicationItem, later);
  assert.deepEqual(f.store.commitTerminalReportPublication(input), { ok: false, code: "item_conflict" });
  assert.equal(f.store.getTerminalReport(input.reportId).report, undefined);
});

test("normal evidence callbacks are synchronous and query-only and restore the writer after failure", async (t) => {
  const f = await fixture(t);
  const input = candidate(f);
  for (const readEvidence of [
    () => { f.store.appendEvent(f.run.id, "assistant_text_delta", { text: "forbidden write" }); return input.readEvidence(); },
    async () => input.readEvidence(),
    () => ({ then() {} }),
    () => { throw new Error("collector failed"); },
  ]) {
    assert.throws(() => f.store.commitTerminalReportPublication({ ...input, readEvidence }), /readonly|synchronous|collector failed/i);
    assert.equal(f.store.getTerminalReport(input.reportId).report, undefined);
  }
  assert.equal(f.store.commitTerminalReportPublication(input).ok, true);
});

test("normal later evidence publishes a superseding result while lower generations cannot publish", async (t) => {
  const f = await fixture(t);
  const firstInput = candidate(f);
  const first = f.store.commitTerminalReportPublication(firstInput);
  assert.equal(first.ok, true);
  f.store.createArtifact({ runId: f.run.id, type: "file", path: "src/verified.ts", title: "verified.ts", createdAt: later });
  const second = await processTurnTerminalReport(f.store, f.turn.id, { now: later });
  assert.equal(second.record.generation, 2);
  assert.equal(f.store.getConversationItem(second.record.resultItemId).supersedesItemId, first.item.id);
  assert.equal(f.store.listConversationItemsPage({ threadId: f.thread.id, effectiveOnly: true }).items.filter((item) => item.kind === "terminal_report").length, 1);
  assert.equal(f.store.commitTerminalReportPublication(firstInput).ok, false);
});

test("normal recovery publishes a pre-atomic orphan only when its evidence is still current", async (t) => {
  const f = await fixture(t);
  const input = candidate(f);
  commitOrphan(f, input);
  await recoverTerminalReports(f.store);
  assert.ok(f.store.getTerminalReport(input.reportId).resultItemId);
});

test("normal recovery replaces stale orphan evidence instead of publishing or stranding it", async (t) => {
  const f = await fixture(t);
  const input = candidate(f);
  commitOrphan(f, input);
  f.store.createArtifact({ runId: f.run.id, type: "file", path: "src/recovery.ts", title: "recovery.ts", createdAt: later });
  await recoverTerminalReports(f.store);
  const records = f.store.listTerminalReports({ sourceKind: "turn", sourceId: f.turn.id });
  assert.equal(records.length, 2);
  assert.equal(f.store.getTerminalReport(input.reportId).resultItemId, undefined);
  assert.ok(records.find((record) => record.generation === 2).resultItemId);
});

test("normal run-source recovery does not create a second turn-source result", async (t) => {
  const f = await fixture(t);
  const result = await processRunTerminalReport(f.store, f.run.id, { now: later });
  await recoverTerminalReports(f.store);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM conversation_items WHERE kind = 'terminal_report'").get().count, 1);
  assert.equal(f.store.getTerminalReport(result.record.id).resultItemId, result.record.resultItemId);
});

test("normal publication rolls back all writes when the final COMMIT fails", async (t) => {
  const f = await fixture(t);
  const input = candidate(f);
  f.database.exec(`CREATE TABLE normal_commit_parent (id TEXT PRIMARY KEY);
    CREATE TABLE normal_commit_child (parent_id TEXT REFERENCES normal_commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER reject_normal_commit AFTER INSERT ON control_plane_events WHEN NEW.action = 'terminal_report.published'
      BEGIN INSERT INTO normal_commit_child (parent_id) VALUES ('missing'); END;`);
  assert.throws(() => f.store.commitTerminalReportPublication(input), /FOREIGN KEY/);
  assert.equal(f.store.getTerminalReport(input.reportId).status, "validating");
  assert.equal(f.store.getTerminalReport(input.reportId).report, undefined);
  assert.equal(f.store.getLingThread(f.thread.id).nextItemSequence, 2);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM control_plane_events WHERE action = 'terminal_report.published'").get().count, 0);
  f.database.exec("DROP TRIGGER reject_normal_commit;");
  assert.equal(f.store.commitTerminalReportPublication(input).ok, true);
});

test("normal successful retry owns completion without historical primary failure overriding it", async (t) => {
  const f = await fixture(t);
  f.store.markRunFailed(f.run.id, later, "Historical attempt failed");
  const retry = addRun(f, "retry");
  f.store.appendEvent(retry.id, "tool_start", { toolCallId: "retry-edit", toolName: "edit", args: { path: "src/report.ts" } });
  f.store.appendEvent(retry.id, "tool_end", { toolCallId: "retry-edit", toolName: "edit", isError: false });
  f.store.markRunSucceeded(retry.id, later);
  const result = await processTurnTerminalReport(f.store, f.turn.id, { now: later });
  assert.equal(result.record.report.outcome.status, "succeeded");
  assert.ok(result.record.resultItemId);
  assert.equal(result.record.evidenceSnapshot.steps.length, 2, "failed history remains audit evidence");
});

test("normal failed current validation downgrades a succeeded Turn marker to partial", async (t) => {
  const f = await fixture(t);
  const validation = addRun(f, "validation");
  f.store.markRunFailed(validation.id, later, "Validation failed");
  f.database.prepare("UPDATE ling_turns SET status = 'succeeded' WHERE id = ?").run(f.turn.id);
  const result = await processTurnTerminalReport(f.store, f.turn.id, { now: later });
  assert.equal(result.record.report.outcome.status, "partially_succeeded");
});

test("normal supersession failure keeps the previous result effective and rolls back the new commit", async (t) => {
  const f = await fixture(t);
  const first = await processTurnTerminalReport(f.store, f.turn.id, { now: later });
  f.store.createArtifact({ runId: f.run.id, type: "file", path: "src/revision.ts", title: "revision.ts", createdAt: later });
  f.database.exec("CREATE TRIGGER fail_normal_supersession BEFORE INSERT ON conversation_items WHEN NEW.supersedes_item_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'supersession crash'); END;");
  await assert.rejects(processTurnTerminalReport(f.store, f.turn.id, { now: later }), /supersession crash/);
  const failed = f.store.listTerminalReports({ sourceKind: "turn", sourceId: f.turn.id }).find((record) => record.generation === 2);
  assert.equal(failed.report, undefined);
  assert.equal(failed.resultItemId, undefined);
  const effective = f.store.listConversationItemsPage({ threadId: f.thread.id, effectiveOnly: true }).items.filter((item) => item.kind === "terminal_report");
  assert.deepEqual(effective.map((item) => item.id), [first.record.resultItemId]);
});

test("normal concurrent coordinator callbacks share one canonical report and result", async (t) => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([
    processTurnTerminalReport(f.store, f.turn.id, { now: later }),
    processTurnTerminalReport(f.store, f.turn.id, { now: later }),
  ]);
  assert.ok(first.record.resultItemId);
  assert.equal(first.record.id, second.record.id);
  assert.equal(first.record.resultItemId, second.record.resultItemId);
});

test("normal recovery refuses inconsistent report outcome markers instead of returning a duplicate", async (t) => {
  const f = await fixture(t);
  const input = candidate(f);
  assert.equal(f.store.commitTerminalReportPublication(input).ok, true);
  f.database.prepare("UPDATE ling_terminal_reports SET outcome_status = 'failed' WHERE id = ?").run(input.reportId);
  assert.deepEqual(f.store.commitTerminalReportPublication(input), { ok: false, code: "report_conflict" });
});

test("normal stale synthesis failure does not fail the newer evidence owner", async (t) => {
  const f = await fixture(t);
  const first = processTurnTerminalReport(f.store, f.turn.id, { now: later });
  f.store.createArtifact({ runId: f.run.id, type: "file", path: "src/racing.ts", title: "racing.ts", createdAt: later });
  const second = processTurnTerminalReport(f.store, f.turn.id, { now: later });
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, "rejected", "the old evidence owner must not publish");
  assert.equal(results[1].status, "fulfilled", "the stale callback must not fail the newer draft or its shared WorkUnit");
  assert.ok(results[1].value.record.resultItemId);
  assert.equal(results[1].value.workUnit.status, "succeeded");
});

function commitOrphan(f, input) {
  f.store.commitTerminalReport({ reportId: input.reportId, expectedStatus: "validating", expectedEvidenceFingerprint: input.expectedEvidenceFingerprint,
    report: input.report, synthesisMode: input.report.synthesis.mode, promptVersion: input.report.synthesis.promptVersion,
    attemptCount: input.report.synthesis.attemptCount, now: later });
}

function candidate(f, generation = 1) {
  const { snapshot, basis } = f.store.readSnapshot(() => ({
    snapshot: collectTurnTerminalReportEvidence(f.store, f.turn.id, { generatedAt: later }),
    basis: captureNormalTerminalReportBasis(f.store, { kind: "turn", id: f.turn.id }),
  }));
  const record = f.store.createTerminalReportDraft({ generation, evidenceSnapshot: snapshot }, later);
  f.store.updateTerminalReportDraft({ reportId: record.id, expectedStatus: "draft", expectedEvidenceFingerprint: snapshot.evidenceFingerprint, status: "validating", now: later });
  const report = buildDeterministicTerminalReport(snapshot, { id: record.id, createdAt: record.createdAt, committedAt: later });
  return {
    reportId: record.id, expectedReportStatus: "validating", expectedEvidenceFingerprint: snapshot.evidenceFingerprint,
    expectedNormalBasis: basis, report, readEvidence: () => collectTurnTerminalReportEvidence(f.store, f.turn.id, { generatedAt: later }),
    publicationItem: {
      id: `result_terminal_report:${record.id}`, threadId: f.thread.id, turnId: f.turn.id, kind: "terminal_report", status: "committed",
      actorType: "system", visibility: "thread_participants", idempotencyKey: `terminal-report:${record.id}`,
      payload: { reportId: record.id, generation, sourceKind: "turn", sourceId: f.turn.id, evidenceFingerprint: snapshot.evidenceFingerprint, outcomeStatus: report.outcome.status },
      domainRefs: [{ type: "terminal_report", id: record.id }, { type: "conversation_item", id: f.turn.sourceItemId },
        { type: "turn", id: f.turn.id }, ...basis.runIds.map((id) => ({ type: "run", id }))],
    },
    publicationEventIdempotencyKey: `terminal-report:${record.id}:published`, now: later,
  };
}

function approval(f) {
  return f.store.createApprovalRequest({ runId: f.run.id, taskId: f.run.taskId, actionType: "bash", risk: "medium",
    title: "Pending command", description: "Must not publish success", payload: { type: "bash", cwd: f.cwd, command: "echo ok", riskFlags: [] },
  }, later);
}

function addRun(f, role) {
  return f.store.createRun({ id: `normal-report-${role}`, cwd: f.cwd, taskId: f.run.taskId, threadId: f.thread.id, turnId: f.turn.id,
    turnRunRole: role, parentRunId: f.run.id, providerName: "test-provider", providerModel: "test-model",
    taskSnapshot: { id: f.run.taskId, title: "Another attempt" }, providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: { cwd: f.cwd, responseLanguage: "zh-CN" }, createdAt: later });
}

async function fixture(t, actorType = "local_user") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-normal-report-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  f.database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => { f.database.close(); f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  configureTerminalReportStore(f.store, { enabled: true });
  const channel = f.store.createChannel({ name: "Backing task only", boundPath: cwd }, now);
  const task = f.store.createTask({ channelId: channel.id, title: "Edit and verify", prompt: "Edit and verify" }, now);
  f.thread = f.store.createLingThread({ kind: "conversation", title: task.title, objective: task.prompt }, now);
  const accepted = f.store.appendConversationUserTurn({
    threadId: f.thread.id, itemId: "normal-report-source", turnId: "normal-report-turn",
    title: task.title, userInstruction: task.prompt, actorType, actorId: actorType === "local_user" ? "local-user" : undefined, idempotencyKey: "normal-report-input",
    payload: { body: task.prompt, format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }, now);
  f.turn = f.store.getLingTurn(accepted.turnId);
  f.run = f.store.createRun({
    id: "normal-report-run", cwd, taskId: task.id, threadId: f.thread.id, turnId: f.turn.id,
    providerName: "test-provider", providerModel: "test-model",
    taskSnapshot: { id: task.id, title: task.title }, providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: { cwd, responseLanguage: "zh-CN" }, createdAt: now,
  });
  f.store.appendEvent(f.run.id, "tool_start", { toolCallId: "edit", toolName: "edit", args: { path: "src/report.ts" } });
  f.store.appendEvent(f.run.id, "tool_end", { toolCallId: "edit", toolName: "edit", isError: false });
  f.store.markRunSucceeded(f.run.id, later);
  return f;
}
