import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDeterministicTerminalReport, createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { collectWorkflowTerminalReportEvidence } from "../dist/features/channels/terminal-report-evidence.js";
import { publishTerminalReport } from "../dist/features/channels/terminal-report-publisher.js";
import { createTerminalWorkflowFixture } from "./terminal-report-coordinator-fixture.mjs";

// Regression: R11-PUBLICATION — an unpublished committed revision hid the real result.
// Found by /qa on 2026-10-25
// Report: output/e6-20260928/p3-bash-cwd-contract-live-20261025/exploration-178.json
async function fixture(t, suffix, blocked = false) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-report-publication-selection-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const f = { ...createTerminalWorkflowFixture(store, cwd, suffix), cwd, store };
  if (blocked) store.updateChannelWorkflow(f.workflow.id, { status: "blocked" }, "2026-07-11T10:00:00.000Z");
  return f;
}

function commit(f, generation) {
  const now = `2026-07-11T10:0${generation}:00.000Z`;
  const snapshot = collectWorkflowTerminalReportEvidence(f.store, f.workflow.id, { generatedAt: now });
  const draft = f.store.createTerminalReportDraft({ generation, evidenceSnapshot: snapshot }, now);
  f.store.updateTerminalReportDraft({ reportId: draft.id, expectedStatus: "draft",
    expectedEvidenceFingerprint: draft.evidenceFingerprint, status: "validating", now });
  const report = buildDeterministicTerminalReport(snapshot, { id: draft.id, committedAt: now });
  f.store.commitTerminalReport({ reportId: draft.id, expectedStatus: "validating",
    expectedEvidenceFingerprint: draft.evidenceFingerprint, report, synthesisMode: "deterministic_fallback",
    promptVersion: report.synthesis.promptVersion, attemptCount: 0, now });
  return report;
}

function publish(f, report) {
  const item = publishTerminalReport({ store: f.store, report, now: report.committedAt });
  assert.ok(item);
  assert.equal(f.store.getTerminalReport(report.id).resultItemId, item.id);
  return item;
}

const query = f => ({ sourceKind: "workflow", sourceId: f.workflow.id });
const ids = rows => rows.map(row => row.id);

test("display selection keeps a published result when successor publication fails without settling a successful Turn again", async t => {
  const f = await fixture(t, "orphan");
  const first = commit(f, 1), item = publish(f, first);
  const turnBefore = f.store.getLingTurn(f.workflow.metadata.sourceTurnId);
  const orphan = commit(f, 2);
  assert.throws(() => publish(f, orphan), /source_turn_conflict/);
  assert.deepEqual(f.store.getLingTurn(turnBefore.id), turnBefore);
  assert.equal(f.store.getTerminalReport(orphan.id).resultItemId, undefined);
  assert.deepEqual(ids(f.store.listTerminalReports({ ...query(f), effectiveOnly: true })), [orphan.id], "Internal committed evidence keeps existing semantics");
  assert.deepEqual(ids(f.store.listTerminalReports({ ...query(f), publishedOnly: true, effectiveOnly: true, limit: 1 })), [first.id]);
  assert.equal(f.store.getConversationItem(item.id).payload.reportId, first.id);
  assert.equal(f.store.listTerminalReports(query(f)).length, 2, "The orphan stays available for audit/recovery");
});

test("published filtering happens before LIMIT and rejects dangling or foreign publication markers", async t => {
  const f = await fixture(t, "marker");
  const first = commit(f, 1), item = publish(f, first);
  const original = f.store.getConversationItem(item.id);
  const foreign = f.store.appendConversationItem({ threadId: original.threadId, turnId: original.turnId,
    channelId: original.channelId, kind: "terminal_report", status: "committed", actorType: "system",
    visibility: "channel", payload: original.payload, domainRefs: [] }, "2026-07-11T10:01:30.000Z");
  for (const [generation, messageId] of [[2, "missing-result-item"], [3, foreign.id]]) {
    const report = commit(f, generation);
    f.store.markTerminalReportPublished({ reportId: report.id, messageId, now: report.committedAt });
  }
  assert.deepEqual(ids(f.store.listTerminalReports({ ...query(f), publishedOnly: true, effectiveOnly: true, limit: 1 })), [first.id]);
  assert.equal(f.store.listTerminalReports(query(f)).length, 3);
});

