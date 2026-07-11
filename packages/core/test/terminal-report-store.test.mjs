import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { buildTerminalReport, buildTerminalReportSnapshot } from "./terminal-report-fixture.mjs";

test("sqlite terminal reports create, update, commit, publish, list, and reopen", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-store-"));
  try {
    const store = createSqliteRunStore(cwd);
    const snapshot = buildTerminalReportSnapshot();
    const draft = store.createTerminalReportDraft({ id: "terminal_report_store", evidenceSnapshot: snapshot }, "2026-07-11T01:05:01.000Z");
    assert.equal(draft.status, "draft");
    assert.equal(draft.generation, 1);
    assert.equal(store.getTerminalReportForSource("run", snapshot.source.id)?.id, draft.id);

    const updatedSnapshot = buildTerminalReportSnapshot({
      id: "terminal_report_snapshot_updated",
      objective: "Persist and publish a terminal report",
      generatedAt: "2026-07-11T01:05:02.000Z",
    });
    const validating = store.updateTerminalReportDraft({
      reportId: draft.id,
      expectedStatus: "draft",
      expectedEvidenceFingerprint: snapshot.evidenceFingerprint,
      status: "validating",
      evidenceSnapshot: updatedSnapshot,
      promptVersion: "terminal-report-v1",
      attemptCount: 1,
      now: "2026-07-11T01:05:02.000Z",
    });
    assert.equal(validating.status, "validating");
    assert.equal(validating.evidenceSnapshot.objective, "Persist and publish a terminal report");

    const report = buildTerminalReport(updatedSnapshot, { id: draft.id });
    const committed = store.commitTerminalReport({
      reportId: draft.id,
      expectedStatus: "validating",
      expectedEvidenceFingerprint: updatedSnapshot.evidenceFingerprint,
      report,
      synthesisMode: "model",
      promptVersion: "terminal-report-v1",
      attemptCount: 1,
      now: report.committedAt,
    });
    assert.equal(committed.status, "committed");
    assert.equal(committed.outcomeStatus, "succeeded");
    assert.equal(committed.report?.outcome.title, report.outcome.title);

    const published = store.markTerminalReportPublished({
      reportId: draft.id,
      messageId: "message_terminal_report",
      now: "2026-07-11T01:05:03.000Z",
    });
    assert.equal(published.publishedMessageId, "message_terminal_report");
    assert.equal(store.markTerminalReportPublished({
      reportId: draft.id,
      messageId: "message_terminal_report",
      now: "2026-07-11T01:05:04.000Z",
    }).publishedMessageId, "message_terminal_report");
    assert.deepEqual(store.listTerminalReports({ sourceKind: "run" }).map((item) => item.id), [draft.id]);
    assert.throws(() => store.updateTerminalReportDraft({
      reportId: draft.id,
      expectedStatus: "validating",
      expectedEvidenceFingerprint: updatedSnapshot.evidenceFingerprint,
      now: "2026-07-11T01:05:05.000Z",
    }), /immutable/);
    assert.throws(() => store.markTerminalReportPublished({
      reportId: draft.id,
      messageId: "message_other",
      now: "2026-07-11T01:05:05.000Z",
    }), /another message/);

    store.close();
    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.getTerminalReport(draft.id)?.publishedMessageId, "message_terminal_report");
      assert.equal(reopened.getTerminalReport(draft.id)?.report?.id, draft.id);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
