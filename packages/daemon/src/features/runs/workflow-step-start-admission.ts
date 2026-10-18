import { classifyWorkflowStepStartOwner, workflowStepStartOwnerMatches, toRuntimeAttemptFence,
  type RunSession, type RunStore, type WorkflowStepStartOwnerV1 } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import type { RunRequest } from "./schemas.js";

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
  owner: WorkflowStepStartOwnerV1 | undefined, options: { readonly claimQueuedTask?: boolean } = {}): void {
  if (!request.workflowStepId) return;
  if (!owner) throw new HttpError(409, "workflow_start_owner_missing", "Workflow Run requires its captured start owner.");
  const result = store.commitChannelWorkflowStepRunReady({ workflowStepId: request.workflowStepId, owner, runId,
    claimQueuedTask: options.claimQueuedTask, now: new Date().toISOString() });
  if (result.status !== "linked" && result.status !== "duplicate") {
    rejectPreparedWorkflowRun(store, runId, result.code ?? "workflow_start_owner_stale");
    throw new HttpError(409, result.code ?? "workflow_start_owner_stale", "Workflow start changed before the Run could become ready.");
  }
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

function rejectPreparedWorkflowRun(store: RunStore, runId: string, code: string): void {
  const run = store.getRun(runId);
  // Answer admission owns atomic Task/wait/outbox cleanup. A partial generic
  // terminal transition would destroy the exact unstarted fence it requires.
  if (run?.continuationReason === "user_input_answer") return;
  const unit = run?.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
  const attempt = unit?.activeAttemptId ? store.getWorkUnitAttempt(unit.activeAttemptId) : undefined;
  if (!run || !unit || !attempt || unit.linkedRunId !== run.id || !["queued", "running"].includes(run.status)) return;
  const now = new Date().toISOString();
  const fence = toRuntimeAttemptFence(attempt);
  const terminal = store.transitionRunExecutionStatus({ runId, sourceFence: fence, expectedStatus: run.status,
    event: "runner_failed", actor: "system", reason: code, now, endedAt: now, errorMessage: code });
  if (terminal.ok) {
    store.transitionWorkUnitAttemptTerminal({ ...fence, event: "runner_failed", attemptStatus: "failed",
      runtimeEventType: "work_unit_failed", actor: "system", now, errorCode: code, errorMessage: code });
    store.releaseResourceLeasesForAttempt(fence, now, code);
  }
}
