import type { LingApprovalCheckpoint } from "../../approval-checkpoints.js";
import { classifyWorkflowStepStartOwner, type WorkflowStepStartReadStore,
  type WorkflowStepStartFailureInput, type WorkflowStepStartCommitResult } from "../../workflow-step-start-owner.js";
import type { ApprovalRequest, ListApprovalRequestsOptions } from "../../approval-types.js";
import { inspectWorkflowPreApproval, isWorkflowPreGateMarkerV1,
  type WorkflowStepPreApprovalResolveInput, type WorkflowStepPreApprovalResult } from "../../workflow-pre-gate.js";
import {
  type LingThread,
  type RunEventDataByType,
  type RunEventType,
  type RunStore,
  type RunSession,
  type UpdateLingThreadInput,
} from "../../run-types.js";
import {
  type ChannelWorkflow,
  type ChannelWorkflowStatus,
  type ChannelWorkflowStep,
  type ChannelWorkflowStepStatus,
  type ListChannelWorkflowStepsOptions,
} from "../../workspace-types.js";
import {
  type StateTransitionActor,
  type TransitionResult,
  type WorkflowStepTransitionEvent,
  type WorkflowTransitionEvent,
} from "../../state-machines.js";

const STALE_RUN_ERROR = "Daemon stopped before the run reached a terminal state.";

export interface SqliteRuntimeRecoveryCoordinatorPorts extends Pick<RunStore,
  "getWorkUnitAttempt" | "getUserInputContinuationBinding" | "getUserInputContinuationReceipt"> {
  readonly workflowStepStartReadStore: WorkflowStepStartReadStore & Pick<RunStore, "getApprovalRequest">;
  readonly settleChannelWorkflowStepStartFailure: (input: WorkflowStepStartFailureInput) => WorkflowStepStartCommitResult;
  readonly expireResourceLeases: (now: string) => number;
  readonly listRecoverableRunIds: () => string[];
  readonly hasTerminalRunEvent: (runId: string) => boolean;
  readonly appendRunEvent: <K extends RunEventType>(runId: string, type: K, data: RunEventDataByType[K]) => unknown;
  readonly markRunFailed: (runId: string, endedAt: string, errorMessage: string) => void;
  readonly getRun: (runId: string) => RunSession | undefined;
  readonly getWorkUnit: (workUnitId: string) => import("../../runtime-supervisor-types.js").WorkUnit | undefined;
  readonly getLingThread: (threadId: string) => LingThread | undefined;
  readonly updateLingThread: (threadId: string, input: UpdateLingThreadInput, now: string) => LingThread | undefined;
  readonly listRecoverableChannelWorkflows: () => ChannelWorkflow[];
  readonly listChannelWorkflowSteps: (options: ListChannelWorkflowStepsOptions) => ChannelWorkflowStep[];
  readonly getApprovalRequest: (id: string) => ApprovalRequest | undefined;
  readonly resolveChannelWorkflowStepPreApproval: (input: WorkflowStepPreApprovalResolveInput) => WorkflowStepPreApprovalResult;
  readonly listApprovalRequests: (options: ListApprovalRequestsOptions) => ApprovalRequest[];
  readonly getApprovalCheckpointForApproval: (approvalId: string) => LingApprovalCheckpoint | undefined;
  readonly transitionChannelWorkflowStepStatus: (input: {
    readonly workflowStepId: string;
    readonly expectedStatus?: ChannelWorkflowStepStatus;
    readonly event: WorkflowStepTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly taskId?: string | null;
    readonly runId?: string | null;
    readonly blocker?: string | null;
    readonly resultSummary?: string | null;
  }) => TransitionResult<ChannelWorkflowStepStatus>;
  readonly getChannelWorkflow: (workflowId: string) => ChannelWorkflow | undefined;
  readonly transitionChannelWorkflowStatus: (input: {
    readonly workflowId: string;
    readonly expectedStatus?: ChannelWorkflowStatus;
    readonly event: WorkflowTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
  }) => TransitionResult<ChannelWorkflowStatus>;
}

