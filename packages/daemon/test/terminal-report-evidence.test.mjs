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
import { channelOperationPlanFingerprintV1 } from "../../contracts/dist/index.js";
import {
  collectRunTerminalReportEvidence,
  collectTurnTerminalReportEvidence,
  collectWorkflowTerminalReportEvidence,
} from "../dist/features/channels/terminal-report-evidence.js";
import { createDelegatedStepRequirement } from "../dist/features/channels/workflow-step-requirement.js";

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
    assert.equal(snapshot.terminalState, "partially_succeeded");
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

test("workflow participant status folds independent step outcomes without last-row-wins", async (t) => {
  for (const scenario of [
    { name: "failed then completed", firstStatus: "failed", expectedStatus: "failed" },
    { name: "blocked then completed", firstStatus: "blocked", expectedStatus: "blocked" },
    { name: "cancelled then completed", firstStatus: "cancelled", expectedStatus: "cancelled" },
  ]) {
    await t.test(scenario.name, async () => {
      const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-participant-fold-"));
      const store = createSqliteRunStore(cwd);
      try {
        const now = "2026-07-11T02:20:00.000Z";
        const channel = store.createChannel({ name: "Participant status fold", boundPath: cwd }, now);
        const workflow = store.createChannelWorkflow({
          channelId: channel.id,
          title: "Participant status fold",
          objective: "Preserve every independent workflow step outcome",
          status: scenario.firstStatus === "failed" ? "failed" : scenario.firstStatus,
          createdBy: "ling_agent",
        }, now);
        const first = createWorkflowRun(store, {
          cwd,
          channelId: channel.id,
          workflowId: workflow.id,
          teammateId: "engineer",
          title: `${scenario.name} first step`,
          status: scenario.firstStatus,
          resultSummary: `${scenario.name} first result`,
          blocker: scenario.firstStatus === "blocked" ? "Waiting on independent evidence." : undefined,
          runId: `run_terminal_participant_${scenario.firstStatus}`,
          createdAt: "2026-07-11T02:20:01.000Z",
        });
        const second = createWorkflowRun(store, {
          cwd,
          channelId: channel.id,
          workflowId: workflow.id,
          teammateId: "engineer",
          title: `${scenario.name} second step`,
          status: "succeeded",
          resultSummary: `${scenario.name} second result`,
          runId: `run_terminal_participant_${scenario.firstStatus}_success`,
          createdAt: "2026-07-11T02:20:02.000Z",
        });

        const snapshot = collectWorkflowTerminalReportEvidence(store, workflow.id, { generatedAt: now });
        assert.equal(snapshot.participants.length, 1);
        assert.equal(snapshot.participants[0]?.status, scenario.expectedStatus);
        assert.deepEqual(snapshot.participants[0]?.workflowStepIds, [first.step.id, second.step.id]);
        assert.deepEqual(snapshot.participants[0]?.runIds, [first.run.id, second.run.id]);
      } finally {
        store.close();
        await rm(cwd, { recursive: true, force: true });
      }
    });
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

test("workflow participant status uses the effective retry of each logical step", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-workflow-retry-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-07-11T02:30:00.000Z";
    const channel = store.createChannel({ name: "Workflow retry", boundPath: cwd }, now);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Workflow retry",
      objective: "Repair the same logical step without retaining its previous failure as current.",
      status: "succeeded",
      createdBy: "ling_agent",
    }, now);
    const original = createWorkflowRun(store, {
      cwd,
      channelId: channel.id,
      workflowId: workflow.id,
      teammateId: "engineer",
      title: "Implementation",
      status: "failed",
      resultSummary: "Initial implementation failed.",
      runId: "run_workflow_original_failure",
      createdAt: now,
    });
    const repair = store.createRun(runInput({
      id: "run_workflow_repair_success",
      cwd,
      taskId: original.task.id,
      channelId: channel.id,
      teammateId: "engineer",
      workflowStepId: original.step.id,
      parentRunId: original.run.id,
      createdAt: "2026-07-11T02:31:00.000Z",
    }));
    store.appendEvent(repair.id, "assistant_text_delta", { text: "Repair completed." });
    store.markRunSucceeded(repair.id, "2026-07-11T02:32:00.000Z");
    store.updateChannelWorkflowStep(original.step.id, {
      runId: repair.id,
      status: "succeeded",
      resultSummary: "Repair completed.",
    }, "2026-07-11T02:32:00.000Z");

    const snapshot = collectWorkflowTerminalReportEvidence(store, workflow.id, { generatedAt: now });
    assert.equal(snapshot.participants[0]?.status, "completed");
    assert.deepEqual(snapshot.participants[0]?.runIds, [repair.id]);
    assert.deepEqual(snapshot.participants[0]?.workflowStepIds, [original.step.id]);
    assert.equal(store.getRun(original.run.id).status, "failed");
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
      teammateId: "engineer",
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
      parentRunId: cancelledBeforeStart.id,
      createdAt: "2026-07-11T03:03:00.000Z",
    }));
    store.appendEvent(repairRun.id, "assistant_text_delta", { text: "修复类型错误并通过验证。" });
    appendToolAction(store, repairRun.id, "repair_typecheck", "bash", { command: "pnpm typecheck" }, false, "2026-07-11T03:03:10.000Z");
    store.markRunSucceeded(repairRun.id, "2026-07-11T03:04:00.000Z");
    // Late persistence of the old failure must not outrank the newer durable attempt.
    store.markRunFailed(failedRun.id, "2026-07-11T03:04:30.000Z", "Typecheck failed.");
    assert.ok(store.getRun(failedRun.id).updatedAt > store.getRun(repairRun.id).updatedAt);

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
    assert.equal(turnSnapshot.terminalState, "succeeded");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("turn participant status preserves independent validation and unrelated run failures", async (t) => {
  for (const scenario of [
    { name: "unrelated primary success", successRole: "primary", hasParent: false },
    { name: "validation success is not repair", successRole: "validation", hasParent: true },
  ]) {
    await t.test(scenario.name, async () => {
      const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-independent-turn-"));
      const store = createSqliteRunStore(cwd);
      try {
        const now = "2026-07-11T03:10:00.000Z";
        const thread = store.createLingThread({
          kind: "conversation",
          title: scenario.name,
          objective: "Implement and independently verify the project.",
        }, now);
        const turn = store.createLingTurn({
          threadId: thread.id,
          kind: "initial_request",
          title: scenario.name,
          userInstruction: "Implement and independently verify the project.",
        }, now);
        const channel = store.createChannel({ name: "Independent participation", boundPath: cwd }, now);
        const task = store.createTask({
          channelId: channel.id,
          title: scenario.name,
          prompt: "Implement and independently verify the project.",
          assigneeTeammateId: "engineer",
        }, now);
        const failedRun = store.createRun(runInput({
          id: "run_independent_failed",
          cwd,
          taskId: task.id,
          teammateId: "engineer",
          threadId: thread.id,
          turnId: turn.id,
          createdAt: now,
        }));
        store.appendEvent(failedRun.id, "assistant_text_delta", { text: "Implementation failed." });
        store.markRunFailed(failedRun.id, now, "Implementation failed.");
        const successfulRun = store.createRun(runInput({
          id: "run_independent_success",
          cwd,
          taskId: task.id,
          teammateId: "engineer",
          threadId: thread.id,
          turnId: turn.id,
          turnRunRole: scenario.successRole,
          parentRunId: scenario.hasParent ? failedRun.id : undefined,
          createdAt: "2026-07-11T03:11:00.000Z",
        }));
        store.appendEvent(successfulRun.id, "assistant_text_delta", { text: "Independent verification completed." });
        store.markRunSucceeded(successfulRun.id, "2026-07-11T03:12:00.000Z");

        const snapshot = collectTurnTerminalReportEvidence(store, turn.id, { generatedAt: now });
        assert.equal(snapshot.participants[0]?.status, "failed");
        assert.deepEqual(snapshot.participants[0]?.runIds, [failedRun.id, successfulRun.id]);
        assert.equal(snapshot.terminalState, "partially_succeeded");
      } finally {
        store.close();
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
});

test("failed command evidence overrides a stale succeeded run marker", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-command-failure-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-07-11T03:20:00.000Z";
    const channel = store.createChannel({ name: "Command failure", boundPath: cwd }, now);
    const task = store.createTask({ channelId: channel.id, title: "Run command", prompt: "Run command" }, now);
    const run = store.createRun(runInput({ id: "run_command_failed_but_marked_success", cwd, taskId: task.id, createdAt: now }));
    appendToolAction(store, run.id, "failed_command", "bash", { command: "git status" }, true, now);
    store.markRunSucceeded(run.id, "2026-07-11T03:21:00.000Z");

    const snapshot = collectRunTerminalReportEvidence(store, run.id, { generatedAt: "2026-07-11T03:22:00.000Z" });
    assert.equal(snapshot.operations[0]?.status, "failed");
    assert.equal(snapshot.terminalState, "failed");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("approval lineage is retained but becomes an operation only after durable execution evidence", async (t) => {
  for (const approvalStatus of ["pending", "approved", "denied"]) {
    await t.test(`approval-only ${approvalStatus}`, async () => {
      const cwd = await mkdtemp(resolve(tmpdir(), `ling-stack-terminal-report-approval-${approvalStatus}-`));
      const store = createSqliteRunStore(cwd);
      try {
        const now = "2026-07-11T03:30:00.000Z";
        const channel = store.createChannel({ name: "Approval evidence", boundPath: cwd }, now);
        const task = store.createTask({ channelId: channel.id, title: "Answer only", prompt: "Answer only" }, now);
        const run = store.createRun(runInput({
          id: `run_approval_only_${approvalStatus}`,
          cwd,
          taskId: task.id,
          createdAt: now,
        }));
        store.appendEvent(run.id, "assistant_text_delta", { text: "Plain answer." });
        store.markRunSucceeded(run.id, "2026-07-11T03:30:10.000Z");
        const approval = store.createApprovalRequest({
          runId: run.id,
          taskId: task.id,
          toolCallId: `tool_approval_only_${approvalStatus}`,
          actionType: "bash",
          risk: "medium",
          title: "Approve check",
          description: "pnpm test",
          payload: { type: "bash", cwd, command: "pnpm test", riskFlags: [] },
        }, "2026-07-11T03:30:01.000Z");
        if (approvalStatus === "approved") {
          store.approveApprovalRequest(approval.id, { reason: "Fixture approval only" }, "2026-07-11T03:30:02.000Z");
        } else if (approvalStatus === "denied") {
          store.denyApprovalRequest(approval.id, { reason: "Fixture denial only" }, "2026-07-11T03:30:02.000Z");
        }

        const snapshot = collectRunTerminalReportEvidence(store, run.id, {
          generatedAt: "2026-07-11T03:30:20.000Z",
        });
        assert.equal(snapshot.operations.length, 0);
        assert.equal(snapshot.checks.length, 0);
        assert.equal(snapshot.terminalState, "succeeded");
        assert.equal(snapshot.approvals[0]?.status, approvalStatus);
      } finally {
        store.close();
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }

  await t.test("approved action with tool lifecycle", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-approved-execution-"));
    const store = createSqliteRunStore(cwd);
    try {
      const now = "2026-07-11T03:31:00.000Z";
      const channel = store.createChannel({ name: "Approved execution", boundPath: cwd }, now);
      const task = store.createTask({ channelId: channel.id, title: "Run approved check", prompt: "Run approved check" }, now);
      const run = store.createRun(runInput({ id: "run_approved_execution", cwd, taskId: task.id, createdAt: now }));
      const toolCallId = "tool_approved_execution";
      const approval = store.createApprovalRequest({
        runId: run.id,
        taskId: task.id,
        toolCallId,
        actionType: "bash",
        risk: "medium",
        title: "Approve test",
        description: "pnpm test",
        payload: { type: "bash", cwd, command: "pnpm test", riskFlags: [] },
      }, "2026-07-11T03:31:01.000Z");
      store.approveApprovalRequest(approval.id, { reason: "Run the check" }, "2026-07-11T03:31:02.000Z");
      store.appendEvent(run.id, "tool_start", { toolCallId, toolName: "bash", args: { command: "pnpm test", cwd } });
      store.appendEvent(run.id, "tool_end", { toolCallId, toolName: "bash", isError: false });
      store.markRunSucceeded(run.id, "2026-07-11T03:31:05.000Z");

      const snapshot = collectRunTerminalReportEvidence(store, run.id, {
        generatedAt: "2026-07-11T03:31:06.000Z",
      });
      const correlated = snapshot.operations.find((operation) => operation.id === `approval:${approval.id}`);
      assert.ok(correlated);
      assert.equal(correlated.status, "succeeded");
      assert.ok(snapshot.checks.some((check) => check.id === correlated.id && check.status === "passed"));
    } finally {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("end-only durable tool evidence still produces a terminal operation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-end-only-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-07-11T03:32:00.000Z";
    const channel = store.createChannel({ name: "End-only evidence", boundPath: cwd }, now);
    const task = store.createTask({ channelId: channel.id, title: "Recover tool completion", prompt: "Recover tool completion" }, now);
    const run = store.createRun(runInput({ id: "run_terminal_end_only", cwd, taskId: task.id, createdAt: now }));
    store.appendEvent(run.id, "tool_end", {
      toolCallId: "end_only_read",
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: "Recovered durable result" }] },
    });
    store.markRunSucceeded(run.id, "2026-07-11T03:32:01.000Z");

    const snapshot = collectRunTerminalReportEvidence(store, run.id, {
      generatedAt: "2026-07-11T03:32:02.000Z",
    });
    assert.equal(snapshot.operations.length, 1);
    assert.equal(snapshot.operations[0]?.id, `tool:${run.id}:end_only_read`);
    assert.equal(snapshot.operations[0]?.status, "succeeded");
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

test("terminal report consumes the atomic execution-loop action and its durable risk", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-loop-evidence-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-07-11T04:10:00.000Z";
    const thread = store.createLingThread({
      kind: "conversation",
      title: "Stop a repeated execution loop",
      objective: "Stop a repeated execution loop",
    }, now);
    const turn = store.createLingTurn({
      threadId: thread.id,
      kind: "initial_request",
      title: "Stop a repeated execution loop",
      userInstruction: "Stop a repeated execution loop",
    }, now);
    const channel = store.createChannel({ name: "Loop evidence", boundPath: cwd }, now);
    const task = store.createTask({
      channelId: channel.id,
      title: "Loop evidence",
      prompt: "Stop a repeated execution loop",
      assigneeTeammateId: "engineer",
    }, now);
    const run = store.createRun(runInput({
      id: "run_terminal_execution_loop",
      cwd,
      taskId: task.id,
      teammateId: "engineer",
      threadId: thread.id,
      turnId: turn.id,
      createdAt: now,
    }));
    store.appendEvent(run.id, "loop_detected", {
      code: "execution_loop_detected",
      attemptId: "attempt_terminal_execution_loop",
      loopKind: "exact_repeat",
      observedEventType: "tool_end",
      observedEventSeq: 4,
      repeatedCount: 3,
      noProgressActionCount: 3,
      fingerprint: "c".repeat(64),
      message: "Execution stopped after the same action and result repeated 3 times.",
      retryable: false,
    });
    store.markRunFailed(run.id, "2026-07-11T04:10:01.000Z", "execution_loop_detected");

    const snapshot = collectRunTerminalReportEvidence(store, run.id, {
      generatedAt: "2026-07-11T04:10:02.000Z",
    });
    const diagnostic = snapshot.operations.find((operation) =>
      operation.id.startsWith(`runtime-diagnostic:${run.id}:`));
    assert.ok(diagnostic);
    assert.equal(diagnostic.kind, "other");
    assert.equal(diagnostic.status, "failed");
    assert.match(diagnostic.title, /Repeated execution stopped/u);
    assert.ok(diagnostic.sourceRefs.some((ref) => ref.kind === "operation" && ref.id === diagnostic.id));
    assert.ok(snapshot.risks.some((risk) =>
      risk.id === `action-failure:${diagnostic.id}`
      && risk.status === "unresolved"
      && risk.sourceRefs.some((ref) => ref.kind === "operation" && ref.id === diagnostic.id)));
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

test("workflow terminal evidence scopes required-operation risks to the owning step", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-operation-ownership-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-09-20T10:00:00.000Z";
    const channel = store.createChannel({ name: "Operation ownership", boundPath: cwd }, now);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Designer review and Engineer command",
      objective: "Review the channel and run the required command.",
      status: "succeeded",
      createdBy: "ling_agent",
    }, now);
    const command = "node -e \"process.stdout.write('N05')\"";
    const sourceRefs = [{ itemId: "source_n05", quote: `@Engineer 执行命令 ${command}` }];
    const operations = [{
      id: "run_n05_command",
      kind: "run_command",
      targetKind: "command",
      targetRef: { type: "operation", id: "target:run_n05_command", label: command },
      commandMatchPolicy: { kind: "exact_command", command },
      required: true,
      dependsOn: [],
      binding: {
        schemaVersion: 1,
        ownerParticipantId: "teammate_builtin_engineer",
        sourceRefs,
        inputRefs: [],
        outputRefs: [],
        effectScope: {
          readPaths: [],
          writePaths: [],
          exactCommands: [command],
          allowEnvironmentAccess: false,
          allowNetworkAccess: false,
        },
      },
    }];
    const executionPlan = {
      bindingVersion: 1,
      operations,
      fingerprint: channelOperationPlanFingerprintV1(operations),
    };
    let designerStep = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Designer review",
      prompt: "Review the channel rendering.",
      toParticipantId: "teammate_builtin_designer",
      toParticipantLabel: "Designer",
      status: "succeeded",
      metadata: {
        executionPlan,
        executionOperationIds: [],
      },
    }, now);
    designerStep = store.updateChannelWorkflowStep(designerStep.id, {
      metadata: {
        ...designerStep.metadata,
        delegatedRequirement: createDelegatedStepRequirement({
          workflow,
          step: designerStep,
          participant: { expectedOutcome: "synthesis" },
          manifestFingerprint: "manifest_n05",
        }),
      },
    }, now);
    let engineerStep = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Engineer command",
      prompt: "Run the N05 command.",
      toParticipantId: "teammate_builtin_engineer",
      toParticipantLabel: "Engineer",
      status: "succeeded",
      metadata: {
        executionPlan,
        executionOperationIds: ["run_n05_command"],
      },
    }, now);
    engineerStep = store.updateChannelWorkflowStep(engineerStep.id, {
      metadata: {
        ...engineerStep.metadata,
        delegatedRequirement: createDelegatedStepRequirement({
          workflow,
          step: engineerStep,
          participant: { expectedOutcome: "execution" },
          manifestFingerprint: "manifest_n05",
        }),
        executionVerification: {
          status: "blocked",
          checkedAt: now,
          operationResults: [{
            operationId: "run_n05_command",
            status: "missing",
            evidenceActionIds: [],
            reasonCode: "required_operation_missing_evidence",
          }],
        },
      },
    }, now);

    const unverified = collectWorkflowTerminalReportEvidence(store, workflow.id, { generatedAt: now });
    assert.equal(unverified.risks.some((risk) =>
      risk.id === `workflow-diagnostic:${designerStep.id}:operation_unverified`), false);
    assert.equal(unverified.risks.some((risk) =>
      risk.id === `workflow-diagnostic:${engineerStep.id}:operation_unverified`), true);

    store.updateChannelWorkflowStep(engineerStep.id, {
      metadata: {
        ...engineerStep.metadata,
        executionVerification: {
          status: "verified",
          checkedAt: "2026-09-20T10:00:01.000Z",
          operationResults: [{
            operationId: "run_n05_command",
            status: "succeeded",
            evidenceActionIds: ["action_n05_command"],
          }],
        },
      },
    }, "2026-09-20T10:00:01.000Z");
    const verified = collectWorkflowTerminalReportEvidence(store, workflow.id, {
      generatedAt: "2026-09-20T10:00:02.000Z",
    });
    assert.equal(verified.risks.some((risk) =>
      risk.id.endsWith(":operation_unverified")), false);
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
  if (input.status === "failed" || input.status === "blocked") {
    store.markRunFailed(run.id, input.createdAt, input.blocker ?? "Run failed.");
  } else if (input.status === "cancelled") {
    store.markRunCancelled(run.id, input.createdAt);
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
