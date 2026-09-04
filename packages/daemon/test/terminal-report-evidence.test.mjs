import { appendChannelItemFixture, getChannelItemViewFixture, listChannelItemViewsFixture, updateChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
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
import {
  collectRunTerminalReportEvidence,
  collectTurnTerminalReportEvidence,
  collectWorkflowTerminalReportEvidence,
} from "../dist/features/channels/terminal-report-evidence.js";

test("workflow terminal evidence aggregates rounds, actions, checks, artifacts, and actual participants", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-workflow-evidence-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-07-11T02:00:00.000Z";
    const channel = store.createChannel({ name: "Terminal Report", boundPath: cwd }, now);
    const sourceMessage = appendChannelItemFixture(store, {
      channelId: channel.id,
      authorType: "local-user",
      body: "实现并验证 TerminalReport",
    }, now);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "TerminalReport implementation",
      objective: "实现并验证 TerminalReport",
      status: "succeeded",
      createdBy: "ling_agent",
      metadata: { sourceMessageId: sourceMessage.id, responseLanguage: "zh-CN" },
    }, now);

    const engineerOne = createWorkflowRun(store, {
      cwd,
      channelId: channel.id,
      workflowId: workflow.id,
      teammateId: "engineer",
      title: "Engineer 第 1 轮",
      status: "succeeded",
      resultSummary: "完成协议和持久化实现。",
      runId: "run_terminal_engineer_one",
      createdAt: "2026-07-11T02:01:00.000Z",
    });
    const terminalReportTypesArtifact = store.createArtifact({
      runId: engineerOne.run.id,
      type: "file",
      path: `${engineerOne.run.id}/001-terminal-report-types.txt`,
      title: "Terminal report types",
      createdAt: "2026-07-11T02:01:20.000Z",
    });
    appendToolAction(store, engineerOne.run.id, "edit_core", "edit", {
      path: "packages/core/src/terminal-report-types.ts",
    }, false, "2026-07-11T02:01:10.000Z", terminalReportTypesArtifact.id);
    appendToolAction(store, engineerOne.run.id, "edit_ui", "edit", {
      path: "apps/web/src/lib/terminal-report.ts",
    }, false, "2026-07-11T02:01:11.000Z");

    const qa = createWorkflowRun(store, {
      cwd,
      channelId: channel.id,
      workflowId: workflow.id,
      teammateId: "qa",
      title: "QA 验证",
      status: "failed",
      resultSummary: "发现类型检查失败，需要 Engineer 修复。",
      blocker: "Typecheck failed.",
      runId: "run_terminal_qa",
      createdAt: "2026-07-11T02:02:00.000Z",
    });
    appendToolAction(store, qa.run.id, "qa_typecheck", "bash", {
      command: "pnpm typecheck",
    }, true, "2026-07-11T02:02:10.000Z");

    const engineerTwo = createWorkflowRun(store, {
      cwd,
      channelId: channel.id,
      workflowId: workflow.id,
      teammateId: "engineer",
      title: "Engineer 第 2 轮",
      status: "succeeded",
      resultSummary: "修复类型问题并补充 CAS 测试。",
      runId: "run_terminal_engineer_two",
      createdAt: "2026-07-11T02:03:00.000Z",
    });
    store.createArtifact({
      runId: engineerTwo.run.id,
      type: "file",
      path: "packages/core/test/terminal-report-store.test.mjs",
      title: "Terminal report store tests",
      createdAt: "2026-07-11T02:03:20.000Z",
    });
    appendToolAction(store, engineerTwo.run.id, "engineer_typecheck", "bash", {
      command: "pnpm typecheck",
    }, false, "2026-07-11T02:03:10.000Z");

    store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Designer 未触发",
      prompt: "Review UI only if needed.",
      toParticipantId: "designer",
      toParticipantLabel: "Designer",
      status: "queued",
    }, "2026-07-11T02:04:00.000Z");
    store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Architect 阻塞但未启动",
      prompt: "Review architecture after implementation.",
      toParticipantId: "architect",
      toParticipantLabel: "Architect",
      status: "blocked",
    }, "2026-07-11T02:04:10.000Z");

    const snapshot = collectWorkflowTerminalReportEvidence(store, workflow.id, {
      generatedAt: "2026-07-11T02:05:00.000Z",
    });
    assert.equal(snapshot.terminalState, "succeeded");
    assert.equal(snapshot.language, "zh-CN");
    assert.equal(snapshot.steps.length, 4);
    assert.deepEqual(snapshot.participants.map((participant) => participant.agentId).sort(), ["engineer", "qa"]);
    assert.equal(snapshot.participants.find((participant) => participant.agentId === "engineer")?.workflowStepIds.length, 2);
    assert.equal(snapshot.participants.some((participant) => participant.agentId === "architect"), false);
    assert.equal(snapshot.participants.some((participant) => participant.agentId === "designer"), false);
    assert.ok(snapshot.operations.some((operation) => operation.kind === "edit"));
    assert.ok(snapshot.checks.some((check) => check.command === "pnpm typecheck" && check.status === "passed"));
    assert.ok(snapshot.checks.some((check) => check.command === "pnpm typecheck" && check.status === "failed"));
    assert.ok(snapshot.artifacts.some((artifact) => artifact.path === `${engineerOne.run.id}/001-terminal-report-types.txt`));
    assert.ok(snapshot.steps.every((step) => !step.changedPaths.some((path) => path.startsWith(`${engineerOne.run.id}/`))));
    assert.deepEqual(snapshot.operations.find((operation) => operation.id.includes("edit_core"))?.changedPaths, [
      "packages/core/src/terminal-report-types.ts",
    ]);
    assert.deepEqual(snapshot.operations.find((operation) => operation.id.includes("edit_ui"))?.changedPaths, [
      "apps/web/src/lib/terminal-report.ts",
    ]);
    assert.ok(snapshot.artifacts.find((artifact) => artifact.id === terminalReportTypesArtifact.id)?.sourceRefs.some((ref) =>
      ref.kind === "file" && ref.id === "packages/core/src/terminal-report-types.ts"
    ));
    assert.ok(snapshot.risks.some((risk) => risk.id.includes("qa_typecheck") || /Typecheck failed/u.test(risk.summary)));

    const report = buildDeterministicTerminalReport(snapshot, {
      id: "terminal_report_workflow_evidence",
      committedAt: "2026-07-11T02:05:01.000Z",
    });
    assert.equal(validateTerminalReport(report, snapshot).ok, true);
    assert.ok(report.changes.some((change) => change.paths.includes("packages/core/src/terminal-report-types.ts")));
    assert.ok(report.changes.every((change) => !change.paths.some((path) => path.startsWith(`${engineerOne.run.id}/`))));
    assert.ok(report.artifacts.find((artifact) => artifact.id === terminalReportTypesArtifact.id)?.sourceRefs.some((ref) =>
      ref.kind === "file" && ref.id === "packages/core/src/terminal-report-types.ts"
    ));
    const engineerContribution = report.participants.find((participant) => participant.agentId === "engineer")?.contribution ?? "";
    const qaContribution = report.participants.find((participant) => participant.agentId === "qa")?.contribution ?? "";
    assert.match(engineerContribution, /Changed files: packages\/core\/src\/terminal-report-types\.ts \(completed\)/u);
    assert.match(engineerContribution, /Changed files: apps\/web\/src\/lib\/terminal-report\.ts \(completed\)/u);
    assert.match(engineerContribution, /Verified: verification \(completed\)/u);
    assert.match(qaContribution, /Verified: verification \(failed\)/u);
    assert.doesNotMatch(engineerContribution, /pnpm typecheck/u);
    assert.doesNotMatch(qaContribution, /pnpm typecheck/u);
    assert.doesNotMatch(qaContribution, /terminal-report-types|terminal-report\.ts/u);
    assert.doesNotMatch(engineerContribution, /发现类型检查失败/u);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal report checks use the exact Host command instead of action prose", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-command-authority-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-07-11T02:30:00.000Z";
    const channel = store.createChannel({ name: "Command authority", boundPath: cwd }, now);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Command authority",
      objective: "Use Host command evidence",
      status: "succeeded",
      createdBy: "ling_agent",
    }, now);
    const created = createWorkflowRun(store, {
      cwd,
      channelId: channel.id,
      workflowId: workflow.id,
      teammateId: "qa",
      title: "QA command authority",
      status: "succeeded",
      resultSummary: "The model prose must not become the command.",
      runId: "run_terminal_command_authority",
      createdAt: now,
    });
    const toolCallId = "qa-command-authority";
    store.appendEvent(created.run.id, "tool_start", {
      toolCallId,
      toolName: "bash",
      args: { command: "pnpm typecheck" },
    });
    store.appendEvent(created.run.id, "tool_end", {
      toolCallId,
      toolName: "bash",
      isError: false,
      result: {
        details: {
          unifiedExec: {
            status: "succeeded",
            cwd,
            command: { kind: "shell", command: "pnpm typecheck", shell: "bash" },
            startedAt: now,
            endedAt: now,
            durationMs: 1,
            exitCode: 0,
            timedOut: false,
            cancelled: false,
            stdout: { byteCount: 3, lineCount: 1, preview: "ok\n", truncated: false },
            stderr: { byteCount: 0, lineCount: 0, preview: "", truncated: false },
            artifacts: [],
          },
        },
      },
    });
    store.appendEvent(created.run.id, "assistant_text_delta", {
      text: "I ran a semantic substitute instead.",
    });
    store.markRunSucceeded(created.run.id, now);

    const snapshot = collectWorkflowTerminalReportEvidence(store, workflow.id, { generatedAt: now });
    const check = snapshot.checks.find((entry) => entry.runId === created.run.id);
    assert.ok(check);
    assert.equal(check.command, "pnpm typecheck");
    assert.notEqual(check.command, "I ran a semantic substitute instead.");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run and turn terminal evidence preserve retry history while latest participation can complete", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-turn-evidence-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-07-11T03:00:00.000Z";
    const thread = store.createLingThread({
      kind: "conversation",
      title: "Implement report",
      objective: "Implement report with verification",
    }, now);
    const turn = store.createLingTurn({
      threadId: thread.id,
      kind: "initial_request",
      title: "Implement report",
      userInstruction: "Implement report with verification",
    }, now);
    const taskChannel = store.createChannel({ name: "Conversation task backing channel", boundPath: cwd }, now);
    const task = store.createTask({
      channelId: taskChannel.id,
      title: "Implement report",
      prompt: "Implement report with verification",
      assigneeTeammateId: "engineer",
    }, now);
    const failedRun = store.createRun(runInput({
      id: "run_turn_failed",
      cwd,
      taskId: task.id,
      teammateId: "engineer",
      threadId: thread.id,
      turnId: turn.id,
      createdAt: "2026-07-11T03:01:00.000Z",
    }));
    store.appendEvent(failedRun.id, "assistant_text_delta", { text: "第一次实现存在类型错误。" });
    store.markRunFailed(failedRun.id, "2026-07-11T03:02:00.000Z", "Typecheck failed.");

    const cancelledBeforeStart = store.createRun(runInput({
      id: "run_turn_cancelled_before_start",
      cwd,
      taskId: task.id,
      teammateId: "designer",
      threadId: thread.id,
      turnId: turn.id,
      turnRunRole: "retry",
      parentRunId: failedRun.id,
      createdAt: "2026-07-11T03:02:30.000Z",
    }));
    store.markRunCancelled(cancelledBeforeStart.id, "2026-07-11T03:02:40.000Z");

    const repairRun = store.createRun(runInput({
      id: "run_turn_repair",
      cwd,
      taskId: task.id,
      teammateId: "engineer",
      threadId: thread.id,
      turnId: turn.id,
      turnRunRole: "repair",
      parentRunId: failedRun.id,
      createdAt: "2026-07-11T03:03:00.000Z",
    }));
    store.appendEvent(repairRun.id, "assistant_text_delta", { text: "修复类型错误并通过验证。" });
    appendToolAction(store, repairRun.id, "repair_typecheck", "bash", { command: "pnpm typecheck" }, false, "2026-07-11T03:03:10.000Z");
    store.markRunSucceeded(repairRun.id, "2026-07-11T03:04:00.000Z");

    const runSnapshot = collectRunTerminalReportEvidence(store, repairRun.id, {
      generatedAt: "2026-07-11T03:05:00.000Z",
    });
    assert.equal(runSnapshot.source.kind, "run");
    assert.equal(runSnapshot.language, "zh-CN");
    assert.equal(runSnapshot.participants[0]?.status, "completed");
    assert.equal(runSnapshot.checks[0]?.status, "passed");

    const cancelledRunSnapshot = collectRunTerminalReportEvidence(store, cancelledBeforeStart.id, {
      language: "zh-CN",
      generatedAt: "2026-07-11T03:05:00.000Z",
    });
    assert.equal(cancelledRunSnapshot.participants.length, 0);

    const turnSnapshot = collectTurnTerminalReportEvidence(store, turn.id, {
      generatedAt: "2026-07-11T03:05:00.000Z",
    });
    assert.equal(turnSnapshot.source.kind, "turn");
    assert.equal(turnSnapshot.language, "zh-CN");
    assert.equal(turnSnapshot.steps.length, 3);
    assert.deepEqual(turnSnapshot.steps.map((step) => step.status), ["failed", "cancelled", "succeeded"]);
    assert.equal(turnSnapshot.participants.length, 1);
    assert.equal(turnSnapshot.participants[0]?.status, "completed");
    assert.equal(turnSnapshot.participants[0]?.runIds.length, 2);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("failed edit actions never become changed paths", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-failed-edit-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-07-11T04:00:00.000Z";
    const channel = store.createChannel({ name: "Failed edit", boundPath: cwd }, now);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Failed edit",
      objective: "Reject failed path",
      status: "failed",
      createdBy: "ling_agent",
    }, now);
    const created = createWorkflowRun(store, {
      cwd,
      channelId: channel.id,
      workflowId: workflow.id,
      teammateId: "engineer",
      title: "Failed edit",
      status: "failed",
      resultSummary: "The edit failed before it changed the workspace.",
      blocker: "permission denied",
      runId: "run_terminal_failed_edit",
      createdAt: now,
    });
    appendToolAction(store, created.run.id, "failed_edit", "edit", { path: "src/should-not-count.ts" }, true, now);

    const snapshot = collectWorkflowTerminalReportEvidence(store, workflow.id, { generatedAt: now });
    assert.deepEqual(snapshot.steps[0].changedPaths, []);
    assert.deepEqual(snapshot.operations.find((operation) => operation.id.includes("failed_edit"))?.changedPaths, []);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal evidence infers the user language when a legacy run has no language snapshot", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-language-fallback-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-07-11T04:00:00.000Z";
    const thread = store.createLingThread({
      kind: "conversation",
      title: "修复会话总结",
      objective: "修复中文会话的总结语言",
    }, now);
    const turn = store.createLingTurn({
      threadId: thread.id,
      kind: "initial_request",
      title: "修复会话总结",
      userInstruction: "修复中文会话的总结语言",
    }, now);
    const channel = store.createChannel({ name: "Conversation backing channel", boundPath: cwd }, now);
    const task = store.createTask({
      channelId: channel.id,
      title: "修复会话总结",
      prompt: "修复中文会话的总结语言",
      assigneeTeammateId: "ling_agent",
    }, now);
    const run = store.createRun(runInput({
      id: "run_terminal_language_fallback",
      cwd,
      taskId: task.id,
      teammateId: "ling_agent",
      threadId: thread.id,
      turnId: turn.id,
      responseLanguage: null,
      createdAt: now,
    }));
    store.appendEvent(run.id, "assistant_text_delta", { text: "已完成中文会话总结修复。" });
    appendToolAction(store, run.id, "language_typecheck", "bash", { command: "pnpm typecheck" }, false, now);
    store.markRunSucceeded(run.id, now);

    assert.equal(collectRunTerminalReportEvidence(store, run.id).language, "zh-CN");
    assert.equal(collectTurnTerminalReportEvidence(store, turn.id).language, "zh-CN");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow terminal evidence promotes delegated node assertions into verification", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-workflow-check-evidence-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-07-11T05:00:00.000Z";
    const channel = store.createChannel({ name: "Workflow check evidence", boundPath: cwd }, now);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Verify generated file",
      objective: "Verify generated file",
      status: "succeeded",
      createdBy: "ling_agent",
    }, now);
    const created = createWorkflowRun(store, {
      cwd,
      channelId: channel.id,
      workflowId: workflow.id,
      teammateId: "qa",
      title: "QA verification",
      status: "succeeded",
      resultSummary: "The generated file matches the expected content.",
      runId: "run_terminal_workflow_node_check",
      createdAt: now,
    });
    store.updateChannelWorkflowStep(created.step.id, {
      metadata: {
        executionPlan: {
          operations: [{
            id: "verify_target",
            kind: "run_command",
            targetKind: "command",
            targetRef: { type: "command", label: "Verify generated file" },
            commandMatchPolicy: { kind: "executable", executable: "node" },
            required: true,
            dependsOn: [],
          }],
        },
        executionOperationIds: ["verify_target"],
      },
    }, now);
    appendUnifiedBashAction(store, created.run.id, "node -e \"if (actual !== expected) process.exit(1)\"", now);

    const snapshot = collectWorkflowTerminalReportEvidence(store, workflow.id, { generatedAt: now });
    assert.equal(snapshot.checks.length, 1);
    assert.equal(snapshot.checks[0]?.status, "passed");
    assert.match(snapshot.checks[0]?.command ?? "", /^node -e/u);
    const report = buildDeterministicTerminalReport(snapshot, { id: "terminal_report_workflow_node_check", committedAt: now });
    assert.equal(validateTerminalReport(report, snapshot).ok, true);
    assert.equal(report.verification.length, 1);
    assert.equal(report.verification[0]?.status, "passed");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function createWorkflowRun(store, input) {
  const task = store.createTask({
    channelId: input.channelId,
    title: input.title,
    prompt: input.title,
    assigneeTeammateId: input.teammateId,
  }, input.createdAt);
  const step = store.createChannelWorkflowStep({
    workflowId: input.workflowId,
    title: input.title,
    prompt: input.title,
    toParticipantId: input.teammateId,
    toParticipantLabel: input.teammateId === "qa" ? "QA" : "Engineer",
    status: input.status,
  }, input.createdAt);
  const run = store.createRun(runInput({
    id: input.runId,
    cwd: input.cwd,
    taskId: task.id,
    channelId: input.channelId,
    teammateId: input.teammateId,
    workflowStepId: step.id,
    createdAt: input.createdAt,
  }));
  store.appendEvent(run.id, "assistant_text_delta", { text: input.resultSummary });
  if (input.status === "failed") {
    store.markRunFailed(run.id, input.createdAt, input.blocker ?? "Run failed.");
  } else {
    store.markRunSucceeded(run.id, input.createdAt);
  }
  store.updateChannelWorkflowStep(step.id, {
    taskId: task.id,
    runId: run.id,
    resultSummary: input.resultSummary,
    blocker: input.blocker,
  }, input.createdAt);
  return { task, step, run };
}