export class SqliteRuntimeRecoveryCoordinator {
  constructor(private readonly ports: SqliteRuntimeRecoveryCoordinatorPorts) {}

  recoverStaleRuns(now: string): number {
    const staleRuns = this.ports.listRecoverableRunIds();
    let recovered = 0;

    for (const runId of staleRuns) {
      const runBeforeRecovery = this.ports.getRun(runId);
      let resumableApproval: ApprovalRequest | undefined;
      if (runBeforeRecovery?.status === "waiting_for_approval" || runBeforeRecovery?.status === "running") {
        resumableApproval = this.ports.listApprovalRequests({ runId, limit: 20 })
          .find((approval) => approval.status === "pending" || approval.status === "approved");
        const checkpoint = resumableApproval
          ? this.ports.getApprovalCheckpointForApproval(resumableApproval.id)
          : undefined;
        const checkpointStatusMatches = resumableApproval?.status === "pending"
          ? checkpoint?.status === "pending"
          : checkpoint?.status === "approved" || checkpoint?.status === "resume_pending";
        if (resumableApproval
          && checkpoint
          && checkpointStatusMatches
          && checkpoint.resumeBasis?.runId === runId
          && checkpoint.resumeBasis.approvalId === resumableApproval.id) {
          continue;
        }
      }
      if (!resumableApproval && runBeforeRecovery && this.isDaemonRecoverableHarnessRun(runBeforeRecovery)) {
        // The daemon owns restart continuation for enforced Harness task,
        // conversation, and private Runs. Channel reply children have their
        // own dispatch recovery path and must not be claimed here.
        // Core preserves the logical Run until RuntimeSupervisor fences the
        // abandoned Attempt and the daemon creates its replacement atomically.
        continue;
      }
      if (!resumableApproval && runBeforeRecovery && this.isRecoverableUserInputReceiver(runBeforeRecovery)) {
        // The immutable pre-ACK binding is the restart authority. The daemon
        // must reopen that exact queued Run/claimed WorkUnit/created Attempt;
        // Core must not publish a terminal failure before the receiver does.
        continue;
      }
      if (!this.ports.hasTerminalRunEvent(runId)) {
        this.ports.appendRunEvent(runId, "run_error", { message: STALE_RUN_ERROR });
      }
      this.ports.markRunFailed(runId, now, STALE_RUN_ERROR);
      const run = this.ports.getRun(runId);
      const thread = run?.threadId ? this.ports.getLingThread(run.threadId) : undefined;
      if (run?.threadId && thread) {
        this.ports.updateLingThread(
          run.threadId,
          {
            status: "failed",
            activeRunId: thread.activeRunId === run.id ? null : thread.activeRunId,
            lastRunId: run.id,
          },
          now,
        );
      }
      recovered += 1;
    }

    // Expiry never revokes an Attempt; run it after recovery and require positive
    // terminal ownership evidence in the lease store itself.
    this.ports.expireResourceLeases(now);
    return recovered;
  }

  private isDaemonRecoverableHarnessRun(run: RunSession): boolean {
    if ((run.status !== "queued" && run.status !== "running") || !run.workUnitId || !run.contextViewId) {
      return false;
    }
    const workUnit = this.ports.getWorkUnit(run.workUnitId);
    const thread = run.threadId ? this.ports.getLingThread(run.threadId) : undefined;
    if (!workUnit
      || !["task_run", "conversation_run", "teammate_direct_reply"].includes(workUnit.kind)
      || workUnit.linkedRunId !== run.id
      || !workUnit.activeAttemptId
      || !["claimed", "running", "cancelling"].includes(workUnit.status)) {
      return false;
    }
    if (workUnit.kind === "conversation_run" && thread?.kind !== "conversation") return false;
    if (workUnit.kind === "teammate_direct_reply"
      && (thread?.kind !== "teammate_direct" || !run.teammateId
        || thread.teammateId !== run.teammateId || workUnit.teammateId !== run.teammateId)) return false;
    const snapshot = run.requestSnapshot;
    if (!isRecord(snapshot) || !isRecord(snapshot.harnessFeatureSnapshot)) return false;
    return snapshot.harnessFeatureSnapshot.schemaVersion === 1
      && snapshot.harnessFeatureSnapshot.continuations === "enforce"
      && isRecord(snapshot.runnerExecutionInput);
  }

