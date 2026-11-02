import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { appendApprovalDecisionEvent } from "../dist/features/runs/approvals.js";
import { recoverApprovalPostCommitStore } from "../dist/features/runs/approval-postcommit-recovery.js";
import { ensureRunCancelled } from "../dist/features/runs/cancellation.js";
import { createDaemonServer } from "../dist/index.js";
import { RunControlService } from "../dist/run-control.js";
import { mediaApprovalRecoveryBlocked } from "../dist/features/media/approval-recovery-guard.js";
import { resumePendingMediaJobExecutions } from "../dist/features/media/executor.js";
import {
  configureTerminalReportStore,
  processWorkflowTerminalReport,
} from "../dist/features/channels/terminal-report-coordinator.js";

test("restart reconciles a claimed decision event without duplicating it or the owner", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-approval-effect-restart-"));
  const now = "2026-09-25T02:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    store.createRun({ id: "run_effect_restart", cwd, taskId: "task_effect_restart",
      providerName: "test-provider", providerModel: "test-model",
      taskSnapshot: { id: "task_effect_restart", title: "Restart" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd }, createdAt: now });
    const approval = store.createApprovalRequest({ runId: "run_effect_restart", taskId: "task_effect_restart",
      actionType: "bash", risk: "medium", title: "Approve", description: "echo once",
      payload: { type: "bash", cwd, command: "echo once", riskFlags: [] } }, now);
    const resolved = store.approveApprovalRequest(approval.id, { decisionKind: "approve_once" }, now);
    assert.ok(resolved);
    store.claimApprovalPostCommitEffect(approval.id, "decision_event", {
      token: "crashed-worker", claimExpiresAt: "2026-09-25T02:01:00.000Z",
    }, now);
    appendApprovalDecisionEvent(store, resolved); // Crash before claim settlement.
    appendApprovalDecisionEvent(store, resolved); // A stale publisher from another claim generation.
    assert.equal(store.listEvents("run_effect_restart").filter((event) => event.type === "approval_approved").length, 1);
    store.close();
    store = createSqliteRunStore(cwd);
    let ownerCalls = 0;
    const result = recoverApprovalPostCommitStore({ store, cwd, now: "2026-09-25T02:02:00.000Z",
      onOwnerResolved: () => { ownerCalls += 1; return undefined; } });
    assert.equal(result.deferred, 0);
    assert.equal(ownerCalls, 1);
    assert.deepEqual(store.listApprovalPostCommitEffects({ approvalId: approval.id }).map((effect) => effect.status),
      ["completed", "completed", "completed"]);
    assert.equal(store.listEvents("run_effect_restart").filter((event) => event.type === "approval_approved").length, 1);
    recoverApprovalPostCommitStore({ store, cwd, now: "2026-09-25T02:03:00.000Z",
      onOwnerResolved: () => { ownerCalls += 1; return undefined; } });
    assert.equal(ownerCalls, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("restart continues a post-step owner until Workflow, Turn and TerminalReport evidence are durable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-approval-workflow-post-restart-"));
  const createdAt = "2026-09-25T02:10:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Post-step recovery", boundPath: cwd }, createdAt);
    const source = appendChannelItemFixture(store, {
      channelId: channel.id,
      authorType: "local-user",
      body: "Implement and verify the post-step recovery fixture.",
    }, createdAt);
    const sourceItem = store.getConversationItem(source.id);
    assert.ok(sourceItem?.turnId);
    const task = store.createTask({
      channelId: channel.id,
      title: "Post-step recovery",
      prompt: "Implement and verify the post-step recovery fixture.",
      assigneeTeammateId: "engineer",
    }, createdAt);
    const turn = store.createLingTurn({
      threadId: sourceItem.threadId,
      kind: "manual_followup",
      title: "Post-step recovery execution",
      userInstruction: "Implement and verify the post-step recovery fixture.",
      channelId: channel.id,
      taskId: task.id,
      sourceItemId: "post-step-recovery-source",
      createdByActor: "local-user",
    }, createdAt);
    const executionSource = store.appendConversationItem({
      id: "post-step-recovery-source",
      channelId: channel.id,
      threadId: sourceItem.threadId,
      turnId: turn.id,
      kind: "user_message",
      status: "committed",
      actorType: "local_user",
      visibility: "channel",
      payload: {
        body: "Implement and verify the post-step recovery fixture.",
        format: "plain_text",
        mentions: [],
        attachmentIds: [],
        linkPreviewIds: [],
        fileRefs: [],
      },
      domainRefs: [{ type: "turn", id: turn.id }],
      idempotencyKey: "post-step-recovery-source",
    }, createdAt);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Post-step recovery",
      objective: "Recover every canonical projection after approval.",
      status: "running",
      createdBy: "local-user",
      metadata: { sourceMessageId: executionSource.id, sourceTurnId: turn.id },
    }, createdAt);
    const step = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Implement recovery",
      prompt: "Implement recovery.",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      status: "running",
    }, createdAt);
    const run = store.createRun({
      id: "run_workflow_post_restart",
      cwd,
      taskId: task.id,
      channelId: channel.id,
      teammateId: "engineer",
      workflowStepId: step.id,
      threadId: sourceItem.threadId,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: task.id, title: task.title },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt,
    });
    store.markRunStarted(run.id, "2026-09-25T02:10:10.000Z");
    store.appendEvent(run.id, "tool_start", {
      toolCallId: "post-restart-read",
      toolName: "read",
      args: { path: "README.md" },
    });
    store.appendEvent(run.id, "tool_end", {
      toolCallId: "post-restart-read",
      toolName: "read",
      isError: false,
    });
    store.markRunSucceeded(run.id, "2026-09-25T02:10:20.000Z");
    store.updateChannelWorkflowStep(step.id, {
      taskId: task.id,
      runId: run.id,
      resultSummary: "Recovery implementation and verification completed.",
    }, "2026-09-25T02:10:20.000Z");
    const approval = store.createApprovalRequest({
      workflowStepId: step.id,
      channelId: channel.id,
      actionType: "workflow_step",
      risk: "medium",
      title: "Review completed recovery",
      description: "Approve the completed recovery result.",
      payload: {
        type: "workflow_step",
        gateStage: "post",
        workflowId: workflow.id,
        workflowStepId: step.id,
        runId: run.id,
        title: step.title,
        approvalMode: "standard",
        requiredForTools: [],
        requiredForActions: [],
      },
    }, "2026-09-25T02:10:30.000Z");
    const currentStep = store.getChannelWorkflowStep(step.id);
    store.updateChannelWorkflowStep(step.id, {
      metadata: { ...currentStep.metadata, activeGateStage: "post", postStepApprovalId: approval.id },
    }, "2026-09-25T02:10:30.000Z");
    assert.equal(store.transitionChannelWorkflowStepStatus({ workflowStepId: step.id, expectedStatus: "running",
      event: "approval_requested", actor: "system", now: "2026-09-25T02:10:31.000Z" }).ok, true);
    assert.equal(store.transitionChannelWorkflowStatus({ workflowId: workflow.id, expectedStatus: "running",
      event: "approval_requested", actor: "system", now: "2026-09-25T02:10:31.000Z" }).ok, true);
    let sourceTurn = store.getLingTurn(turn.id);
    if (sourceTurn.status === "open") {
      assert.equal(store.transitionLingTurnStatus({ turnId: turn.id, expectedStatus: "open",
        event: "start", actor: "system", now: "2026-09-25T02:10:31.000Z" }).ok, true);
      sourceTurn = store.getLingTurn(turn.id);
    }
    assert.equal(sourceTurn.status, "running");
    assert.equal(store.transitionLingTurnStatus({ turnId: turn.id, expectedStatus: "running",
      event: "approval_requested", actor: "system", now: "2026-09-25T02:10:32.000Z" }).ok, true);
    const resolved = store.approveApprovalRequest(approval.id, {
      decisionKind: "approve_once",
      resolvedBy: "local-user",
    }, "2026-09-25T02:10:40.000Z");
    assert.ok(resolved);
    const ownerClaim = store.claimApprovalPostCommitEffect(approval.id, "owner", {
      token: "crashed-workflow-owner",
      claimExpiresAt: "2026-09-25T02:11:00.000Z",
    }, "2026-09-25T02:10:41.000Z");
    assert.ok(ownerClaim);
    store.close();

    store = createSqliteRunStore(cwd);
    configureTerminalReportStore(store, {
      enabled: true,
      barrierDeadlineMs: 50,
      barrierPollIntervalMs: 5,
    });
    let ownerCalls = 0;
    const projectOwner = () => {
      ownerCalls += 1;
      let liveStep = store.getChannelWorkflowStep(step.id);
      if (liveStep.status === "waiting_for_approval") {
        assert.equal(store.transitionChannelWorkflowStepStatus({ workflowStepId: liveStep.id,
          expectedStatus: "waiting_for_approval", event: "approval_approved", actor: "local-user",
          now: "2026-09-25T02:12:00.000Z" }).ok, true);
        liveStep = store.getChannelWorkflowStep(step.id);
        const { activeGateStage: _activeGateStage, ...metadata } = liveStep.metadata ?? {};
        store.updateChannelWorkflowStep(liveStep.id, { metadata }, "2026-09-25T02:12:00.000Z");
        assert.equal(store.transitionChannelWorkflowStepStatus({ workflowStepId: liveStep.id,
          expectedStatus: "running", event: "succeed", actor: "system",
          now: "2026-09-25T02:12:01.000Z" }).ok, true);
      }
      let liveWorkflow = store.getChannelWorkflow(workflow.id);
      if (liveWorkflow.status === "waiting_for_approval") {
        assert.equal(store.transitionChannelWorkflowStatus({ workflowId: liveWorkflow.id,
          expectedStatus: "waiting_for_approval", event: "approval_approved", actor: "local-user",
          now: "2026-09-25T02:12:02.000Z" }).ok, true);
        liveWorkflow = store.getChannelWorkflow(workflow.id);
      }
      if (liveWorkflow.status === "running") {
        assert.equal(store.transitionChannelWorkflowStatus({ workflowId: liveWorkflow.id,
          expectedStatus: "running", event: "all_steps_succeeded", actor: "system",
          now: "2026-09-25T02:12:03.000Z" }).ok, true);
      }
      let liveTurn = store.getLingTurn(turn.id);
      if (liveTurn.status === "waiting_for_approval") {
        assert.equal(store.transitionLingTurnStatus({ turnId: liveTurn.id, expectedStatus: "waiting_for_approval",
          event: "approval_approved", actor: "system", now: "2026-09-25T02:12:04.000Z" }).ok, true);
      }
      return undefined;
    };

    const firstRecovery = recoverApprovalPostCommitStore({
      store,
      cwd,
      now: "2026-09-25T02:12:00.000Z",
      onOwnerResolved: projectOwner,
    });
    assert.equal(firstRecovery.deferred, 1);
    assert.equal(ownerCalls, 1);
    assert.equal(store.getChannelWorkflowStep(step.id).status, "succeeded");
    assert.equal(store.getChannelWorkflow(workflow.id).status, "succeeded");
    assert.equal(store.getLingTurn(turn.id).status, "running");
    assert.equal(store.listApprovalPostCommitEffects({ approvalId: approval.id })
      .find((effect) => effect.effectKind === "owner")?.status, "pending");
    assert.equal(store.listEvents(run.id).filter((event) => event.type === "approval_approved").length, 1);

    const report = await processWorkflowTerminalReport(store, workflow.id, {
      linkedRunId: run.id,
      now: "2026-09-25T02:13:00.000Z",
    });
    assert.ok(report.record.resultItemId);
    assert.equal(store.getConversationItem(report.record.resultItemId)?.kind, "terminal_report");
    assert.equal(store.getLingTurn(turn.id).status, "succeeded");

    const secondRecovery = recoverApprovalPostCommitStore({
      store,
      cwd,
      now: "2026-09-25T02:14:00.000Z",
      onOwnerResolved: projectOwner,
    });
    assert.equal(secondRecovery.deferred, 0);
    assert.equal(ownerCalls, 1, "durable Workflow/Turn/TerminalReport evidence must suppress owner replay");
    assert.deepEqual(store.listApprovalPostCommitEffects({ approvalId: approval.id }).map((effect) => effect.status),
      ["completed", "completed", "completed"]);
    assert.equal(store.listEvents(run.id).filter((event) => event.type === "approval_approved").length, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("restart recognizes a cancelled approval event without inventing a denial", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-approval-cancel-restart-"));
  const now = "2026-09-25T02:30:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    store.createRun({ id: "run_cancel_restart", cwd, taskId: "task_cancel_restart",
      providerName: "test-provider", providerModel: "test-model",
      taskSnapshot: { id: "task_cancel_restart", title: "Cancel" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd }, createdAt: now });
    const approval = store.createApprovalRequest({ runId: "run_cancel_restart", taskId: "task_cancel_restart",
      actionType: "bash", risk: "medium", title: "Approve", description: "echo once",
      payload: { type: "bash", cwd, command: "echo once", riskFlags: [] } }, now);
    const cancelled = store.cancelApprovalRequest(approval.id, { reason: "Run cancelled", resolvedBy: "local-user" }, now);
    assert.ok(cancelled);
    store.appendEvent("run_cancel_restart", "approval_cancelled", { approvalId: approval.id, decisionReason: "Run cancelled" });
    recoverApprovalPostCommitStore({ store, cwd, now: "2026-09-25T02:31:00.000Z", onOwnerResolved: () => undefined });
    const decisionEvents = store.listEvents("run_cancel_restart")
      .filter((event) => event.type.startsWith("approval_") && event.type !== "approval_requested");
    assert.deepEqual(decisionEvents.map((event) => event.type), ["approval_cancelled"]);
    assert.equal(store.listApprovalPostCommitEffects({ approvalId: approval.id })
      .find((effect) => effect.effectKind === "decision_event")?.status, "completed");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const entry of ["ensureRunCancelled", "RunControlService.cancelRun"]) {
  test(`${entry} reuses the canonical cancellation event when recovery wins the publication race`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ling-approval-cancel-publication-race-"));
    const now = "2026-09-25T02:40:00.000Z";
    const store = createSqliteRunStore(cwd);
    try {
      const run = store.createRun({ id: `run_cancel_race_${entry.replaceAll(/[^a-zA-Z]/g, "_")}`, cwd,
        taskId: `task_cancel_race_${entry.replaceAll(/[^a-zA-Z]/g, "_")}`,
        providerName: "test-provider", providerModel: "test-model",
        taskSnapshot: { title: "Cancel publication race" },
        providerSnapshot: { provider: "test-provider", model: "test-model" },
        requestSnapshot: { cwd }, createdAt: now });
      const approval = store.createApprovalRequest({ runId: run.id, taskId: run.taskId,
        actionType: "bash", risk: "medium", title: "Approve", description: "echo once",
        payload: { type: "bash", cwd, command: "echo once", riskFlags: [] } }, now);
      const originalCancel = store.cancelApprovalRequest.bind(store);
      let recoveryScans = 0;
      store.cancelApprovalRequest = (...args) => {
        const cancelled = originalCancel(...args);
        if (cancelled) {
          recoveryScans += 1;
          recoverApprovalPostCommitStore({ store, cwd, now: "2026-09-25T02:40:01.000Z",
            onOwnerResolved: () => undefined });
        }
        return cancelled;
      };

      if (entry === "ensureRunCancelled") {
        ensureRunCancelled({ store, runId: run.id, taskId: run.taskId, reason: "user_requested", active: false });
      } else {
        new RunControlService().cancelRun({ store, runId: run.id, reason: "user_requested" });
      }
      assert.equal(recoveryScans, 1, "recovery must publish between the cancellation commit and the old caller continuation");

      const decisionEvents = store.listEvents(run.id, { limit: 100 })
        .filter(event => event.type === "approval_cancelled" && event.data.approvalId === approval.id);
      assert.equal(decisionEvents.length, 1);
      assert.equal(decisionEvents[0].id, `evt_approval_decision_${approval.id}`);
      const logEvents = (await readFile(run.eventLogPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse)
        .filter(event => event.type === "approval_cancelled" && event.data?.approvalId === approval.id);
      assert.equal(logEvents.length, 1);
      assert.equal(logEvents[0].id, decisionEvents[0].id);

      recoverApprovalPostCommitStore({ store, cwd, now: "2026-09-25T02:40:02.000Z",
        onOwnerResolved: () => undefined });
      assert.equal(store.listEvents(run.id, { limit: 100 })
        .filter(event => event.type === "approval_cancelled" && event.data.approvalId === approval.id).length, 1);
      assert.equal((await readFile(run.eventLogPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse)
        .filter(event => event.type === "approval_cancelled" && event.data?.approvalId === approval.id).length, 1);
    } finally {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("media approval with queued job but no durable execution handle is effect-unknown, never re-dispatched", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-approval-media-unknown-"));
  const now = "2026-09-25T03:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    const job = store.createMediaJob({ providerPresetId: "provider_test", operation: "image_generate", prompt: "Test" }, now);
    store.updateMediaJobStatus(job.id, { status: "waiting_for_approval" }, now);
    const approval = store.createApprovalRequest({ mediaJobId: job.id, actionType: "media_cost",
      risk: "medium", title: "Approve media", description: "Cost",
      payload: { type: "media_cost", providerPresetId: "provider_test", model: "test",
        operation: "image_generate", promptPreview: "Test" } }, now);
    store.approveApprovalRequest(approval.id, { decisionKind: "approve_once" }, now);
    // The daemon died after queueing the job, before persisting an external handle.
    store.updateMediaJobStatus(job.id, { status: "queued" }, now);
    store.close();
    store = createSqliteRunStore(cwd);
    let dispatches = 0;
    const result = recoverApprovalPostCommitStore({ store, cwd, now: "2026-09-25T03:01:00.000Z",
      onOwnerResolved: () => { dispatches += 1; return undefined; } });
    assert.equal(dispatches, 0);
    assert.equal(result.unknown, 1);
    assert.equal(store.listApprovalPostCommitEffects({ approvalId: approval.id }).find((effect) => effect.effectKind === "owner")?.status,
      "effect_unknown");
    recoverApprovalPostCommitStore({ store, cwd, now: "2026-09-25T03:02:00.000Z",
      onOwnerResolved: () => { dispatches += 1; return undefined; } });
    assert.equal(dispatches, 0);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon stop/start observes durable media effect-unknown instead of replaying a queued job", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-approval-daemon-restart-"));
  const now = "2026-09-25T04:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  let daemon;
  try {
    const job = store.createMediaJob({ providerPresetId: "provider_test", operation: "image_generate", prompt: "Test" }, now);
    store.updateMediaJobStatus(job.id, { status: "waiting_for_approval" }, now);
    const approval = store.createApprovalRequest({ mediaJobId: job.id, actionType: "media_cost",
      risk: "medium", title: "Approve media", description: "Cost",
      payload: { type: "media_cost", providerPresetId: "provider_test", model: "test",
        operation: "image_generate", promptPreview: "Test" } }, now);
    store.approveApprovalRequest(approval.id, { decisionKind: "approve_once" }, now);
    store.updateMediaJobStatus(job.id, { status: "queued" }, now);
    store.close();
    const config = { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd };
    daemon = createDaemonServer(config);
    await daemon.start();
    await daemon.stop();
    daemon = undefined;
    store = createSqliteRunStore(cwd);
    assert.equal(store.listApprovalPostCommitEffects({ approvalId: approval.id }).find((effect) => effect.effectKind === "owner")?.status,
      "effect_unknown");
    assert.equal(store.getMediaJob(job.id)?.status, "queued");
    store.close();
    daemon = createDaemonServer(config);
    await daemon.start();
    await daemon.stop();
    daemon = undefined;
    store = createSqliteRunStore(cwd);
    assert.equal(store.listApprovalPostCommitEffects({ approvalId: approval.id }).find((effect) => effect.effectKind === "owner")?.status,
      "effect_unknown");
    assert.equal(store.getMediaJobExecutionHandle(job.id), undefined);
  } finally {
    if (daemon) await daemon.stop();
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a placeholder handle is not proof of provider submission and quarantines even a completed approval effect", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-approval-placeholder-"));
  const now = "2026-09-25T05:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const job = store.createMediaJob({ providerPresetId: "provider_test", operation: "image_generate", prompt: "Test" }, now);
    store.updateMediaJobStatus(job.id, { status: "waiting_for_approval" }, now);
    const approval = store.createApprovalRequest({ mediaJobId: job.id, actionType: "media_cost",
      risk: "medium", title: "Approve media", description: "Cost",
      payload: { type: "media_cost", providerPresetId: "provider_test", model: "test",
        operation: "image_generate", promptPreview: "Test" } }, now);
    store.approveApprovalRequest(approval.id, { decisionKind: "approve_once" }, now);
    const claim = store.claimApprovalPostCommitEffect(approval.id, "owner", {
      token: "handed-off", claimExpiresAt: "2026-09-25T05:01:00.000Z",
    }, now);
    assert.ok(claim);
    store.settleApprovalPostCommitEffect(approval.id, "owner", { token: "handed-off", status: "completed" }, now);
    store.updateMediaJobStatus(job.id, { status: "queued" }, now);
    const handle = store.upsertMediaJobExecutionHandle({ mediaJobId: job.id, adapterKind: "test",
      externalOperationId: `ling-pending:${job.id}`, recovery: { phase: "waiting_for_submission" } }, now);
    assert.equal(mediaApprovalRecoveryBlocked(store, job.id, handle), true);
    assert.equal(store.listApprovalPostCommitEffects({ approvalId: approval.id }).find((effect) => effect.effectKind === "owner")?.status,
      "effect_unknown");
    assert.equal(mediaApprovalRecoveryBlocked(store, job.id, handle), true);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a completed media owner without a durable handle cannot be dispatched again after restart", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-approval-no-handle-"));
  const now = "2026-09-25T06:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    const job = store.createMediaJob({ providerPresetId: "provider_test", operation: "image_generate", prompt: "Test" }, now);
    store.updateMediaJobStatus(job.id, { status: "waiting_for_approval" }, now);
    const approval = store.createApprovalRequest({ mediaJobId: job.id, actionType: "media_cost",
      risk: "medium", title: "Approve media", description: "Cost",
      payload: { type: "media_cost", providerPresetId: "provider_test", model: "test",
        operation: "image_generate", promptPreview: "Test" } }, now);
    store.approveApprovalRequest(approval.id, { decisionKind: "approve_once" }, now);
    const claim = store.claimApprovalPostCommitEffect(approval.id, "owner", {
      token: "completed-before-crash", claimExpiresAt: "2026-09-25T06:01:00.000Z",
    }, now);
    assert.ok(claim);
    store.updateMediaJobStatus(job.id, { status: "queued" }, now);
    store.settleApprovalPostCommitEffect(approval.id, "owner", { token: "completed-before-crash", status: "completed" }, now);
    assert.equal(store.getMediaJobExecutionHandle(job.id), undefined);
    const run = store.createRun({ id: "run_media_no_handle", cwd, taskId: "task_media_no_handle", providerName: "test-provider",
      providerModel: "test-model", taskSnapshot: { id: "task_media_no_handle", title: "Media" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd }, createdAt: now });
    store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "media_job",
      ownerType: "conversation_run", ownerId: run.id, idempotencyKey: "media-no-handle",
      createdByActor: "system", request: { source: "conversation_media_tool" },
      linkedRunId: run.id, linkedMediaJobId: job.id, now });
    store.close();
    store = createSqliteRunStore(cwd);

    const dispatched = [];
    resumePendingMediaJobExecutions({ cwd, storeRegistry: { getStore: () => store },
      secretResolver: {}, hooks: {}, dispatchInitialConversationMediaJob: (mediaJobId) => dispatched.push(mediaJobId) });
    assert.deepEqual(dispatched, []);
    assert.equal(mediaApprovalRecoveryBlocked(store, job.id, undefined), true);
    assert.equal(store.listApprovalPostCommitEffects({ approvalId: approval.id }).find((effect) => effect.effectKind === "owner")?.status,
      "effect_unknown");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
