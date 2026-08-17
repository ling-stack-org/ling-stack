import {
  type ApprovalRequest,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type RunSession,
  type RunStore,
  type WorkflowFanInContextReview,
  type WorkflowStepFailurePolicy,
  type WorkflowStepGate,
  type WorkflowStepPolicy,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { isRecord } from "../../shared/validation.js";
import type { ValidateWorkflowStepRunRequest, WorkflowStepRunRequest } from "./workflows.js";
import {
  completeWorkflowIfStepsFinished,
  maybeCreateWorkflowTerminalCoordinatorReply,
  prepareWorkflowStepStart,
} from "./workflows.js";
import { getWorkflowPlanModeBlocker } from "./plan-mode-guard.js";
import { maybeCreateWorkflowFanInEvidence } from "./workflow-fanin.js";
import {
  createWorkflowStepOutputArtifact,
  readWorkflowAgentContextFromRunSnapshot,
  readWorkflowStepContextPacketArtifact,
} from "./workflow-step-packets.js";
import {
  privateRoleEvidenceValues,
  reviewWorkflowAgentContextStamp,
  textContainsPrivateRoleEvidence,
} from "./agent-context-consistency.js";
import { ensureDeterministicWorkflowSelectorDecision } from "./workflow-selector.js";
import { verifyWorkflowStepExecutionOperations } from "./workflow-operation-evidence.js";
import { finalizeDelegatedWorkflowStepFromCanonicalState } from "./workflow-step-finalizer.js";
import { reconcileWorkflowFromCanonicalState } from "./workflow-reconciliation.js";
import { syncWorkflowSourceTurnProgress } from "./workflow-source-turn.js";
import {
  resolveSmartSchedulingDecision,
  withSmartSchedulingReason,
  type SmartSchedulingDecision,
} from "./smart-scheduler.js";

export interface OrchestrateWorkflowInput {
  readonly store: RunStore;
  readonly cwd: string;
  readonly workflowId: string;
  readonly validateRunRequest: ValidateWorkflowStepRunRequest;
  readonly startRun: StartOrchestratedWorkflowStepRun;
}

export type StartOrchestratedWorkflowStepRun = (input: {
  readonly workflow: ChannelWorkflow;
  readonly workflowStep: ChannelWorkflowStep;
  readonly taskId: string;
  readonly runRequest: WorkflowStepRunRequest;
}) => Promise<string | undefined>;

export interface WorkflowOrchestrationStartedStep {
  readonly workflowStep: ChannelWorkflowStep;
  readonly taskId: string;
  readonly runId?: string;
}

export type WorkflowOrchestrationResult =
  | {
      readonly status: "started";
      readonly workflow: ChannelWorkflow;
      readonly workflowStep: ChannelWorkflowStep;
      readonly taskId: string;
      readonly runId?: string;
      readonly startedSteps?: readonly WorkflowOrchestrationStartedStep[];
      readonly schedulingDecision?: SmartSchedulingDecision;
    }
  | {
      readonly status: "waiting_for_approval";
      readonly workflow: ChannelWorkflow;
      readonly workflowStep: ChannelWorkflowStep;
      readonly approval: ApprovalRequest;
      readonly waitingApprovals?: readonly {
        readonly workflowStep: ChannelWorkflowStep;
        readonly approval: ApprovalRequest;
      }[];
      readonly schedulingDecision?: SmartSchedulingDecision;
    }
  | { readonly status: "idle"; readonly workflow: ChannelWorkflow; readonly reason: string; readonly schedulingDecision?: SmartSchedulingDecision }
  | { readonly status: "blocked"; readonly workflow: ChannelWorkflow; readonly workflowStep?: ChannelWorkflowStep; readonly blocker: string; readonly schedulingDecision?: SmartSchedulingDecision }
  | { readonly status: "failed"; readonly workflow: ChannelWorkflow; readonly workflowStep?: ChannelWorkflowStep; readonly blocker: string; readonly schedulingDecision?: SmartSchedulingDecision }
  | { readonly status: "completed"; readonly workflow: ChannelWorkflow; readonly schedulingDecision?: SmartSchedulingDecision };

export type WorkflowApprovalDecisionSyncResult =
  | { readonly status: "not_workflow_approval" }
  | { readonly status: "missing_owner"; readonly workflowStepId: string }
  | { readonly status: "synced"; readonly workflow: ChannelWorkflow; readonly workflowStep: ChannelWorkflowStep; readonly result?: WorkflowOrchestrationResult };

export interface CancelWorkflowInput {
  readonly store: RunStore;
  readonly workflowId: string;
  readonly reason?: string;
  readonly cancelRun?: (run: RunSession) => void;
}

export interface CancelWorkflowResult {
  readonly workflow: ChannelWorkflow;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly cancelledRunIds: readonly string[];
  readonly cancelledApprovalIds: readonly string[];
}

export interface RetryWorkflowStepInput {
  readonly store: RunStore;
  readonly cwd: string;
  readonly workflowStepId: string;
  readonly validateRunRequest: ValidateWorkflowStepRunRequest;
  readonly startRun: StartOrchestratedWorkflowStepRun;
}

const DEFAULT_WORKFLOW_STEP_POLICY: WorkflowStepPolicy = {
  onRunFailed: "block_for_user",
  onRunCancelled: "block_for_user",
  onApprovalDenied: "block_for_user",
  retryable: true,
};

export async function orchestrateChannelWorkflow(input: OrchestrateWorkflowInput): Promise<WorkflowOrchestrationResult> {
  const workflow = input.store.getChannelWorkflow(input.workflowId);
  if (!workflow) {
    throw new HttpError(404, "workflow_not_found", `Channel workflow not found: ${input.workflowId}`);
  }
  syncWorkflowSourceTurnProgress(input.store, workflow, new Date().toISOString());
  const planModeBlocker = getWorkflowPlanModeBlocker(input.store, workflow);
  if (planModeBlocker) {
    throw new HttpError(409, "plan_mode_workflow_blocked", planModeBlocker);
  }
  const reconciled = reconcileWorkflowStepRuns(input.store, workflow.id);
  if (reconciled.status === "completed") {
    return { status: "completed", workflow: reconciled.workflow };
  }
  if (reconciled.status === "blocked") {
    return reconciled;
  }
  if (reconciled.status === "waiting_for_approval" || reconciled.status === "failed") {
    return reconciled;
  }
  const currentWorkflow = input.store.getChannelWorkflow(workflow.id) ?? workflow;
  const steps = input.store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 });
  const activeStepCount = countActiveWorkflowSteps(steps);
  const approvedGatedSteps = steps.filter((step) => step.status === "running" && step.metadata?.preStepApprovalId && !step.runId && !step.taskId);
  const eligibleSteps = [
    ...approvedGatedSteps,
    ...steps.filter((step) => step.status === "queued" && isWorkflowStepEligible(step, steps)),
  ].sort(compareWorkflowStepForScheduling);
  const schedulingDecision = resolveSmartSchedulingDecision({
    store: input.store,
    channel: input.store.getChannel(currentWorkflow.channelId),
    workflow: currentWorkflow,
    steps,
    eligibleSteps,
    activeStepCount,
  });
  const parallelStartBudget = schedulingDecision.parallelLimit;
  const startBudget = schedulingDecision.runnableStepIds.length;
  if (parallelStartBudget <= 1 && approvedGatedSteps.length === 0 && steps.some((step) => step.status === "claimed" || step.status === "running" || step.status === "waiting_for_approval")) {
    return { status: "idle", workflow: currentWorkflow, reason: "Workflow already has an active step.", schedulingDecision };
  }
  if (eligibleSteps.length === 0 || startBudget <= 0) {
    completeWorkflowIfStepsFinished(input.store, workflow.id, new Date().toISOString());
    const latest = input.store.getChannelWorkflow(workflow.id) ?? currentWorkflow;
    if (latest.status === "succeeded") {
      return { status: "completed", workflow: latest, schedulingDecision };
    }
    return {
      status: "idle",
      workflow: latest,
      reason: startBudget <= 0 ? "Workflow smart scheduling budget is exhausted." : "No eligible queued workflow step.",
      schedulingDecision,
    };
  }

  const startedSteps: WorkflowOrchestrationStartedStep[] = [];
  const waitingApprovals: Array<{ readonly workflowStep: ChannelWorkflowStep; readonly approval: ApprovalRequest }> = [];
  const blockedResults: Array<Extract<WorkflowOrchestrationResult, { status: "blocked" }>> = [];

  for (const candidate of eligibleSteps) {
    if (startedSteps.length + waitingApprovals.length >= startBudget) {
      break;
    }
    let latestCandidate = input.store.getChannelWorkflowStep(candidate.id) ?? candidate;
    if (latestCandidate.metadata?.autoStart === false) {
      continue;
    }
    latestCandidate = ensureDeterministicWorkflowSelectorDecision({
      store: input.store,
      workflow: input.store.getChannelWorkflow(workflow.id) ?? currentWorkflow,
      selectedStep: latestCandidate,
      eligibleSteps,
      now: new Date().toISOString(),
    }).workflowStep;
    const isApprovedGatedStep = latestCandidate.status === "running" && latestCandidate.metadata?.preStepApprovalId && !latestCandidate.runId && !latestCandidate.taskId;
    if (!isApprovedGatedStep) {
      const gateResult = maybeRequestPreStepApproval(input.store, input.store.getChannelWorkflow(workflow.id) ?? currentWorkflow, latestCandidate);
      if (gateResult) {
        if (gateResult.status === "waiting_for_approval") {
          waitingApprovals.push({ workflowStep: gateResult.workflowStep, approval: gateResult.approval });
          if (parallelStartBudget <= 1) {
            break;
          }
          continue;
        }
        return { ...gateResult, schedulingDecision };
      }
    }

    const started = prepareWorkflowStepStart(
      input.store,
      latestCandidate.id,
      {
        mode: "create_and_run_task",
        assigneeTeammateId: latestCandidate.toParticipantId,
        providerPresetId: latestCandidate.metadata?.providerPresetId,
        runnerId: latestCandidate.metadata?.requestedRunnerId,
        idempotencyKey: `workflow-step:${latestCandidate.id}`,
      },
      input.cwd,
      input.validateRunRequest,
    );
    if (started.kind === "blocked") {
      blockedResults.push({
        status: "blocked",
        workflow: input.store.getChannelWorkflow(started.workflowId) ?? currentWorkflow,
        workflowStep: input.store.getChannelWorkflowStep(latestCandidate.id) ?? latestCandidate,
        blocker: started.blocker,
      });
      continue;
    }
    if (started.kind === "error") {
      throw new HttpError(started.statusCode, started.code, started.message);
    }

    const runRequest: WorkflowStepRunRequest = {
      ...started.runRequest,
      requestedSkillId: latestCandidate.metadata?.skillId,
    };
    const runId = await input.startRun({
      workflow: input.store.getChannelWorkflow(started.workflowId) ?? currentWorkflow,
      workflowStep: input.store.getChannelWorkflowStep(latestCandidate.id) ?? latestCandidate,
      taskId: started.task.id,
      runRequest,
    });
    if (!runId) {
      blockedResults.push(blockWorkflowStepRunStartFailure(input.store, started.workflowId, latestCandidate.id, started.task.id));
      continue;
    }
    startedSteps.push({
      workflowStep: input.store.getChannelWorkflowStep(latestCandidate.id) ?? latestCandidate,
      taskId: started.task.id,
      runId,
    });
  }

  if (startedSteps.length === 0 && waitingApprovals.length > 0) {
    const first = waitingApprovals[0];
    syncWorkflowSourceTurnProgress(input.store, input.store.getChannelWorkflow(workflow.id) ?? currentWorkflow, new Date().toISOString());
    return {
      status: "waiting_for_approval",
      workflow: input.store.getChannelWorkflow(workflow.id) ?? currentWorkflow,
      workflowStep: first.workflowStep,
      approval: first.approval,
      waitingApprovals,
      schedulingDecision: withSmartSchedulingReason(schedulingDecision, "approval_pending"),
    };
  }
  if (startedSteps.length === 0 && blockedResults.length > 0) {
    return { ...blockedResults[0], schedulingDecision };
  }
  if (startedSteps.length === 0) {
    return { status: "idle", workflow: input.store.getChannelWorkflow(workflow.id) ?? currentWorkflow, reason: "No workflow step was started.", schedulingDecision };
  }
  const firstStarted = startedSteps[0];
  return {
    status: "started",
    workflow: input.store.getChannelWorkflow(workflow.id) ?? currentWorkflow,
    workflowStep: firstStarted.workflowStep,
    taskId: firstStarted.taskId,
    runId: firstStarted.runId,
    startedSteps,
    schedulingDecision,
  };
}

