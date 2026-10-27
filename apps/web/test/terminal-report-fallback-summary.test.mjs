import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)),
  configFile: false, logLevel: "silent", server: { middlewareMode: true } });
after(() => vite.close());
const { terminalReportFallbackSummary } = await vite.ssrLoadModule("/src/shared/conversation/timeline/terminal-report-fallback-summary.ts");

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

// Regression: a model-timeout fallback must end with visible delivery facts,
// rather than only a generic success line and workflow-step count.
test("a Host fallback describes visible files and real check states without claiming extra work", () => {
  const item = report({ reportStatus: "fallback", status: "succeeded", outcomeStatus: "succeeded",
    summary: "任务已完成。完成2/2个步骤。",
    changes: [{ id: "change", paths: ["src/ledger.js"], addedLines: 12, deletedLines: 3, sourceRefs: [] }],
    verification: [{ id: "check", title: "Ledger tests", command: "node --test ledger.test.js", status: "passed", sourceRefs: [] }],
    participants: [{ displayName: "Engineer", contribution: "MODEL_ONLY_DO_NOT_COPY", status: "completed", sourceRefs: [] }],
  });
  const before = JSON.stringify(item);
  const summary = terminalReportFallbackSummary(item);
  assert.match(summary, /src\/ledger\.js/u);
  assert.doesNotMatch(summary, /\+12|−3/u, "exact diff counts belong to the file cards, not this prose preview");
  assert.match(summary, /Ledger tests.*已通过/u);
  assert.doesNotMatch(summary, /node --test ledger\.test\.js/u, "commands stay in the tool item, not the final result");
  assert.doesNotMatch(summary, /MODEL_ONLY_DO_NOT_COPY/u);
  assert.equal(JSON.stringify(item), before);
});

test("a model result and legacy unknown report provenance are not expanded into a second summary", () => {
  for (const reportStatus of [undefined, "committed"]) {
    assert.equal(terminalReportFallbackSummary(report({ reportStatus, changes: [{ paths: ["do-not-repeat.js"], sourceRefs: [] }] })), "任务执行失败。");
  }
});

test("a multi-file change total is never presented as each file's line count", () => {
  const summary = terminalReportFallbackSummary(report({ reportStatus: "fallback", changes: [
    { id: "group", paths: ["first.js", "second.js"], addedLines: 12, deletedLines: 3, sourceRefs: [] },
    { id: "single", paths: ["third.js"], addedLines: 7, deletedLines: 1, sourceRefs: [] },
  ] }));
  assert.match(summary, /first\.js/u);
  assert.match(summary, /second\.js/u);
  assert.doesNotMatch(summary, /\+12|−3/u);
  assert.match(summary, /third\.js/u);
  assert.doesNotMatch(summary, /\+7|−1/u);
});

test("fallback detail privacy applies before composing the ending, including stronger duplicate refs", () => {
  for (const restriction of [{ visibility: "private" }, { visibility: "developer_only" },
    { visibility: "audit" }, { sensitivity: "secret_adjacent" }]) {
    const hidden = { kind: "file", id: "hidden.js", ...restriction };
    const summary = terminalReportFallbackSummary(report({ reportStatus: "fallback", references: [hidden],
      changes: [{ paths: ["hidden.js"], sourceRefs: [{ kind: "file", id: "hidden.js", visibility: "conversation" }] },
        { paths: ["visible.js"], sourceRefs: [] }],
      verification: [{ title: "PRIVATE_SENTINEL", command: "PRIVATE_SENTINEL", status: "passed",
        sourceRefs: [{ kind: "check", id: "public" }, hidden] }],
    }));
    assert.match(summary, /visible\.js/u);
    assert.doesNotMatch(summary, /hidden\.js|PRIVATE_SENTINEL/u);
  }
});

test("fallback check statuses stay distinct and metadata counts cannot invent evidence", () => {
  const summary = terminalReportFallbackSummary(report({ reportStatus: "fallback", language: "en-US",
    changeCount: 500, verificationCount: 500,
    verification: ["failed", "blocked", "cancelled", "skipped", "not_run", "unknown"].map((status) => ({
      id: status, title: `check-${status}`, status, sourceRefs: [],
    })),
  }));
  assert.match(summary, /check-failed.*Failed/u);
  assert.match(summary, /check-blocked.*Blocked/u);
  assert.doesNotMatch(summary, /Passed|500/u);
  assert.equal(terminalReportFallbackSummary(report({ reportStatus: "fallback", changeCount: 500, verificationCount: 500 })), "任务执行失败。");
});

test("fallback fact previews are bounded and render hostile Markdown as code, not links", () => {
  const item = report({ reportStatus: "fallback", changes: Array.from({ length: 20 }, (_, i) => ({
    id: `file-${i}`, paths: [`file-${i}-` + "x".repeat(300)], sourceRefs: [],
  })), verification: [{ id: "cmd", title: "Check `](https://example.invalid)\nnext", command: "RAW_COMMAND_SENTINEL", status: "unknown", sourceRefs: [] }] });
  const summary = terminalReportFallbackSummary(item);
  assert.match(summary, /file-0-/u);
  assert.doesNotMatch(summary, /file-4-/u);
  assert.match(summary, /``Check/u);
  assert.doesNotMatch(summary, /RAW_COMMAND_SENTINEL/u);
  assert.ok(summary.length < 1500);
});
