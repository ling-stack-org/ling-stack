import type {
  CommitApprovalResumeClaimInput,
  CommitApprovalResumeClaimResult,
  CommitApprovalResumeSuspensionInput,
  CommitApprovalResumeSuspensionResult,
  CommitApprovalResumeTerminalInput,
  CommitApprovalResumeTerminalResult,
  CommitApprovalResumeVerifiedTerminalInput,
  LingApprovalCheckpoint,
  UpdateApprovalCheckpointStatusInput,
} from "../../approval-checkpoints.js";
import type { ApprovalRequest } from "../../approval-types.js";
import type {
  AppendControlPlaneEventInput,
  ControlPlaneEvent,
  RunSession,
} from "../../run-types.js";
import {
  toRuntimeAttemptFence,
  type AppendRuntimeEventInput,
  type AppendTerminalRuntimeAuditInput,
  type CreateWorkUnitAttemptInput,
  type RuntimeAttemptFenceV1,
  type WorkUnit,
  type WorkUnitAttempt,
} from "../../runtime-supervisor-types.js";
import type { RunTransitionEvent, StateTransitionActor, TaskTransitionEvent, TransitionResult, WorkUnitTransitionEvent } from "../../state-machines.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

interface ApprovalResumeStorePorts {
  readonly getApprovalRequest: (id: string) => ApprovalRequest | undefined;
  readonly getApprovalCheckpoint: (id: string) => LingApprovalCheckpoint | undefined;
  readonly updateApprovalCheckpointStatus: (
    id: string,
    input: UpdateApprovalCheckpointStatusInput,
    now: string,
  ) => LingApprovalCheckpoint | undefined;
  readonly getRun: (id: string) => RunSession | undefined;
  readonly transitionRunStatus: (input: {
    readonly runId: string;
    readonly expectedStatus: RunSession["status"];
    readonly event: RunTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly endedAt?: string;
    readonly summaryPath?: string;
    readonly errorMessage?: string | null;
  }) => TransitionResult<RunSession["status"]>;
  readonly getWorkUnit: (id: string) => WorkUnit | undefined;
  readonly transitionWorkUnitStatus: (input: Parameters<import("../../run-types.js").RunStore["transitionWorkUnitStatus"]>[0]) => TransitionResult<WorkUnit["status"]>;
  readonly getWorkUnitAttempt: (id: string) => WorkUnitAttempt | undefined;
  readonly createWorkUnitAttempt: (input: CreateWorkUnitAttemptInput) => WorkUnitAttempt;
  readonly createWorkUnitAttemptWithinTransaction: (input: CreateWorkUnitAttemptInput) => WorkUnitAttempt;
  readonly updateWorkUnitAttemptStatus: (input: {
    readonly attemptId: string;
    readonly workUnitId: string;
    readonly runtimeInstanceId: string;
    readonly fencingToken: string;
    readonly status: WorkUnitAttempt["status"];
    readonly now: string;
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly lastHeartbeatAt?: string;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
  }) => WorkUnitAttempt | undefined;
  readonly releaseRuntimeSemaphoreSlotsForAttempt: (fence: RuntimeAttemptFenceV1, releasedAt: string, releaseReason: string) => number;
  readonly appendRuntimeEvent: (input: AppendRuntimeEventInput) => unknown;
  readonly appendTerminalRuntimeAudit: (input: AppendTerminalRuntimeAuditInput) => unknown;
  readonly appendControlPlaneEventWithinTransaction: (
    input: AppendControlPlaneEventInput,
    now: string,
  ) => ControlPlaneEvent;
  readonly getTask: (id: string) => { readonly id: string; readonly status: string } | undefined;
  readonly transitionTaskStatus: (input: {
    readonly taskId: string;
    readonly expectedStatus: "running";
    readonly event: TaskTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly currentRunId?: string | null;
  }) => TransitionResult<import("../../workspace-types.js").Task["status"]>;
  readonly releaseResourceLeasesForAttempt: (fence: RuntimeAttemptFenceV1, releasedAt: string, releaseReason: string) => number;
  readonly getDefaultControlPlaneScope: () => { readonly workspaceId: string; readonly cwd: string };
}

class ApprovalResumeClaimAbort extends Error {
  constructor(readonly code: Extract<CommitApprovalResumeClaimResult, { ok: false }>["code"]) {
    super(code);
  }
}

class ApprovalResumeTransitionAbort extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Owns the only pre-execution approval-resume transaction.
 *
 * checkpoint CAS -> old-attempt fence -> replacement Attempt -> Run/WorkUnit
 * activation -> runtime audit -> durable observer invalidations
 */