export function syncWorkflowApprovalDecision(
  store: RunStore,
  approval: ApprovalRequest,
  now = new Date().toISOString(),
): WorkflowApprovalDecisionSyncResult {
  if (!approval.workflowStepId) {
    return { status: "not_workflow_approval" };
  }
  const step = store.getChannelWorkflowStep(approval.workflowStepId);
  if (!step) {
    return { status: "missing_owner", workflowStepId: approval.workflowStepId };
  }
  const workflow = store.getChannelWorkflow(step.workflowId);
  if (!workflow) {
    return { status: "missing_owner", workflowStepId: step.id };
  }
  const matchesPostGate = step.metadata?.postStepApprovalId === approval.id || (
    approval.payload.type === "workflow_step" &&
    approval.payload.gateStage === "post" &&
    approval.payload.workflowStepId === step.id
  );
  if (matchesPostGate) {
    const result = reconcilePostStepApprovalDecision(store, workflow, step, approval, now);
    syncWorkflowSourceTurnProgress(store, store.getChannelWorkflow(workflow.id) ?? workflow, now);
    return {
      status: "synced",
      workflow: store.getChannelWorkflow(workflow.id) ?? workflow,
      workflowStep: store.getChannelWorkflowStep(step.id) ?? step,
      ...(result ? { result } : {}),
    };
  }
  const matchesPreGate = step.metadata?.preStepApprovalId === approval.id || (
    approval.payload.type === "workflow_step" &&
    approval.payload.gateStage === "pre" &&
    approval.payload.workflowStepId === step.id
  );
  if (matchesPreGate) {
    const result = reconcilePreStepApprovalDecision(store, workflow, step, approval, now);
    syncWorkflowSourceTurnProgress(store, store.getChannelWorkflow(workflow.id) ?? workflow, now);
    return {
      status: "synced",
      workflow: store.getChannelWorkflow(workflow.id) ?? workflow,
      workflowStep: store.getChannelWorkflowStep(step.id) ?? step,
      ...(result ? { result } : {}),
    };
  }
  const result = reconcileLegacyWorkflowApprovalDecision(store, workflow, step, approval, now);
  syncWorkflowSourceTurnProgress(store, store.getChannelWorkflow(workflow.id) ?? workflow, now);
  return {
    status: "synced",
    workflow: store.getChannelWorkflow(workflow.id) ?? workflow,
    workflowStep: store.getChannelWorkflowStep(step.id) ?? step,
    ...(result ? { result } : {}),
  };
}

function reconcileLegacyWorkflowApprovalDecision(
  store: RunStore,
  workflow: ChannelWorkflow,
  step: ChannelWorkflowStep,
  approval: ApprovalRequest,
  now: string,
): Extract<WorkflowOrchestrationResult, { status: "waiting_for_approval" | "blocked" | "failed" }> | undefined {
  if (approval.status === "pending") {
    return { status: "waiting_for_approval", workflow, workflowStep: step, approval };
  }
  if (approval.status === "approved") {
    const workflowApproval = workflow.status === "waiting_for_approval"
      ? store.transitionChannelWorkflowStatus({
          workflowId: workflow.id,
          expectedStatus: "waiting_for_approval",
          event: "approval_approved",
          actor: "local-user",
          reason: `approval:${approval.id}`,
          now,
        })
      : { ok: true as const, from: workflow.status, to: workflow.status };
    if (!workflowApproval.ok) {
      throw new HttpError(409, workflowApproval.code, `Workflow approval transition failed: ${workflowApproval.code}`);
    }
    syncWorkflowSourceTurnProgress(store, store.getChannelWorkflow(workflow.id) ?? workflow, now);
    const stepApproval = step.status === "waiting_for_approval"
      ? store.transitionChannelWorkflowStepStatus({
          workflowStepId: step.id,
          expectedStatus: "waiting_for_approval",
          event: "approval_approved",
          actor: "local-user",
          reason: `approval:${approval.id}`,
          now,
          blocker: null,
        })
      : { ok: true as const, from: step.status, to: step.status };
    if (!stepApproval.ok) {
      throw new HttpError(409, stepApproval.code, `Workflow step approval transition failed: ${stepApproval.code}`);
    }
    const runningStep = store.getChannelWorkflowStep(step.id) ?? step;
    if (runningStep.status === "running" && !runningStep.taskId && !runningStep.runId) {
      const succeeded = store.transitionChannelWorkflowStepStatus({
        workflowStepId: runningStep.id,
        expectedStatus: "running",
        event: "succeed",
        actor: "local-user",
        reason: `approval:${approval.id}`,
        now,
        blocker: null,
        resultSummary: "Approval was granted.",
      });
      if (!succeeded.ok) {
        throw new HttpError(409, succeeded.code, `Workflow approval-only step close failed: ${succeeded.code}`);
      }
      completeWorkflowIfStepsFinished(store, workflow.id, now);
    }
    return undefined;
  }
  const reason = approval.decisionReason ?? `Workflow step approval ${approval.status}.`;
  applyWorkflowStepFailurePolicy({
    store,
    workflow,
    step,
    policy: resolveWorkflowStepPolicy(step).onApprovalDenied,
    actor: approval.status === "expired" ? "system" : "local-user",
    reason,
    now,
    blocker: reason,
  });
  const latestWorkflow = store.getChannelWorkflow(workflow.id) ?? workflow;
  const latestStep = store.getChannelWorkflowStep(step.id) ?? step;
  return latestWorkflow.status === "failed"
    ? { status: "failed", workflow: latestWorkflow, workflowStep: latestStep, blocker: reason }
    : { status: "blocked", workflow: latestWorkflow, workflowStep: latestStep, blocker: latestStep.blocker ?? reason };
}

