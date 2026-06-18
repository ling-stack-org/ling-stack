import type { ApprovalRequest } from "../../approval-types.js";
import {
  type LingThread,
  type RunEventType,
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

export interface SqliteRuntimeRecoveryCoordinatorPorts {
  readonly expireResourceLeases: (now: string) => number;
  readonly listRecoverableRunIds: () => string[];
  readonly hasTerminalRunEvent: (runId: string) => boolean;
  readonly appendRunEvent: (runId: string, type: RunEventType, data: unknown) => unknown;
  readonly markRunFailed: (runId: string, endedAt: string, errorMessage: string) => void;
  readonly getRun: (runId: string) => RunSession | undefined;
  readonly getLingThread: (threadId: string) => LingThread | undefined;
  readonly updateLingThread: (threadId: string, input: UpdateLingThreadInput, now: string) => LingThread | undefined;
  readonly listRecoverableChannelWorkflows: () => ChannelWorkflow[];
  readonly listChannelWorkflowSteps: (options: ListChannelWorkflowStepsOptions) => ChannelWorkflowStep[];
  readonly getApprovalRequest: (id: string) => ApprovalRequest | undefined;
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
    this.ports.expireResourceLeases(now);
    const staleRuns = this.ports.listRecoverableRunIds();

    for (const runId of staleRuns) {
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
    }

    return staleRuns.length;
  }

  recoverStaleChannelWorkflows(now: string): number {
    let recovered = 0;
    const workflows = this.ports.listRecoverableChannelWorkflows();

    for (const workflow of workflows) {
      const steps = this.ports.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 });
      for (const step of steps) {
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
        if (step.status === "waiting_for_approval" && step.metadata?.preStepApprovalId) {
          const approval = this.ports.getApprovalRequest(step.metadata.preStepApprovalId);
          if (approval?.status === "approved") {
            recovered += this.recoverWorkflowStepBlocked(step, "Daemon restarted after approval but before workflow step run started; retry required.", now) ? 1 : 0;
          } else if (approval && approval.status !== "pending") {
            recovered += this.recoverWorkflowStepApprovalFailed(step, approval.status, approval.decisionReason ?? `Workflow step approval ${approval.status}.`, now) ? 1 : 0;
          }
        }
      }
      recovered += this.recoverWorkflowAggregateStatus(workflow.id, now);
    }

    return recovered;
  }

  private recoverWorkflowStepSucceeded(step: ChannelWorkflowStep, run: RunSession, now: string): boolean {
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
    const steps = this.ports.listChannelWorkflowSteps({ workflowId, limit: 500 });
    if (steps.length > 0 && steps.every((step) => step.status === "succeeded" || step.status === "skipped")) {
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