export class SqliteApprovalResumeStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: ApprovalResumeStorePorts,
  ) {}

  commitApprovalResumeClaim(input: CommitApprovalResumeClaimInput): CommitApprovalResumeClaimResult {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const checkpoint = this.ports.getApprovalCheckpoint(input.checkpointId);
      if (!checkpoint
        || checkpoint.status !== input.expectedCheckpointStatus
        || checkpoint.revision !== input.expectedCheckpointRevision) {
        throw new ApprovalResumeClaimAbort("approval_resume_checkpoint_stale");
      }
      if (checkpoint.approvalId !== input.approvalId
        || checkpoint.runId !== input.runId
        || checkpoint.resumeBasis?.runId !== input.runId
        || checkpoint.resumeBasis?.workUnitId !== input.workUnitId
        || input.replacementAttempt.workUnitId !== input.workUnitId
        || input.runnerResumeHandle.runId !== input.runId
        || input.runnerResumeHandle.attemptId !== input.replacementAttempt.id) {
        throw new ApprovalResumeClaimAbort("approval_resume_lineage_mismatch");
      }

      const run = this.ports.getRun(input.runId);
      const workUnit = this.ports.getWorkUnit(input.workUnitId);
      if (!run || run.workUnitId !== input.workUnitId) {
        throw new ApprovalResumeClaimAbort("approval_resume_lineage_mismatch");
      }
      const expectedStatus = input.mode === "activate_waiting" ? "waiting_for_approval" : "running";
      if (run.status !== expectedStatus) {
        throw new ApprovalResumeClaimAbort("approval_resume_run_state_stale");
      }
      if (!workUnit || workUnit.status !== expectedStatus || workUnit.activeAttemptId !== input.expectedActiveAttemptId) {
        throw new ApprovalResumeClaimAbort("approval_resume_work_unit_state_stale");
      }
      if (this.ports.getWorkUnitAttempt(input.replacementAttempt.id)) {
        throw new ApprovalResumeClaimAbort("approval_resume_attempt_conflict");
      }

      if (input.attemptToLoseId) {
        if (input.attemptToLoseId !== input.expectedActiveAttemptId) {
          throw new ApprovalResumeClaimAbort("approval_resume_attempt_conflict");
        }
        const attemptToLose = this.ports.getWorkUnitAttempt(input.attemptToLoseId);
        if (!attemptToLose || attemptToLose.workUnitId !== input.workUnitId) {
          throw new ApprovalResumeClaimAbort("approval_resume_attempt_conflict");
        }
        if (!isAttemptTerminal(attemptToLose.status)) {
          const lost = this.ports.updateWorkUnitAttemptStatus({
            attemptId: attemptToLose.id,
            workUnitId: attemptToLose.workUnitId,
            runtimeInstanceId: attemptToLose.runtimeInstanceId,
            fencingToken: attemptToLose.fencingToken,
            status: "lost",
            now: input.now,
            endedAt: input.now,
            errorCode: "runtime_suspend",
            errorMessage: "approval_resume_replaced_before_tool_start",
          });
          if (!lost || lost.status !== "lost") {
            throw new ApprovalResumeClaimAbort("approval_resume_attempt_conflict");
          }
        }
        const attemptToLoseFence = toRuntimeAttemptFence(attemptToLose);
        this.ports.releaseResourceLeasesForAttempt(
          attemptToLoseFence,
          input.now,
          "approval-resume-replaced-before-tool-start",
        );
        this.ports.releaseRuntimeSemaphoreSlotsForAttempt(
          attemptToLoseFence,
          input.now,
          "approval-resume-replaced-before-tool-start",
        );
      }

      const claimedCheckpoint = this.ports.updateApprovalCheckpointStatus(checkpoint.id, {
        status: "resume_pending",
        expectedStatus: checkpoint.status,
        expectedRevision: checkpoint.revision,
        runnerResumeHandle: input.runnerResumeHandle,
        resumeFailureReason: null,
      }, input.now);
      if (!claimedCheckpoint) {
        throw new ApprovalResumeClaimAbort("approval_resume_checkpoint_stale");
      }

      const createdAttempt = this.ports.createWorkUnitAttemptWithinTransaction({
        ...input.replacementAttempt,
        status: "created",
      });
      if (createdAttempt.id !== input.replacementAttempt.id) {
        throw new ApprovalResumeClaimAbort("approval_resume_attempt_conflict");
      }
      const attempt = this.ports.updateWorkUnitAttemptStatus({
        attemptId: createdAttempt.id,
        workUnitId: createdAttempt.workUnitId,
        runtimeInstanceId: createdAttempt.runtimeInstanceId,
        fencingToken: createdAttempt.fencingToken,
        status: "started",
        now: input.now,
        startedAt: input.now,
        lastHeartbeatAt: input.now,
        errorCode: null,
        errorMessage: null,
      });
      if (!attempt || attempt.status !== "started") {
        throw new ApprovalResumeClaimAbort("approval_resume_attempt_conflict");
      }

      if (input.mode === "activate_waiting") {
        const workUnitTransition = this.ports.transitionWorkUnitStatus({
          workUnitId: workUnit.id,
          attemptId: attempt.id,
          runtimeInstanceId: attempt.runtimeInstanceId,
          fencingToken: attempt.fencingToken,
          expectedStatus: "waiting_for_approval",
          event: "approval_approved",
          actor: "local-user",
          reason: `approval_resume:${input.approvalId}`,
          idempotencyKey: claimIdempotencyKey(input, "work-unit-transition"),
          now: input.now,
          activeAttemptId: attempt.id,
          endedAt: null,
          errorCode: null,
          errorMessage: null,
        });
        const runTransition = this.ports.transitionRunStatus({
          runId: run.id,
          expectedStatus: "waiting_for_approval",
          event: "approval_approved",
          actor: "local-user",
          reason: `approval_resume:${input.approvalId}`,
          idempotencyKey: claimIdempotencyKey(input, "run-transition"),
          now: input.now,
        });
        if (!workUnitTransition.ok || !runTransition.ok) {
          throw new ApprovalResumeClaimAbort("approval_resume_transition_failed");
        }
      }

      this.ports.appendRuntimeEvent({
        workUnitId: workUnit.id,
        attemptId: attempt.id,
        runtimeInstanceId: attempt.runtimeInstanceId,
        fencingToken: attempt.fencingToken,
        type: "work_unit_started",
        actor: "system",
        ts: input.now,
        data: {
          reason: "approval_resume",
          approvalId: input.approvalId,
          priorAttemptId: input.expectedActiveAttemptId,
          resumeBasisFingerprint: checkpoint.resumeBasis?.fingerprint,
          recoveryMode: input.mode,
        },
      });

      const controlPlaneEvents = appendClaimInvalidations(this.ports, input, workUnit.workspaceId, run.cwd);
      this.context.database.exec("COMMIT;");

      const committedRun = this.ports.getRun(run.id);
      const committedWorkUnit = this.ports.getWorkUnit(workUnit.id);
      const committedAttempt = this.ports.getWorkUnitAttempt(attempt.id);
      const committedCheckpoint = this.ports.getApprovalCheckpoint(checkpoint.id);
      if (!committedRun || !committedWorkUnit || !committedAttempt || !committedCheckpoint) {
        throw new Error("Approval resume claim committed but could not be reloaded.");
      }
      return {
        ok: true,
        checkpoint: committedCheckpoint,
        run: committedRun,
        workUnit: committedWorkUnit,
        attempt: committedAttempt,
        controlPlaneEvents,
      };
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      if (error instanceof ApprovalResumeClaimAbort) {
        return { ok: false, code: error.code };
      }
      throw error;
    }
  }

  commitApprovalResumeSuspension(input: CommitApprovalResumeSuspensionInput): CommitApprovalResumeSuspensionResult {
    if (!isValidApprovalResumeSuspensionShape(input)) {
      throw new Error("Approval resume suspension lifecycle shape is invalid.");
    }
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const checkpoint = this.ports.getApprovalCheckpoint(input.checkpointId);
      const run = this.ports.getRun(input.runId);
      const workUnit = this.ports.getWorkUnit(input.workUnitId);
      const attempt = this.ports.getWorkUnitAttempt(input.attemptId);
      if (!checkpoint
        || checkpoint.status !== input.expectedCheckpointStatus
        || checkpoint.revision !== input.expectedCheckpointRevision) {
        throw new ApprovalResumeTransitionAbort("approval_resume_suspension_stale");
      }
      const boundAttemptId = input.kind === "resume_pre_dispatch"
        ? checkpoint.runnerResumeHandle?.attemptId
        : checkpoint.resumeBasis?.priorAttemptId;
      if (checkpoint.approvalId !== input.approvalId
        || checkpoint.runId !== input.runId
        || boundAttemptId !== input.attemptId
        || !run
        || run.workUnitId !== input.workUnitId
        || run.status !== input.expectedRunStatus
        || !workUnit
        || workUnit.status !== input.expectedWorkUnitStatus
        || workUnit.activeAttemptId !== input.attemptId
        || !attempt
        || attempt.workUnitId !== input.workUnitId) {
        throw new ApprovalResumeTransitionAbort("approval_resume_lineage_mismatch");
      }
      const updatedCheckpoint = this.ports.updateApprovalCheckpointStatus(checkpoint.id, {
        status: checkpoint.status,
        expectedStatus: checkpoint.status,
        expectedRevision: checkpoint.revision,
        runnerResumeHandle: checkpoint.runnerResumeHandle,
      }, input.now);
      const lostAttempt = this.ports.updateWorkUnitAttemptStatus({
        attemptId: attempt.id,
        workUnitId: attempt.workUnitId,
        runtimeInstanceId: attempt.runtimeInstanceId,
        fencingToken: attempt.fencingToken,
        status: "lost",
        now: input.now,
        endedAt: input.now,
        errorCode: "runtime_suspend",
        errorMessage: input.cause,
      });
      if (!updatedCheckpoint || !lostAttempt || lostAttempt.status !== "lost") {
        throw new ApprovalResumeTransitionAbort("approval_resume_suspension_stale");
      }
      const suspendedFence = toRuntimeAttemptFence(lostAttempt);
      this.ports.releaseResourceLeasesForAttempt(suspendedFence, input.now, "approval-resume-suspended");
      this.ports.releaseRuntimeSemaphoreSlotsForAttempt(suspendedFence, input.now, "approval-resume-suspended");
      this.ports.appendTerminalRuntimeAudit({
        capability: toTerminalAuditCapability(lostAttempt, input.now),
        type: "work_unit_stale",
        actor: "system",
        data: { reason: "runtime_suspend", cause: input.cause, recoverable: true, checkpointId: checkpoint.id },
      });
      const controlPlaneEvents = appendResumeInvalidations(this.ports, {
        workspaceId: workUnit.workspaceId,
        cwd: run.cwd,
        runId: run.id,
        workUnitId: workUnit.id,
        approvalId: input.approvalId,
        action: "suspended",
        idempotencyPrefix: `approval-resume-suspend:${input.kind}:${checkpoint.id}:${checkpoint.revision}:${attempt.id}`,
        now: input.now,
      });
      this.context.database.exec("COMMIT;");
      return reloadSuspensionResult(this.ports, checkpoint.id, run.id, workUnit.id, attempt.id, controlPlaneEvents);
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      if (error instanceof ApprovalResumeTransitionAbort) {
        return {
          ok: false,
          code: error.code === "approval_resume_lineage_mismatch"
            ? "approval_resume_lineage_mismatch"
            : "approval_resume_suspension_stale",
        };
      }
      throw error;
    }
  }

  commitApprovalResumeTerminal(input: CommitApprovalResumeTerminalInput): CommitApprovalResumeTerminalResult {
    if (input.kind === "checkpoint_quarantine") {
      return this.commitApprovalResumeCheckpointQuarantine(input);
    }
    if (input.kind === "system_review_denied") {
      return this.commitApprovalReviewDeniedTerminal(input);
    }
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const checkpoint = this.ports.getApprovalCheckpoint(input.checkpointId);
      const run = this.ports.getRun(input.runId);
      const workUnit = this.ports.getWorkUnit(input.workUnitId);
      const attempt = this.ports.getWorkUnitAttempt(input.attemptId);
      if (!checkpoint
        || checkpoint.status !== input.expectedCheckpointStatus
        || checkpoint.revision !== input.expectedCheckpointRevision
        || !run
        || run.status !== input.expectedRunStatus
        || !workUnit
        || workUnit.status !== input.expectedWorkUnitStatus) {
        throw new ApprovalResumeTransitionAbort("approval_resume_terminal_stale");
      }
      if (checkpoint.approvalId !== input.approvalId
        || checkpoint.runId !== input.runId
        || run.workUnitId !== input.workUnitId
        || workUnit.activeAttemptId !== input.attemptId
        || !attempt
        || attempt.workUnitId !== input.workUnitId) {
        throw new ApprovalResumeTransitionAbort("approval_resume_lineage_mismatch");
      }

      const updatedCheckpoint = this.ports.updateApprovalCheckpointStatus(checkpoint.id, {
        status: input.checkpointStatus,
        expectedStatus: checkpoint.status,
        expectedRevision: checkpoint.revision,
        resumedAt: input.checkpointStatus === "resumed" ? input.now : undefined,
        resumeFailureReason: input.checkpointStatus === "resume_failed" ? input.errorMessage ?? input.errorCode ?? "approval_resume_failed" : null,
      }, input.now);
      const runTransition = this.ports.transitionRunStatus({
        runId: run.id,
        expectedStatus: input.expectedRunStatus,
        event: input.status === "succeeded" ? "runner_succeeded" : "runner_failed",
        actor: "system",
        reason: input.errorCode ?? `approval_resume:${input.approvalId}`,
        idempotencyKey: terminalIdempotencyKey(input, "run-transition"),
        now: input.now,
        endedAt: input.now,
        summaryPath: input.summaryPath,
        errorMessage: input.errorMessage ?? null,
      });
      const workUnitTransition = this.ports.transitionWorkUnitStatus({
        workUnitId: workUnit.id,
        attemptId: attempt.id,
        activeAttemptId: attempt.id,
        runtimeInstanceId: attempt.runtimeInstanceId,
        fencingToken: attempt.fencingToken,
        ...(attempt.status === "lost" ? {
          terminalAttemptOwnership: { kind: "lost_attempt_reconciliation" as const },
        } : {}),
        expectedStatus: input.expectedWorkUnitStatus,
        event: input.status === "succeeded" ? "runner_succeeded" : "runner_failed",
        actor: "system",
        reason: input.errorCode ?? `approval_resume:${input.approvalId}`,
        idempotencyKey: terminalIdempotencyKey(input, "work-unit-transition"),
        now: input.now,
        endedAt: input.now,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
      });
      const updatedAttempt = isAttemptTerminal(attempt.status) && attempt.status === input.attemptStatus
        ? attempt
        : this.ports.updateWorkUnitAttemptStatus({
            attemptId: attempt.id,
            workUnitId: attempt.workUnitId,
            runtimeInstanceId: attempt.runtimeInstanceId,
            fencingToken: attempt.fencingToken,
            status: input.attemptStatus,
            now: input.now,
            endedAt: input.now,
            errorCode: input.errorCode ?? null,
            errorMessage: input.errorMessage ?? null,
          });
      if (!updatedCheckpoint || !runTransition.ok || !workUnitTransition.ok || !updatedAttempt) {
        throw new ApprovalResumeTransitionAbort("approval_resume_terminal_stale");
      }
      if (!isAttemptTerminal(updatedAttempt.status)) {
        throw new ApprovalResumeTransitionAbort("approval_resume_terminal_audit_ownership_mismatch");
      }
      // A startup-recovered lost Attempt may already have its terminal audit
      // stamped at the original loss time. Reusing that exact timestamp lets
      // terminal settlement finish the logical Run without publishing a second
      // runtime terminal event.
      const terminalTransitionedAt = updatedAttempt.status === "lost"
        ? updatedAttempt.endedAt ?? input.now
        : input.now;
      this.ports.appendTerminalRuntimeAudit({
        capability: toTerminalAuditCapability(updatedAttempt, terminalTransitionedAt),
        type: terminalRuntimeEventType(updatedAttempt.status),
        actor: "system",
        data: {
          reason: input.errorCode ?? "approval_resume",
          fromStatus: input.expectedWorkUnitStatus,
          toStatus: input.status,
          resumeTerminal: true,
        },
      });
      const task = this.ports.getTask(run.taskId);
      if (task?.status === "running") {
        const taskTransition = this.ports.transitionTaskStatus({
          taskId: task.id,
          expectedStatus: "running",
          event: input.status === "succeeded" ? "run_succeeded" : "run_failed",
          actor: "system",
          reason: input.errorCode ?? `approval_resume:${input.approvalId}`,
          idempotencyKey: terminalIdempotencyKey(input, "task-transition"),
          now: input.now,
          currentRunId: run.id,
        });
        if (!taskTransition.ok) throw new ApprovalResumeTransitionAbort("approval_resume_terminal_stale");
      }
      const terminalFence = toRuntimeAttemptFence(updatedAttempt);
      this.ports.releaseResourceLeasesForAttempt(terminalFence, input.now, "approval-resume-finished");
      this.ports.releaseRuntimeSemaphoreSlotsForAttempt(terminalFence, input.now, "approval-resume-finished");
      const controlPlaneEvents = appendResumeInvalidations(this.ports, {
        workspaceId: workUnit.workspaceId,
        cwd: run.cwd,
        runId: run.id,
        workUnitId: workUnit.id,
        approvalId: input.approvalId,
        action: input.checkpointStatus === "resume_failed" ? "blocked" : "finalized",
        idempotencyPrefix: `approval-resume-terminal:${checkpoint.id}:${checkpoint.revision}:${attempt.id}:${input.status}`,
        now: input.now,
      });
      this.context.database.exec("COMMIT;");
      return reloadTerminalResult(this.ports, checkpoint.id, run.id, workUnit.id, attempt.id, controlPlaneEvents);
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      if (error instanceof ApprovalResumeTransitionAbort) {
        return {
          ok: false,
          code: error.code === "approval_resume_lineage_mismatch"
            ? "approval_resume_lineage_mismatch"
            : "approval_resume_terminal_stale",
        };
      }
      throw error;
    }
  }

  private commitApprovalReviewDeniedTerminal(
    input: Extract<CommitApprovalResumeTerminalInput, { readonly kind: "system_review_denied" }>,
  ): CommitApprovalResumeTerminalResult {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const approval = this.ports.getApprovalRequest(input.approvalId);
      const checkpoint = this.ports.getApprovalCheckpoint(input.checkpointId);
      const run = this.ports.getRun(input.runId);
      const workUnit = this.ports.getWorkUnit(input.workUnitId);
      const attempt = this.ports.getWorkUnitAttempt(input.attemptId);
      if (!approval
        || approval.status !== "denied"
        || approval.resolvedBy !== "system-reviewer"
        || !checkpoint
        || checkpoint.status !== "denied"
        || checkpoint.revision !== input.expectedCheckpointRevision
        || !run
        || run.status !== "waiting_for_approval"
        || !workUnit
        || workUnit.status !== "waiting_for_approval") {
        throw new ApprovalResumeTransitionAbort("approval_resume_terminal_stale");
      }
      if (approval.runId !== input.runId
        || checkpoint.approvalId !== input.approvalId
        || checkpoint.runId !== input.runId
        || checkpoint.resumeBasis?.workUnitId !== input.workUnitId
        || checkpoint.resumeBasis.priorAttemptId !== input.attemptId
        || run.workUnitId !== input.workUnitId
        || workUnit.activeAttemptId !== input.attemptId
        || !attempt
        || attempt.workUnitId !== input.workUnitId
        || attempt.status !== "lost"
        || attempt.errorCode !== "runtime_suspend") {
        throw new ApprovalResumeTransitionAbort("approval_resume_lineage_mismatch");
      }

      const runTransition = this.ports.transitionRunStatus({
        runId: run.id,
        expectedStatus: "waiting_for_approval",
        event: "approval_denied",
        actor: "system",
        reason: input.reason,
        idempotencyKey: systemReviewDeniedIdempotencyKey(input, "run-transition"),
        now: input.now,
        endedAt: input.now,
        errorMessage: input.reason,
      });
      const workUnitTransition = this.ports.transitionWorkUnitStatus({
        ...toRuntimeAttemptFence(attempt),
        terminalAttemptOwnership: { kind: "lost_attempt_reconciliation" as const },
        expectedStatus: "waiting_for_approval",
        event: "runner_failed",
        actor: "system",
        reason: input.reason,
        idempotencyKey: systemReviewDeniedIdempotencyKey(input, "work-unit-transition"),
        now: input.now,
        endedAt: input.now,
        errorCode: "approval_denied",
        errorMessage: input.reason,
      });
      if (!runTransition.ok || !workUnitTransition.ok) {
        throw new ApprovalResumeTransitionAbort("approval_resume_terminal_stale");
      }
      const task = this.ports.getTask(run.taskId);
      if (task?.status === "running") {
        const taskTransition = this.ports.transitionTaskStatus({
          taskId: task.id,
          expectedStatus: "running",
          event: "run_failed",
          actor: "system",
          reason: input.reason,
          idempotencyKey: systemReviewDeniedIdempotencyKey(input, "task-transition"),
          now: input.now,
          currentRunId: run.id,
        });
        if (!taskTransition.ok) {
          throw new ApprovalResumeTransitionAbort("approval_resume_terminal_stale");
        }
      }
      const fence = toRuntimeAttemptFence(attempt);
      this.ports.releaseResourceLeasesForAttempt(fence, input.now, "approval-review-denied");
      this.ports.releaseRuntimeSemaphoreSlotsForAttempt(fence, input.now, "approval-review-denied");
      const controlPlaneEvents = appendResumeInvalidations(this.ports, {
        workspaceId: workUnit.workspaceId,
        cwd: run.cwd,
        runId: run.id,
        workUnitId: workUnit.id,
        approvalId: approval.id,
        action: "blocked",
        idempotencyPrefix: `approval-review-denied:${checkpoint.id}:${checkpoint.revision}:${attempt.id}`,
        now: input.now,
      });
      this.context.database.exec("COMMIT;");
      return reloadSystemReviewDeniedResult(
        this.ports,
        checkpoint.id,
        run.id,
        workUnit.id,
        attempt.id,
        controlPlaneEvents,
      );
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      if (error instanceof ApprovalResumeTransitionAbort) {
        return {
          ok: false,
          code: error.code === "approval_resume_lineage_mismatch"
            ? "approval_resume_lineage_mismatch"
            : "approval_resume_terminal_stale",
        };
      }
      throw error;
    }
  }

  private commitApprovalResumeCheckpointQuarantine(
    input: Extract<CommitApprovalResumeTerminalInput, { readonly kind: "checkpoint_quarantine" }>,
  ): CommitApprovalResumeTerminalResult {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const checkpoint = this.ports.getApprovalCheckpoint(input.checkpointId);
      if (!checkpoint
        || checkpoint.status !== input.expectedCheckpointStatus
        || checkpoint.revision !== input.expectedCheckpointRevision) {
        throw new ApprovalResumeTransitionAbort("approval_resume_terminal_stale");
      }
      if (checkpoint.approvalId !== input.approvalId) {
        throw new ApprovalResumeTransitionAbort("approval_resume_lineage_mismatch");
      }
      const updatedCheckpoint = this.ports.updateApprovalCheckpointStatus(checkpoint.id, {
        status: "resume_failed",
        expectedStatus: checkpoint.status,
        expectedRevision: checkpoint.revision,
        resumeFailureReason: input.errorMessage || input.errorCode,
      }, input.now);
      if (!updatedCheckpoint) {
        throw new ApprovalResumeTransitionAbort("approval_resume_terminal_stale");
      }
      const scope = this.ports.getDefaultControlPlaneScope();
      const controlPlaneEvent = this.ports.appendControlPlaneEventWithinTransaction({
        workspaceId: scope.workspaceId,
        cwd: scope.cwd,
        domain: "approvals",
        entityType: "approval",
        entityId: input.approvalId,
        action: "approval.resume_blocked",
        data: {},
        idempotencyKey: `approval-resume-quarantine:${checkpoint.id}:${checkpoint.revision}:${input.errorCode}:approvals`,
      }, input.now);
      this.context.database.exec("COMMIT;");
      const committedCheckpoint = this.ports.getApprovalCheckpoint(checkpoint.id);
      if (!committedCheckpoint) {
        throw new Error("Approval resume checkpoint quarantine committed but could not be reloaded.");
      }
      return {
        ok: true,
        kind: "checkpoint_quarantine",
        checkpoint: committedCheckpoint,
        controlPlaneEvents: [controlPlaneEvent],
      };
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      if (error instanceof ApprovalResumeTransitionAbort) {
        return {
          ok: false,
          code: error.code === "approval_resume_lineage_mismatch"
            ? "approval_resume_lineage_mismatch"
            : "approval_resume_terminal_stale",
        };
      }
      throw error;
    }
  }
}

