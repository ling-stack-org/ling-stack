import assert from "node:assert/strict";
import test from "node:test";
import { buildDeterministicTerminalReport, validateTerminalReport } from "../../core/dist/index.js";
import { formatSynchronousCatalogMessage } from "../../localization/dist/index.js";
import { taskTerminalFixture } from "./support/task-terminal-empty-contribution-fixture.mjs";

function expectedEmptyContribution(participant, language) {
  return participant.status === "completed"
    ? formatSynchronousCatalogMessage(language, "terminal_report.participant.completed", { displayName: participant.displayName })
    : formatSynchronousCatalogMessage(language, `terminal_report.outcome.${participant.status}`);
}

for (const language of ["en-US", "zh-CN"]) {
  for (const status of ["cancelled", "failed", "succeeded"]) {
    for (const synthesis of ["unavailable", "request-failed"]) {
      test(`B010 ${language} task ${status}, synthesis ${synthesis}: fallback publication stays truthful`, async t => {
        const f = await taskTerminalFixture(t, { status, language, synthesis });
        assert.equal(f.thread.kind, "task");
        assert.equal(f.executionCalls, 1);
        assert.equal(f.run.status, status);
        assert.equal(f.run.errorMessage, undefined, "SQL NULL is exposed as undefined by the public Run mapper");
        const snapshot = f.collect();
        assert.equal(snapshot.source.kind, "run");
        assert.equal(snapshot.operations.length, 1, "a completed actual read makes this an executed-work report");
        assert.equal(snapshot.participants.length, 1);
        assert.deepEqual(snapshot.participants[0].contributionSummaries, []);
        const result = await f.process();
        assert.ok(result);
        assert.equal(result.record.status, "fallback");
        assert.equal(result.record.report.synthesis.mode, "deterministic_fallback");
        assert.equal(f.synthesisCalls, synthesis === "request-failed" ? 1 : 0);
        const report = result.record.report;
        assert.equal(report.outcome.status, status);
        assert.equal(report.participants[0].status, status === "succeeded" ? "completed" : status);
        assert.equal(report.participants[0].contribution, expectedEmptyContribution(report.participants[0], language));
        assert.equal(validateTerminalReport(report, result.record.evidenceSnapshot).ok, true);
        const reopened = f.reopen();
        try {
          const durable = reopened.getTerminalReport(result.record.id);
          assert.deepEqual(durable.report.participants, report.participants);
          assert.equal(durable.report.outcome.status, status);
          assert.ok(durable.resultItemId, "the real task-run coordinator must publish its committed result Item");
          assert.equal(reopened.getConversationItem(durable.resultItemId).kind, "terminal_report");
          assert.equal(reopened.getConversationItem(durable.resultItemId).status, "committed");
        } finally { reopened.close(); }
      });
    }
  }

  test(`B010 ${language} legal blocked Workflow empty contribution is not completed work`, async t => {
    const f = await taskTerminalFixture(t, { status: "blocked", language });
    assert.equal(f.run.status, "failed", "blocked belongs to Workflow/Step, never an invented Run status");
    assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "blocked");
    const snapshot = f.collect();
    assert.equal(snapshot.participants[0].status, "blocked");
    assert.deepEqual(snapshot.participants[0].contributionSummaries, []);
    const report = buildDeterministicTerminalReport(snapshot);
    assert.equal(report.participants[0].contribution, expectedEmptyContribution(report.participants[0], language));
    assert.equal(validateTerminalReport(report, snapshot).ok, true);
  });

  test(`B010 ${language} an existing contribution is preserved, not replaced by status prose`, async t => {
    const contribution = "Read the owned evidence; the remaining assignment was cancelled.";
    const f = await taskTerminalFixture(t, { status: "cancelled", language, contribution });
    const snapshot = f.collect();
    assert.deepEqual(snapshot.participants[0].contributionSummaries, [contribution]);
    const result = await f.process();
    assert.equal(result.record.report.participants[0].contribution, contribution);
    assert.equal(result.record.report.participants[0].status, "cancelled");
  });

  for (const surface of ["conversation", "teammate_direct"]) {
    test(`B010 ${language} ${surface} retains its existing typed-action contribution`, async t => {
      const f = await taskTerminalFixture(t, { status: "cancelled", language, surface });
      const snapshot = f.collect();
      assert.equal(snapshot.source.kind, "turn");
      assert.equal(snapshot.participants[0].status, "cancelled");
      assert.ok(snapshot.participants[0].contributionSummaries.length > 0);
      const expected = snapshot.participants[0].contributionSummaries.join("; ");
      assert.match(expected, /evidence\.txt|Read/u);
      const report = buildDeterministicTerminalReport(snapshot);
      assert.equal(report.participants[0].contribution, expected);
    });
  }
}