export function cancelChannelWorkflow(input: CancelWorkflowInput): CancelWorkflowResult {
  const workflow = input.store.getChannelWorkflow(input.workflowId);
  if (!workflow) {
    throw new HttpError(404, "workflow_not_found", `Channel workflow not found: ${input.workflowId}`);
  }
  if (workflow.status === "cancelled") {
    return {
      workflow,
      workflowSteps: input.store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 }),
      cancelledRunIds: [],
      cancelledApprovalIds: [],
    };
  }
  if (isTerminalWorkflowStatus(workflow.status)) {
    throw new HttpError(409, "workflow_not_cancellable", `Workflow ${workflow.id} is already ${workflow.status}.`);
  }

  const now = new Date().toISOString();
  const reason = input.reason ?? "workflow_cancelled";
  const cancelledRunIds: string[] = [];
  const cancelledApprovalIds: string[] = [];

  for (const step of input.store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 })) {
    for (const approval of input.store.listApprovalRequests({ workflowStepId: step.id, status: "pending", limit: 500 })) {
      const cancelled = input.store.cancelApprovalRequest(
        approval.id,
        { reason: `Workflow cancelled: ${reason}`, resolvedBy: "local-user" },
        now,
      );
      if (cancelled) {
        cancelledApprovalIds.push(cancelled.id);
      }
    }

    const linkedRun = step.runId ? input.store.getRun(step.runId) : undefined;
    if (linkedRun && !isTerminalRunStatus(linkedRun.status)) {
      input.cancelRun?.(linkedRun);
      cancelledRunIds.push(linkedRun.id);
    }

    const latestStep = input.store.getChannelWorkflowStep(step.id) ?? step;
    if (isTerminalWorkflowStepStatus(latestStep.status)) {
      continue;
    }
    const cancelled = input.store.transitionChannelWorkflowStepStatus({
      workflowStepId: latestStep.id,
      expectedStatus: latestStep.status,
      event: "cancel",
      actor: "local-user",
      reason,
      now,
      blocker: latestStep.blocker ?? reason,
    });
    if (!cancelled.ok && !isTerminalWorkflowStepStatus(cancelled.currentStatus)) {
      throw new HttpError(409, cancelled.code, `Workflow step cancel failed: ${cancelled.code}`);
    }
  }

  const latestWorkflow = input.store.getChannelWorkflow(workflow.id) ?? workflow;
  if (!isTerminalWorkflowStatus(latestWorkflow.status)) {
    const cancelled = input.store.transitionChannelWorkflowStatus({
      workflowId: workflow.id,
      expectedStatus: latestWorkflow.status,
      event: "cancel",
      actor: "local-user",
      reason,
      now,
    });
    if (!cancelled.ok && cancelled.currentStatus !== "cancelled") {
      throw new HttpError(409, cancelled.code, `Workflow cancel failed: ${cancelled.code}`);
    }
  }

  return {
    workflow: input.store.getChannelWorkflow(workflow.id) ?? workflow,
    workflowSteps: input.store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 }),
    cancelledRunIds,
    cancelledApprovalIds,
  };
}

export async function retryChannelWorkflowStep(input: RetryWorkflowStepInput): Promise<WorkflowOrchestrationResult> {
  const step = input.store.getChannelWorkflowStep(input.workflowStepId);
  if (!step) {
    throw new HttpError(404, "workflow_step_not_found", `Channel workflow step not found: ${input.workflowStepId}`);
  }
  if (step.status !== "blocked") {
    throw new HttpError(409, "workflow_step_not_retryable", `Workflow step ${step.id} is ${step.status}; only blocked steps can be retried.`);
  }
  const workflow = input.store.getChannelWorkflow(step.workflowId);
  if (!workflow) {
    throw new HttpError(404, "workflow_not_found", `Channel workflow not found: ${step.workflowId}`);
  }
  if (isTerminalWorkflowStatus(workflow.status)) {
    throw new HttpError(409, "workflow_terminal", `Workflow ${workflow.id} is already ${workflow.status}.`);
  }

  const steps = input.store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 });
  if (!isWorkflowStepEligible(step, steps)) {
    return {
      status: "blocked",
      workflow,
      workflowStep: step,
      blocker: "Workflow step dependencies are not complete.",
    };
  }

  const started = prepareWorkflowStepStart(
    input.store,
    step.id,
    {
      mode: "create_and_run_task",
      assigneeTeammateId: step.toParticipantId,
      providerPresetId: step.metadata?.providerPresetId,
      runnerId: step.metadata?.requestedRunnerId,
      idempotencyKey: `workflow-step-retry:${step.id}:${randomRetryNonce()}`,
    },
    input.cwd,
    input.validateRunRequest,
  );
  if (started.kind === "blocked") {
    return {
      status: "blocked",
      workflow: input.store.getChannelWorkflow(started.workflowId) ?? workflow,
      workflowStep: input.store.getChannelWorkflowStep(step.id) ?? step,
      blocker: started.blocker,
    };
  }
  if (started.kind === "error") {
    throw new HttpError(started.statusCode, started.code, started.message);
  }

  const runRequest: WorkflowStepRunRequest = {
    ...started.runRequest,
    requestedSkillId: step.metadata?.skillId,
  };
  const runId = await input.startRun({
    workflow: input.store.getChannelWorkflow(started.workflowId) ?? workflow,
    workflowStep: input.store.getChannelWorkflowStep(step.id) ?? step,
    taskId: started.task.id,
    runRequest,
  });
  if (!runId) {
    return blockWorkflowStepRunStartFailure(input.store, started.workflowId, step.id, started.task.id);
  }
  return {
    status: "started",
    workflow: input.store.getChannelWorkflow(started.workflowId) ?? workflow,
    workflowStep: input.store.getChannelWorkflowStep(step.id) ?? step,
    taskId: started.task.id,
    runId,
  };
}

