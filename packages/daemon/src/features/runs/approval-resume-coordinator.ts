import {
  approvalSideEffectFingerprintV1,
  createWorkUnitAttemptId,
  getRunSummaryPath,
  toRuntimeAttemptFence,
  type ApprovalRequest,
  type LingApprovalCheckpoint,
  type RunEventEnvelope,
  type RunEventDataByType,
  type RunEventEmitter,
  type RunSession,
  type RunStore,
  type WorkUnit,
  type WorkUnitAttempt,
} from "@ling-stack/core";
import type { PiRunnerApprovalRequest, PiRunnerToolHandledResult } from "@ling-stack/runner-pi";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import { resolveRunnerResumeCapabilities, type RunnerRegistry } from "../../runtime/runners.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { finalizeOrchestratedWorkflowStepRun } from "../channels/orchestrator.js";
import { appendApprovalDecisionEvent, workflowExactCommandBindingRejection } from "./approvals.js";
import { workflowOperationEffectRejection } from "./workflow-operation-effect-gate.js";
import { workflowStepExecutionOperationBindings } from "../channels/workflow-operation-evidence.js";
import { acquireRunRuntimeSemaphores, prepareRunConcurrency } from "./concurrency.js";
import {
  executeHarnessedBashTool,
  harnessToolBrokerModeForRun,
} from "../harness/tool-execution/broker.js";
import { appendRuntimeProgressForRunEvent, syncWorkUnitForRunEvent } from "./work-units.js";
import { syncLingThreadForRunEvent, syncLingThreadForTerminalRun } from "./threads.js";
import { writeTerminalSummary } from "./terminal.js";
import { auditIgnoredRunnerCompletion } from "./stale-completion.js";
import {
  readStoredEffectivePolicySnapshot,
  readStoredRunnerExecution,
} from "./existing-run-request.js";
import {
  finishPreparedRunnerContinuation,
  materializeExistingRunContinuation,
  prepareExistingRunContinuationPlan,
  type ExistingRunContinuationPlan,
  type PreparedRunnerContinuationExecution,
} from "../harness/index.js";

export type ApprovalResumeStartResult =
  | { readonly status: "not_applicable"; readonly reason: string }
  | { readonly status: "already_active"; readonly runId: string; readonly attemptId?: string }
  | { readonly status: "started"; readonly runId: string; readonly attemptId: string }
  | { readonly status: "blocked"; readonly runId?: string; readonly reason: string };

export type SuspendedApprovalDenialFinalizeResult =
  | { readonly status: "finalized"; readonly runId: string }
  | { readonly status: "not_applicable"; readonly reason: string }
  | { readonly status: "blocked"; readonly runId?: string; readonly reason: string };

export class ApprovalResumeCoordinator {
  private readonly harnessDispatches = new Set<string>();

  constructor(private readonly options: {
    readonly runtimeSupervisor: RuntimeSupervisor;
    readonly activeRuns: ActiveRunRegistry;
    readonly runnerRegistry: RunnerRegistry;
    readonly controlPlaneEvents?: ControlPlaneEventHub;
    readonly afterRunTerminal?: (run: RunSession) => void | Promise<void>;
    readonly executeExistingRunContinuation?: (input: {
      readonly cwd: string;
      readonly runId: string;
      readonly approvalId: string;
      readonly preparedExecution: PreparedRunnerContinuationExecution;
    }) => Promise<string | undefined>;
  }) {}

  registerStore(store: RunStore): void {
    for (const status of ["approved", "resume_pending", "denied"] as const) {
      let before: { createdAt: string; id: string } | undefined;
      while (true) {
        const checkpoints = store.listApprovalCheckpoints({ status, limit: 500, before });
        for (const checkpoint of checkpoints) {
          const approval = store.getApprovalRequest(checkpoint.approvalId);
          if (status === "denied") {
            if (approval?.status === "denied") {
              this.finalizeSuspendedApprovalDenial({ store, approval });
            }
          } else if (approval?.status === "approved") {
            this.resumeAfterApproval({ store, approval });
          }
        }
        if (checkpoints.length < 500) break;
        const last = checkpoints[checkpoints.length - 1];
        before = { createdAt: last.createdAt, id: last.id };
      }
    }
  }

  finalizeSuspendedApprovalDenial(input: {
    readonly store: RunStore;
    readonly approval: ApprovalRequest;
  }): SuspendedApprovalDenialFinalizeResult {
    const checkpoint = input.store.getApprovalCheckpointForApproval(input.approval.id);
    if (input.approval.status !== "denied"
      || (input.approval.resolvedBy !== "system-reviewer" && input.approval.resolvedBy !== "local-user")) {
      return { status: "not_applicable", reason: `approval_${input.approval.status}` };
    }
    if (hasDelegationRecoveryOwner(input.store, input.approval.runId)) {
      return { status: "blocked", runId: input.approval.runId, reason: "delegation.authority_invalid" };
    }
    if (!checkpoint || checkpoint.status !== "denied" || !checkpoint.resumeBasis) {
      return { status: "blocked", runId: input.approval.runId, reason: "approval_denial_checkpoint_invalid" };
    }
    const run = input.store.getRun(checkpoint.resumeBasis.runId);
    const workUnit = input.store.getWorkUnit(checkpoint.resumeBasis.workUnitId);
    const attempt = input.store.getWorkUnitAttempt(checkpoint.resumeBasis.priorAttemptId);
    if (!run || !workUnit || !attempt
      || run.workUnitId !== workUnit.id
      || attempt.workUnitId !== workUnit.id) {
      return { status: "blocked", runId: input.approval.runId, reason: "approval_denial_lineage_missing" };
    }
    if (run.status === "failed" && workUnit.status === "failed") {
      this.publishRecoveredApprovalDecision(input.store, input.approval);
      // Recovery repairs a projection; it is not new conversation activity.
      // Retain later user edits, and still repair a stale terminal projection.
      const terminalAt = run.endedAt ?? run.updatedAt;
      const thread = run.threadId ? input.store.getLingThread(run.threadId) : undefined;
      const activityAt = thread && thread.updatedAt > terminalAt ? thread.updatedAt : terminalAt;
      const now = new Date().toISOString();
      syncLingThreadForTerminalRun(input.store, run.id, now, activityAt);
      void this.reconcileTerminalRun(input.store, run.id, now).catch(() => undefined);
      return { status: "finalized", runId: run.id };
    }
    if (run.status !== "waiting_for_approval"
      || workUnit.status !== "waiting_for_approval"
      || workUnit.activeAttemptId !== attempt.id
      || attempt.status !== "lost"
      || attempt.errorCode !== "runtime_suspend") {
      return { status: "blocked", runId: run.id, reason: "approval_denial_state_mismatch" };
    }
    const now = new Date().toISOString();
    const terminal = input.store.commitApprovalResumeTerminal({
      kind: "suspended_approval_denied",
      checkpointId: checkpoint.id,
      expectedCheckpointRevision: checkpoint.revision,
      approvalId: input.approval.id,
      runId: run.id,
      workUnitId: workUnit.id,
      attemptId: attempt.id,
      reason: input.approval.decisionReason ?? "Approval denied the action.",
      now,
    });
    if (!terminal.ok) {
      return { status: "blocked", runId: run.id, reason: terminal.code };
    }
    const summaryPath = getRunSummaryPath(input.store.paths, run.id);
    writeTerminalSummary(summaryPath, {
      runId: run.id,
      status: "failed",
      taskId: run.taskId,
      eventCount: input.store.countEvents(run.id),
      startedAt: run.startedAt,
      endedAt: now,
      errorMessage: input.approval.decisionReason ?? "Approval denied the action.",
    });
    for (const event of terminal.controlPlaneEvents) this.options.controlPlaneEvents?.publish(event);
    this.publishRecoveredApprovalDecision(input.store, input.approval);
    syncLingThreadForTerminalRun(input.store, run.id, now);
    void this.reconcileTerminalRun(input.store, run.id, now).catch(() => undefined);
    return { status: "finalized", runId: run.id };
  }

