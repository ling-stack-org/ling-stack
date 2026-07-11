import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildDeterministicTerminalReport,
  createSqliteRunStore,
  validateTerminalReport,
} from "../../core/dist/index.js";
import { collectRunTerminalReportEvidence } from "../dist/features/channels/terminal-report-evidence.js";

test("deterministic fallback hides folded log artifacts and records evidence truncation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-fallback-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-07-11T04:00:00.000Z";
    const taskChannel = store.createChannel({ name: "Fallback task backing channel", boundPath: cwd }, now);
    const task = store.createTask({
      channelId: taskChannel.id,
      title: "Fallback report",
      prompt: "Build fallback report",
      assigneeTeammateId: "engineer",
    }, now);
    const run = store.createRun({
      id: "run_terminal_fallback",
      cwd,
      taskId: task.id,
      teammateId: "engineer",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: task.id, title: task.title },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd, responseLanguage: "zh-CN" },
      createdAt: now,
    });
    store.createArtifact({
      runId: run.id,
      type: "file",
      path: "src/fallback.ts",
      createdAt: now,
    });
    store.createArtifact({
      runId: run.id,
      type: "log",
      path: "logs/sk-secretvalue123456/runtime.log",
      createdAt: now,
    });
    store.appendEvent(run.id, "assistant_text_delta", { text: "完成 fallback 报告。" });
    store.markRunSucceeded(run.id, "2026-07-11T04:01:00.000Z");

    const snapshot = collectRunTerminalReportEvidence(store, run.id, {
      generatedAt: "2026-07-11T04:02:00.000Z",
      budgets: { artifacts: 1 },
    });
    assert.equal(snapshot.artifacts.length, 1);
    assert.ok(snapshot.risks.some((risk) => risk.id === "terminal-report-truncated:artifacts"));
    assert.equal(JSON.stringify(snapshot).includes("sk-secretvalue123456"), false);

    const report = buildDeterministicTerminalReport(snapshot, {
      id: "terminal_report_fallback",
      committedAt: "2026-07-11T04:02:01.000Z",
    });
    assert.equal(validateTerminalReport(report, snapshot).ok, true);
    assert.equal(report.artifacts.some((artifact) => artifact.path?.includes("runtime.log")), false);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
