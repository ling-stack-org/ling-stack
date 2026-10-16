import assert from "node:assert/strict";
import test from "node:test";
import { terminalReportToViewModel } from "@ling-stack/conversation-ui-core";
import { buildDeterministicTerminalReport } from "../../../packages/core/dist/index.js";
import { formatSynchronousCatalogMessage } from "../../../packages/localization/dist/index.js";
import { taskTerminalFixture } from "../../../packages/daemon/test/support/task-terminal-empty-contribution-fixture.mjs";
import { terminalReportCopyText } from "../src/shared/conversation/timeline/terminal-report-copy-text.ts";

function timelineItem(report, resultItemId = "b010-core-only-blocked-report") {
  return { id: resultItemId, kind: "terminalReport", reportId: report.id, resultItemId, generation: 1,
    revision: 1, threadSequence: 1, partIndex: 0, status: report.outcome.status, outcomeStatus: report.outcome.status,
    language: report.language, title: report.outcome.title, summary: report.outcome.summary,
    outcomeSourceRefs: report.outcome.sourceRefs, corrections: report.outcome.corrections,
    changes: report.changes, verification: report.verification, participants: report.participants,
    artifacts: report.artifacts, risks: report.risks, references: report.references,
    changeCount: report.changes.length, verificationCount: report.verification.length,
    participantCount: report.participants.length, artifactCount: report.artifacts.length, riskCount: report.risks.length };
}

for (const language of ["en-US", "zh-CN"]) {
  for (const status of ["cancelled", "failed", "blocked"]) {
    test(`B010 ${language} ${status}: real fallback content stays truthful in shared rows and copy`, async t => {
      const f = await taskTerminalFixture(t, { status, language, synthesis: status === "failed" ? "request-failed" : "unavailable" });
      let report, resultItemId;
      if (status === "blocked") report = buildDeterministicTerminalReport(f.collect());
      else {
        const result = await f.process();
        assert.ok(result);
        const persisted = f.store.getTerminalReport(result.record.id);
        report = persisted.report;
        resultItemId = persisted.resultItemId;
        assert.ok(resultItemId, "copy must use the actual published task report");
      }
      const expected = formatSynchronousCatalogMessage(language, `terminal_report.outcome.${status}`);
      const falseCompletion = formatSynchronousCatalogMessage(language, "terminal_report.participant.completed",
        { displayName: report.participants[0].displayName });
      const view = terminalReportToViewModel(report);
      const row = view.rows.find(item => item.reportSection === "participant");
      assert.ok(row);
      assert.equal(row.description, expected);
      assert.notEqual(row.description, falseCompletion);
      const copy = terminalReportCopyText(timelineItem(report, resultItemId));
      assert.ok(copy.includes(expected));
      assert.equal(copy.includes(falseCompletion), false);
      assert.ok(copy.includes(report.participants[0].displayName));
      assert.equal(report.participants[0].status, status);
    });
  }
}