  private isRecoverableUserInputReceiver(run: RunSession): boolean {
    if (run.status !== "queued" || run.continuationReason !== "user_input_answer"
      || !run.threadId || !run.workUnitId) return false;
    const deliveryId = deliveryIdFromContinuationSnapshot(run.requestSnapshot);
    if (!deliveryId) return false;
    const workUnit = this.ports.getWorkUnit(run.workUnitId);
    if (!workUnit || workUnit.status !== "claimed" || workUnit.linkedRunId !== run.id
      || !workUnit.activeAttemptId) return false;
    try {
      const binding = this.ports.getUserInputContinuationBinding(run.threadId, deliveryId);
      if (!binding || this.ports.getUserInputContinuationReceipt(run.threadId, deliveryId)
        || binding.runId !== run.id || binding.fence.workUnitId !== workUnit.id
        || binding.fence.attemptId !== workUnit.activeAttemptId) return false;
      const attempt = this.ports.getWorkUnitAttempt(binding.fence.attemptId);
      return Boolean(attempt && attempt.status === "created" && !attempt.endedAt
        && attempt.workUnitId === workUnit.id
        && attempt.runtimeInstanceId === binding.fence.runtimeInstanceId
        && attempt.fencingToken === binding.fence.fencingToken);
    } catch {
      // Missing or corrupt continuation evidence is not restart authority.
      return false;
    }
  }