export function finalizeOrchestratedWorkflowStepRun(
  store: RunStore,
  workflowStepId: string,
  taskId: string,
  run: RunSession,
  now = new Date().toISOString(),
): ChannelWorkflowStep | undefined {
  const step = store.getChannelWorkflowStep(workflowStepId);
  if (!step || step.status !== "running") {
    return step;
  }
  const workflow = store.getChannelWorkflow(step.workflowId);
  if (!workflow) {
    return step;
  }
  if (workflow.metadata?.requiredParticipantManifest) {
    const canonicalRun = step.runId ? store.getRun(step.runId) : undefined;
    if (!canonicalRun || (canonicalRun.status !== "succeeded" && canonicalRun.status !== "failed" && canonicalRun.status !== "cancelled")) {
      return step;
    }
    if (canonicalRun.status === "succeeded") {
      const resultSummary = workflowStepRunResultSummary(store, canonicalRun);
      if (blockWorkflowStepForRejectedAgentContext(store, workflow, step, canonicalRun, resultSummary, now)) {
        return store.getChannelWorkflowStep(workflowStepId);
      }
      const latestStep = store.getChannelWorkflowStep(workflowStepId) ?? step;
      if (maybeRequestPostStepApproval(store, workflow, latestStep, taskId, canonicalRun, now)) {
        return store.getChannelWorkflowStep(workflowStepId);
      }
    }
    finalizeDelegatedWorkflowStepFromCanonicalState({
      store,
      workflowStepId,
      cause: "run_terminal",
      now,
    });
    const latestStep = store.getChannelWorkflowStep(workflowStepId);
    try {
      if (latestStep && !latestStep.metadata?.outputArtifactId) {
        attachWorkflowStepOutputArtifact(store, workflowStepId, canonicalRun, now);
      }
      if (latestStep && isTerminalWorkflowStepStatus(latestStep.status)) {
        maybeCreateWorkflowFanInEvidence({ store, workflow, step: latestStep, run: canonicalRun, now });
      }
    } catch {
      // Audit packets are best-effort after semantic finalization; completion evidence was already committed.
    }
    reconcileWorkflowFromCanonicalState({ store, workflowId: workflow.id, cause: "run_terminal", now });
    maybeCreateWorkflowTerminalCoordinatorReply(store, workflow.id, { linkedRunId: canonicalRun.id, now });
    store.releaseResourceLeasesForOwner("workflow_step", workflowStepId, now);
    return store.getChannelWorkflowStep(workflowStepId);
  }
  if (run.status === "succeeded") {
    const resultSummary = workflowStepRunResultSummary(store, run);
    const executionVerification = verifyWorkflowStepExecutionOperations({ store, step: { ...step, runId: run.id }, now });
    if (executionVerification && executionVerification.status !== "verified") {
      const reason = executionVerification.operationResults
        .filter((result) => result.status !== "succeeded")
        .map((result) => `${result.operationId}:${result.reasonCode ?? result.status}`)
        .join(", ");
      store.updateChannelWorkflowStep(step.id, {
        metadata: { ...step.metadata, executionVerification },
      }, now);
      applyWorkflowStepFailurePolicy({
        store,
        workflow,
        step: store.getChannelWorkflowStep(step.id) ?? step,
        policy: executionVerification.status === "failed" ? resolveWorkflowStepPolicy(step).onRunFailed : "block_for_user",
        actor: "system",
        reason: reason || "Required operation evidence was not verified.",
        now,
        taskId,
        runId: run.id,
        blocker: reason || "Required operation evidence was not verified.",
      });
    } else if (blockWorkflowStepForRejectedAgentContext(store, workflow, step, run, resultSummary, now)) {
      // Preserve the rejected run as audit evidence, but never commit its stale or private result.
    } else if (maybeRequestPostStepApproval(store, workflow, step, taskId, run, now)) {
      return store.getChannelWorkflowStep(workflowStepId);
    } else {
      if (executionVerification) {
        const latestMetadata = store.getChannelWorkflowStep(step.id)?.metadata ?? step.metadata;
        store.updateChannelWorkflowStep(step.id, {
          metadata: { ...latestMetadata, executionVerification },
        }, now);
      }
      store.transitionChannelWorkflowStepStatus({
        workflowStepId,
        expectedStatus: "running",
        event: "succeed",
        actor: "runner",
        reason: `run:${run.id}`,
        now,
        taskId,
        runId: run.id,
        resultSummary,
      });
      completeWorkflowIfStepsFinished(store, step.workflowId, now);
    }
  } else if (run.status === "cancelled") {
    applyWorkflowStepFailurePolicy({
      store,
      workflow,
      step,
      policy: resolveWorkflowStepPolicy(step).onRunCancelled,
      actor: "runner",
      reason: run.errorMessage ?? `run:${run.id}`,
      now,
      taskId,
      runId: run.id,
      blocker: run.errorMessage ?? "Run was cancelled.",
    });
  } else {
    applyWorkflowStepFailurePolicy({
      store,
      workflow,
      step,
      policy: resolveWorkflowStepPolicy(step).onRunFailed,
      actor: "runner",
      reason: run.errorMessage ?? `run:${run.id}`,
      now,
      taskId,
      runId: run.id,
      blocker: run.errorMessage ?? "Run failed.",
    });
  }
  try {
    attachWorkflowStepOutputArtifact(store, workflowStepId, run, now);
    const latestStep = store.getChannelWorkflowStep(workflowStepId);
    if (latestStep && isTerminalWorkflowStepStatus(latestStep.status)) {
      maybeCreateWorkflowFanInEvidence({
        store,
        workflow,
        step: latestStep,
        run,
        now,
      });
    }
  } catch {
    // Output packets and fan-in summaries are audit evidence; terminal workflow state remains authoritative if artifact IO fails.
  }
  maybeCreateWorkflowTerminalCoordinatorReply(store, step.workflowId, { linkedRunId: run.id, now });
  store.releaseResourceLeasesForOwner("workflow_step", workflowStepId, now);
  return store.getChannelWorkflowStep(workflowStepId);
}

function blockWorkflowStepForRejectedAgentContext(
  store: RunStore,
  workflow: ChannelWorkflow,
  step: ChannelWorkflowStep,
  run: RunSession,
  resultSummary: string,
  now: string,
): boolean {
  const continuityBacked = Boolean(step.metadata?.sourceMessageId ?? workflow.metadata?.sourceMessageId);
  if (!continuityBacked) return false;
  const contextArtifactId = step.metadata?.contextArtifactId;
  const agentContext = contextArtifactId
    ? readWorkflowStepContextPacketArtifact({ store, artifactId: contextArtifactId })?.agentContext
    : readWorkflowAgentContextFromRunSnapshot(run);
  if (!agentContext) {
    return blockWorkflowStepForContextReason(
      store,
      workflow,
      step,
      run,
      "Continuity-backed result has no durable agent context stamp.",
      {
        dependencyWorkflowStepId: step.id,
        status: "rejected_stale",
        reason: "Continuity-backed result has no durable agent context stamp.",
      },
      now,
    );
  }
  const privateValues = privateRoleEvidenceValues({ store, stamp: agentContext });
  if (textContainsPrivateRoleEvidence(resultSummary, privateValues)) {
    return blockWorkflowStepForContextReason(
      store,
      workflow,
      step,
      run,
      "Workflow result repeats private role evidence and cannot be committed.",
      {
        dependencyWorkflowStepId: step.id,
        status: "rejected_private_leak",
        consumedProjectionVersion: agentContext.contextProjection.projectionVersion,
        reason: "Workflow result repeats private role evidence and cannot be committed.",
      },
      now,
    );
  }
  const reviewed = reviewWorkflowAgentContextStamp({
    store,
    dependencyWorkflowStepId: step.id,
    consumed: agentContext,
  }).review;
  if (reviewed.status === "rejected_stale" || reviewed.status === "rejected_private_leak") {
    return blockWorkflowStepForContextReason(
      store,
      workflow,
      step,
      run,
      `Workflow result context is no longer current: ${reviewed.reason}`,
      reviewed,
      now,
    );
  }
  return false;
}

function blockWorkflowStepForContextReason(
  store: RunStore,
  workflow: ChannelWorkflow,
  step: ChannelWorkflowStep,
  run: RunSession,
  reason: string,
  review: WorkflowFanInContextReview,
  now: string,
): true {
  if (workflow.metadata?.requiredParticipantManifest) {
    const code = review.status === "rejected_private_leak"
      ? "agent_context_private_leak"
      : reason.includes("no durable agent context stamp")
        ? "agent_context_missing"
        : "agent_context_stale";
    const finalized = finalizeDelegatedWorkflowStepFromCanonicalState({
      store,
      workflowStepId: step.id,
      cause: "run_terminal",
      now,
      contextBlocker: { code, reason, review },
    });
    if (finalized.status !== "finalized" && finalized.status !== "duplicate") {
      throw new HttpError(409, "delegated_context_finalization_failed", `Workflow result context finalization failed: ${finalized.status}`);
    }
    reconcileWorkflowFromCanonicalState({ store, workflowId: workflow.id, cause: "run_terminal", now });
    return true;
  }
  const stepTransition = store.transitionChannelWorkflowStepStatus({
    workflowStepId: step.id,
    expectedStatus: "running",
    event: "blocked",
    actor: "system",
    reason,
    now,
    taskId: step.taskId ?? run.taskId,
    runId: run.id,
    blocker: reason,
  });
  if (!stepTransition.ok) {
    throw new HttpError(409, stepTransition.code, `Workflow result context transition failed: ${stepTransition.code}`);
  }
  const blockedStep = store.getChannelWorkflowStep(step.id) ?? step;
  store.updateChannelWorkflowStep(step.id, {
    metadata: { ...blockedStep.metadata, resultContextReview: review },
  }, now);
  const workflowTransition = store.transitionChannelWorkflowStatus({
    workflowId: workflow.id,
    expectedStatus: "running",
    event: "step_blocked",
    actor: "system",
    reason,
    now,
  });
  if (!workflowTransition.ok) {
    throw new HttpError(409, workflowTransition.code, `Workflow result context transition failed: ${workflowTransition.code}`);
  }
  return true;
}