function isValidApprovalResumeSuspensionShape(input: CommitApprovalResumeSuspensionInput): boolean {
  if (input.kind === "approval_wait") {
    return (input.expectedCheckpointStatus === "pending" || input.expectedCheckpointStatus === "approved")
      && input.expectedRunStatus === "waiting_for_approval"
      && input.expectedWorkUnitStatus === "waiting_for_approval";
  }
  if (input.kind === "resume_pre_dispatch") {
    return input.expectedCheckpointStatus === "resume_pending"
      && input.expectedRunStatus === "running"
      && input.expectedWorkUnitStatus === "running";
  }
  return false;
}

function appendClaimInvalidations(
  ports: ApprovalResumeStorePorts,
  input: CommitApprovalResumeClaimInput,
  workspaceId: string,
  cwd: string,
): ControlPlaneEvent[] {
  const definitions = [
    { domain: "runs" as const, entityType: "run", entityId: input.runId, action: "run.approval_resume_claimed" },
    { domain: "work_units" as const, entityType: "work_unit", entityId: input.workUnitId, action: "work_unit.approval_resume_claimed" },
    { domain: "approvals" as const, entityType: "approval", entityId: input.approvalId, action: "approval.resume_claimed" },
  ];
  return definitions.map((definition) => ports.appendControlPlaneEventWithinTransaction({
    workspaceId,
    cwd,
    ...definition,
    data: {},
    idempotencyKey: claimIdempotencyKey(input, definition.domain),
  }, input.now));
}

