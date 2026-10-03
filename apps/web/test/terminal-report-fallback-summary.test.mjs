import assert from "node:assert/strict";
import test from "node:test";
import { terminalReportFallbackSummary } from "../src/shared/conversation/timeline/terminal-report-fallback-summary.ts";

function report(overrides = {}) {
  return { id: "item", kind: "terminalReport", reportId: "report", resultItemId: "result", generation: 1,
    status: "failed", outcomeStatus: "failed", summary: "任务执行失败。", title: "Task", language: "zh-CN",
    corrections: [], changes: [], verification: [], participants: [], artifacts: [], references: [], sourceRefs: [],
    risks: [], ...overrides };
}
const risk = (summary, overrides = {}) => ({ id: "risk", summary, severity: "critical", status: "unverified",
  sourceRefs: [{ kind: "run", id: "run", visibility: "conversation" }], ...overrides });

test("a report-only failure explains interruption and unconfirmed effects once in readable prose", () => {
  const warning = "未收到工具结束证据，实际影响尚未确认。";
  const item = Object.freeze(report({ risks: [risk(warning), risk("运行环境重启，任务已中断，未自动重试。"), risk(warning)] }));
  const before = JSON.stringify(item);
  assert.equal(terminalReportFallbackSummary(item), "任务执行失败。\n\n" + warning + "\n\n运行环境重启，任务已中断，未自动重试。");
  assert.equal(JSON.stringify(item), before);
});

test("only unresolved critical run-level warnings supplement a non-success fallback", () => {
  const item = report({ risks: [risk("run-level"), risk("operation only", { sourceRefs: [{ kind: "operation", id: "action" }] }),
    risk("mitigated", { status: "mitigated" }), risk("warning", { severity: "warning" })] });
  assert.equal(terminalReportFallbackSummary(item), "任务执行失败。\n\nrun-level");
  for (const outcomeStatus of ["succeeded", "partially_succeeded"]) {
    assert.equal(terminalReportFallbackSummary({ ...item, outcomeStatus }), "任务执行失败。");
  }
});

test("hidden and mixed-reference warnings never leak through fallback prose", () => {
  for (const visibility of ["private", "developer_only", "audit"]) {
    const item = report({ risks: [risk("PRIVATE_SENTINEL", { sourceRefs: [
      { kind: "run", id: "public", visibility: "conversation" }, { kind: "run", id: "hidden", visibility },
    ] })] });
    assert.equal(terminalReportFallbackSummary(item), "任务执行失败。");
  }
  assert.equal(terminalReportFallbackSummary(report({ summary: "", risks: [] })), "");
});

test("canonical projection may omit internal refs without dropping fixed Host interruption warnings", () => {
  const item = report({ risks: [risk("Effect unknown", { id: "execution-unconfirmed:run:tool", sourceRefs: [] }),
    risk("Interrupted", { id: "run-failure:run", sourceRefs: [] }),
    risk("Not a run risk", { id: "action-failure:action", sourceRefs: [] })] });
  assert.equal(terminalReportFallbackSummary(item), "任务执行失败。\n\nEffect unknown\n\nInterrupted");
});