function appendToolAction(store, runId, toolCallId, toolName, args, isError, at, resultArtifactId) {
  store.appendEvent(runId, "tool_start", { toolCallId, toolName, args });
  store.appendEvent(runId, "tool_end", { toolCallId, toolName, isError });
  if (resultArtifactId) {
    store.appendEvent(runId, "artifact_created", { toolCallId, artifactId: resultArtifactId });
  }
}

function appendUnifiedBashAction(store, runId, command, at) {
  const toolCallId = `bash_${command.replaceAll(/\W+/gu, "_")}`;
  store.appendEvent(runId, "tool_start", { toolCallId, toolName: "bash", args: { command } });
  store.appendEvent(runId, "tool_end", {
    toolCallId,
    toolName: "bash",
    isError: false,
    result: {
      details: {
        unifiedExec: {
          status: "succeeded",
          command: { kind: "shell", command, shell: "bash" },
          cwd: "/workspace",
          startedAt: at,
          endedAt: at,
          durationMs: 0,
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          stdout: { byteCount: 0, lineCount: 0, preview: "", truncated: false },
          stderr: { byteCount: 0, lineCount: 0, preview: "", truncated: false },
          artifacts: [],
        },
      },
    },
  });
}

function runInput(overrides) {
  return {
    id: overrides.id,
    cwd: overrides.cwd,
    taskId: overrides.taskId,
    channelId: overrides.channelId,
    teammateId: overrides.teammateId,
    workflowStepId: overrides.workflowStepId,
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: { id: overrides.taskId, title: "Terminal report" },
    providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: {
      cwd: overrides.cwd,
      ...(overrides.responseLanguage === null ? {} : { responseLanguage: overrides.responseLanguage ?? "zh-CN" }),
    },
    threadId: overrides.threadId,
    turnId: overrides.turnId,
    turnRunRole: overrides.turnRunRole,
    parentRunId: overrides.parentRunId,
    createdAt: overrides.createdAt,
  };
}