function workflowStepRunResultSummary(store: RunStore, run: RunSession): string {
  return readRunAssistantTextSummary(store, run.id) ??
    readRunArtifactResultSummary(store, run.id) ??
    "Run succeeded.";
}

function readRunAssistantTextSummary(store: RunStore, runId: string): string | undefined {
  const text = store
    .listEvents(runId, { limit: 1000 })
    .filter((event) => event.type === "assistant_text_delta")
    .map((event) => isRecord(event.data) && typeof event.data.text === "string" ? event.data.text : "")
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

function readRunArtifactResultSummary(store: RunStore, runId: string): string | undefined {
  const artifacts = store.listArtifacts(runId).filter((artifact) => artifact.type === "file" || artifact.type === "diff");
  if (artifacts.length === 0) {
    return undefined;
  }
  const labels = artifacts
    .map((artifact) => artifact.title?.trim() || artifact.path)
    .filter((label) => label.trim().length > 0)
    .slice(0, 3);
  return labels.length > 0 ? `Run succeeded. Artifacts: ${labels.join(", ")}.` : undefined;
}

function attachWorkflowStepOutputArtifact(
  store: RunStore,
  workflowStepId: string,
  run: RunSession,
  now: string,
  projected?: Pick<ChannelWorkflowStep, "status" | "resultSummary">,
): ReturnType<typeof createWorkflowStepOutputArtifact> | undefined {
  const step = store.getChannelWorkflowStep(workflowStepId);
  if (!step || step.runId !== run.id) {
    return undefined;
  }
  const workflow = store.getChannelWorkflow(step.workflowId);
  if (!workflow) {
    return undefined;
  }
  const artifact = createWorkflowStepOutputArtifact({
    store,
    workflow,
    step: projected ? { ...step, ...projected } : step,
    run,
    now,
  });
  const latestStep = store.getChannelWorkflowStep(workflowStepId) ?? step;
  store.updateChannelWorkflowStep(
    workflowStepId,
    {
      metadata: {
        ...latestStep.metadata,
        outputArtifactId: artifact.id,
        outputArtifactIds: uniqueStrings([
          artifact.id,
          ...(latestStep.metadata?.outputArtifactIds ?? []),
          ...store.listArtifacts(run.id).map((candidate) => candidate.id),
        ]),
      },
    },
    now,
  );
  return artifact;
}

function maybeRequestPostStepApproval(
  store: RunStore,
  workflow: ChannelWorkflow,
  step: ChannelWorkflowStep,
  taskId: string,
  run: RunSession,
  now: string,
): boolean {
  const gate = selectWorkflowStepGate(step, "post", "succeeded");
  if (!gate || gate.approvalProfile.mode === "none") {
    return false;
  }
  const existingApproval = step.metadata?.postStepApprovalId ? store.getApprovalRequest(step.metadata.postStepApprovalId) : undefined;
  if (existingApproval?.status === "approved") {
    return false;
  }
  if (existingApproval && existingApproval.status !== "pending") {
    applyWorkflowStepApprovalPolicy(store, workflow, step, existingApproval, now);
    return true;
  }
  const approval = existingApproval ?? store.createApprovalRequest(
    {
      workflowStepId: step.id,
      channelId: step.channelId,
      actionType: "workflow_step",
      risk: gate.approvalProfile.risk ?? (gate.approvalProfile.mode === "strict" ? "high" : "medium"),
      title: gate.title,
      description: gate.reason,
      payload: {
        type: "workflow_step",
        gateStage: "post",
        workflowId: workflow.id,
        workflowStepId: step.id,
        templateStepId: step.metadata?.templateStepId,
        contextArtifactId: step.metadata?.contextArtifactId,
        outputArtifactId: step.metadata?.outputArtifactId,
        runId: run.id,
        title: step.title,
        approvalMode: gate.approvalProfile.mode,
        requiredForTools: gate.approvalProfile.requiredForTools ?? [],
        requiredForActions: gate.approvalProfile.requiredForActions ?? [],
      },
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    },
    now,
  );
  const latestStep = store.getChannelWorkflowStep(step.id) ?? step;
  store.updateChannelWorkflowStep(
    step.id,
    {
      metadata: {
        ...latestStep.metadata,
        activeGateStage: "post",
        postStepApprovalId: approval.id,
      },
    },
    now,
  );
  const waitingStep = store.transitionChannelWorkflowStepStatus({
    workflowStepId: step.id,
    expectedStatus: "running",
    event: "approval_requested",
    actor: "system",
    reason: `approval:${approval.id}`,
    now,
    taskId,
    runId: run.id,
    blocker: `Waiting for post-step approval: ${approval.title}`,
    resultSummary: "Run succeeded; waiting for post-step approval.",
  });
  if (!waitingStep.ok) {
    throw new HttpError(409, waitingStep.code, `Workflow step post approval transition failed: ${waitingStep.code}`);
  }
  const latestWorkflow = store.getChannelWorkflow(workflow.id) ?? workflow;
  if (latestWorkflow.status === "running") {
    const waitingWorkflow = store.transitionChannelWorkflowStatus({
      workflowId: workflow.id,
      expectedStatus: "running",
      event: "approval_requested",
      actor: "system",
      reason: `approval:${approval.id}`,
      now,
    });
    if (!waitingWorkflow.ok) {
      throw new HttpError(409, waitingWorkflow.code, `Workflow post approval transition failed: ${waitingWorkflow.code}`);
    }
  }
  syncWorkflowSourceTurnProgress(store, store.getChannelWorkflow(workflow.id) ?? workflow, now);
  return true;
}

function reconcileWorkflowStepRuns(store: RunStore, workflowId: string): WorkflowOrchestrationResult | { readonly status: "open" } {
  const steps = store.listChannelWorkflowSteps({ workflowId, limit: 500 });
  const workflow = store.getChannelWorkflow(workflowId);
  if (!workflow) {
    throw new HttpError(404, "workflow_not_found", `Channel workflow not found: ${workflowId}`);
  }
  for (const step of steps) {
    if (step.status === "waiting_for_approval" && step.metadata?.postStepApprovalId && step.metadata.activeGateStage === "post") {
      const approval = store.getApprovalRequest(step.metadata.postStepApprovalId);
      if (!approval || approval.status === "pending") {
        if (approval) {
          return { status: "waiting_for_approval", workflow, workflowStep: step, approval };
        }
        continue;
      }
      const approvalResult = reconcilePostStepApprovalDecision(store, workflow, step, approval);
      if (approvalResult) {
        return approvalResult;
      }
    }
    if (step.status === "waiting_for_approval" && step.metadata?.preStepApprovalId) {
      const approval = store.getApprovalRequest(step.metadata.preStepApprovalId);
      if (!approval || approval.status === "pending") {
        if (approval) {
          return { status: "waiting_for_approval", workflow, workflowStep: step, approval };
        }
        continue;
      }
      const approvalResult = reconcilePreStepApprovalDecision(store, workflow, step, approval);
      if (approvalResult) {
        return approvalResult;
      }
    }
    if (step.status !== "running" || !step.runId || !step.taskId) {
      continue;
    }
    const run = store.getRun(step.runId);
    if (!run) {
      continue;
    }
    if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
      finalizeOrchestratedWorkflowStepRun(store, step.id, step.taskId, run);
    }
  }
  completeWorkflowIfStepsFinished(store, workflowId, new Date().toISOString());
  const latest = store.getChannelWorkflow(workflowId) ?? workflow;
  if (latest.status === "succeeded") {
    return { status: "completed", workflow: latest };
  }
  const blocked = store.listChannelWorkflowSteps({ workflowId, status: "blocked", limit: 500 })[0];
  if (blocked) {
    return { status: "blocked", workflow: latest, workflowStep: blocked, blocker: blocked.blocker ?? "Workflow step is blocked." };
  }
  return { status: "open" };
}