function appendResumeInvalidations(
  ports: ApprovalResumeStorePorts,
  input: {
    readonly workspaceId: string;
    readonly cwd: string;
    readonly runId: string;
    readonly workUnitId: string;
    readonly approvalId: string;
    readonly action: "suspended" | "finalized" | "blocked";
    readonly idempotencyPrefix: string;
    readonly now: string;
  },
): ControlPlaneEvent[] {
  const definitions = [
    { domain: "runs" as const, entityType: "run", entityId: input.runId, action: `run.approval_resume_${input.action}` },
    { domain: "work_units" as const, entityType: "work_unit", entityId: input.workUnitId, action: `work_unit.approval_resume_${input.action}` },
    { domain: "approvals" as const, entityType: "approval", entityId: input.approvalId, action: `approval.resume_${input.action}` },
  ];
  return definitions.map((definition) => ports.appendControlPlaneEventWithinTransaction({
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    ...definition,
    data: {},
    idempotencyKey: `${input.idempotencyPrefix}:${definition.domain}`,
  }, input.now));
}

function reloadSuspensionResult(
  ports: ApprovalResumeStorePorts,
  checkpointId: string,
  runId: string,
  workUnitId: string,
  attemptId: string,
  controlPlaneEvents: readonly ControlPlaneEvent[],
): Extract<CommitApprovalResumeSuspensionResult, { ok: true }> {
  const checkpoint = ports.getApprovalCheckpoint(checkpointId);
  const run = ports.getRun(runId);
  const workUnit = ports.getWorkUnit(workUnitId);
  const attempt = ports.getWorkUnitAttempt(attemptId);
  if (!checkpoint || !run || !workUnit || !attempt) {
    throw new Error("Approval resume suspension committed but could not be reloaded.");
  }
  return { ok: true, checkpoint, run, workUnit, attempt, controlPlaneEvents };
}