  resumeAfterApproval(input: { readonly store: RunStore; readonly approval: ApprovalRequest }): ApprovalResumeStartResult {
    const checkpoint = input.store.getApprovalCheckpointForApproval(input.approval.id);
    if (!input.approval.runId || !checkpoint) {
      return { status: "not_applicable", reason: "approval_has_no_run_checkpoint" };
    }
    if (input.approval.status !== "approved") {
      return { status: "not_applicable", reason: `approval_${input.approval.status}` };
    }
    // Discovery and dispatcher guards are too late: this coordinator writes
    // decision events and claims replacement Attempts before dispatching.
    if (hasDelegationRecoveryOwner(input.store, input.approval.runId)) {
      return { status: "blocked", runId: input.approval.runId, reason: "delegation.authority_invalid" };
    }
    const existingActive = this.options.activeRuns.get(input.approval.runId);
    if (existingActive) {
      return { status: "already_active", runId: input.approval.runId, attemptId: existingActive.attemptId };
    }
    // Harness dispatch has a preflight window before ActiveRun registration.
    // The same startup scan visits approved then resume_pending; it must not
    // replace the just-claimed Attempt while that dispatch is still pending.
    if (this.harnessDispatches.has(input.approval.runId)) {
      return { status: "already_active", runId: input.approval.runId, attemptId: checkpoint.runnerResumeHandle?.attemptId };
    }
    const validated = validateResumeBasis(input.store, input.approval, checkpoint);
    if (!validated.ok) {
      this.failResume(input.store, checkpoint, validated.reason);
      return { status: "blocked", runId: input.approval.runId, reason: validated.reason };
    }
    try {
      ensureApprovedRunEvent(input.store, input.approval);
    } catch {
      // The durable approval is recoverable, but no side effect may begin
      // before its run-owned decision evidence can be recorded.
      return { status: "blocked", runId: input.approval.runId, reason: "approval_decision_event_unavailable" };
    }
    const { run, workUnit, priorAttempt } = validated;
    const runner = this.options.runnerRegistry.get(
      workUnit.effectiveRunnerId ?? workUnit.runnerId ?? priorAttempt.runnerId,
    );
    const resumeCapabilities = runner ? resolveRunnerResumeCapabilities(runner) : undefined;
    if (input.approval.payload.type !== "bash"
      || !resumeCapabilities?.hostApprovalContinuation.includes(input.approval.actionType)) {
      const reason = `approval_resume_unsupported:${input.approval.payload.type}`;
      this.failResume(input.store, checkpoint, reason);
      return { status: "blocked", runId: run.id, reason };
    }
    if (checkpoint.status === "resume_pending") {
      return this.recoverResumePending(input.store, input.approval, checkpoint, validated);
    }
    if (checkpoint.status !== "approved") {
      return { status: "not_applicable", reason: `checkpoint_${checkpoint.status}` };
    }
    if (run.status !== "waiting_for_approval" || workUnit.status !== "waiting_for_approval") {
      const reason = "approval_resume_state_mismatch";
      this.failResume(input.store, checkpoint, reason);
      return { status: "blocked", runId: run.id, reason };
    }
    const now = new Date().toISOString();
    const runtime = this.options.runtimeSupervisor.getRuntime(input.store.paths.cwd, input.store);
    let harnessPlan: ExistingRunContinuationPlan | undefined;
    if (readHarnessContinuationEnforced(run.requestSnapshot)) {
      const policySnapshot = readStoredEffectivePolicySnapshot(run.requestSnapshot);
      const execution = readStoredRunnerExecution(run);
      if (!runner || !policySnapshot || !execution) {
        const reason = "approval_resume_harness_source_incomplete";
        this.failResume(input.store, checkpoint, reason);
        return { status: "blocked", runId: run.id, reason };
      }
      try {
        harnessPlan = prepareExistingRunContinuationPlan({
          store: input.store,
          run,
          workUnit,
          sourceAttempt: priorAttempt,
          runtime,
          runner,
          origin: "approval_resume",
          policySnapshot,
          execution,
          workspaceCwd: input.store.paths.cwd,
          now,
          idempotencyDiscriminator: input.approval.id,
          approvalEvidence: [approvalReplayEvidence(input.approval, checkpoint)],
        });
      } catch (error) {
        const reason = `approval_resume_harness_prepare_failed:${formatError(error)}`;
        this.failResume(input.store, checkpoint, reason);
        return { status: "blocked", runId: run.id, reason };
      }
    }
    const attemptId = harnessPlan?.preparation.targetAttempt.id ?? createWorkUnitAttemptId();
    const claim = input.store.commitApprovalResumeClaim({
      checkpointId: checkpoint.id,
      expectedCheckpointStatus: "approved",
      expectedCheckpointRevision: checkpoint.revision,
      approvalId: input.approval.id,
      runId: run.id,
      workUnitId: workUnit.id,
      expectedActiveAttemptId: priorAttempt.id,
      attemptToLoseId: priorAttempt.id,
      ...(harnessPlan
        ? { continuationPreparation: harnessPlan.preparation }
        : { replacementAttempt: {
            id: attemptId,
            workUnitId: workUnit.id,
            attemptNumber: workUnit.attemptCount + 1,
            runtimeInstanceId: runtime.runtimeInstanceId,
            runnerId: priorAttempt.runnerId,
            requestedRunnerId: priorAttempt.requestedRunnerId,
            effectiveRunnerId: priorAttempt.effectiveRunnerId,
            fallbackReason: priorAttempt.fallbackReason,
            providerPresetId: priorAttempt.providerPresetId,
            now,
          } }),
      runnerResumeHandle: {
        kind: "ling_continuation",
        runnerId: workUnit.effectiveRunnerId ?? workUnit.runnerId,
        runId: run.id,
        attemptId,
        verified: true,
        payload: {
          schemaVersion: 1,
          approvalId: input.approval.id,
          resumeBasisFingerprint: checkpoint.resumeBasis?.fingerprint,
        },
      },
      mode: "activate_waiting",
      now,
    });
    if (!claim.ok) {
      return { status: "blocked", runId: run.id, reason: claim.code };
    }
    let harnessExecution: PreparedRunnerContinuationExecution | undefined;
    if (harnessPlan) {
      try {
        if (!claim.runnerContinuation) throw new Error("Approval resume continuation was not committed.");
        harnessExecution = materializeExistingRunContinuation(harnessPlan, {
          continuation: claim.runnerContinuation,
          attempt: claim.attempt,
          replayed: false,
        });
      } catch (error) {
        const reason = `approval_resume_harness_start_failed:${formatError(error)}`;
        this.failResume(input.store, claim.checkpoint, reason);
        return { status: "blocked", runId: run.id, reason };
      }
      return this.startClaimedHarnessAttempt(input.store, input.approval, claim, harnessExecution);
    }
    return this.startClaimedBashAttempt(input.store, input.approval, claim, harnessExecution);
  }

