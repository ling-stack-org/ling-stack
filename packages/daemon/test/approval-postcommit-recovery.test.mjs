import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID } from "@ling-stack/core";
import { appendApprovalDecisionEvent } from "../dist/features/runs/approvals.js";
import { recoverApprovalPostCommitStore } from "../dist/features/runs/approval-postcommit-recovery.js";
import { createDaemonServer } from "../dist/index.js";
import { mediaApprovalRecoveryBlocked } from "../dist/features/media/approval-recovery-guard.js";
import { resumePendingMediaJobExecutions } from "../dist/features/media/executor.js";

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
