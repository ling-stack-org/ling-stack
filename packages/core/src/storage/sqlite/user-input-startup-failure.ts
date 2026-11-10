import type { RunStore } from "../../run-types.js";
import type { UserInputContinuationSeed } from "../../user-input-continuation-types.js";
import type { FailUserInputContinuationStartup, UserInputContinuationBinding } from "../../user-input-host-continuation-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import { workflowStepStartOwnerMatches } from "../../workflow-step-start-owner.js";
import type { SqliteStoreContext } from "./store-context.js";

export type UserInputStartupFailurePorts = Pick<RunStore, "getTask" | "getLingThread" | "getChannelWorkflowStep"
  | "getChannelWorkflow" | "listChannelWorkflowSteps" | "transitionTaskStatus" | "transitionChannelWorkflowStepStatus"
  | "transitionChannelWorkflowStatus" | "transitionRunExecutionStatus" | "transitionWorkUnitStatus"
  | "updateWorkUnitAttemptStatus" | "appendTerminalRuntimeAudit" | "releaseResourceLease"
  | "releaseResourceLeasesForAttempt" | "releaseRuntimeSemaphoreSlotsForAttempt"
  | "reconcileLingTurnStatus" | "updateLingThread">;

/** Caller owns the writer transaction and has verified an unstarted, unacknowledged binding. */
export function failUserInputStartupWithinTransaction(context: SqliteStoreContext, store: UserInputStartupFailurePorts,
  seed: UserInputContinuationSeed, binding: UserInputContinuationBinding, input: FailUserInputContinuationStartup, now: string): void {
  const transition = { actor: "system" as const, reason: input.errorCode, now };
  requireTransition(store.transitionRunExecutionStatus({ ...transition, runId: binding.runId, sourceFence: binding.fence,
    expectedStatus: "queued", event: "runner_failed", errorMessage: input.errorMessage, endedAt: now }));
  requireTransition(store.transitionWorkUnitStatus({ ...transition, ...binding.fence, expectedStatus: "claimed",
    event: "runner_failed", activeAttemptId: binding.fence.attemptId, endedAt: now,
    errorCode: input.errorCode, errorMessage: input.errorMessage }));
  const attempt = store.updateWorkUnitAttemptStatus({ ...binding.fence, status: "failed", endedAt: now, now,
    errorCode: input.errorCode, errorMessage: input.errorMessage });
  if (!attempt) throw new UserInputStoreError("source_conflict");
  store.appendTerminalRuntimeAudit({ capability: { ...binding.fence, attemptStatus: "failed", transitionedAt: now },
    type: "work_unit_failed", actor: "system", data: { fromStatus: "claimed", toStatus: "failed",
      errorCode: input.errorCode, errorMessage: input.errorMessage } });
  if (seed.source.taskBinding.kind === "stored_task") {
    const task = store.getTask(seed.source.taskBinding.taskId);
    if (!task || task.status !== "claimed" || task.currentRunId !== binding.runId) throw new UserInputStoreError("source_conflict");
    requireTransition(store.transitionTaskStatus({ ...transition, taskId: task.id, expectedStatus: "claimed",
      currentRunId: binding.runId, event: "run_failed" }));
  }
  if (seed.source.workflowStepId && !binding.workflowStartOwner) throw new UserInputStoreError("source_conflict");
  if (binding.workflowStartOwner) {
    const step = seed.source.workflowStepId && store.getChannelWorkflowStep(seed.source.workflowStepId);
    if (!step || step.status !== "running" || step.runId !== binding.runId
      || !workflowStepStartOwnerMatches(step.metadata?.startOwner, binding.workflowStartOwner)) {
      throw new UserInputStoreError("source_conflict");
    }
    const policy = step.metadata?.policy?.onRunFailed ?? "block_for_user";
    const event = policy === "fail_workflow" ? "fail" : policy === "cancel_workflow" ? "cancel"
      : policy === "skip_if_optional" ? "skip" : "blocked";
    requireTransition(store.transitionChannelWorkflowStepStatus({ ...transition, workflowStepId: step.id,
      expectedStatus: "running", event, blocker: event === "skip" ? null : input.errorCode }));
    store.releaseResourceLease(binding.workflowStartOwner.leaseId, "workflow_step", step.id, now);
    const workflow = store.getChannelWorkflow(step.workflowId);
    if (!workflow) throw new UserInputStoreError("source_conflict");
    const workflowEvent = policy === "fail_workflow" ? "step_failed" : policy === "cancel_workflow" ? "cancel"
      : policy === "block_for_user" ? "step_blocked" : undefined;
    if (workflowEvent && ["running", "waiting_for_input", "waiting_for_approval", "blocked"].includes(workflow.status)
      && !(workflow.status === "blocked" && workflowEvent === "step_blocked")) {
      requireTransition(store.transitionChannelWorkflowStatus({ ...transition, workflowId: workflow.id,
        expectedStatus: workflow.status, event: workflowEvent }));
    }
    if (event === "skip" && workflow.status === "running" && !workflow.metadata?.requiredParticipantManifest) {
      const steps = store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true });
      if (steps.length > 0 && steps.every(item => item.status === "succeeded" || item.status === "skipped")) {
        requireTransition(store.transitionChannelWorkflowStatus({ ...transition, workflowId: workflow.id,
          expectedStatus: "running", event: "all_steps_succeeded" }));
      }
    }
  }
  store.releaseResourceLeasesForAttempt(binding.fence, now, input.errorCode);
  store.releaseRuntimeSemaphoreSlotsForAttempt(binding.fence, now, input.errorCode);
  requireChange(context.database.prepare("UPDATE user_input_deliveries SET status='obsolete',status_revision=status_revision+1,updated_at=?,"
    + "claim_owner_id=NULL,claim_token=NULL,claim_expires_at=NULL,retry_at=NULL,last_error_code='receiver_rejected'"
    + " WHERE delivery_id=? AND status='claimed' AND status_revision=?").run(now, seed.deliveryId, binding.deliveryRevision).changes);
  requireChange(context.database.prepare("UPDATE user_input_requests SET wait_status='cancelled',wait_revision=wait_revision+1,updated_at=?"
    + " WHERE request_id=? AND wait_status='resuming' AND wait_revision=?").run(now, seed.request.requestId, binding.waitRevision).changes);
  store.reconcileLingTurnStatus(seed.source.turnId, now);
  const thread = store.getLingThread(seed.source.threadId);
  if (thread && thread.status !== "archived") {
    const active = context.database.prepare("SELECT id,status FROM run_sessions WHERE thread_id=?"
      + " AND status IN ('queued','running','waiting_for_approval')"
      + " ORDER BY CASE WHEN status='waiting_for_approval' THEN 0 ELSE 1 END,updated_at DESC,id DESC LIMIT 1").get(thread.id);
    store.updateLingThread(thread.id, { status: active?.status === "waiting_for_approval" ? "waiting_for_approval" : active ? "running" : "failed",
      activeRunId: active ? String(active.id) : null, lastRunId: binding.runId }, now);
  }
}

function requireTransition(result: { readonly ok: boolean }): void {
  if (!result.ok) throw new UserInputStoreError("source_conflict");
}

function requireChange(changes: number | bigint): void {
  if (Number(changes) !== 1) throw new UserInputStoreError("source_conflict");
}