function maybeRequestPreStepApproval(
  store: RunStore,
  workflow: ChannelWorkflow,
  step: ChannelWorkflowStep,
): Extract<WorkflowOrchestrationResult, { status: "waiting_for_approval" | "blocked" | "failed" }> | undefined {
  const approvalGate = step.metadata?.approvalGate;
  if (!approvalGate || approvalGate.mode === "none") {
    return undefined;
  }
  const existingApproval = step.metadata?.preStepApprovalId ? store.getApprovalRequest(step.metadata.preStepApprovalId) : undefined;
  if (existingApproval?.status === "approved") {
    return undefined;
  }
  if (existingApproval && existingApproval.status !== "pending") {
    return reconcilePreStepApprovalDecision(store, workflow, step, existingApproval);
  }
  const now = new Date().toISOString();
  const workflowStart = ensureWorkflowRunningForGate(store, workflow, now);
  if (!workflowStart.ok) {
    throw new HttpError(409, workflowStart.code, `Workflow transition failed: ${workflowStart.code}`);
  }
  const latestWorkflow = store.getChannelWorkflow(workflow.id) ?? workflow;
  const stepStart = ensureWorkflowStepRunningForGate(store, step, now);
  if (!stepStart.ok) {
    throw new HttpError(409, stepStart.code, `Workflow step transition failed: ${stepStart.code}`);
  }
  const latestStep = store.getChannelWorkflowStep(step.id) ?? step;
  const approval = existingApproval ?? store.createApprovalRequest(
    {
      workflowStepId: step.id,
      channelId: step.channelId,
      actionType: "workflow_step",
      risk: approvalGate.risk ?? (approvalGate.mode === "strict" ? "high" : "medium"),
      title: `Approve workflow step: ${step.title}`,
      description: `Approve starting workflow step "${step.title}" for workflow "${workflow.title}".`,
      payload: {
        type: "workflow_step",
        gateStage: "pre",
        workflowId: workflow.id,
        workflowStepId: step.id,
        templateStepId: step.metadata?.templateStepId,
        contextArtifactId: step.metadata?.contextArtifactId,
        outputArtifactId: step.metadata?.outputArtifactId,
        title: step.title,
        approvalMode: approvalGate.mode,
        requiredForTools: approvalGate.requiredForTools ?? [],
        requiredForActions: approvalGate.requiredForActions ?? [],
      },
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    },
    now,
  );
  store.updateChannelWorkflowStep(
    step.id,
    {
      metadata: {
        ...latestStep.metadata,
        activeGateStage: "pre",
        preStepApprovalId: approval.id,
      },
    },
    now,
  );
  const waitingStep = store.transitionChannelWorkflowStepStatus({
    workflowStepId: step.id,
    expectedStatus: "running",
    event: "approval_requested",
    actor: "system",
    reason: `approval:${approval.id}`,
    now,
    blocker: `Waiting for approval: ${approval.title}`,
  });
  if (!waitingStep.ok) {
    throw new HttpError(409, waitingStep.code, `Workflow step approval transition failed: ${waitingStep.code}`);
  }
  const waitingWorkflow = store.transitionChannelWorkflowStatus({
    workflowId: workflow.id,
    expectedStatus: "running",
    event: "approval_requested",
    actor: "system",
    reason: `approval:${approval.id}`,
    now,
  });
  if (!waitingWorkflow.ok) {
    throw new HttpError(409, waitingWorkflow.code, `Workflow approval transition failed: ${waitingWorkflow.code}`);
  }
  return {
    status: "waiting_for_approval",
    workflow: store.getChannelWorkflow(workflow.id) ?? latestWorkflow,
    workflowStep: store.getChannelWorkflowStep(step.id) ?? latestStep,
    approval,
  };
}

function reconcilePreStepApprovalDecision(
  store: RunStore,
  workflow: ChannelWorkflow,
  step: ChannelWorkflowStep,
  approval: ApprovalRequest,
  decisionAt = new Date().toISOString(),
): Extract<WorkflowOrchestrationResult, { status: "waiting_for_approval" | "blocked" | "failed" }> | undefined {
  if (approval.status === "pending") {
    return { status: "waiting_for_approval", workflow, workflowStep: step, approval };
  }
  const now = decisionAt;
  if (approval.status === "approved") {
    const workflowApproval = workflow.status === "waiting_for_approval"
      ? store.transitionChannelWorkflowStatus({
          workflowId: workflow.id,
          expectedStatus: "waiting_for_approval",
          event: "approval_approved",
          actor: "local-user",
          reason: `approval:${approval.id}`,
          now,
        })
      : { ok: true as const, from: workflow.status, to: workflow.status };
    if (!workflowApproval.ok) {
      throw new HttpError(409, workflowApproval.code, `Workflow approval transition failed: ${workflowApproval.code}`);
    }
    syncWorkflowSourceTurnProgress(store, store.getChannelWorkflow(workflow.id) ?? workflow, now);
    const stepApproval = step.status === "waiting_for_approval"
      ? store.transitionChannelWorkflowStepStatus({
          workflowStepId: step.id,
          expectedStatus: "waiting_for_approval",
          event: "approval_approved",
          actor: "local-user",
          reason: `approval:${approval.id}`,
          now,
          blocker: null,
        })
      : { ok: true as const, from: step.status, to: step.status };
    if (!stepApproval.ok) {
      throw new HttpError(409, stepApproval.code, `Workflow step approval transition failed: ${stepApproval.code}`);
    }
    const latestStep = store.getChannelWorkflowStep(step.id) ?? step;
    const { activeGateStage, ...metadata } = latestStep.metadata ?? {};
    if (activeGateStage === "pre") {
      store.updateChannelWorkflowStep(step.id, { metadata }, now);
    }
    return undefined;
  }
  const reason = approval.decisionReason ?? `Workflow step approval ${approval.status}.`;
  applyWorkflowStepFailurePolicy({
    store,
    workflow,
    step,
    policy: resolveWorkflowStepPolicy(step).onApprovalDenied,
    actor: approval.status === "expired" ? "system" : "local-user",
    reason,
    now,
    blocker: reason,
  });
  const latestWorkflow = store.getChannelWorkflow(workflow.id) ?? workflow;
  const latestStep = store.getChannelWorkflowStep(step.id) ?? step;
  return latestWorkflow.status === "failed"
    ? { status: "failed", workflow: latestWorkflow, workflowStep: latestStep, blocker: reason }
    : { status: "blocked", workflow: latestWorkflow, workflowStep: latestStep, blocker: latestStep.blocker ?? reason };
}