  private recoverResumePending(
    store: RunStore,
    approval: ApprovalRequest,
    checkpoint: LingApprovalCheckpoint,
    validated: Extract<ReturnType<typeof validateResumeBasis>, { ok: true }>,
  ): ApprovalResumeStartResult {
    const { run, workUnit, priorAttempt } = validated;
    const boundAttemptId = checkpoint.runnerResumeHandle?.attemptId;
    if (!boundAttemptId) {
      const reason = "approval_resume_handle_missing";
      this.failResume(store, checkpoint, reason);
      return { status: "blocked", runId: run.id, reason };
    }
    const boundAttempt = store.getWorkUnitAttempt(boundAttemptId);
    if (isTerminalRunStatus(run.status)) {
      if (run.workflowStepId) {
        finalizeOrchestratedWorkflowStepRun(store, run.workflowStepId, run.taskId, run, new Date().toISOString());
      }
      return { status: "not_applicable", reason: `run_${run.status}` };
    }
    if (!boundAttempt) {
      if (run.status !== "waiting_for_approval"
        || workUnit.status !== "waiting_for_approval"
        || workUnit.activeAttemptId !== priorAttempt.id) {
        const reason = "approval_resume_attempt_missing";
        this.failResume(store, checkpoint, reason);
        return { status: "blocked", runId: run.id, reason };
      }
      const runtime = this.options.runtimeSupervisor.getRuntime(store.paths.cwd, store);
      const repaired = store.commitApprovalResumeClaim({
        checkpointId: checkpoint.id,
        expectedCheckpointStatus: "resume_pending",
        expectedCheckpointRevision: checkpoint.revision,
        approvalId: approval.id,
        runId: run.id,
        workUnitId: workUnit.id,
        expectedActiveAttemptId: priorAttempt.id,
        attemptToLoseId: priorAttempt.id,
        replacementAttempt: replacementAttemptInput(boundAttemptId, workUnit, priorAttempt, runtime.runtimeInstanceId),
        runnerResumeHandle: checkpoint.runnerResumeHandle ?? lingContinuationHandle(approval, checkpoint, workUnit, boundAttemptId),
        mode: "activate_waiting",
        now: new Date().toISOString(),
      });
      if (!repaired.ok) return { status: "blocked", runId: run.id, reason: repaired.code };
      return this.startClaimedBashAttempt(store, approval, repaired);
    }

    const phase = readResumeToolPhase(store, run.id, approval, checkpoint, boundAttempt.id);
    const harnessEnforced = readHarnessContinuationEnforced(run.requestSnapshot);
    if (phase.toolEnd && !harnessEnforced) {
      const handled = readHandledToolResult(phase.toolEnd);
      if (!handled) {
        const reason = "approval_resume_result_invalid";
        this.failResume(store, checkpoint, reason);
        return { status: "blocked", runId: run.id, reason };
      }
      const completion = this.finishRun(
        { store, approval, checkpoint, run, workUnit, attempt: boundAttempt },
        handled.isError === true ? "failed" : "succeeded",
        handled.isError === true ? runtimeFailureCodeForHandledResult(handled) ?? "approval_resumed_action_failed" : undefined,
        handled,
      );
      this.options.activeRuns.trackCompletion(completion);
      return { status: "started", runId: run.id, attemptId: boundAttempt.id };
    }
    if (phase.toolStart && !phase.toolEnd) {
      const reason = "approval_resume_effect_unknown";
      this.failResume(store, checkpoint, reason);
      return { status: "blocked", runId: run.id, reason };
    }
    if ((run.status !== "running" && run.status !== "waiting_for_approval")
      || workUnit.status !== run.status
      || workUnit.activeAttemptId !== boundAttempt.id) {
      const reason = "approval_resume_state_mismatch";
      this.failResume(store, checkpoint, reason);
      return { status: "blocked", runId: run.id, reason };
    }

    if (harnessEnforced) {
      const runner = this.options.runnerRegistry.get(
        workUnit.effectiveRunnerId ?? workUnit.runnerId ?? boundAttempt.runnerId,
      );
      const policySnapshot = readStoredEffectivePolicySnapshot(run.requestSnapshot);
      const execution = readStoredRunnerExecution(run);
      if (!runner || !policySnapshot || !execution) {
        const reason = "approval_resume_harness_source_incomplete";
        this.failResume(store, checkpoint, reason);
        return { status: "blocked", runId: run.id, reason };
      }
      const runtime = this.options.runtimeSupervisor.getRuntime(store.paths.cwd, store);
      let plan: ExistingRunContinuationPlan;
      try {
        plan = prepareExistingRunContinuationPlan({
          store,
          run,
          workUnit,
          sourceAttempt: boundAttempt,
          runtime,
          runner,
          origin: "approval_resume",
          policySnapshot,
          execution,
          workspaceCwd: store.paths.cwd,
          now: new Date().toISOString(),
          idempotencyDiscriminator: approval.id,
          approvalEvidence: [approvalReplayEvidence(approval, checkpoint)],
        });
      } catch (error) {
        const reason = `approval_resume_harness_prepare_failed:${formatError(error)}`;
        this.failResume(store, checkpoint, reason);
        return { status: "blocked", runId: run.id, reason };
      }
      const now = new Date().toISOString();
      const replacement = store.commitApprovalResumeClaim({
        checkpointId: checkpoint.id,
        expectedCheckpointStatus: "resume_pending",
        expectedCheckpointRevision: checkpoint.revision,
        approvalId: approval.id,
        runId: run.id,
        workUnitId: workUnit.id,
        expectedActiveAttemptId: boundAttempt.id,
        attemptToLoseId: boundAttempt.id,
        continuationPreparation: plan.preparation,
        runnerResumeHandle: lingContinuationHandle(approval, checkpoint, workUnit, plan.preparation.targetAttempt.id),
        mode: run.status === "waiting_for_approval" ? "activate_waiting" : "replace_running",
        now,
      });
      if (!replacement.ok || !replacement.runnerContinuation) {
        return { status: "blocked", runId: run.id, reason: replacement.ok
          ? "approval_resume_continuation_missing"
          : replacement.code };
      }
      const harnessExecution = materializeExistingRunContinuation(plan, {
        continuation: replacement.runnerContinuation,
        attempt: replacement.attempt,
        replayed: false,
      });
      return this.startClaimedHarnessAttempt(store, approval, replacement, harnessExecution);
    }

    const runtime = this.options.runtimeSupervisor.getRuntime(store.paths.cwd, store);
    const attemptId = createWorkUnitAttemptId();
    const now = new Date().toISOString();
    const replacement = store.commitApprovalResumeClaim({
      checkpointId: checkpoint.id,
      expectedCheckpointStatus: "resume_pending",
      expectedCheckpointRevision: checkpoint.revision,
      approvalId: approval.id,
      runId: run.id,
      workUnitId: workUnit.id,
      expectedActiveAttemptId: boundAttempt.id,
      attemptToLoseId: boundAttempt.id,
      replacementAttempt: replacementAttemptInput(attemptId, workUnit, boundAttempt, runtime.runtimeInstanceId, now),
      runnerResumeHandle: lingContinuationHandle(approval, checkpoint, workUnit, attemptId),
      mode: run.status === "waiting_for_approval" ? "activate_waiting" : "replace_running",
      now,
    });
    if (!replacement.ok) return { status: "blocked", runId: run.id, reason: replacement.code };
    return this.startClaimedBashAttempt(store, approval, replacement);
  }

