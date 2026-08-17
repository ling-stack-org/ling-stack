import { appendChannelItemFixture, getChannelItemViewFixture, listChannelItemViewsFixture, updateChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  buildDeterministicTerminalReport,
  createSqliteRunStore,
  resolveRuntimePaths,
} from "../../core/dist/index.js";
import {
  configureTerminalReportStore,
  recoverWorkflowTerminalReports,
} from "../dist/features/channels/terminal-report-coordinator.js";
import { collectWorkflowTerminalReportEvidence } from "../dist/features/channels/terminal-report-evidence.js";
import { publishWorkflowTerminalReport } from "../dist/features/channels/terminal-report-publisher.js";
import { createTerminalWorkflowFixture } from "./terminal-report-coordinator-fixture.mjs";

test("terminal report recovery publishes committed reports without duplicating the message", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-recovery-"));
  const store = createSqliteRunStore(cwd);
  try {
    const fixture = createTerminalWorkflowFixture(store, cwd, "recovery");
    const now = "2026-07-11T05:04:00.000Z";
    const snapshot = collectWorkflowTerminalReportEvidence(store, fixture.workflow.id, { generatedAt: now });
    const draft = store.createTerminalReportDraft({ id: "terminal_report_recovery", evidenceSnapshot: snapshot }, now);
    store.updateTerminalReportDraft({
      reportId: draft.id,
      expectedStatus: "draft",
      expectedEvidenceFingerprint: draft.evidenceFingerprint,
      status: "validating",
      now,
    });
    const report = buildDeterministicTerminalReport(snapshot, { id: draft.id, committedAt: now });
    store.commitTerminalReport({
      reportId: draft.id,
      expectedStatus: "validating",
      expectedEvidenceFingerprint: snapshot.evidenceFingerprint,
      report,
      synthesisMode: "deterministic_fallback",
      promptVersion: report.synthesis.promptVersion,
      attemptCount: 0,
      now,
    });
    assert.equal(store.getTerminalReport(draft.id)?.publishedMessageId, undefined);

    configureTerminalReportStore(store, { enabled: true });
    await recoverWorkflowTerminalReports(store);
    const recovered = store.getTerminalReport(draft.id);
    assert.ok(recovered?.publishedMessageId);
    await recoverWorkflowTerminalReports(store);
    assert.equal(listChannelItemViewsFixture(store, { channelId: fixture.channel.id, limit: 100 }).filter((message) => message.id === recovered?.publishedMessageId).length, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal report recovery does not backfill workflows created before rollout", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-recovery-watermark-"));
  const store = createSqliteRunStore(cwd);
  try {
    const createdAt = "2026-07-10T23:59:59.999Z";
    const channel = store.createChannel({ name: "Historical workflow", boundPath: cwd }, createdAt);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Historical terminal workflow",
      objective: "Must not receive a rollout report",
      status: "succeeded",
      createdBy: "ling_agent",
    }, createdAt);

    configureTerminalReportStore(store, { enabled: true });
    await recoverWorkflowTerminalReports(store);

    assert.equal(store.listTerminalReports({ sourceKind: "workflow", sourceId: workflow.id, limit: 100 }).length, 0);
    assert.equal(listChannelItemViewsFixture(store, { channelId: channel.id, limit: 100 }).length, 0);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal report recovery rejects incompatible partial publication lineage", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-turn-recovery-"));
  const store = createSqliteRunStore(cwd);
  try {
    const fixture = createTerminalWorkflowFixture(store, cwd, "turn-recovery");
    const sourceItem = store.getConversationItem(fixture.sourceMessage.id);
    assert.ok(sourceItem?.turnId);
    store.updateChannelWorkflow(fixture.workflow.id, {
      metadata: { ...fixture.workflow.metadata, sourceTurnId: sourceItem.turnId },
    }, "2026-07-11T05:03:59.000Z");
    store.transitionLingTurnStatus({
      turnId: sourceItem.turnId,
      expectedStatus: "open",
      event: "start",
      actor: "system",
      now: "2026-07-11T05:03:59.000Z",
    });
    const now = "2026-07-11T05:04:00.000Z";
    const snapshot = collectWorkflowTerminalReportEvidence(store, fixture.workflow.id, { generatedAt: now });
    const draft = store.createTerminalReportDraft({ id: "terminal_report_turn_recovery", evidenceSnapshot: snapshot }, now);
    store.updateTerminalReportDraft({ reportId: draft.id, expectedStatus: "draft", expectedEvidenceFingerprint: draft.evidenceFingerprint, status: "validating", now });
    const report = buildDeterministicTerminalReport(snapshot, { id: draft.id, committedAt: now });
    store.commitTerminalReport({
      reportId: draft.id,
      expectedStatus: "validating",
      expectedEvidenceFingerprint: snapshot.evidenceFingerprint,
      report,
      synthesisMode: "deterministic_fallback",
      promptVersion: report.synthesis.promptVersion,
      attemptCount: 0,
      now,
    });
    const published = publishWorkflowTerminalReport({ store, report, now });
    assert.equal(store.getLingTurn(sourceItem.turnId).status, "succeeded");
    const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
    database.prepare("UPDATE ling_turns SET status = 'running', completed_at = NULL WHERE id = ?").run(sourceItem.turnId);
    database.close();
    assert.equal(store.getLingTurn(sourceItem.turnId).status, "running");

    configureTerminalReportStore(store, { enabled: true });
    await assert.rejects(
      recoverWorkflowTerminalReports(store),
      /publication conflict: terminal_report_turn_recovery\/publication_event_conflict/u,
    );
    assert.equal(store.getLingTurn(sourceItem.turnId).status, "running");
    assert.equal(listChannelItemViewsFixture(store, { channelId: fixture.channel.id, limit: 100 }).filter((message) => message.id === published.id).length, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