test("a genuinely published retry replaces the older result and is not hidden by a later orphan", async t => {
  const f = await fixture(t, "retry", true);
  const first = commit(f, 1), firstItem = publish(f, first);
  f.store.transitionLingTurnStatus({ turnId: f.workflow.metadata.sourceTurnId, expectedStatus: "blocked",
    event: "start", actor: "system", reason: "Synthetic supported retry", idempotencyKey: "publication-selection-retry",
    now: "2026-07-11T10:01:10.000Z" });
  f.store.transitionChannelWorkflowStatus({ workflowId: f.workflow.id, expectedStatus: "blocked", event: "start",
    actor: "system", reason: "Synthetic supported retry", now: "2026-07-11T10:01:11.000Z" });
  f.store.transitionChannelWorkflowStatus({ workflowId: f.workflow.id, expectedStatus: "running", event: "all_steps_succeeded",
    actor: "system", reason: "Synthetic completed retry", now: "2026-07-11T10:01:12.000Z" });
  const second = commit(f, 2), secondItem = publish(f, second);
  assert.equal(f.store.getConversationItem(secondItem.id).supersedesItemId, firstItem.id);
  commit(f, 3);
  assert.deepEqual(ids(f.store.listTerminalReports({ ...query(f), publishedOnly: true, effectiveOnly: true })), [second.id]);
  assert.deepEqual(ids(f.store.listTerminalReports({ ...query(f), publishedOnly: true })).sort(), [first.id, second.id].sort());
});

for (const visibility of ["operator", "agent_private"]) test(`a ${visibility} result marker cannot shadow a channel-visible publication`, async t => {
  const f = await fixture(t, `visibility-${visibility}`);
  const first = commit(f, 1), item = publish(f, first), original = f.store.getConversationItem(item.id);
  const hidden = commit(f, 2), record = f.store.getTerminalReport(hidden.id);
  const privateItem = f.store.appendConversationItem({ threadId: original.threadId, turnId: original.turnId,
    channelId: original.channelId, kind: "terminal_report", status: "committed", actorType: "system", visibility,
    ...(visibility === "agent_private" ? { visibilityOwnerId: "engineer" } : {}),
    payload: { ...original.payload, reportId: hidden.id, generation: record.generation,
      evidenceFingerprint: record.evidenceFingerprint, outcomeStatus: record.outcomeStatus }, domainRefs: [] }, hidden.committedAt);
  f.store.markTerminalReportPublished({ reportId: hidden.id, messageId: privateItem.id, now: hidden.committedAt });
  assert.deepEqual(ids(f.store.listTerminalReports({ ...query(f), publishedOnly: true, effectiveOnly: true })), [first.id]);
  assert.equal(f.store.getConversationItem(privateItem.id).visibility, visibility, "Do not rewrite private history to make it visible");
});

for (const hasPublished of [false, true]) test(`report collection APIs select canonical publications; published=${hasPublished}`, async t => {
  const f = await fixture(t, `api-${hasPublished}`);
  const first = commit(f, 1);
  if (hasPublished) publish(f, first);
  const orphan = commit(f, 2);
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: f.cwd,
    channels: { terminalReports: false } }); // Read-only API test; no startup publication sweep.
  await daemon.start();
  try {
    const base = `http://127.0.0.1:${daemon.server.address().port}`;
    const search = new URLSearchParams({ cwd: f.cwd, sourceKind: "workflow", sourceId: f.workflow.id, limit: "1" });
    for (const route of ["/terminal-reports", `/channels/${f.channel.id}/terminal-reports`]) {
      const current = await fetch(`${base}${route}?${search}`);
      assert.equal(current.status, 200);
      assert.deepEqual(ids((await current.json()).reports), hasPublished ? [first.id] : []);
      const historySearch = new URLSearchParams(search);
      historySearch.set("includeHistory", "true");
      historySearch.set("limit", "20");
      const history = await fetch(`${base}${route}?${historySearch}`);
      assert.equal(history.status, 200);
      assert.deepEqual(ids((await history.json()).reports).sort(), [first.id, orphan.id].sort());
    }
  } finally {
    await daemon.stop(); // Drain the Daemon before fixture.after closes/removes its store.
  }
});
