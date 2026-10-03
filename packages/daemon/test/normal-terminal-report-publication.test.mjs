import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildDeterministicTerminalReport, captureNormalTerminalReportBasis, createSqliteRunStore, resolveRuntimePaths } from "../../core/dist/index.js";
import { collectRunTerminalReportEvidence, collectTurnTerminalReportEvidence } from "../dist/features/channels/terminal-report-evidence.js";
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

for (const status of ["failed", "cancelled"]) {
  test(`normal interrupted ${status} report publishes once without claiming tool settlement`, async (t) => {
    const f = await interruptedFixture(t, status);
    const basis = captureNormalTerminalReportBasis(f.store, { kind: "turn", id: f.turn.id });
    assert.equal(basis.settled, false);
    assert.equal(basis.failurePublicationAllowed, true);
    assert.equal(basis.unsettledTools.length, 1);
    const result = await processTurnTerminalReport(f.store, f.turn.id, { now: later });
    const report = result.record.report;
    assert.notEqual(report.outcome.status, "succeeded");
    const risk = report.risks.find(risk => risk.id === `execution-unconfirmed:${f.run.id}:unfinished`);
    assert.equal(risk?.severity, "critical");
    assert.equal(risk?.status, "unverified");
    assert.match(risk?.summary, /未确认/);
    const unfinishedCheck = report.verification.find(check => check.sourceRefs.some(ref => ref.kind === "operation"
      && ref.id === `tool:${f.run.id}:unfinished`));
    assert.ok(unfinishedCheck, "an interrupted verification command remains inspectable");
    assert.equal(unfinishedCheck.status, "unknown", "Run failure is not a command exit receipt");
    assert.match(unfinishedCheck.summary, /未确认/);
    const runCheck = collectRunTerminalReportEvidence(f.store, f.run.id).checks.find(check => check.id === `tool:${f.run.id}:unfinished`);
    assert.equal(runCheck?.status, "unknown");
    assert.match(runCheck?.summary, /未确认/);
    assert.ok(result.record.resultItemId);
    assert.equal(f.store.listEvents(f.run.id).filter(event => event.type === "tool_start").length, 2);
    assert.equal(f.store.listEvents(f.run.id).filter(event => event.type === "tool_end").length, 1);
    f.store.close(); f.store = createSqliteRunStore(f.cwd);
    configureTerminalReportStore(f.store, { enabled: true });
    await recoverTerminalReports(f.store);
    assert.equal(f.store.getTerminalReport(result.record.id).resultItemId, result.record.resultItemId);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_items WHERE kind='terminal_report'").get().n, 1);
    assert.equal(captureNormalTerminalReportBasis(f.store, { kind: "turn", id: f.turn.id }).settled, false);
  });
}

for (const change of ["missing fence", "pending approval", "live successor", "malformed identity"]) {
  test(`normal interrupted publication refuses ${change}`, async (t) => {
    const f = await interruptedFixture(t, "failed", change !== "missing fence");
    const input = candidate(f);
    if (change === "pending approval") approval(f);
    if (change === "live successor") addRun(f, "retry");
    if (change === "malformed identity") f.store.appendEvent(f.run.id, "tool_start", { toolName: "bash", args: { command: "unknown" } });
    const basis = captureNormalTerminalReportBasis(f.store, { kind: "turn", id: f.turn.id });
    assert.equal(basis.failurePublicationAllowed, false);
    assert.equal(f.store.commitTerminalReportPublication(input).ok, false);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_items WHERE kind='terminal_report'").get().n, 0);
  });
}

for (const change of ["omit warning", "mitigate warning", "confirm stop", "claim success", "invent failed check", "invent passed check"]) {
  test(`normal interrupted publication refuses synthesized ${change}`, async (t) => {
    const f = await interruptedFixture(t, "failed");
    const input = candidate(f);
    const risk = input.report.risks.find(risk => risk.id === `execution-unconfirmed:${f.run.id}:unfinished`);
    assert.ok(risk);
    if (change === "omit warning") input.report.risks = input.report.risks.filter(entry => entry !== risk);
    if (change === "mitigate warning") risk.status = "mitigated";
    if (change === "confirm stop") risk.summary = "All command processes have definitely stopped.";
    if (change === "claim success") input.report.outcome.status = "succeeded";
    if (change === "invent failed check" || change === "invent passed check") {
      const check = input.report.verification.find(entry => entry.sourceRefs.some(ref => ref.kind === "operation"
        && ref.id === `tool:${f.run.id}:unfinished`));
      assert.ok(check);
      check.status = change === "invent failed check" ? "failed" : "passed";
    }
    assert.equal(f.store.commitTerminalReportPublication(input).ok, false);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_items WHERE kind='terminal_report'").get().n, 0);
  });
}

