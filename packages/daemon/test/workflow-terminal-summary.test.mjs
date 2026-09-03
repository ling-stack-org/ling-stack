import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
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
import { finalizeOrchestratedWorkflowStepRun } from "../dist/features/channels/orchestrator.js";
import { buildWorkflowStepContextPack } from "../dist/features/channels/context-packs.js";
import {
  configureTerminalReportStore,
  processWorkflowTerminalReport,
} from "../dist/features/channels/terminal-report-coordinator.js";
import { collectWorkflowTerminalReportEvidence } from "../dist/features/channels/terminal-report-evidence.js";

test("workflow terminal report preserves full step result text without a legacy assistant reply", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workflow-terminal-summary-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-06-25T00:00:00.000Z";
    const channel = store.createChannel({
      name: "Workflow Summary",
      status: "active",
      boundPath: cwd,
      allowedTools: ["read", "write"],
    }, now);
    const sourceMessage = appendChannelItemFixture(store, {
      channelId: channel.id,
      authorType: "local-user",
      body: "创建 index.html",
    }, now);
    const sourceItem = store.getConversationItem(sourceMessage.id);
    assert.ok(sourceItem?.turnId);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Create index.html",
      objective: "Create the requested file.",
      status: "running",
      createdBy: "ling_agent",
      metadata: {
        sourceMessageId: sourceMessage.id,
        sourceTurnId: sourceItem.turnId,
        responseLanguage: "zh-CN",
      },
    }, "2026-06-25T00:01:00.000Z");
    const step = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Create index.html",
      prompt: "Create index.html.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "running",
    }, "2026-06-25T00:02:00.000Z");
    const task = store.createTask({
      channelId: channel.id,
      title: "Create index.html",
      prompt: "Create index.html.",
      status: "doing",
      assigneeTeammateId: "ling_agent",
    }, "2026-06-25T00:02:30.000Z");
    const contextPack = buildWorkflowStepContextPack({
      store,
      channel,
      workflow,
      step,
      prompt: step.prompt,
      consumerTeammateId: "ling_agent",
      workflowSteps: [step],
    });
    assert.ok(contextPack.agentContext);
    const run = store.createRun({
      id: "run_workflow_terminal_summary",
      cwd,
      taskId: task.id,
      channelId: channel.id,
      teammateId: "ling_agent",
      workflowStepId: step.id,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: task.id, title: "Create index.html" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd, contextPack },
      createdAt: "2026-06-25T00:03:00.000Z",
    });
    const longResult = `${Array.from({ length: 90 }, (_, index) => `结果片段${index}`).join(" ")} END_MARKER_完整结尾`;
    assert.equal(longResult.length > 480, true);
    store.appendEvent(run.id, "assistant_text_delta", { text: longResult });
    store.markRunSucceeded(run.id, "2026-06-25T00:04:00.000Z");
    const terminalRun = store.getRun(run.id);
    assert.ok(terminalRun);

    finalizeOrchestratedWorkflowStepRun(store, step.id, run.taskId, terminalRun, "2026-06-25T00:05:00.000Z");

    const completedStep = store.getChannelWorkflowStep(step.id);
    assert.equal(completedStep?.status, "succeeded");
    assert.equal(completedStep?.resultSummary, longResult);
    assert.equal(
      store.getConversationItem(`message_workflow_terminal_${workflow.id}`),
      undefined,
    );
    assert.equal(
      store.listConversationItemsByChannelPage({
        channelId: channel.id,
        kinds: ["assistant_message"],
        effectiveOnly: true,
        limit: 20,
      }).items.some((item) => item.id.startsWith("message_workflow_terminal_")),
      false,
    );

    const snapshot = collectWorkflowTerminalReportEvidence(store, workflow.id, {
      generatedAt: "2026-06-25T00:05:01.000Z",
    });
    const report = buildDeterministicTerminalReport(snapshot, {
      id: "terminal_report_long_summary",
      committedAt: "2026-06-25T00:05:02.000Z",
    });
    assert.equal(validateTerminalReport(report, snapshot).ok, true);
    assert.match(report.participants[0]?.contribution ?? "", /END_MARKER_完整结尾/u);

    configureTerminalReportStore(store, { enabled: true });
    const published = await processWorkflowTerminalReport(store, workflow.id, {
      now: "2026-06-25T00:05:02.000Z",
    });
    assert.ok(published.record.resultItemId);
    assert.match(
      published.record.report?.participants[0]?.contribution ?? "",
      /END_MARKER_完整结尾/u,
    );
    assert.equal(
      published.record.report?.participants[0]?.contribution.includes("..."),
      false,
    );
    const resultItem = store.getConversationItem(published.record.resultItemId);
    assert.equal(resultItem?.kind, "terminal_report");
    assert.equal(resultItem?.turnId, sourceItem.turnId);
    assert.equal(resultItem?.payload.reportId, published.record.id);
    assert.equal(resultItem?.payload.sourceKind, "workflow");
    assert.equal(resultItem?.payload.sourceId, workflow.id);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
