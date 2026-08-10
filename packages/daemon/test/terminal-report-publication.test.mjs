import { appendChannelItemFixture, getChannelItemViewFixture, listChannelItemViewsFixture, updateChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildDeterministicTerminalReport,
  createSqliteRunStore,
} from "../../core/dist/index.js";
import { collectWorkflowTerminalReportEvidence } from "../dist/features/channels/terminal-report-evidence.js";
import {
  publishWorkflowTerminalReport,
  terminalReportMessageId,
} from "../dist/features/channels/terminal-report-publisher.js";
import { createTerminalWorkflowFixture } from "./terminal-report-coordinator-fixture.mjs";

test("terminal report publication uses a deterministic message id across mark-published retries", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-publication-"));
  const store = createSqliteRunStore(cwd);
  try {
    const fixture = createTerminalWorkflowFixture(store, cwd, "publication");
    const now = "2026-07-11T05:04:00.000Z";
    const snapshot = collectWorkflowTerminalReportEvidence(store, fixture.workflow.id, { generatedAt: now });
    const draft = store.createTerminalReportDraft({ id: "terminal_report_publication", evidenceSnapshot: snapshot }, now);
    const validating = store.updateTerminalReportDraft({
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
      expectedEvidenceFingerprint: validating.evidenceFingerprint,
      report,
      synthesisMode: "deterministic_fallback",
      promptVersion: report.synthesis.promptVersion,
      attemptCount: 0,
      now,
    });

    const message = publishWorkflowTerminalReport({ store, report, now });
    assert.equal(message?.id, terminalReportMessageId(report.id));
    assert.equal(publishWorkflowTerminalReport({ store, report, now: "2026-07-11T05:05:00.000Z" })?.id, message?.id);
    assert.equal(listChannelItemViewsFixture(store, { channelId: fixture.channel.id, limit: 100 }).filter((item) => item.id === message?.id).length, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