  private startClaimedHarnessAttempt(
    store: RunStore,
    approval: ApprovalRequest,
    claim: Extract<ReturnType<RunStore["commitApprovalResumeClaim"]>, { ok: true }>,
    execution: PreparedRunnerContinuationExecution,
  ): ApprovalResumeStartResult {
    for (const event of claim.controlPlaneEvents) this.options.controlPlaneEvents?.publish(event);
    if (!this.options.executeExistingRunContinuation) {
      const reason = "approval_resume_harness_dispatch_unavailable";
      this.failResume(store, claim.checkpoint, reason);
      return { status: "blocked", runId: claim.run.id, reason };
    }
    if (this.harnessDispatches.has(claim.run.id)) {
      return { status: "already_active", runId: claim.run.id, attemptId: claim.attempt.id };
    }
    this.harnessDispatches.add(claim.run.id);
    let completion: Promise<string | undefined>;
    try {
      completion = this.options.executeExistingRunContinuation({
        cwd: store.paths.cwd,
        runId: claim.run.id,
        approvalId: approval.id,
        preparedExecution: execution,
      });
    } catch (error) {
      this.harnessDispatches.delete(claim.run.id);
      const reason = `approval_resume_harness_dispatch_failed:${formatError(error)}`;
      this.failResume(store, claim.checkpoint, reason);
      return { status: "blocked", runId: claim.run.id, reason };
    }
    const settled = completion.then((runId) => {
      if (runId !== claim.run.id) {
        this.failResume(store, claim.checkpoint, "approval_resume_harness_dispatch_failed");
        return;
      }
      const currentUnit = store.getWorkUnit(claim.workUnit.id);
      if (currentUnit?.activeAttemptId !== claim.attempt.id || currentUnit.linkedRunId !== claim.run.id) return;
      // The dispatcher owns report/goal hooks. The coordinator still owns the
      // workflow obligation after an approval continuation, for every terminal
      // outcome; a second approval/question yield remains non-terminal.
      this.finalizeTerminalWorkflow(store, claim.run.id, new Date().toISOString());
    }, (error) => {
      this.failResume(store, claim.checkpoint, `approval_resume_harness_dispatch_failed:${formatError(error)}`);
    }).finally(() => {
      this.harnessDispatches.delete(claim.run.id);
    });
    this.options.activeRuns.trackCompletion(settled);
    return { status: "started", runId: claim.run.id, attemptId: claim.attempt.id };
  }

