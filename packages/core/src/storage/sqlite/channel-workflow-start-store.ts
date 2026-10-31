import type { RunSession, RunStore } from "../../run-types.js";
import type { WorkUnit, WorkUnitAttempt } from "../../runtime-supervisor-types.js";
import { delegatedStepFinalizationBasisFingerprintV1, isDelegatedStepRequirementV1, type DelegatedOutcomeV1 } from "@ling-stack/contracts";
import { transitionWorkflow, transitionWorkflowStep } from "../../state-machines.js";
import { inspectWorkflowPreApproval, isWorkflowPreGateExecutionPermitV1, workflowStepNewStartMetadata } from "../../workflow-pre-gate.js";
import {
  classifyWorkflowStepStartOwner, workflowStepStartAuthorityBasis, workflowStepStartOwnerMatches,
  type BeginChannelWorkflowStepStartInput, type BeginChannelWorkflowStepStartResult,
  type WorkflowStepStartCommitInput, type WorkflowStepStartCommitResult,
  type WorkflowStepStartFailureInput, type WorkflowStepStartOwnerV1, type WorkflowStepStartReadStore,
  type WorkflowStepPostApprovalInput, type WorkflowStepPostApprovalResult,
  type WorkflowStepPostApprovalResolvedInput,
} from "../../workflow-step-start-owner.js";
import type { ChannelWorkflow, ChannelWorkflowStep, ChannelWorkflowStepMetadata, Task } from "../../workspace-types.js";
import { stringifyJson } from "./helpers.js";
import { workflowHasUnresolvedApprovalWait } from "./channel-workflow-pre-approval-store.js";
import type { SqliteStoreContext } from "./store-context.js";

type Ports = WorkflowStepStartReadStore & Pick<RunStore, "createTask" | "transitionTaskStatus" | "recordStateTransitionEvent" | "releaseResourceLease" | "listChannelWorkflowSteps" | "getWorkUnit" | "getWorkUnitAttempt" | "getApprovalRequest" | "createApprovalRequest">;

