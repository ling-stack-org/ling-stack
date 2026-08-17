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
import type {
  AppendControlPlaneEventInput,
  ControlPlaneEvent,
  RunSession,
} from "../../run-types.js";
import type {
  AppendRuntimeEventInput,
  CreateWorkUnitAttemptInput,
  WorkUnit,
  WorkUnitAttempt,
} from "../../runtime-supervisor-types.js";
import type { ResourceLeaseOwnerType } from "../../channel-runtime-types.js";
import type { RunTransitionEvent, StateTransitionActor, TaskTransitionEvent, TransitionResult, WorkUnitTransitionEvent } from "../../state-machines.js";
import type { SqliteStoreContext } from "./store-context.js";

interface ApprovalResumeStorePorts {
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
  readonly transitionWorkUnitStatus: (input: {
    readonly workUnitId: string;
    readonly expectedStatus: WorkUnit["status"];
    readonly event: WorkUnitTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly activeAttemptId?: string | null;
    readonly endedAt?: string | null;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
  }) => TransitionResult<WorkUnit["status"]>;
  readonly getWorkUnitAttempt: (id: string) => WorkUnitAttempt | undefined;
  readonly createWorkUnitAttempt: (input: CreateWorkUnitAttemptInput) => WorkUnitAttempt;
  readonly updateWorkUnitAttemptStatus: (input: {
    readonly attemptId: string;
    readonly status: WorkUnitAttempt["status"];
    readonly now: string;
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly lastHeartbeatAt?: string;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
  }) => WorkUnitAttempt | undefined;
  readonly releaseRuntimeSemaphoreSlotsForOwner: (ownerId: string, releasedAt: string, releaseReason: string) => number;
  readonly appendRuntimeEvent: (input: AppendRuntimeEventInput) => unknown;
  readonly appendControlPlaneEvent: (input: AppendControlPlaneEventInput, now: string) => ControlPlaneEvent;
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
  readonly releaseResourceLeasesForOwner: (
    ownerType: ResourceLeaseOwnerType,
    ownerId: string,
    releasedAt: string,
  ) => number;
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
    if (this.context.database.isTransaction) {
      throw new Error("Approval resume claim cannot join an unrelated SQLite transaction.");
    }
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
        this.ports.releaseRuntimeSemaphoreSlotsForOwner(
          attemptToLose.id,
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

      const createdAttempt = this.ports.createWorkUnitAttempt({
        ...input.replacementAttempt,
        status: "created",
      });
      if (createdAttempt.id !== input.replacementAttempt.id) {
        throw new ApprovalResumeClaimAbort("approval_resume_attempt_conflict");
      }
      const attempt = this.ports.updateWorkUnitAttemptStatus({
        attemptId: createdAttempt.id,
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
      if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK;");
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
    if (this.context.database.isTransaction) {
      throw new Error("Approval resume suspension cannot join an unrelated SQLite transaction.");
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
        status: "lost",
        now: input.now,
        endedAt: input.now,
        errorCode: "runtime_suspend",
        errorMessage: input.cause,
      });
      if (!updatedCheckpoint || !lostAttempt || lostAttempt.status !== "lost") {
        throw new ApprovalResumeTransitionAbort("approval_resume_suspension_stale");
      }
      this.ports.releaseResourceLeasesForOwner("run", run.id, input.now);
      this.ports.releaseRuntimeSemaphoreSlotsForOwner(attempt.id, input.now, "approval-resume-suspended");
      this.ports.appendRuntimeEvent({
        workUnitId: workUnit.id,
        attemptId: attempt.id,
        type: "work_unit_stale",
        actor: "system",
        ts: input.now,
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
      if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK;");
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
    if (this.context.database.isTransaction) {
      throw new Error("Approval resume terminal transition cannot join an unrelated SQLite transaction.");
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
      const updatedAttempt = this.ports.updateWorkUnitAttemptStatus({
        attemptId: attempt.id,
        status: input.attemptStatus,
        now: input.now,
        endedAt: input.now,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
      });
      if (!updatedCheckpoint || !runTransition.ok || !workUnitTransition.ok || !updatedAttempt) {
        throw new ApprovalResumeTransitionAbort("approval_resume_terminal_stale");
      }
      this.ports.appendRuntimeEvent({
        workUnitId: workUnit.id,
        attemptId: attempt.id,
        type: input.status === "succeeded" ? "work_unit_succeeded" : "work_unit_failed",
        actor: "system",
        ts: input.now,
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
      this.ports.releaseResourceLeasesForOwner("run", run.id, input.now);
      this.ports.releaseRuntimeSemaphoreSlotsForOwner(attempt.id, input.now, "approval-resume-finished");
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
      if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK;");
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
    if (this.context.database.isTransaction) {
      throw new Error("Approval resume checkpoint quarantine cannot join an unrelated SQLite transaction.");
    }
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
      const controlPlaneEvent = this.ports.appendControlPlaneEvent({
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
      if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK;");
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
  return definitions.map((definition) => ports.appendControlPlaneEvent({
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
  return definitions.map((definition) => ports.appendControlPlaneEvent({
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

function claimIdempotencyKey(input: CommitApprovalResumeClaimInput, suffix: string): string {
  return `approval-resume-claim:${input.checkpointId}:${input.expectedCheckpointRevision}:${input.replacementAttempt.id}:${suffix}`;
}

function terminalIdempotencyKey(input: CommitApprovalResumeVerifiedTerminalInput, suffix: string): string {
  return `approval-resume-terminal:${input.checkpointId}:${input.expectedCheckpointRevision}:${input.attemptId}:${input.status}:${suffix}`;
}

function isAttemptTerminal(status: WorkUnitAttempt["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost";
}