  recoverStaleChannelWorkflows(now: string): number {
    let recovered = 0;
    const workflows = this.ports.listRecoverableChannelWorkflows();

    for (const workflow of workflows) {
      const steps = this.ports.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true });
      for (const step of steps) {
        if ((step.status === "running" || step.status === "waiting_for_approval")
          && step.metadata?.activeGateStage === "pre" && !step.taskId && !step.runId && !step.metadata.startOwner) {
          // A permission wait is not an abandoned execution. Resolve the exact
          // persisted cycle before legacy recovery can block/fail it. Stale or
          // missing markers never fall through into approval-only completion.
          const beforeWorkflow = this.ports.getChannelWorkflow(workflow.id);
          if (step.metadata.preStepApprovalId) this.ports.resolveChannelWorkflowStepPreApproval({
            workflowStepId: step.id, approvalId: step.metadata.preStepApprovalId, actor: "system", now,
          });
          const current = this.ports.workflowStepStartReadStore.getChannelWorkflowStep(step.id);
          if (current?.status !== step.status || this.ports.getChannelWorkflow(workflow.id)?.status !== beforeWorkflow?.status) recovered += 1;
          continue;
        }
        if (this.isApprovedPreAdmissionHolding(step, now)) {
          // Approval grants permission for a later explicit start. Until that
          // start atomically consumes the marker with its Task, there is no
          // missing execution owner for startup recovery to repair.
          continue;
        }
        if (step.status === "running" || step.status === "waiting_for_approval" && Boolean(step.taskId || step.runId || step.metadata?.startOwner)) {
          const ownership = classifyWorkflowStepStartOwner(this.ports.workflowStepStartReadStore, step, now, { requireActiveLease: false });
          if (ownership.status !== "linked") {
            const owner = step.metadata?.startOwner;
            const result = this.ports.settleChannelWorkflowStepStartFailure({ workflowStepId: step.id, expected: step,
              ...(owner ? { owner, leaseId: owner.leaseId } : {}),
              mode: ownership.status === "preparing" ? "startup_recovery" : "invalid_owner",
              blocker: ownership.status === "preparing"
                ? "Daemon restarted before workflow step run started; retry required."
                : "Workflow start owner is missing or inconsistent after daemon restart; retry required.", now });
            if (result.status === "linked") recovered += 1;
            continue;
          }
        }
        if (workflow.metadata?.requiredParticipantManifest && step.status === "running" && step.runId) {
          const run = this.ports.getRun(step.runId);
          if (!run) {
            recovered += this.recoverWorkflowStepBlocked(step, "Linked run is missing after daemon restart.", now) ? 1 : 0;
          }
          // Terminal linked Runs remain running here. The daemon semantic reconciler
          // reloads immutable requirements, actions, packets, approvals, and graph state.
          continue;
        }
        if (workflow.metadata?.requiredParticipantManifest
          && step.status === "waiting_for_approval"
          && step.metadata?.activeGateStage === "post") {
          // Approval state is durable, but only the daemon semantic reconciler may turn
          // it into a delegated outcome after revalidating evidence.
          continue;
        }
        if (step.status === "running" && step.runId) {
          const run = this.ports.getRun(step.runId);
          if (run?.status === "succeeded") {
            recovered += this.recoverWorkflowStepSucceeded(step, run, now) ? 1 : 0;
          } else if (run?.status === "failed" || run?.status === "cancelled") {
            recovered += this.recoverWorkflowStepFailed(step, run, now) ? 1 : 0;
          } else if (!run) {
            recovered += this.recoverWorkflowStepBlocked(step, "Linked run is missing after daemon restart.", now) ? 1 : 0;
          }
          continue;
        }
        if (step.status === "running" && !step.runId) {
          recovered += this.recoverWorkflowStepBlocked(step, "Daemon restarted before workflow step run started; retry required.", now) ? 1 : 0;
          continue;
        }
        if (step.status === "claimed") {
          recovered += this.recoverWorkflowClaimedStepBlocked(step, "Daemon restarted after workflow step was claimed; retry required.", now) ? 1 : 0;
          continue;
        }
        if (step.status === "waiting_for_approval") {
          const approval = this.findWorkflowStepApproval(step);
          if (approval?.status === "approved") {
            recovered += this.recoverApprovedWorkflowStep(step, approval, now);
          } else if (approval && approval.status !== "pending") {
            recovered += this.recoverWorkflowStepApprovalFailed(step, approval.status, approval.decisionReason ?? `Workflow step approval ${approval.status}.`, now) ? 1 : 0;
          }
        }
      }
      recovered += this.recoverWorkflowAggregateStatus(workflow.id, now);
    }

    return recovered;
  }

  private findWorkflowStepApproval(step: ChannelWorkflowStep): ApprovalRequest | undefined {
    const checkpointIds = [step.metadata?.postStepApprovalId, step.metadata?.preStepApprovalId]
      .filter((id): id is string => Boolean(id));
    for (const approvalId of checkpointIds) {
      const approval = this.ports.getApprovalRequest(approvalId);
      if (approval) {
        return approval;
      }
    }
    return this.ports.listApprovalRequests({ workflowStepId: step.id, limit: 1 })[0];
  }

  private isApprovedPreAdmissionHolding(step: ChannelWorkflowStep, now: string): boolean {
    const approvalId = step.metadata?.preStepApprovalId;
    const marker = step.metadata?.preStepApprovalMarker;
    if ((step.status !== "running" && step.status !== "waiting_for_approval")
      || !approvalId || !isWorkflowPreGateMarkerV1(marker) || marker.consumedByTaskId
      || step.taskId || step.runId || step.metadata?.startOwner) {
      return false;
    }
    const inspection = inspectWorkflowPreApproval(this.ports.workflowStepStartReadStore, step, now);
    return inspection.status === "approved" && inspection.approval.id === approvalId;
  }

  private isTerminalRejectedPreAdmission(step: ChannelWorkflowStep, now: string): boolean {
    const approvalId = step.metadata?.preStepApprovalId;
    const marker = step.metadata?.preStepApprovalMarker;
    if (step.status !== "skipped" || !approvalId || !isWorkflowPreGateMarkerV1(marker)
      || marker.consumedByTaskId) {
      return false;
    }
    const inspection = inspectWorkflowPreApproval(this.ports.workflowStepStartReadStore, step, now);
    return inspection.status === "blocked" && inspection.approval.id === approvalId
      && inspection.approval.status !== "pending" && inspection.approval.status !== "approved";
  }

  private recoverApprovedWorkflowStep(step: ChannelWorkflowStep, approval: ApprovalRequest, now: string): number {
    const approvalOnlyStep = !step.taskId && !step.runId && !step.metadata?.preStepApprovalId;
    const postStepApproval = step.metadata?.postStepApprovalId === approval.id || step.metadata?.activeGateStage === "post";
    if (!approvalOnlyStep && !postStepApproval) {
      return this.recoverWorkflowStepBlocked(
        step,
        "Daemon restarted after approval but before workflow step run started; retry required.",
        now,
      ) ? 1 : 0;
    }
    const approved = this.ports.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "waiting_for_approval",
      event: "approval_approved",
      actor: "system",
      reason: `startup_recovery:${approval.id}`,
      now,
      blocker: null,
    });
    if (!approved.ok) {
      return 0;
    }
    if (postStepApproval && step.metadata?.executionPlan && step.metadata.executionVerification?.status !== "verified") {
      return this.recoverWorkflowStepBlocked(
        { ...step, status: "running" },
        "Required operation evidence was not verified before post-step approval recovery.",
        now,
      ) ? 2 : 1;
    }
    const succeeded = this.ports.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "running",
      event: "succeed",
      actor: "system",
      reason: `startup_recovery:${approval.id}`,
      now,
      blocker: null,
      resultSummary: postStepApproval
        ? "Recovered completed post-step approval."
        : "Recovered completed approval-only workflow step.",
    });
    return succeeded.ok ? 2 : 1;
  }

  private recoverWorkflowStepSucceeded(step: ChannelWorkflowStep, run: RunSession, now: string): boolean {
    if (step.metadata?.executionPlan && step.metadata.executionVerification?.status !== "verified") {
      return this.recoverWorkflowStepBlocked(
        step,
        "Required operation evidence was not verified before workflow recovery.",
        now,
      );
    }
    const result = this.ports.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "running",
      event: "succeed",
      actor: "system",
      reason: `startup_recovery:${run.id}`,
      now,
      taskId: step.taskId ?? run.taskId,
      runId: run.id,
      resultSummary: "Recovered from linked terminal run.",
    });
    return result.ok;
  }

  private recoverWorkflowStepFailed(step: ChannelWorkflowStep, run: RunSession, now: string): boolean {
    const result = this.ports.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "running",
      event: run.status === "cancelled" ? "cancel" : "fail",
      actor: "system",
      reason: run.errorMessage ?? `startup_recovery:${run.id}`,
      now,
      taskId: step.taskId ?? run.taskId,
      runId: run.id,
      blocker: run.errorMessage ?? `Linked run ${run.status} during startup recovery.`,
    });
    return result.ok;
  }

  private recoverWorkflowClaimedStepBlocked(step: ChannelWorkflowStep, blocker: string, now: string): boolean {
    const started = this.ports.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "claimed",
      event: "start",
      actor: "system",
      reason: "startup_recovery",
      now,
      blocker: null,
    });
    if (!started.ok) {
      return false;
    }
    return this.recoverWorkflowStepBlocked({ ...step, status: "running" }, blocker, now);
  }

  private recoverWorkflowStepBlocked(step: ChannelWorkflowStep, blocker: string, now: string): boolean {
    if (step.status === "waiting_for_approval") {
      const approved = this.ports.transitionChannelWorkflowStepStatus({
        workflowStepId: step.id,
        expectedStatus: "waiting_for_approval",
        event: "approval_approved",
        actor: "system",
        reason: "startup_recovery",
        now,
        blocker: null,
      });
      if (!approved.ok) {
        return false;
      }
      return this.recoverWorkflowStepBlocked({ ...step, status: "running" }, blocker, now);
    }
    const result = this.ports.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: step.status,
      event: "blocked",
      actor: "system",
      reason: blocker,
      now,
      blocker,
    });
    return result.ok;
  }

  private recoverWorkflowStepApprovalFailed(step: ChannelWorkflowStep, status: string, blocker: string, now: string): boolean {
    const result = this.ports.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "waiting_for_approval",
      event: "fail",
      actor: "system",
      reason: blocker,
      now,
      blocker,
    });
    if (result.ok) {
      this.ports.transitionChannelWorkflowStatus({
        workflowId: step.workflowId,
        expectedStatus: this.ports.getChannelWorkflow(step.workflowId)?.status,
        event: "step_failed",
        actor: "system",
        reason: `approval_${status}`,
        now,
      });
    }
    return result.ok;
  }

  private recoverWorkflowAggregateStatus(workflowId: string, now: string): number {
    const workflow = this.ports.getChannelWorkflow(workflowId);
    if (!workflow || workflow.status === "succeeded" || workflow.status === "failed" || workflow.status === "cancelled") {
      return 0;
    }
    const steps = this.ports.listChannelWorkflowSteps({ workflowId, complete: true });
    if (steps.length > 0 && steps.every((step) => step.status === "succeeded" || step.status === "skipped")) {
      if (steps.some(step => this.isTerminalRejectedPreAdmission(step, now))) {
        // A pre-gate denial policy may skip a Step, but cannot publish workflow
        // success. The canonical completion gate still owns that decision.
        return 0;
      }
      if (workflow.metadata?.requiredParticipantManifest) {
        // Continuity-backed workflows are completed only by the daemon's shared
        // WorkflowCompletionGate after this storage-level reconciliation returns.
        // Core cannot verify operation actions, output packets, or immutable graph edges.
        return 0;
      }
      const result = this.ports.transitionChannelWorkflowStatus({
        workflowId,
        expectedStatus: workflow.status,
        event: workflow.status === "waiting_for_approval" ? "approval_approved" : "all_steps_succeeded",
        actor: "system",
        reason: "startup_recovery",
        now,
      });
      if (result.ok && result.to !== "succeeded") {
        const succeeded = this.ports.transitionChannelWorkflowStatus({
          workflowId,
          expectedStatus: "running",
          event: "all_steps_succeeded",
          actor: "system",
          reason: "startup_recovery",
          now,
        });
        return succeeded.ok ? 2 : 1;
      }
      return result.ok ? 1 : 0;
    }
    const failed = steps.find((step) => step.status === "failed" || step.status === "cancelled");
    if (failed) {
      const result = this.ports.transitionChannelWorkflowStatus({
        workflowId,
        expectedStatus: workflow.status,
        event: "step_failed",
        actor: "system",
        reason: failed.blocker ?? "startup_recovery",
        now,
      });
      return result.ok ? 1 : 0;
    }
    const blocked = steps.find((step) => step.status === "blocked");
    if (blocked && workflow.status === "running") {
      const result = this.ports.transitionChannelWorkflowStatus({
        workflowId,
        expectedStatus: "running",
        event: "step_blocked",
        actor: "system",
        reason: blocked.blocker ?? "startup_recovery",
        now,
      });
      return result.ok ? 1 : 0;
    }
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deliveryIdFromContinuationSnapshot(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.userInputContinuationContext)) return undefined;
  const seedRef = value.userInputContinuationContext.seedRef;
  if (!isRecord(seedRef)) return undefined;
  const prefix = "user_input_continuation_seed:";
  return typeof seedRef.id === "string" && seedRef.id.startsWith(prefix) && seedRef.id.length > prefix.length
    ? seedRef.id.slice(prefix.length)
    : undefined;
}
