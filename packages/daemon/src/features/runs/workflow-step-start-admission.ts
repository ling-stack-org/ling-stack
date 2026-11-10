import { classifyWorkflowStepStartOwner, workflowStepStartOwnerMatches, toRuntimeAttemptFence,
  type RunSession, type RunStore, type WorkUnitAttempt, type WorkflowStepStartOwnerV1 } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import type { RunRequest } from "./schemas.js";
import { createWorkflowSafetyAdmission } from "./workflow-safety.js";
import { QueueableRunConflictError } from "./concurrency.js";
import type { PreparedRunnerContinuationExecution } from "../harness/continuations/coordinator.js";
import type { RuntimeHostCapacityAdmission } from "../../runtime/run-queue.js";
import type { RuntimeHostCapacityDispatchReference } from "@ling-stack/core/runtime-host-capacity-store-bridge";

/** Rebuild continuation ownership only from an already linked canonical Run. Never synthesize a missing marker. */
export function captureWorkflowStartOwner(
  store: RunStore,
  request: RunRequest,
  continuationRunId?: string,
  options: { readonly waitingForInput?: boolean } = {},
): WorkflowStepStartOwnerV1 | undefined {
  if (!request.workflowStepId) return undefined;
  const step = store.getChannelWorkflowStep(request.workflowStepId);
  const classified = step && classifyWorkflowStepStartOwner(
    store,
    step,
    new Date().toISOString(),
    options.waitingForInput ? { requireActiveLease: false, allowWaitingForInput: true } : {},
  );
  const owner = request.workflowStartOwner ?? (continuationRunId && step?.runId === continuationRunId
    && classified?.status === "linked" ? classified.owner : undefined);
  if (!step || !owner || !classified || classified.status === "invalid"
    || !workflowStepStartOwnerMatches(classified.owner, owner) || owner.taskId !== request.task.id
    || continuationRunId && (classified.status !== "linked" || step.runId !== continuationRunId)) {
    throw new HttpError(409, "workflow_start_owner_stale", "Workflow start no longer owns this task and source.");
  }
  return owner;
}

/** Mandatory durable gate. Auxiliary ready notifications cannot authorize a Run. */
export function commitWorkflowStartReady(store: RunStore, request: RunRequest, runId: string,
  owner: WorkflowStepStartOwnerV1 | undefined, options: {
    readonly claimQueuedTask?: boolean;
    readonly hostCapacity?: RuntimeHostCapacityDispatchReference;
  } = {}): void {
  if (!request.workflowStepId) return;
  if (!owner) throw new HttpError(409, "workflow_start_owner_missing", "Workflow Run requires its captured start owner.");
  const step = store.getChannelWorkflowStep(request.workflowStepId);
  const reservation = store.getChannelWorkflowStepStartAdmission(request.workflowStepId, owner);
  const run = store.getRun(runId);
  const unit = run?.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
  const attempt = unit?.activeAttemptId ? store.getWorkUnitAttempt(unit.activeAttemptId) : undefined;
  const plan = reservation && step && attempt ? createWorkflowSafetyAdmission(store, step,
    { ...request, runnerId: attempt.effectiveRunnerId }) : undefined;
  if (reservation && (!plan || !attempt)) throw new HttpError(409, "workflow_admission_plan_mismatch", "Prepared Run has no matching admission plan.");
  const now = new Date().toISOString();
  const result = store.commitChannelWorkflowStepRunReady({ workflowStepId: request.workflowStepId, owner, runId,
    claimQueuedTask: options.claimQueuedTask, now,
    ...(options.hostCapacity ? { hostCapacity: options.hostCapacity } : {}),
    ...(plan && attempt ? { admission: { ...toRuntimeAttemptFence(attempt), admission: plan,
      expiresAt: new Date(Date.parse(now) + 6 * 60 * 60 * 1000).toISOString() } } : {}) });
  if (result.status !== "linked" && result.status !== "duplicate") {
    rejectPreparedWorkflowRun(store, runId, result.code ?? "workflow_start_owner_stale");
    if (!options.hostCapacity) {
      failUndispatchedWorkflowStart({ store, request, owner, run, attempt, now,
        reason: result.code ?? "workflow_start_owner_stale" });
    }
    throw new HttpError(409, result.code ?? "workflow_start_owner_stale", "Workflow start changed before the Run could become ready.");
  }
}