function reconcilePostStepApprovalDecision(
  store: RunStore,
  workflow: ChannelWorkflow,
  step: ChannelWorkflowStep,
  approval: ApprovalRequest,
  decisionAt = new Date().toISOString(),
): Extract<WorkflowOrchestrationResult, { status: "waiting_for_approval" | "blocked" | "failed" }> | undefined {
  if (approval.status === "pending") {
    return { status: "waiting_for_approval", workflow, workflowStep: step, approval };
  }
  const now = decisionAt;
  if (approval.status === "approved") {
    const workflowApproval = workflow.status === "waiting_for_approval"
      ? store.transitionChannelWorkflowStatus({
          workflowId: workflow.id,
          expectedStatus: "waiting_for_approval",
          event: "approval_approved",
          actor: "local-user",
          reason: `approval:${approval.id}`,
          now,
        })
      : { ok: true as const, from: workflow.status, to: workflow.status };
    if (!workflowApproval.ok) {
      throw new HttpError(409, workflowApproval.code, `Workflow post approval transition failed: ${workflowApproval.code}`);
    }
    syncWorkflowSourceTurnProgress(store, store.getChannelWorkflow(workflow.id) ?? workflow, now);
    const stepApproval = step.status === "waiting_for_approval"
      ? store.transitionChannelWorkflowStepStatus({
          workflowStepId: step.id,
          expectedStatus: "waiting_for_approval",
          event: "approval_approved",
          actor: "local-user",
          reason: `approval:${approval.id}`,
          now,
          blocker: null,
        })
      : { ok: true as const, from: step.status, to: step.status };
    if (!stepApproval.ok) {
      throw new HttpError(409, stepApproval.code, `Workflow step post approval transition failed: ${stepApproval.code}`);
    }
    const latestStep = store.getChannelWorkflowStep(step.id) ?? step;
    const runningStep = latestStep;
    if (workflow.metadata?.requiredParticipantManifest) {
      finalizeDelegatedWorkflowStepFromCanonicalState({
        store,
        workflowStepId: runningStep.id,
        cause: "approval_decision",
        now,
      });
      reconcileWorkflowFromCanonicalState({
        store,
        workflowId: workflow.id,
        cause: "approval_decision",
        now,
      });
      maybeCreateWorkflowTerminalCoordinatorReply(store, workflow.id, { linkedRunId: runningStep.runId, now });
      const latestWorkflow = store.getChannelWorkflow(workflow.id) ?? workflow;
      const finalizedStep = store.getChannelWorkflowStep(step.id) ?? runningStep;
      if (finalizedStep.status === "blocked" || finalizedStep.status === "failed") {
        return latestWorkflow.status === "failed"
          ? { status: "failed", workflow: latestWorkflow, workflowStep: finalizedStep, blocker: finalizedStep.blocker ?? "Delegated evidence failed." }
          : { status: "blocked", workflow: latestWorkflow, workflowStep: finalizedStep, blocker: finalizedStep.blocker ?? "Delegated evidence is incomplete." };
      }
      return undefined;
    }
    const { activeGateStage, ...metadata } = latestStep.metadata ?? {};
    if (activeGateStage === "post") {
      store.updateChannelWorkflowStep(step.id, { metadata }, now);
    }
    if (runningStep.status === "running") {
      const run = runningStep.runId ? store.getRun(runningStep.runId) : undefined;
      const executionVerification = verifyWorkflowStepExecutionOperations({ store, step: runningStep, now });
      if (executionVerification && executionVerification.status !== "verified") {
        const reason = executionVerificationFailureReason(executionVerification);
        store.updateChannelWorkflowStep(runningStep.id, {
          metadata: { ...runningStep.metadata, executionVerification },
        }, now);
        applyWorkflowStepFailurePolicy({
          store,
          workflow: store.getChannelWorkflow(workflow.id) ?? workflow,
          step: store.getChannelWorkflowStep(runningStep.id) ?? runningStep,
          policy: executionVerification.status === "failed" ? resolveWorkflowStepPolicy(runningStep).onRunFailed : "block_for_user",
          actor: "system",
          reason,
          now,
          taskId: runningStep.taskId,
          runId: runningStep.runId,
          blocker: reason,
        });
        const blockedWorkflow = store.getChannelWorkflow(workflow.id) ?? workflow;
        const blockedStep = store.getChannelWorkflowStep(step.id) ?? runningStep;
        return blockedWorkflow.status === "failed"
          ? { status: "failed", workflow: blockedWorkflow, workflowStep: blockedStep, blocker: blockedStep.blocker ?? reason }
          : { status: "blocked", workflow: blockedWorkflow, workflowStep: blockedStep, blocker: blockedStep.blocker ?? reason };
      }
      if (executionVerification) {
        store.updateChannelWorkflowStep(runningStep.id, {
          metadata: { ...runningStep.metadata, executionVerification },
        }, now);
      }
      if (run && blockWorkflowStepForRejectedAgentContext(
        store,
        store.getChannelWorkflow(workflow.id) ?? workflow,
        runningStep,
        run,
        workflowStepRunResultSummary(store, run),
        now,
      )) {
        try {
          attachWorkflowStepOutputArtifact(store, runningStep.id, run, now);
        } catch {
          // The rejected run is still linked durably even when its audit artifact cannot be written.
        }
        const blockedWorkflow = store.getChannelWorkflow(workflow.id) ?? workflow;
        const blockedStep = store.getChannelWorkflowStep(step.id) ?? runningStep;
        return { status: "blocked", workflow: blockedWorkflow, workflowStep: blockedStep, blocker: blockedStep.blocker ?? "Workflow result context changed." };
      }
      const succeed = store.transitionChannelWorkflowStepStatus({
        workflowStepId: runningStep.id,
        expectedStatus: "running",
        event: "succeed",
        actor: "local-user",
        reason: `approval:${approval.id}`,
        now,
        taskId: runningStep.taskId,
        runId: runningStep.runId,
        blocker: null,
        resultSummary: "Run succeeded and post-step approval was granted.",
      });
      if (!succeed.ok) {
        throw new HttpError(409, succeed.code, `Workflow step post approval close failed: ${succeed.code}`);
      }
    }
    const succeededStep = store.getChannelWorkflowStep(step.id) ?? runningStep;
    const run = succeededStep.runId ? store.getRun(succeededStep.runId) : undefined;
    if (run) {
      try {
        attachWorkflowStepOutputArtifact(store, succeededStep.id, run, now);
      } catch {
        // Output packets are audit evidence; terminal workflow state remains authoritative.
      }
    }
    completeWorkflowIfStepsFinished(store, step.workflowId, now);
    return undefined;
  }
  const reason = approval.decisionReason ?? `Workflow post-step approval ${approval.status}.`;
  applyWorkflowStepApprovalPolicy(store, workflow, step, approval, now, reason);
  const latestWorkflow = store.getChannelWorkflow(workflow.id) ?? workflow;
  const latestStep = store.getChannelWorkflowStep(step.id) ?? step;
  return latestWorkflow.status === "failed"
    ? { status: "failed", workflow: latestWorkflow, workflowStep: latestStep, blocker: reason }
    : { status: "blocked", workflow: latestWorkflow, workflowStep: latestStep, blocker: latestStep.blocker ?? reason };
}

function executionVerificationFailureReason(
  verification: NonNullable<ReturnType<typeof verifyWorkflowStepExecutionOperations>>,
): string {
  return verification.operationResults
    .filter((result) => result.status !== "succeeded")
    .map((result) => `${result.operationId}:${result.reasonCode ?? result.status}`)
    .join(", ") || "Required operation evidence was not verified.";
}

function applyWorkflowStepApprovalPolicy(
  store: RunStore,
  workflow: ChannelWorkflow,
  step: ChannelWorkflowStep,
  approval: ApprovalRequest,
  now: string,
  reason = approval.decisionReason ?? `Workflow step approval ${approval.status}.`,
): void {
  applyWorkflowStepFailurePolicy({
    store,
    workflow,
    step,
    policy: resolveWorkflowStepPolicy(step).onApprovalDenied,
    actor: approval.status === "expired" ? "system" : "local-user",
    reason,
    now,
    blocker: reason,
  });
}

function applyWorkflowStepFailurePolicy(input: {
  readonly store: RunStore;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly policy: WorkflowStepFailurePolicy;
  readonly actor: "system" | "local-user" | "runner";
  readonly reason: string;
  readonly now: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly blocker?: string;
}): void {
  const step = input.store.getChannelWorkflowStep(input.step.id) ?? input.step;
  const workflow = input.store.getChannelWorkflow(input.workflow.id) ?? input.workflow;
  const transitionFields = {
    taskId: input.taskId ?? step.taskId,
    runId: input.runId ?? step.runId,
  };
  if (input.policy === "block_for_user") {
    const blocked = input.store.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: step.status,
      event: "blocked",
      actor: input.actor,
      reason: input.reason,
      now: input.now,
      ...transitionFields,
      blocker: input.blocker ?? input.reason,
    });
    if (!blocked.ok) {
      throw new HttpError(409, blocked.code, `Workflow step block failed: ${blocked.code}`);
    }
    transitionWorkflowAfterStepPolicy(input.store, workflow, "step_blocked", input.actor, input.reason, input.now);
    maybeCreateWorkflowTerminalCoordinatorReply(input.store, workflow.id, { linkedRunId: input.runId, now: input.now });
    return;
  }
  if (input.policy === "fail_workflow") {
    const failed = input.store.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: step.status,
      event: "fail",
      actor: input.actor,
      reason: input.reason,
      now: input.now,
      ...transitionFields,
      blocker: input.blocker ?? input.reason,
    });
    if (!failed.ok) {
      throw new HttpError(409, failed.code, `Workflow step fail failed: ${failed.code}`);
    }
    transitionWorkflowAfterStepPolicy(input.store, workflow, "step_failed", input.actor, input.reason, input.now);
    maybeCreateWorkflowTerminalCoordinatorReply(input.store, workflow.id, { linkedRunId: input.runId, now: input.now });
    return;
  }
  if (input.policy === "cancel_workflow") {
    const cancelled = input.store.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: step.status,
      event: "cancel",
      actor: input.actor,
      reason: input.reason,
      now: input.now,
      ...transitionFields,
      blocker: input.blocker ?? input.reason,
    });
    if (!cancelled.ok) {
      throw new HttpError(409, cancelled.code, `Workflow step cancel failed: ${cancelled.code}`);
    }
    if (!isTerminalWorkflowStatus(workflow.status)) {
      const workflowCancel = input.store.transitionChannelWorkflowStatus({
        workflowId: workflow.id,
        expectedStatus: workflow.status,
        event: "cancel",
        actor: input.actor,
        reason: input.reason,
        now: input.now,
      });
      if (!workflowCancel.ok && workflowCancel.currentStatus !== "cancelled") {
        throw new HttpError(409, workflowCancel.code, `Workflow cancel failed: ${workflowCancel.code}`);
      }
    }
    maybeCreateWorkflowTerminalCoordinatorReply(input.store, workflow.id, { linkedRunId: input.runId, now: input.now });
    return;
  }
  const skipped = input.store.transitionChannelWorkflowStepStatus({
    workflowStepId: step.id,
    expectedStatus: step.status,
    event: "skip",
    actor: input.actor,
    reason: input.reason,
    now: input.now,
    ...transitionFields,
    blocker: null,
    resultSummary: input.reason,
  });
  if (!skipped.ok) {
    throw new HttpError(409, skipped.code, `Workflow step skip failed: ${skipped.code}`);
  }
  if (workflow.status === "waiting_for_approval") {
    const workflowApproval = input.store.transitionChannelWorkflowStatus({
      workflowId: workflow.id,
      expectedStatus: "waiting_for_approval",
      event: "approval_approved",
      actor: input.actor,
      reason: input.reason,
      now: input.now,
    });
    if (!workflowApproval.ok) {
      throw new HttpError(409, workflowApproval.code, `Workflow skip resume failed: ${workflowApproval.code}`);
    }
  }
  completeWorkflowIfStepsFinished(input.store, workflow.id, input.now);
}