  private startClaimedBashAttempt(
    store: RunStore,
    approval: ApprovalRequest,
    claim: Extract<ReturnType<RunStore["commitApprovalResumeClaim"]>, { ok: true }>,
    harnessExecution?: PreparedRunnerContinuationExecution,
  ): ApprovalResumeStartResult {
    for (const event of claim.controlPlaneEvents) this.options.controlPlaneEvents?.publish(event);
    const abortController = new AbortController();
    const completion = Promise.resolve().then(() => this.executeBashResume({
      store,
      approval,
      checkpoint: claim.checkpoint,
      run: claim.run,
      workUnit: claim.workUnit,
      attempt: claim.attempt,
      abortController,
      harnessExecution,
    })).finally(() => {
      if (this.options.activeRuns.get(claim.run.id)?.attemptId === claim.attempt.id) this.options.activeRuns.delete(claim.run.id);
    });
    this.options.activeRuns.add(claim.run.id, {
      abortController,
      runtimeShutdownPolicy: "stop_without_resume",
      streamEnvelope: () => undefined,
      completion,
      runtimeInstanceId: claim.attempt.runtimeInstanceId,
      workUnitId: claim.workUnit.id,
      attemptId: claim.attempt.id,
      fencingToken: claim.attempt.fencingToken,
    });
    return { status: "started", runId: claim.run.id, attemptId: claim.attempt.id };
  }

  private async executeBashResume(input: {
    readonly store: RunStore;
    readonly approval: ApprovalRequest;
    readonly checkpoint: LingApprovalCheckpoint;
    readonly run: RunSession;
    readonly workUnit: WorkUnit;
    readonly attempt: WorkUnitAttempt;
    readonly abortController: AbortController;
    readonly harnessExecution?: PreparedRunnerContinuationExecution;
  }): Promise<void> {
    const payload = input.approval.payload;
    if (payload.type !== "bash") return;
    const sourceFence = Object.freeze(toRuntimeAttemptFence(input.attempt));
    const append: RunEventEmitter = <K extends Parameters<RunStore["appendEvent"]>[1]>(
      type: K,
      data: RunEventDataByType[K],
    ): RunEventEnvelope => {
      const envelope = input.store.appendExecutionEvent(input.run.id, sourceFence, type, data);
      syncWorkUnitForRunEvent(input.store, input.workUnit.id, input.attempt.id, type, envelope);
      appendRuntimeProgressForRunEvent(input.store, input.workUnit.id, input.attempt.id, type, envelope);
      syncLingThreadForRunEvent(input.store, input.run, type, envelope);
      return envelope;
    };
    try {
      const task = readTaskSnapshot(input.run);
      const preparedConcurrency = prepareRunConcurrency({
        store: input.store,
        runRequest: {
          cwd: payload.cwd,
          task,
          tools: ["bash"],
        },
        runId: input.run.id,
        workUnit: input.workUnit,
        attempt: input.attempt,
        now: new Date().toISOString(),
      });
      acquireRunRuntimeSemaphores({
        store: input.store,
        workUnit: input.workUnit,
        attempt: input.attempt,
        channel: preparedConcurrency.channel,
        providerKey: "approval-resume-local-bash",
        runnerId: input.workUnit.effectiveRunnerId ?? input.workUnit.runnerId,
        now: new Date().toISOString(),
      });
      const request: PiRunnerApprovalRequest = {
        toolCallId: input.approval.toolCallId ?? input.checkpoint.resumeBasis?.toolCallId ?? "approval_resume_tool",
        toolName: "bash",
        input: {
          command: payload.command,
          cwd: payload.cwd,
          timeoutMs: payload.exec?.timeoutMs,
          idleTimeoutMs: payload.exec?.idleTimeoutMs,
          pty: payload.exec?.pty,
        },
        task,
        cwd: payload.cwd,
        defaultApproval: "allow",
      };
      const workflowStep = input.run.workflowStepId
        ? input.store.getChannelWorkflowStep(input.run.workflowStepId)
        : undefined;
      const bindingRejection = workflowExactCommandBindingRejection({
        bindings: workflowStep ? workflowStepExecutionOperationBindings(workflowStep) : undefined,
        request,
      });
      const restrictedCommandRuntime = this.options.runtimeSupervisor.getRestrictedCommandRuntime();
      const effectRejection = workflowOperationEffectRejection({ store: input.store, run: input.run, request, restrictedCommandRuntime });
      if (effectRejection) {
        this.failResume(input.store, input.checkpoint, effectRejection.code + ":" + effectRejection.reason);
        return;
      }
      if (bindingRejection) {
        this.failResume(input.store, input.checkpoint, `approval_resume_tool_mismatch:${bindingRejection}`);
        return;
      }
      if (input.abortController.signal.aborted) {
        throw input.abortController.signal.reason ?? new Error("approval_resume_suspended_before_tool_start");
      }
      append("tool_start", {
        type: "tool_start",
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        args: request.input,
        resumedFromApprovalId: input.approval.id,
        attemptId: input.attempt.id,
      });
      const handled = await executeHarnessedBashTool({
        mode: harnessToolBrokerModeForRun(input.run),
        restrictedCommandRuntime,
        store: input.store,
        sourceFence,
        run: input.run,
        request,
        approvalId: input.approval.id,
        appendAndMaybeStream: (type, data) => append(type, data),
        signal: input.abortController.signal,
      });
      append("tool_end", {
        type: "tool_end",
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        result: handled,
        isError: handled.isError === true,
        resumedFromApprovalId: input.approval.id,
        attemptId: input.attempt.id,
      });
      if (handled.isError === true) {
        await this.finishRun(
          input,
          "failed",
          runtimeFailureCodeForHandledResult(handled) ?? "approval_resumed_action_failed",
          handled,
        );
        return;
      }
      append("result", {
        taskId: input.run.taskId,
        messageCount: 1,
        runnerEventCount: 2,
        resumedFromApprovalId: input.approval.id,
      });
      await this.finishRun(input, "succeeded", undefined, handled);
    } catch (error) {
      if (!input.store.isCurrentRunExecutionOwner(input.run.id, sourceFence, true)) {
        auditIgnoredRunnerCompletion({ ...input, reportedStatus: "failed" });
        return;
      }
      const stopIntent = this.options.activeRuns.getStopIntent(input.run.id)
        ?? readStopIntent(input.abortController.signal.reason);
      const phase = readResumeToolPhase(input.store, input.run.id, input.approval, input.checkpoint, input.attempt.id);
      if (phase.toolStart && !phase.toolEnd) {
        this.failResume(input.store, input.checkpoint, "approval_resume_effect_unknown");
        return;
      }
      if (stopIntent?.kind === "runtime_suspend") {
        this.suspendAttemptBeforeToolStart(input, stopIntent.cause);
        return;
      }
      const reason = stopIntent?.kind === "runtime_failure"
        ? stopIntent.code
        : input.abortController.signal.aborted
          ? "approval_resume_interrupted"
          : `approval_resume_failed:${formatError(error)}`;
      await this.finishRun(input, "failed", reason);
    }
  }