/** Synchronous SQLite transactions only. No provider, permission or filesystem await under lock. */
export class SqliteChannelWorkflowStartStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports) {}

  beginChannelWorkflowStepStart(input: BeginChannelWorkflowStepStartInput): BeginChannelWorkflowStepStartResult {
    return this.transaction(() => {
      const step = this.ports.getChannelWorkflowStep(input.workflowStepId);
      if (!step || !sameExpected(step, input.expected)) return { status: "stale", code: "workflow_start_basis_stale" };
      const workflow = this.ports.getChannelWorkflow(step.workflowId);
      const authorityBasis = workflowStepStartAuthorityBasis(this.ports, step);
      if (!workflow || !authorityBasis || !this.validLease(step, input.leaseId, input.now)
        || input.executionPermit !== undefined && (!isWorkflowPreGateExecutionPermitV1(input.executionPermit)
          || input.executionPermit.mode !== (input.createTaskOnly ? "create_task" : "create_and_run_task")
          || input.executionPermit.taskTitle !== input.task.title
          || input.executionPermit.taskPrompt !== input.task.prompt
          || input.executionPermit.assigneeTeammateId !== input.task.assigneeTeammateId)
        || !["queued", "blocked", "claimed", "running"].includes(step.status)
        || step.status === "running" && (step.taskId !== undefined || step.runId !== undefined)
        || input.task.channelId !== step.channelId || input.task.assigneeTeammateId !== step.toParticipantId
        || !dependenciesComplete(this.ports, step)
        || input.createTaskOnly && Boolean(step.metadata?.executionPlan || step.metadata?.delegatedRequirement)) {
        return { status: "invalid", code: "workflow_start_not_permitted" };
      }
      const preApproval = inspectWorkflowPreApproval(this.ports, step, input.now, input.executionPermit);
      if (preApproval.status !== "not_required" && !input.executionPermit) {
        return { status: "invalid", code: "workflow_pre_approval_required" };
      }
      if (preApproval.status === "required" || preApproval.status === "pending") {
        return { status: "invalid", code: "workflow_pre_approval_required" };
      }
      if (preApproval.status === "stale" || preApproval.status === "blocked") {
        return { status: "invalid", code: preApproval.code };
      }
      if (!this.startWorkflow(workflow, input.now) || !this.startStep(step, input.now)) {
        // Throwing rolls the whole start back, including any earlier audit transition.
        throw new Error("Workflow start transition changed while beginning its owner");
      }
      const task = this.ports.createTask(input.task, input.now);
      const owner: WorkflowStepStartOwnerV1 = { schemaVersion: 1, taskId: task.id, leaseId: input.leaseId, phase: "preparing", authorityBasis };
      const { activeGateStage, ...definitionMetadata } = workflowStepNewStartMetadata(step.metadata);
      const startMetadata: ChannelWorkflowStepMetadata = { ...definitionMetadata,
        ...(preApproval.status === "approved"
          ? { preStepApprovalMarker: { basis: preApproval.basis, consumedByTaskId: task.id } }
          : {}),
        ...(input.fanInContextReviews ? { fanInContextReviews: input.fanInContextReviews } : {}) };
      const metadata: ChannelWorkflowStepMetadata = { ...startMetadata, startOwner: owner };
      this.context.database.prepare(`UPDATE channel_workflow_steps
        SET task_id=?, run_id=NULL, blocker=NULL, result_summary=NULL, metadata_json=?, updated_at=? WHERE id=?`)
        .run(task.id, stringifyJson(metadata), input.now, step.id);
      if (input.createTaskOnly) {
        this.stepTransition({ ...step, status: "running" }, "succeed", input.now, `task:${task.id}`);
        this.ports.releaseResourceLease(input.leaseId, "workflow_step", step.id, input.now);
        this.context.database.prepare("UPDATE channel_workflow_steps SET metadata_json=?, result_summary=? WHERE id=?")
          .run(stringifyJson(startMetadata), "Task created from workflow step.", step.id);
      }
      return { status: "begun", task, owner };
    });
  }

  commitChannelWorkflowStepRunReady(input: WorkflowStepStartCommitInput): WorkflowStepStartCommitResult {
    return this.transaction(() => {
      const step = this.ports.getChannelWorkflowStep(input.workflowStepId);
      const owner = step?.metadata?.startOwner;
      const workflow = step && this.ports.getChannelWorkflow(step.workflowId);
      if (!step || !workflow || !workflowStepStartOwnerMatches(owner, input.owner)
        || step.taskId !== input.owner.taskId || step.status !== "running"
        || !["running", "waiting_for_approval", "blocked"].includes(workflow.status)
        || workflowStepStartAuthorityBasis(this.ports, step) !== input.owner.authorityBasis
        || !this.validLease(step, input.owner.leaseId, input.now)) return { status: "stale", code: "workflow_start_owner_stale" };
      const run = this.ports.getRun(input.runId);
      const task = this.ports.getTask(input.owner.taskId);
      const unit = run?.workUnitId ? this.ports.getWorkUnit(run.workUnitId) : undefined;
      const attempt = unit?.activeAttemptId ? this.ports.getWorkUnitAttempt(unit.activeAttemptId) : undefined;
      const claimQueuedTask = input.claimQueuedTask === true && task?.status === "todo"
        && run && unit && attempt && validQueuedTaskHandoff(step, task, run, unit, attempt);
      if (!run || !task || run.taskId !== task.id || run.workflowStepId !== step.id
        || run.channelId !== step.channelId || run.teammateId !== step.toParticipantId
        || task.channelId !== step.channelId || task.assigneeTeammateId !== step.toParticipantId
        || !["claimed", "running", "waiting_for_approval"].includes(task.status) && !claimQueuedTask
        || task.currentRunId !== undefined && task.currentRunId !== run.id
        || !["queued", "running", "waiting_for_approval"].includes(run.status)
        || !unit || unit.linkedRunId !== run.id || unit.taskId !== task.id || !attempt || attempt.workUnitId !== unit.id) {
        return { status: "invalid", code: "workflow_start_run_lineage_invalid" };
      }
      if (owner?.phase === "linked") return step.runId === run.id && task.currentRunId === run.id
        ? { status: "duplicate" } : { status: "stale", code: "workflow_start_run_stale" };
      if (owner?.phase !== "preparing" || step.runId) return { status: "stale", code: "workflow_start_run_stale" };
      if (task.currentRunId || this.context.database.prepare("SELECT id FROM run_sessions WHERE task_id=? AND id<>? LIMIT 1").get(task.id, run.id)) {
        return { status: "stale", code: "workflow_start_task_run_stale" };
      }
      if (claimQueuedTask) {
        const claimed = this.ports.transitionTaskStatus({ taskId: task.id, expectedStatus: "todo", event: "claim",
          actor: "system", reason: `run:${run.id}`, now: input.now });
        if (!claimed.ok) throw new Error("Workflow queued Task claim ownership changed");
      }
      // Ready owns both links. No caller may pre-link a Task and leave a
      // preparing Step, or win a stale ready callback by taking another Run.
      const linkedTask = this.context.database.prepare("UPDATE tasks SET current_run_id=?, updated_at=? WHERE id=? AND current_run_id IS NULL")
        .run(run.id, input.now, task.id);
      if (Number(linkedTask.changes) !== 1) throw new Error("Workflow ready Task ownership changed");
      this.context.database.prepare("UPDATE channel_workflow_steps SET run_id=?, metadata_json=?, updated_at=? WHERE id=?")
        .run(run.id, stringifyJson({ ...step.metadata, startOwner: { ...owner, phase: "linked" } }), input.now, step.id);
      return { status: "linked" };
    });
  }

  settleChannelWorkflowStepStartFailure(input: WorkflowStepStartFailureInput): WorkflowStepStartCommitResult {
    return this.transaction(() => {
      const step = this.ports.getChannelWorkflowStep(input.workflowStepId);
      const workflow = step && this.ports.getChannelWorkflow(step.workflowId);
      const mode = input.mode ?? "start_failure";
      if (!step || !workflow || !["draft", "ready", "running", "blocked", "waiting_for_approval"].includes(workflow.status)
        || input.owner && (!workflowStepStartOwnerMatches(step.metadata?.startOwner, input.owner) || step.taskId !== input.owner.taskId)
        || !input.owner && (!input.expected || !sameExpected(step, input.expected))
        || input.owner?.leaseId !== undefined && input.owner.leaseId !== input.leaseId
        || input.expected && !sameExpected(step, input.expected)) return { status: "stale", code: "workflow_start_owner_stale" };
      if (mode === "start_failure" && (!input.leaseId || !this.validLease(step, input.leaseId, input.now))) {
        return { status: "stale", code: "workflow_start_lease_stale" };
      }
      if (mode === "start_failure" && input.owner
        && (input.owner.phase !== "preparing" || step.metadata?.startOwner?.phase !== "preparing" || step.runId)) {
        return { status: "stale", code: "workflow_start_already_linked" };
      }
      if (mode === "startup_recovery" && (!input.owner || !input.expected
        || input.owner.phase !== "preparing" || step.runId || !input.leaseId
        || !this.leaseBelongsToStep(step, input.leaseId))) return { status: "invalid", code: "workflow_start_recovery_invalid" };
      if (mode === "invalid_owner" && (!input.expected
        || classifyWorkflowStepStartOwner(this.ports, step, input.now).status !== "invalid")) {
        return { status: "stale", code: "workflow_start_owner_current" };
      }
      if (step.status === "blocked" && input.owner) {
        if (input.leaseId) this.ports.releaseResourceLease(input.leaseId, "workflow_step", step.id, input.now);
        return { status: "duplicate" };
      }
      if (!["queued", "claimed", "running", "blocked", "waiting_for_approval"].includes(step.status)) return { status: "stale", code: "workflow_start_terminal" };
      if (workflow.status !== "waiting_for_approval" && !this.startWorkflow(workflow, input.now)
        || step.status !== "waiting_for_approval" && !this.startStep(step, input.now)) {
        throw new Error("Workflow failure settlement transition changed");
      }
      this.stepTransition({ ...step, status: step.status === "waiting_for_approval" ? "waiting_for_approval" : "running" }, "blocked", input.now, input.blocker);
      let metadata: ChannelWorkflowStepMetadata = { ...step.metadata,
        ...(input.fanInContextReviews ? { fanInContextReviews: input.fanInContextReviews } : {}) };
      if (workflow.metadata?.requiredParticipantManifest && !step.runId) {
        const requirement = step.metadata?.delegatedRequirement;
        const validRequirement = isDelegatedStepRequirementV1(requirement) && requirement.workflowId === workflow.id
          && requirement.workflowStepId === step.id && requirement.participantId === step.toParticipantId
          && requirement.participantManifestFingerprint === workflow.metadata.requiredParticipantManifest.fingerprint;
        const details = validRequirement ? input.delegatedBlock ?? { code: "delegated_run_missing" as const,
          reason: input.blocker, missingRequirements: ["linked_run"] }
          : { code: "delegated_requirement_invalid" as const, reason: "Delegated step requirement is missing or inconsistent.", missingRequirements: ["delegated_requirement"] };
        const outcome: DelegatedOutcomeV1 = { kind: "blocked", workflowId: workflow.id, workflowStepId: step.id,
          participantId: step.toParticipantId, ...details, evidenceRefs: [], lineage: { workflowId: workflow.id,
            workflowStepId: step.id, participantId: step.toParticipantId, runId: null, attemptId: null,
            sourceRefs: [{ type: "workflow", id: workflow.id }, { type: "workflow_step", id: step.id }] } };
        metadata = { ...metadata, delegatedOutcome: outcome,
          delegatedOutcomeBasisFingerprint: delegatedStepFinalizationBasisFingerprintV1({ workflowId: workflow.id,
          workflowStepId: step.id, stepUpdatedAt: input.now, runEventCount: 0, runLatestSeq: 0,
          requirementFingerprint: requirement?.fingerprint, artifactIds: [], outcome }) };
      }
      this.context.database.prepare("UPDATE channel_workflow_steps SET blocker=?, updated_at=? WHERE id=?")
        .run(input.blocker, input.now, step.id);
      this.context.database.prepare("UPDATE channel_workflow_steps SET metadata_json=? WHERE id=?").run(stringifyJson(metadata), step.id);
      const currentWorkflow = this.ports.getChannelWorkflow(workflow.id)!;
      if (currentWorkflow.status === "running" || currentWorkflow.status === "waiting_for_approval") this.workflowTransition(currentWorkflow, "step_blocked", input.now, input.blocker);
      // A missing/corrupt marker cannot authorize a guessed lease release.
      if (input.leaseId && (mode !== "invalid_owner" || input.owner && this.leaseBelongsToStep(step, input.leaseId))) {
        this.ports.releaseResourceLease(input.leaseId, "workflow_step", step.id, input.now);
      }
      return { status: "linked" };
    });
  }

  /** Approval, generation marker and waiting states become visible together. */
  commitChannelWorkflowStepPostApproval(input: WorkflowStepPostApprovalInput): WorkflowStepPostApprovalResult {
    return this.transaction(() => {
      const step = this.ports.getChannelWorkflowStep(input.workflowStepId);
      const workflow = step && this.ports.getChannelWorkflow(step.workflowId);
      const ownership = step && classifyWorkflowStepStartOwner(this.ports, step, input.now, { requireActiveLease: false });
      const run = this.ports.getRun(input.runId);
      if (!step || !workflow || ownership?.status !== "linked"
        || !workflowStepStartOwnerMatches(ownership.owner, input.owner)
        || step.runId !== input.runId || run?.status !== "succeeded") {
        return { status: "stale", code: "workflow_post_approval_owner_stale" };
      }
      const payload = input.approval.payload;
      if (payload.type !== "workflow_step" || payload.gateStage !== "post"
        || payload.workflowId !== workflow.id || payload.workflowStepId !== step.id || payload.runId !== run.id) {
        return { status: "invalid", code: "workflow_post_approval_lineage_invalid" };
      }
      const existing = step.metadata?.postStepApprovalId ? this.ports.getApprovalRequest(step.metadata.postStepApprovalId) : undefined;
      if (existing && (existing.workflowStepId !== step.id || existing.channelId !== step.channelId || existing.payload.type !== "workflow_step"
        || existing.payload.workflowId !== workflow.id || existing.payload.workflowStepId !== step.id
        || existing.payload.gateStage !== "post" || existing.payload.runId !== input.runId)) {
        return { status: "invalid", code: "workflow_post_approval_lineage_invalid" };
      }
      if (step.status === "waiting_for_approval" && existing?.status === "pending") return { status: "duplicate", approval: existing };
      if (step.status !== "running" || existing && existing.status !== "pending"
        || input.approval.payload.runId !== input.runId) return { status: "stale", code: "workflow_post_approval_state_stale" };
      const approval = existing ?? this.ports.createApprovalRequest({ ...input.approval,
        workflowStepId: step.id, channelId: step.channelId, actionType: "workflow_step" }, input.now);
      this.context.database.prepare("UPDATE channel_workflow_steps SET metadata_json=?, blocker=?, result_summary=? WHERE id=?")
        .run(stringifyJson({ ...step.metadata, activeGateStage: "post", postStepApprovalId: approval.id }),
          `Waiting for post-step approval: ${approval.title}`, "Run succeeded; waiting for post-step approval.", step.id);
      this.stepTransition(step, "approval_requested", input.now, `approval:${approval.id}`);
      if (workflow.status === "running") this.workflowTransition(workflow, "approval_requested", input.now, `approval:${approval.id}`);
      return { status: "requested", approval };
    });
  }

  /** A durable old approval cannot unlock a successor generation, even on replay. */
  commitChannelWorkflowStepPostApprovalResolved(input: WorkflowStepPostApprovalResolvedInput): WorkflowStepStartCommitResult {
    return this.transaction(() => {
      const step = this.ports.getChannelWorkflowStep(input.workflowStepId);
      const workflow = step && this.ports.getChannelWorkflow(step.workflowId);
      const ownership = step && classifyWorkflowStepStartOwner(this.ports, step, input.now, { requireActiveLease: false });
      const run = this.ports.getRun(input.runId);
      const approval = this.ports.getApprovalRequest(input.approvalId);
      if (!step || !workflow || ownership?.status !== "linked"
        || !workflowStepStartOwnerMatches(ownership.owner, input.owner)
        || step.runId !== input.runId || step.metadata?.postStepApprovalId !== input.approvalId
        || run?.status !== "succeeded") return { status: "stale", code: "workflow_post_approval_owner_stale" };
      if (!approval || approval.status !== "approved" || approval.channelId !== step.channelId
        || approval.workflowStepId !== step.id || approval.payload.type !== "workflow_step"
        || approval.payload.workflowId !== workflow.id || approval.payload.workflowStepId !== step.id
        || approval.payload.gateStage !== "post" || approval.payload.runId !== run.id) {
        return { status: "invalid", code: "workflow_post_approval_lineage_invalid" };
      }
      if (step.status === "running" && !step.metadata.activeGateStage) return { status: "duplicate" };
      if (step.status !== "waiting_for_approval" || step.metadata.activeGateStage !== "post") {
        return { status: "stale", code: "workflow_post_approval_state_stale" };
      }
      const actor = input.actor ?? "system";
      this.stepTransition(step, "approval_approved", input.now, `approval:${approval.id}`, actor);
      if (workflow.status === "waiting_for_approval" && !workflowHasUnresolvedApprovalWait(this.ports, workflow.id)) {
        this.workflowTransition(workflow, "approval_approved", input.now, `approval:${approval.id}`, actor);
      }
      const { activeGateStage, ...metadata } = step.metadata;
      this.context.database.prepare("UPDATE channel_workflow_steps SET metadata_json=?, blocker=NULL, updated_at=? WHERE id=?")
        .run(stringifyJson(metadata), input.now, step.id);
      return { status: "linked" };
    });
  }

  private validLease(step: ChannelWorkflowStep, id: string, now: string): boolean {
    return this.ports.listResourceLeases({ resourceType: "workflow_step", resourceKey: step.id, limit: 100 })
      .some((lease) => lease.id === id && lease.ownerType === "workflow_step" && lease.ownerId === step.id
        && lease.status === "active" && lease.expiresAt > now);
  }
  private leaseBelongsToStep(step: ChannelWorkflowStep, id: string): boolean {
    return this.ports.listResourceLeases({ resourceType: "workflow_step", resourceKey: step.id, limit: 100 })
      .some((lease) => lease.id === id && lease.ownerType === "workflow_step" && lease.ownerId === step.id);
  }

  private startWorkflow(workflow: ChannelWorkflow, now: string): boolean {
    if (workflow.status === "running") return true;
    if (workflow.status === "draft") {
      this.workflowTransition(workflow, "prepare", now);
      return this.workflowTransition({ ...workflow, status: "ready" }, "start", now);
    }
    return (workflow.status === "ready" || workflow.status === "blocked") && this.workflowTransition(workflow, "start", now);
  }
  private startStep(step: ChannelWorkflowStep, now: string): boolean {
    if (step.status === "running") return true;
    if (step.status === "queued" || step.status === "blocked") {
      this.stepTransition(step, step.status === "queued" ? "claim" : "resume", now);
      return this.stepTransition({ ...step, status: "claimed" }, "start", now);
    }
    return step.status === "claimed" && this.stepTransition(step, "start", now);
  }
  private workflowTransition(workflow: ChannelWorkflow, event: Parameters<typeof transitionWorkflow>[0]["event"], now: string, reason = "workflow_start_owner", actor: "system" | "local-user" = "system"): boolean {
    const result = transitionWorkflow({ entityId: workflow.id, currentStatus: workflow.status, expectedStatus: workflow.status, event, actor });
    if (!result.ok) throw new Error(`Invalid workflow owner transition: ${workflow.status}/${event}`);
    this.context.database.prepare("UPDATE channel_workflows SET status=?, updated_at=? WHERE id=?").run(result.to, now, workflow.id);
    this.ports.recordStateTransitionEvent({ workspaceId: workflow.workspaceId, entityType: "workflow", entityId: workflow.id,
      fromStatus: result.from, toStatus: result.to, event, actor, reason, createdAt: now });
    return true;
  }
  private stepTransition(step: ChannelWorkflowStep, event: Parameters<typeof transitionWorkflowStep>[0]["event"], now: string, reason = "workflow_start_owner", actor: "system" | "local-user" = "system"): boolean {
    const result = transitionWorkflowStep({ entityId: step.id, currentStatus: step.status, expectedStatus: step.status, event, actor });
    if (!result.ok) throw new Error(`Invalid step owner transition: ${step.status}/${event}`);
    this.context.database.prepare("UPDATE channel_workflow_steps SET status=?, updated_at=? WHERE id=?").run(result.to, now, step.id);
    this.ports.recordStateTransitionEvent({ workspaceId: step.workspaceId, entityType: "workflow_step", entityId: step.id,
      fromStatus: result.from, toStatus: result.to, event, actor, reason, createdAt: now });
    return true;
  }
  private transaction<T>(operation: () => T): T {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try { const result = operation(); this.context.database.exec("COMMIT;"); return result; }
    catch (error) {
      try { this.context.database.exec("ROLLBACK;"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Workflow start transaction and rollback failed"); }
      throw error;
    }
  }
}

function sameExpected(step: ChannelWorkflowStep, expected: BeginChannelWorkflowStepStartInput["expected"]): boolean {
  return step.status === expected.status && step.taskId === expected.taskId && step.runId === expected.runId && step.updatedAt === expected.updatedAt;
}
/** Only the persisted fresh conflict-queue producer may atomically claim its still-todo Task. */
function validQueuedTaskHandoff(step: ChannelWorkflowStep, task: Task, run: RunSession, unit: WorkUnit, attempt: WorkUnitAttempt): boolean {
  const snapshot = record(run.requestSnapshot);
  const request = record(unit.request);
  const requestTask = record(request?.task);
  const snapshotTask = record(snapshot?.task);
  return run.status === "queued" && !run.startedAt && !run.endedAt
    && snapshot?.queued === true && ["resource_conflict", "runtime_semaphore_conflict"].includes(String(snapshot.queueReason))
    && snapshot.workflowStepId === step.id && snapshot.teammateId === step.toParticipantId
    && snapshotTask?.id === task.id && snapshotTask.channelId === step.channelId
    && snapshotTask.assigneeTeammateId === step.toParticipantId
    && unit.status === "queued" && !unit.startedAt && !unit.endedAt
    && unit.kind === "task_run" && unit.ownerType === "task" && unit.ownerId === task.id
    && unit.linkedRunId === run.id && unit.taskId === task.id && unit.channelId === step.channelId && unit.teammateId === step.toParticipantId
    && request?.workflowStepId === step.id && request.teammateId === step.toParticipantId
    && requestTask?.id === task.id && requestTask.channelId === step.channelId && requestTask.assigneeTeammateId === step.toParticipantId
    && attempt.status === "created" && !attempt.startedAt && !attempt.endedAt && !attempt.abortRequestedAt;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function dependenciesComplete(store: Pick<RunStore, "listChannelWorkflowSteps">, step: ChannelWorkflowStep): boolean {
  const ids = step.metadata?.dependsOnStepIds ?? [];
  const all = store.listChannelWorkflowSteps({ workflowId: step.workflowId, complete: true });
  const deps = ids.map((id) => all.find((s) => s.id === id));
  if (deps.some((s) => !s)) return false;
  const terminal = (s: ChannelWorkflowStep | undefined) => s && ["succeeded", "failed", "cancelled", "skipped"].includes(s.status);
  if (step.metadata?.fanInPolicy?.requireAllBranchesTerminal && !deps.every(terminal)) return false;
  const mode = step.metadata?.dependencyMode ?? "all_succeeded";
  return mode === "any_succeeded" ? deps.length === 0 || deps.some((s) => s?.status === "succeeded")
    : mode === "all_terminal" ? deps.every(terminal) : deps.every((s) => s?.status === "succeeded" || s?.status === "skipped");
}