test("normal late tool_end after interruption neither settles execution nor removes its warning", async (t) => {
  const f = await interruptedFixture(t, "failed");
  const input = candidate(f);
  f.store.appendEvent(f.run.id, "tool_end", { toolCallId: "unfinished", toolName: "bash", isError: false });
  assert.deepEqual(f.store.commitTerminalReportPublication(input), { ok: false, code: "stale_completion_basis" });
  const basis = captureNormalTerminalReportBasis(f.store, { kind: "turn", id: f.turn.id });
  assert.equal(basis.settled, false);
  assert.equal(basis.failurePublicationAllowed, true);
  const result = await processTurnTerminalReport(f.store, f.turn.id, { now: later });
  assert.notEqual(result.record.report.outcome.status, "succeeded");
  assert.ok(result.record.report.risks.some(risk => risk.id === `execution-unconfirmed:${f.run.id}:unfinished`));
});

async function interruptedFixture(t, status, withFence = true) {
  const f = await fixture(t);
  f.store.appendEvent(f.run.id, "tool_start", { toolCallId: "unfinished", toolName: "bash", args: { command: "node -e 'require(\"node:assert\").ok(true); setInterval(() => {}, 1000)'" } });
  if (withFence) f.store.appendEvent(f.run.id, status === "failed" ? "run_error" : "run_cancelled", { message: "runtime_interrupted_no_checkpoint" });
  if (status === "failed") f.store.markRunFailed(f.run.id, later, "runtime_interrupted_no_checkpoint");
  else f.store.markRunCancelled(f.run.id, later);
  return f;
}

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

test("one conflicting old report cannot strand an independent interrupted turn during startup recovery", async (t) => {
  const f = await fixture(t);
  const input = candidate(f);
  commitOrphan(f, input);
  f.store.appendConversationItem({ ...input.publicationItem,
    payload: { ...input.publicationItem.payload, generation: 999 },
  }, later);
  const oldReport = f.store.getTerminalReport(input.reportId);
  const oldItem = f.store.getConversationItem(input.publicationItem.id);
  const interrupted = addIndependentInterruptedTurn(f);

  await assert.rejects(recoverTerminalReports(f.store), error => error.code === "item_conflict");
  const reports = f.store.listTerminalReports({ sourceKind: "turn", sourceId: interrupted.turn.id });
  assert.equal(reports.length, 1);
  assert.ok(reports[0].resultItemId, "the independent turn must be atomically recovered despite the earlier conflict");
  assert.equal(reports[0].report.outcome.status, "failed");
  assert.ok(reports[0].report.risks.some(risk => risk.id === `execution-unconfirmed:${interrupted.run.id}:unfinished`));
  assert.deepEqual(f.store.getTerminalReport(input.reportId), oldReport, "a conflicting old report stays audit-only");
  assert.deepEqual(f.store.getConversationItem(input.publicationItem.id), oldItem, "recovery must not repair a collision by overwriting it");
  const diagnostics = f.database.prepare("SELECT data_json FROM control_plane_events WHERE action='terminal_report.recovery_failed'").all();
  assert.equal(diagnostics.length, 1, "a failed source is attempted only once per sweep");
  assert.equal(JSON.parse(diagnostics[0].data_json).code, "item_conflict");
  assert.equal(JSON.parse(diagnostics[0].data_json).sourceId, f.turn.id);

  await assert.rejects(recoverTerminalReports(f.store), error => error.code === "item_conflict");
  assert.equal(f.store.listTerminalReports({ sourceKind: "turn", sourceId: interrupted.turn.id }).length, 1);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_items WHERE turn_id=? AND kind='terminal_report'").get(interrupted.turn.id).n, 1);
});

function addIndependentInterruptedTurn(f) {
  const accepted = f.store.appendConversationUserTurn({ threadId: f.thread.id,
    itemId: "independent-source", turnId: "independent-turn", title: "Interrupted command", userInstruction: "Run command",
    actorType: "local_user", actorId: "local-user", idempotencyKey: "independent-input",
    payload: { body: "Run command", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }, later);
  const turn = f.store.getLingTurn(accepted.turnId);
  const run = f.store.createRun({ id: "independent-run", cwd: f.cwd, taskId: f.run.taskId, threadId: f.thread.id, turnId: turn.id,
    providerName: "test-provider", providerModel: "test-model", taskSnapshot: { id: f.run.taskId, title: "Interrupted command" },
    providerSnapshot: { provider: "test-provider", model: "test-model" }, requestSnapshot: { cwd: f.cwd, responseLanguage: "zh-CN" }, createdAt: later,
  });
  f.store.appendEvent(run.id, "tool_start", { toolCallId: "unfinished", toolName: "bash", args: { command: "node long-task" } });
  f.store.appendEvent(run.id, "run_error", { message: "runtime_interrupted_no_checkpoint" });
  f.store.markRunFailed(run.id, later, "runtime_interrupted_no_checkpoint");
  return { turn, run };
}

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