  private suspendAttemptBeforeToolStart(
    input: {
      readonly store: RunStore;
      readonly approval: ApprovalRequest;
      readonly checkpoint: LingApprovalCheckpoint;
      readonly run: RunSession;
      readonly workUnit: WorkUnit;
      readonly attempt: WorkUnitAttempt;
      readonly harnessExecution?: PreparedRunnerContinuationExecution;
    },
    cause: string,
  ): void {
    const now = new Date().toISOString();
    const latestCheckpoint = input.store.getApprovalCheckpoint(input.checkpoint.id);
    if (!latestCheckpoint || latestCheckpoint.status !== "resume_pending") return;
    const suspended = input.store.commitApprovalResumeSuspension({
      kind: "resume_pre_dispatch",
      checkpointId: latestCheckpoint.id,
      expectedCheckpointStatus: "resume_pending",
      expectedCheckpointRevision: latestCheckpoint.revision,
      approvalId: input.approval.id,
      runId: input.run.id,
      expectedRunStatus: "running",
      workUnitId: input.workUnit.id,
      expectedWorkUnitStatus: "running",
      attemptId: input.attempt.id,
      cause,
      now,
    });
    if (!suspended.ok) return;
    if (input.harnessExecution && input.harnessExecution.continuation.state === "running") {
      finishPreparedRunnerContinuation({
        store: input.store,
        execution: input.harnessExecution,
        nextState: "recovery_pending",
        now,
      });
    }
    for (const event of suspended.controlPlaneEvents) this.options.controlPlaneEvents?.publish(event);
  }

  private async finishRun(
    input: {
      readonly store: RunStore;
      readonly approval: ApprovalRequest;
      readonly checkpoint: LingApprovalCheckpoint;
      readonly run: RunSession;
      readonly workUnit: WorkUnit;
      readonly attempt: WorkUnitAttempt;
      readonly harnessExecution?: PreparedRunnerContinuationExecution;
    },
    status: "succeeded" | "failed",
    errorCode?: string,
    handledResult?: PiRunnerToolHandledResult,
  ): Promise<void> {
    const now = new Date().toISOString();
    const message = errorCode ?? null;
    const summaryPath = getRunSummaryPath(input.store.paths, input.run.id);
    const currentRun = input.store.getRun(input.run.id);
    const latestCheckpoint = input.store.getApprovalCheckpoint(input.checkpoint.id);
    const currentWorkUnit = input.store.getWorkUnit(input.workUnit.id);
    if (!currentRun
      || currentRun.status !== "running"
      || !latestCheckpoint
      || latestCheckpoint.status !== "resume_pending"
      || !currentWorkUnit
      || currentWorkUnit.status !== "running"
      || currentWorkUnit.activeAttemptId !== input.attempt.id) {
      auditIgnoredRunnerCompletion({ ...input, reportedStatus: status, now });
      return;
    }
    const terminal = input.store.commitApprovalResumeTerminal({
      kind: "verified_lineage",
      checkpointId: latestCheckpoint.id,
      expectedCheckpointStatus: "resume_pending",
      expectedCheckpointRevision: latestCheckpoint.revision,
      approvalId: input.approval.id,
      runId: currentRun.id,
      expectedRunStatus: "running",
      workUnitId: currentWorkUnit.id,
      expectedWorkUnitStatus: "running",
      attemptId: input.attempt.id,
      status,
      attemptStatus: status,
      checkpointStatus: handledResult ? "resumed" : status === "succeeded" ? "resumed" : "resume_failed",
      errorCode,
      errorMessage: message ?? undefined,
      summaryPath,
      now,
    });
    if (!terminal.ok) {
      auditIgnoredRunnerCompletion({ ...input, reportedStatus: status, now });
      return;
    }
    if (input.harnessExecution && input.harnessExecution.continuation.state === "running") {
      finishPreparedRunnerContinuation({
        store: input.store,
        execution: input.harnessExecution,
        nextState: status,
        now,
      });
    }
    writeTerminalSummary(summaryPath, {
      runId: input.run.id, status, taskId: input.run.taskId,
      eventCount: input.store.countEvents(input.run.id), messageCount: handledResult ? 1 : 0,
      startedAt: input.run.startedAt, endedAt: now, errorMessage: message,
    });
    for (const event of terminal.controlPlaneEvents) this.options.controlPlaneEvents?.publish(event);
    syncLingThreadForTerminalRun(input.store, input.run.id, now);
    await this.reconcileTerminalRun(input.store, input.run.id, now);
  }

  private failResume(store: RunStore, checkpoint: LingApprovalCheckpoint, reason: string): void {
    const latest = store.getApprovalCheckpoint(checkpoint.id);
    if (!latest || latest.status === "resume_failed" || latest.status === "resumed") return;
    if (latest.status !== "approved" && latest.status !== "resume_pending") return;
    const now = new Date().toISOString();
    const lineage = readCurrentResumeLineage(store, latest);
    if (!lineage) {
      const quarantined = store.commitApprovalResumeTerminal({
        kind: "checkpoint_quarantine",
        checkpointId: latest.id,
        expectedCheckpointStatus: latest.status,
        expectedCheckpointRevision: latest.revision,
        approvalId: latest.approvalId,
        errorCode: reason.split(":", 1)[0],
        errorMessage: reason,
        now,
      });
      if (quarantined.ok) {
        for (const event of quarantined.controlPlaneEvents) this.options.controlPlaneEvents?.publish(event);
      }
      return;
    }
    const summaryPath = getRunSummaryPath(store.paths, lineage.run.id);
    const terminal = store.commitApprovalResumeTerminal({
      kind: "verified_lineage",
      checkpointId: latest.id,
      expectedCheckpointStatus: latest.status,
      expectedCheckpointRevision: latest.revision,
      approvalId: latest.approvalId,
      runId: lineage.run.id,
      expectedRunStatus: lineage.runStatus,
      workUnitId: lineage.workUnit.id,
      expectedWorkUnitStatus: lineage.workUnitStatus,
      attemptId: lineage.attempt.id,
      status: "failed",
      attemptStatus: lineage.attempt.status === "lost" || reason === "approval_resume_effect_unknown" ? "lost" : "failed",
      checkpointStatus: "resume_failed",
      errorCode: reason.split(":", 1)[0],
      errorMessage: reason,
      summaryPath,
      now,
    });
    if (!terminal.ok) return;
    writeTerminalSummary(summaryPath, {
      runId: lineage.run.id, status: "failed", taskId: lineage.run.taskId,
      eventCount: store.countEvents(lineage.run.id), startedAt: lineage.run.startedAt,
      endedAt: now, errorMessage: reason,
    });
    for (const event of terminal.controlPlaneEvents) this.options.controlPlaneEvents?.publish(event);
    syncLingThreadForTerminalRun(store, lineage.run.id, now);
    void this.reconcileTerminalRun(store, lineage.run.id, now).catch(() => undefined);
  }