/** A new physical Attempt must reacquire the original complete plan, never ordinary Run slots. */
export function resumeWorkflowStartAdmission(store: RunStore, request: RunRequest, runId: string,
  owner: WorkflowStepStartOwnerV1 | undefined, execution: PreparedRunnerContinuationExecution, now: string): void {
  if (!request.workflowStepId || !owner) return;
  const reservation = store.getChannelWorkflowStepStartAdmission(request.workflowStepId, owner);
  if (!reservation) return;
  const step = store.getChannelWorkflowStep(request.workflowStepId);
  const source = store.getWorkUnitAttempt(execution.continuation.sourceAttemptId);
  if (!step || !source) {
    throw new HttpError(409, "workflow_admission_continuation_stale", "Workflow continuation source is no longer available.");
  }
  const admission = createWorkflowSafetyAdmission(store, step, { ...request, runnerId: execution.attempt.effectiveRunnerId });
  if (!admission) {
    throw new HttpError(409, "workflow_admission_plan_mismatch", "Workflow continuation has no complete safety admission plan.");
  }
  const result = store.resumeChannelWorkflowStepStartAdmission({ workflowStepId: step.id, owner, runId,
    ...toRuntimeAttemptFence(execution.attempt), sourceFence: toRuntimeAttemptFence(source),
    continuationId: execution.continuation.id, expectedContinuationRevision: execution.continuation.revision,
    claimOwner: execution.claimOwner, claimToken: execution.claimToken,
    admission,
    now, expiresAt: new Date(Date.parse(now) + 6 * 60 * 60 * 1000).toISOString() });
  if (result.status === "resumed" || result.status === "duplicate") return;
  if (result.status === "conflict") {
    const channel = store.getChannel(step.channelId);
    const message = `Workflow continuation capacity is full: ${result.resourceType}:${result.resourceKey}`;
    if (channel?.runtimePolicy.queueOnConflict) {
      throw new QueueableRunConflictError("runtime_semaphore_conflict", message, channel);
    }
    throw new HttpError(409, "runtime_semaphore_conflict", message);
  }
  throw new HttpError(409, "code" in result ? result.code : "workflow_admission_attempt_stale",
    "Workflow continuation cannot reacquire its original safety admission.");
}

/** Call immediately before an execution-capable operation, without an intervening await. */
export function assertWorkflowRunAdmission(store: RunStore, run: RunSession, owner: WorkflowStepStartOwnerV1 | undefined, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (!run.workflowStepId) return;
  const step = store.getChannelWorkflowStep(run.workflowStepId);
  const classified = step && classifyWorkflowStepStartOwner(store, step, new Date().toISOString());
  const currentRun = store.getRun(run.id);
  const task = currentRun && store.getTask(currentRun.taskId);
  if (!step || !owner || !classified || classified.status !== "linked" || step.runId !== run.id
    || !workflowStepStartOwnerMatches(classified.owner, owner)
    || !currentRun || !["queued", "running"].includes(currentRun.status)
    || !task || !["claimed", "running", "waiting_for_approval"].includes(task.status)) {
    throw new HttpError(409, "workflow_start_owner_stale", "Workflow execution was cancelled, superseded or replaced.");
  }
}

/** Only the preparation caller can assert no dispatch; Core independently checks durable effect evidence. */
export function failUndispatchedWorkflowStart(input: {
  readonly store: RunStore;
  readonly request: RunRequest;
  readonly owner?: WorkflowStepStartOwnerV1;
  readonly run?: RunSession;
  readonly attempt?: WorkUnitAttempt;
  readonly reason: string;
  readonly now: string;
}): void {
  const { store, request } = input;
  const owner = input.owner ?? request.workflowStartOwner;
  if (!request.workflowStepId || !owner
    || !store.getChannelWorkflowStepStartAdmission(request.workflowStepId, owner)) return;
  store.settleChannelWorkflowStepStartFailure({ workflowStepId: request.workflowStepId, owner,
    leaseId: owner.leaseId, blocker: input.reason, now: input.now,
    admissionRelease: { dispatchState: "not_dispatched",
      ...(input.run && input.attempt ? { runId: input.run.id, fence: toRuntimeAttemptFence(input.attempt) } : {}) } });
}


function rejectPreparedWorkflowRun(store: RunStore, runId: string, code: string): void {
  const run = store.getRun(runId);
  // Answer admission owns atomic Task/wait/outbox cleanup. A partial generic
  // terminal transition would destroy the exact unstarted fence it requires.
  if (run?.continuationReason === "user_input_answer") return;
  const unit = run?.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
  const attempt = unit?.activeAttemptId ? store.getWorkUnitAttempt(unit.activeAttemptId) : undefined;
  if (!run || !unit || !attempt || unit.linkedRunId !== run.id || run.status !== "queued"
    || run.startedAt || unit.startedAt || unit.lastHeartbeatAt || attempt.status !== "created"
    || attempt.startedAt || attempt.lastHeartbeatAt || attempt.abortRequestedAt) return;
  const now = new Date().toISOString();
  const fence = toRuntimeAttemptFence(attempt);
  const terminal = store.transitionRunExecutionStatus({ runId, sourceFence: fence, expectedStatus: run.status,
    event: "runner_failed", actor: "system", reason: code, now, endedAt: now, errorMessage: code });
  if (terminal.ok) {
    store.transitionWorkUnitAttemptTerminal({ ...fence, event: "runner_failed", attemptStatus: "failed",
      runtimeEventType: "work_unit_failed", actor: "system", now, errorCode: code, errorMessage: code });
    store.releaseResourceLeasesForAttempt(fence, now, code);
    store.releaseRuntimeSemaphoreSlotsForAttempt(fence, now, code);
  }
}