function reloadTerminalResult(
  ports: ApprovalResumeStorePorts,
  checkpointId: string,
  runId: string,
  workUnitId: string,
  attemptId: string,
  controlPlaneEvents: readonly ControlPlaneEvent[],
): Extract<CommitApprovalResumeTerminalResult, { ok: true }> {
  const checkpoint = ports.getApprovalCheckpoint(checkpointId);
  const run = ports.getRun(runId);
  const workUnit = ports.getWorkUnit(workUnitId);
  const attempt = ports.getWorkUnitAttempt(attemptId);
  if (!checkpoint || !run || !workUnit || !attempt) {
    throw new Error("Approval resume terminal transition committed but could not be reloaded.");
  }
  return { ok: true, kind: "verified_lineage", checkpoint, run, workUnit, attempt, controlPlaneEvents };
}

function reloadSystemReviewDeniedResult(
  ports: ApprovalResumeStorePorts,
  checkpointId: string,
  runId: string,
  workUnitId: string,
  attemptId: string,
  controlPlaneEvents: readonly ControlPlaneEvent[],
): Extract<CommitApprovalResumeTerminalResult, { ok: true; kind: "system_review_denied" }> {
  const checkpoint = ports.getApprovalCheckpoint(checkpointId);
  const run = ports.getRun(runId);
  const workUnit = ports.getWorkUnit(workUnitId);
  const attempt = ports.getWorkUnitAttempt(attemptId);
  if (!checkpoint || !run || !workUnit || !attempt) {
    throw new Error("System review denial committed but could not be reloaded.");
  }
  return { ok: true, kind: "system_review_denied", checkpoint, run, workUnit, attempt, controlPlaneEvents };
}