  private async reconcileTerminalRun(store: RunStore, runId: string, now: string): Promise<void> {
    const terminalRun = this.finalizeTerminalWorkflow(store, runId, now);
    if (!terminalRun) return;
    await this.options.afterRunTerminal?.(terminalRun);
  }

  private finalizeTerminalWorkflow(store: RunStore, runId: string, now: string): RunSession | undefined {
    const terminalRun = store.getRun(runId);
    if (!terminalRun || !isTerminalRunStatus(terminalRun.status)) return undefined;
    if (terminalRun.workflowStepId) {
      finalizeOrchestratedWorkflowStepRun(
        store,
        terminalRun.workflowStepId,
        terminalRun.taskId,
        terminalRun,
        now,
      );
    }
    return terminalRun;
  }

  private publishRecoveredApprovalDecision(store: RunStore, approval: ApprovalRequest): void {
    ensureRunDecisionEvent(store, approval);
  }
}

function hasDelegationRecoveryOwner(store: RunStore, runId: string | undefined): boolean {
  const run = runId ? store.getRun(runId) : undefined;
  return Boolean(run?.workUnitId && store.getWorkUnit(run.workUnitId)?.ownerType === "delegation_step");
}

function ensureApprovedRunEvent(store: RunStore, approval: ApprovalRequest): void {
  ensureRunDecisionEvent(store, approval);
}

function ensureRunDecisionEvent(store: RunStore, approval: ApprovalRequest): void {
  if (!approval.runId) return;
  const eventType = approval.status === "approved" ? "approval_approved"
    : approval.status === "denied" ? "approval_denied" : undefined;
  if (!eventType) return;
  let afterSeq = 0;
  for (;;) {
    const page = store.listEvents(approval.runId, { afterSeq, limit: 1000 });
    if (page.some((event) => event.type === eventType
      && typeof event.data === "object"
      && event.data !== null
      && "approvalId" in event.data
      && event.data.approvalId === approval.id)) return;
    const latestSeq = page.at(-1)?.seq;
    if (page.length < 1000 || latestSeq === undefined || latestSeq <= afterSeq) break;
    afterSeq = latestSeq;
  }
  appendApprovalDecisionEvent(store, approval);
}

function validateResumeBasis(
  store: RunStore,
  approval: ApprovalRequest,
  checkpoint: LingApprovalCheckpoint,
):
  | { readonly ok: true; readonly run: RunSession; readonly workUnit: WorkUnit; readonly priorAttempt: WorkUnitAttempt }
  | { readonly ok: false; readonly reason: string } {
  const basis = checkpoint.resumeBasis;
  if (!basis) return { ok: false, reason: "approval_resume_checkpoint_missing" };
  const run = store.getRun(basis.runId);
  const workUnit = store.getWorkUnit(basis.workUnitId);
  const priorAttempt = store.getWorkUnitAttempt(basis.priorAttemptId);
  if (basis.approvalId !== approval.id || basis.runId !== approval.runId || checkpoint.approvalId !== approval.id) {
    return { ok: false, reason: "approval_resume_owner_mismatch" };
  }
  if (!approval.toolCallId || basis.toolCallId !== approval.toolCallId || basis.actionType !== approval.actionType) {
    return { ok: false, reason: "approval_resume_tool_mismatch" };
  }
  const sideEffectFingerprint = approvalSideEffectFingerprintV1({
    actionType: approval.actionType,
    toolCallId: approval.toolCallId,
    sideEffect: approval.payload,
  });
  if (basis.sideEffectFingerprint !== sideEffectFingerprint) {
    return { ok: false, reason: "approval_resume_mismatch" };
  }
  if (!run || !workUnit || !priorAttempt || run.workUnitId !== workUnit.id || priorAttempt.workUnitId !== workUnit.id) {
    return { ok: false, reason: "approval_resume_lineage_missing" };
  }
  if (basis.workflowStepId) {
    const step = store.getChannelWorkflowStep(basis.workflowStepId);
    if (run.workflowStepId !== basis.workflowStepId
      || step?.runId !== run.id
      || step.metadata?.delegatedRequirement?.fingerprint !== basis.delegatedRequirementFingerprint) {
      return { ok: false, reason: "approval_resume_requirement_mismatch" };
    }
  }
  return { ok: true, run, workUnit, priorAttempt };
}

function approvalReplayEvidence(
  approval: ApprovalRequest,
  checkpoint: LingApprovalCheckpoint,
) {
  const basis = checkpoint.resumeBasis;
  if (!basis || approval.status !== "approved") {
    throw new Error("Approval replay evidence is incomplete.");
  }
  const sideEffectFingerprint = approvalSideEffectFingerprintV1({
    actionType: approval.actionType,
    toolCallId: approval.toolCallId ?? "",
    sideEffect: approval.payload,
  });
  if (!approval.toolCallId || basis.sideEffectFingerprint !== sideEffectFingerprint) {
    throw new Error("Approval replay evidence does not match its durable resume basis.");
  }
  return {
    approvalId: approval.id,
    decision: "approved" as const,
    sideEffectFingerprint,
  };
}