function transitionWorkflowAfterStepPolicy(
  store: RunStore,
  workflow: ChannelWorkflow,
  event: "step_blocked" | "step_failed",
  actor: "system" | "local-user" | "runner",
  reason: string,
  now: string,
): void {
  const latestWorkflow = store.getChannelWorkflow(workflow.id) ?? workflow;
  if (isTerminalWorkflowStatus(latestWorkflow.status) || latestWorkflow.status === "blocked" && event === "step_blocked") {
    return;
  }
  const transition = store.transitionChannelWorkflowStatus({
    workflowId: latestWorkflow.id,
    expectedStatus: latestWorkflow.status,
    event,
    actor,
    reason,
    now,
  });
  if (!transition.ok) {
    throw new HttpError(409, transition.code, `Workflow ${event} failed: ${transition.code}`);
  }
}

function selectWorkflowStepGate(
  step: ChannelWorkflowStep,
  stage: WorkflowStepGate["stage"],
  status: ChannelWorkflowStep["status"],
): WorkflowStepGate | undefined {
  return (step.metadata?.gates ?? []).find((gate) =>
    gate.stage === stage &&
    gate.approvalProfile.mode !== "none" &&
    (!gate.requiredForStatuses || gate.requiredForStatuses.includes(status)));
}

function resolveWorkflowStepPolicy(step: ChannelWorkflowStep): WorkflowStepPolicy {
  return step.metadata?.policy ?? DEFAULT_WORKFLOW_STEP_POLICY;
}

function ensureWorkflowRunningForGate(
  store: RunStore,
  workflow: ChannelWorkflow,
  now: string,
): ReturnType<RunStore["transitionChannelWorkflowStatus"]> {
  if (workflow.status === "running") {
    return { ok: true, from: "running", to: "running" };
  }
  if (workflow.status === "ready" || workflow.status === "blocked") {
    return store.transitionChannelWorkflowStatus({
      workflowId: workflow.id,
      expectedStatus: workflow.status,
      event: "start",
      actor: "system",
      now,
    });
  }
  if (workflow.status === "draft") {
    const prepared = store.transitionChannelWorkflowStatus({
      workflowId: workflow.id,
      expectedStatus: "draft",
      event: "prepare",
      actor: "system",
      now,
    });
    if (!prepared.ok) {
      return prepared;
    }
    return store.transitionChannelWorkflowStatus({
      workflowId: workflow.id,
      expectedStatus: "ready",
      event: "start",
      actor: "system",
      now,
    });
  }
  return { ok: false, code: "invalid_transition", currentStatus: workflow.status };
}

function ensureWorkflowStepRunningForGate(
  store: RunStore,
  step: ChannelWorkflowStep,
  now: string,
): ReturnType<RunStore["transitionChannelWorkflowStepStatus"]> {
  if (step.status === "running") {
    return { ok: true, from: "running", to: "running" };
  }
  if (step.status === "queued") {
    const claimed = store.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "queued",
      event: "claim",
      actor: "system",
      now,
    });
    if (!claimed.ok) {
      return claimed;
    }
    return store.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "claimed",
      event: "start",
      actor: "system",
      now,
      blocker: null,
    });
  }
  if (step.status === "blocked") {
    const resumed = store.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "blocked",
      event: "resume",
      actor: "system",
      now,
      blocker: null,
    });
    if (!resumed.ok) {
      return resumed;
    }
    return store.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "claimed",
      event: "start",
      actor: "system",
      now,
      blocker: null,
    });
  }
  if (step.status === "claimed") {
    return store.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "claimed",
      event: "start",
      actor: "system",
      now,
      blocker: null,
    });
  }
  return { ok: false, code: "invalid_transition", currentStatus: step.status };
}

function isWorkflowStepEligible(step: ChannelWorkflowStep, steps: readonly ChannelWorkflowStep[]): boolean {
  const byId = new Map(steps.map((candidate) => [candidate.id, candidate]));
  const dependencies = (step.metadata?.dependsOnStepIds ?? [])
    .map((dependencyId) => byId.get(dependencyId))
    .filter((dependency): dependency is ChannelWorkflowStep => dependency !== undefined);
  if (dependencies.length !== (step.metadata?.dependsOnStepIds ?? []).length) {
    return false;
  }
  const mode = step.metadata?.dependencyMode ?? "all_succeeded";
  if (mode === "any_succeeded") {
    return dependencies.length === 0 || dependencies.some((dependency) => dependency.status === "succeeded");
  }
  if (mode === "all_terminal") {
    return dependencies.every((dependency) => isTerminalWorkflowStepStatus(dependency.status));
  }
  return dependencies.every((dependency) => dependency.status === "succeeded" || dependency.status === "skipped");
}

function countActiveWorkflowSteps(steps: readonly ChannelWorkflowStep[]): number {
  return steps.filter((step) =>
    step.status === "claimed" ||
    step.status === "running" && (Boolean(step.runId) || Boolean(step.taskId))
  ).length;
}

function compareWorkflowStepForScheduling(left: ChannelWorkflowStep, right: ChannelWorkflowStep): number {
  const positionDelta = left.position - right.position;
  if (positionDelta !== 0) {
    return positionDelta;
  }
  const branchDelta = (left.metadata?.branchGroupId ?? "").localeCompare(right.metadata?.branchGroupId ?? "");
  if (branchDelta !== 0) {
    return branchDelta;
  }
  return left.id.localeCompare(right.id);
}

function blockWorkflowStepRunStartFailure(
  store: RunStore,
  workflowId: string,
  workflowStepId: string,
  taskId: string,
): Extract<WorkflowOrchestrationResult, { status: "blocked" }> {
  const now = new Date().toISOString();
  const blocker = "Run did not start.";
  const step = store.getChannelWorkflowStep(workflowStepId);
  if (step?.status === "running") {
    store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "running",
      event: "blocked",
      actor: "system",
      reason: blocker,
      now,
      taskId,
      blocker,
    });
  }
  const workflow = store.getChannelWorkflow(workflowId);
  if (workflow?.status === "running") {
    store.transitionChannelWorkflowStatus({
      workflowId,
      expectedStatus: "running",
      event: "step_blocked",
      actor: "system",
      reason: blocker,
      now,
    });
  }
  store.releaseResourceLeasesForOwner("workflow_step", workflowStepId, now);
  const latestWorkflow = store.getChannelWorkflow(workflowId) ?? workflow;
  if (!latestWorkflow) {
    throw new HttpError(404, "workflow_not_found", `Channel workflow not found: ${workflowId}`);
  }
  return {
    status: "blocked",
    workflow: latestWorkflow,
    workflowStep: store.getChannelWorkflowStep(workflowStepId) ?? step,
    blocker,
  };
}

function isTerminalWorkflowStatus(status: ChannelWorkflow["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function isTerminalWorkflowStepStatus(status: ChannelWorkflowStep["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped" || status === "cancelled";
}

function isTerminalRunStatus(status: RunSession["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function randomRetryNonce(): string {
  return Math.random().toString(36).slice(2);
}