function claimIdempotencyKey(input: CommitApprovalResumeClaimInput, suffix: string): string {
  return `approval-resume-claim:${input.checkpointId}:${input.expectedCheckpointRevision}:${input.replacementAttempt.id}:${suffix}`;
}

function terminalIdempotencyKey(input: CommitApprovalResumeVerifiedTerminalInput, suffix: string): string {
  return `approval-resume-terminal:${input.checkpointId}:${input.expectedCheckpointRevision}:${input.attemptId}:${input.status}:${suffix}`;
}

function systemReviewDeniedIdempotencyKey(
  input: Extract<CommitApprovalResumeTerminalInput, { readonly kind: "system_review_denied" }>,
  suffix: string,
): string {
  return `approval-review-denied:${input.checkpointId}:${input.expectedCheckpointRevision}:${input.attemptId}:${suffix}`;
}

function isAttemptTerminal(
  status: WorkUnitAttempt["status"],
): status is Extract<WorkUnitAttempt["status"], "succeeded" | "failed" | "cancelled" | "lost"> {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost";
}

function toTerminalAuditCapability(
  attempt: WorkUnitAttempt,
  transitionedAt: string,
): AppendTerminalRuntimeAuditInput["capability"] {
  if (!isAttemptTerminal(attempt.status) || attempt.endedAt !== transitionedAt) {
    throw new ApprovalResumeTransitionAbort("approval_resume_terminal_audit_ownership_mismatch");
  }
  return {
    ...toRuntimeAttemptFence(attempt),
    attemptStatus: attempt.status,
    transitionedAt,
  };
}

function terminalRuntimeEventType(
  status: Extract<WorkUnitAttempt["status"], "succeeded" | "failed" | "cancelled" | "lost">,
): AppendTerminalRuntimeAuditInput["type"] {
  if (status === "succeeded") return "work_unit_succeeded";
  if (status === "failed") return "work_unit_failed";
  if (status === "cancelled") return "work_unit_cancelled";
  return "work_unit_stale";
}