function readCurrentResumeLineage(
  store: RunStore,
  checkpoint: LingApprovalCheckpoint,
): {
  readonly run: RunSession;
  readonly runStatus: "running" | "waiting_for_approval";
  readonly workUnit: WorkUnit;
  readonly workUnitStatus: "running" | "waiting_for_approval";
  readonly attempt: WorkUnitAttempt;
} | undefined {
  const basis = checkpoint.resumeBasis;
  const runId = checkpoint.runId ?? basis?.runId;
  if (!basis || !runId || basis.runId !== runId) return undefined;
  const run = store.getRun(runId);
  const workUnit = store.getWorkUnit(basis.workUnitId);
  if (!run
    || !workUnit
    || run.workUnitId !== workUnit.id
    || (run.status !== "running" && run.status !== "waiting_for_approval")
    || (workUnit.status !== "running" && workUnit.status !== "waiting_for_approval")) {
    return undefined;
  }
  const attemptId = workUnit.activeAttemptId
    ?? checkpoint.runnerResumeHandle?.attemptId
    ?? basis.priorAttemptId;
  const attempt = attemptId ? store.getWorkUnitAttempt(attemptId) : undefined;
  if (!attempt || attempt.workUnitId !== workUnit.id || workUnit.activeAttemptId !== attempt.id) return undefined;
  return {
    run,
    runStatus: run.status,
    workUnit,
    workUnitStatus: workUnit.status,
    attempt,
  };
}

function replacementAttemptInput(
  attemptId: string,
  workUnit: WorkUnit,
  priorAttempt: WorkUnitAttempt,
  runtimeInstanceId: string,
  now = new Date().toISOString(),
) {
  return {
    id: attemptId,
    workUnitId: workUnit.id,
    attemptNumber: workUnit.attemptCount + 1,
    runtimeInstanceId,
    runnerId: priorAttempt.runnerId,
    requestedRunnerId: priorAttempt.requestedRunnerId,
    effectiveRunnerId: priorAttempt.effectiveRunnerId,
    fallbackReason: priorAttempt.fallbackReason,
    providerPresetId: priorAttempt.providerPresetId,
    now,
  };
}

function lingContinuationHandle(
  approval: ApprovalRequest,
  checkpoint: LingApprovalCheckpoint,
  workUnit: WorkUnit,
  attemptId: string,
) {
  return {
    kind: "ling_continuation" as const,
    runnerId: workUnit.effectiveRunnerId ?? workUnit.runnerId,
    runId: approval.runId,
    attemptId,
    verified: true,
    payload: {
      schemaVersion: 1,
      approvalId: approval.id,
      resumeBasisFingerprint: checkpoint.resumeBasis?.fingerprint,
    },
  };
}

function readResumeToolPhase(
  store: RunStore,
  runId: string,
  approval: ApprovalRequest,
  checkpoint: LingApprovalCheckpoint,
  attemptId: string,
): { readonly toolStart?: RunEventEnvelope; readonly toolEnd?: RunEventEnvelope } {
  let afterSeq = 0;
  let toolStart: RunEventEnvelope | undefined;
  let toolEnd: RunEventEnvelope | undefined;
  while (true) {
    const page = store.listEvents(runId, { afterSeq, limit: 1_000 });
    for (const event of page) {
      if (!isMatchingResumeToolEvent(event, approval, checkpoint, attemptId)) continue;
      if (event.type === "tool_start") toolStart = event;
      if (event.type === "tool_end") toolEnd = event;
    }
    if (page.length < 1_000) break;
    afterSeq = page.at(-1)?.seq ?? afterSeq;
  }
  return { toolStart, toolEnd };
}

function isMatchingResumeToolEvent(
  event: RunEventEnvelope,
  approval: ApprovalRequest,
  checkpoint: LingApprovalCheckpoint,
  attemptId: string,
): boolean {
  if ((event.type !== "tool_start" && event.type !== "tool_end") || !isRecord(event.data)) return false;
  return event.data.attemptId === attemptId
    && event.data.resumedFromApprovalId === approval.id
    && event.data.toolCallId === (approval.toolCallId ?? checkpoint.resumeBasis?.toolCallId);
}

function readHandledToolResult(event: RunEventEnvelope): PiRunnerToolHandledResult | undefined {
  if (!isRecord(event.data) || !isRecord(event.data.result) || !Array.isArray(event.data.result.content)) {
    return undefined;
  }
  return event.data.result as unknown as PiRunnerToolHandledResult;
}

function runtimeFailureCodeForHandledResult(
  handled: PiRunnerToolHandledResult,
): "hard_timeout" | undefined {
  if (!isRecord(handled.details) || !isRecord(handled.details.unifiedExec)) return undefined;
  return handled.details.unifiedExec.timedOut === true ? "hard_timeout" : undefined;
}

function readStopIntent(value: unknown): import("../../runtime/active-runs.js").ActiveRunStopIntentV1 | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "runtime_suspend"
    && (value.cause === "daemon_restart" || value.cause === "desktop_quit" || value.cause === "process_signal")
    && typeof value.runtimeInstanceId === "string") {
    return value as unknown as import("../../runtime/active-runs.js").ActiveRunStopIntentV1;
  }
  if (value.kind === "runtime_failure"
    && (value.code === "idle_timeout" || value.code === "hard_timeout" || value.code === "runner_crash")
    && typeof value.reason === "string") {
    return value as unknown as import("../../runtime/active-runs.js").ActiveRunStopIntentV1;
  }
  if (value.kind === "user_cancel" || value.kind === "workflow_cancel") {
    return value as unknown as import("../../runtime/active-runs.js").ActiveRunStopIntentV1;
  }
  return undefined;
}

function isTerminalRunStatus(status: RunSession["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function readHarnessContinuationEnforced(value: unknown): boolean {
  return isRecord(value)
    && isRecord(value.harnessFeatureSnapshot)
    && value.harnessFeatureSnapshot.continuations === "enforce";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readTaskSnapshot(run: RunSession): PiRunnerApprovalRequest["task"] {
  const record = run.taskSnapshot && typeof run.taskSnapshot === "object" && !Array.isArray(run.taskSnapshot)
    ? run.taskSnapshot as Record<string, unknown>
    : {};
  return {
    id: typeof record.id === "string" && record.id ? record.id : run.taskId,
    title: typeof record.title === "string" && record.title ? record.title : run.taskId,
    prompt: typeof record.prompt === "string" ? record.prompt : "Resume the approved operation.",
    channelId: typeof record.channelId === "string" ? record.channelId : run.channelId,
  };
}
