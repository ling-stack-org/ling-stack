import type { SQLOutputValue } from "node:sqlite";
import type { RunStore } from "../../run-types.js";
import type { RuntimeAttemptFenceV1, RuntimeSemaphoreResourceType, RuntimeSemaphoreSlot } from "../../runtime-supervisor-types.js";
import type {
  ReleaseChannelWorkflowStepStartAdmissionInput, ReleaseChannelWorkflowStepStartAdmissionResult,
  ResumeChannelWorkflowStepStartAdmissionInput, ResumeChannelWorkflowStepStartAdmissionResult,
  TransferChannelWorkflowStepStartAdmissionInput, TransferChannelWorkflowStepStartAdmissionResult,
  WorkflowStepAdmissionPlan, WorkflowStepStartAdmission,
} from "../../workflow-step-admission.js";
import { workflowStepStartAuthorityBasis, workflowStepStartOwnerMatches,
  type WorkflowStepStartOwnerV1, type WorkflowStepStartReadStore } from "../../workflow-step-start-owner.js";
import type { ChannelWorkflowStep, Task } from "../../workspace-types.js";
import { mapRuntimeSemaphoreSlot } from "./runtime-work-mappers.js";
import type { SqliteRuntimeSemaphoreStore } from "./runtime-semaphore-store.js";
import type { SqliteStoreContext } from "./store-context.js";
import { readRuntimeSemaphoreCapacity } from "./workflow-step-admission-capacity.js";
import { toRuntimeAttemptFence } from "../../runtime-supervisor-types.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import { hostAttemptReadScopeForSource } from "./host-attempt-read-scope.js";

type Ports = WorkflowStepStartReadStore & Pick<RunStore, "getWorkUnit" | "getWorkUnitAttempt" | "getRunnerContinuation" | "getHostAttemptCompletion">;
type Entry = { readonly resourceType: RuntimeSemaphoreResourceType; readonly resourceKey: string; readonly limit: number };
type Row = Record<string, SQLOutputValue>;
const entryTypes = new Set(["provider", "runner", "channel_parallel", "media_provider"]);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const key = (entry: Entry) => JSON.stringify([entry.resourceType, entry.resourceKey]);
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.trim() === value;
const canonical = (value: string) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function normalizeWorkflowStepAdmissionPlan(value: WorkflowStepAdmissionPlan): WorkflowStepAdmissionPlan | undefined {
  if (!value || !Array.isArray(value.entries) || !Array.isArray(value.resourceKeys) || !value.entries.length) return undefined;
  const entries: WorkflowStepAdmissionPlan["entries"][number][] = [];
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!entry || !entryTypes.has(entry.resourceType) || !identity(entry.resourceKey)
      || !Number.isSafeInteger(entry.limit) || entry.limit < 1 || seen.has(key(entry))) return undefined;
    seen.add(key(entry));
    entries.push({ resourceType: entry.resourceType, resourceKey: entry.resourceKey, limit: entry.limit });
  }
  if (value.resourceKeys.some(resource => !identity(resource)) || new Set(value.resourceKeys).size !== value.resourceKeys.length) return undefined;
  entries.sort((a, b) => compare(key(a), key(b)));
  return { entries, resourceKeys: [...value.resourceKeys].sort(compare) };
}

function allEntries(plan: WorkflowStepAdmissionPlan): Entry[] {
  return [...plan.entries, ...plan.resourceKeys.map(resourceKey => ({ resourceType: "workflow_resource" as const, resourceKey, limit: 1 }))];
}
function sameFence(a: RuntimeAttemptFenceV1 | undefined, b: RuntimeAttemptFenceV1): boolean {
  return !!a && a.workUnitId === b.workUnitId && a.attemptId === b.attemptId
    && a.runtimeInstanceId === b.runtimeInstanceId && a.fencingToken === b.fencingToken;
}

/** All WithinTransaction methods share the caller's short SQLite write transaction. No async preparation here. */
export class SqliteWorkflowStepAdmissionStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports,
    private readonly semaphores: SqliteRuntimeSemaphoreStore,
    private readonly hasUserInputRunLineage: (taskId: string, runId: string) => boolean) {}

  getChannelWorkflowStepStartAdmission(workflowStepId: string, owner: WorkflowStepStartOwnerV1): WorkflowStepStartAdmission | undefined {
    const row = this.row(workflowStepId, owner);
    if (!row) return undefined;
    const plan = normalizeWorkflowStepAdmissionPlan(JSON.parse(String(row.plan_json)) as WorkflowStepAdmissionPlan);
    if (!plan) throw new Error("workflow_admission.plan_corrupt");
    const entries = this.context.database.prepare(`SELECT resource_type,resource_key,capacity_limit,slot_id
      FROM workflow_step_admission_entries WHERE task_id=? ORDER BY resource_type,resource_key`).all(owner.taskId);
    const order = (a: Entry, b: Entry) => compare(key(a), key(b));
    const actual = entries.map(entry => ({ resourceType: entry.resource_type as RuntimeSemaphoreResourceType,
      resourceKey: String(entry.resource_key), limit: Number(entry.capacity_limit) })).sort(order);
    const expected = allEntries(plan).sort(order);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("workflow_admission.entries_corrupt");
    return { workflowStepId, workspaceId: String(row.workspace_id), owner, plan,
      status: row.status as WorkflowStepStartAdmission["status"],
      ...(row.run_id === null ? {} : { runId: String(row.run_id), fence: { workUnitId: String(row.work_unit_id),
        attemptId: String(row.attempt_id), runtimeInstanceId: String(row.runtime_instance_id), fencingToken: String(row.fencing_token) } }),
      slotIds: entries.filter(entry => entry.slot_id !== null).map(entry => String(entry.slot_id)),
      createdAt: String(row.created_at), ...(row.transferred_at === null ? {} : { transferredAt: String(row.transferred_at) }),
      ...(row.released_at === null ? {} : { releasedAt: String(row.released_at) }) };
  }

  hasAdmissionWithinTransaction(taskId: string): boolean {
    return !!this.context.database.prepare("SELECT 1 FROM workflow_step_admissions WHERE task_id=?").get(taskId);
  }

  reserveWithinTransaction(input: { readonly step: ChannelWorkflowStep; readonly task: Task; readonly owner: WorkflowStepStartOwnerV1;
    readonly plan: WorkflowStepAdmissionPlan; readonly now: string }):
    | { readonly status: "reserved" }
    | { readonly status: "conflict"; readonly code: string; readonly resourceType: RuntimeSemaphoreResourceType; readonly resourceKey: string } {
    const { step, task, owner, plan, now } = input;
    const available = this.checkCapacityWithinTransaction(step, plan);
    if (available.status === "conflict") return available;
    this.context.database.prepare(`INSERT INTO workflow_step_admissions
      (task_id,workspace_id,workflow_id,workflow_step_id,lease_id,authority_basis,plan_json,status,created_at)
      VALUES (?,?,?,?,?,?,?,'preparing',?)`)
      .run(task.id, step.workspaceId, step.workflowId, step.id, owner.leaseId, owner.authorityBasis, JSON.stringify(plan), now);
    const insert = this.context.database.prepare(`INSERT INTO workflow_step_admission_entries
      (task_id,resource_type,resource_key,capacity_limit) VALUES (?,?,?,?)`);
    for (const entry of allEntries(plan)) insert.run(task.id, entry.resourceType, entry.resourceKey, entry.limit);
    return { status: "reserved" };
  }

  checkCapacityWithinTransaction(step: ChannelWorkflowStep, plan: WorkflowStepAdmissionPlan):
    | { readonly status: "reserved" }
    | { readonly status: "conflict"; readonly code: string; readonly resourceType: RuntimeSemaphoreResourceType; readonly resourceKey: string } {
    const previous = this.context.database.prepare(`SELECT 1 FROM workflow_step_admissions AS admission
      WHERE admission.workflow_step_id=? AND (admission.status='preparing' OR admission.status='transferred' AND EXISTS (
        SELECT 1 FROM workflow_step_admission_entries AS entry JOIN runtime_semaphore_slots AS slot ON slot.id=entry.slot_id
        WHERE entry.task_id=admission.task_id AND slot.status='active')) LIMIT 1`).get(step.id);
    if (previous) return { status: "conflict", code: "workflow_admission_owner_retained", resourceType: "workflow_resource", resourceKey: step.id };
    for (const entry of allEntries(plan)) {
      const capacity = readRuntimeSemaphoreCapacity(this.context.database, { workspaceId: step.workspaceId, ...entry });
      if (capacity.occupied >= capacity.limit) return { status: "conflict", code: "workflow_admission_resource_conflict", ...entry };
    }
    return { status: "reserved" };
  }

  transferChannelWorkflowStepStartAdmission(input: TransferChannelWorkflowStepStartAdmissionInput): TransferChannelWorkflowStepStartAdmissionResult {
    return this.transaction(() => this.transferWithinTransaction(input));
  }

  transferWithinTransaction(input: TransferChannelWorkflowStepStartAdmissionInput): TransferChannelWorkflowStepStartAdmissionResult {
    const step = this.currentStep(input.workflowStepId, input.owner);
    const admission = this.getChannelWorkflowStepStartAdmission(input.workflowStepId, input.owner);
    if (!step || !admission || step.workspaceId !== admission.workspaceId || step.status !== "running" || admission.status === "released"
      || workflowStepStartAuthorityBasis(this.ports, step) !== input.owner.authorityBasis) {
      return { status: "stale", code: "workflow_admission_owner_stale" };
    }
    const plan = normalizeWorkflowStepAdmissionPlan(input.admission);
    if (!plan || JSON.stringify(plan) !== JSON.stringify(admission.plan)) return { status: "invalid", code: "workflow_admission_plan_mismatch" };
    if (!canonical(input.now) || !canonical(input.expiresAt) || input.expiresAt <= input.now) {
      return { status: "invalid", code: "workflow_admission_deadline_invalid" };
    }
    if (!this.validLineage(step, input.owner, input.runId, input)) return { status: "stale", code: "workflow_admission_attempt_stale" };
    if (admission.status === "transferred") {
      if (admission.runId !== input.runId || !sameFence(admission.fence, input)) return { status: "stale", code: "workflow_admission_attempt_stale" };
      const slots = this.transferredSlots(admission, input);
      return slots ? { status: "duplicate", slots } : { status: "stale", code: "workflow_admission_slots_changed" };
    }
    const lease = this.context.database.prepare(`SELECT 1 FROM resource_leases
      WHERE id=? AND workspace_id=? AND resource_type='workflow_step' AND resource_key=?
        AND owner_type='workflow_step' AND owner_id=? AND status='active' AND expires_at>?`)
      .get(input.owner.leaseId, step.workspaceId, step.id, step.id, input.now);
    if (!lease || step.metadata?.startOwner?.phase !== "preparing" || !this.notDispatched(step, input.owner, input.runId, input)) {
      return { status: "stale", code: "workflow_admission_preparation_changed" };
    }
    if (this.hasActiveAttemptSlots(input.attemptId)) return { status: "invalid", code: "workflow_admission_unplanned_attempt_slots" };
    for (const entry of allEntries(plan)) {
      const capacity = readRuntimeSemaphoreCapacity(this.context.database,
        { workspaceId: step.workspaceId, ...entry, excludePreparingTaskId: input.owner.taskId });
      if (capacity.occupied >= capacity.limit) return { status: "invalid", code: "workflow_admission_capacity_changed" };
    }
    const slots: RuntimeSemaphoreSlot[] = [];
    for (const entry of allEntries(plan)) {
      const result = this.semaphores.ensureRuntimeSemaphoreSlotForAttemptWithinTransaction({ ...entry,
        workspaceId: step.workspaceId, workUnitId: input.workUnitId, attemptId: input.attemptId,
        runtimeInstanceId: input.runtimeInstanceId, fencingToken: input.fencingToken,
        ownerType: "work_unit_attempt", ownerId: input.attemptId, acquiredAt: input.now, expiresAt: input.expiresAt }, input.owner.taskId);
      if (result.status !== "acquired") throw new Error("workflow_admission.transfer_ownership_changed");
      const changed = this.context.database.prepare(`UPDATE workflow_step_admission_entries SET slot_id=?
        WHERE task_id=? AND resource_type=? AND resource_key=? AND slot_id IS NULL`)
        .run(result.slot.id, input.owner.taskId, entry.resourceType, entry.resourceKey);
      if (Number(changed.changes) !== 1) throw new Error("workflow_admission.transfer_entry_changed");
      slots.push(result.slot);
    }
    const changed = this.context.database.prepare(`UPDATE workflow_step_admissions SET status='transferred',run_id=?,
      work_unit_id=?,attempt_id=?,runtime_instance_id=?,fencing_token=?,transferred_at=? WHERE task_id=? AND status='preparing'`)
      .run(input.runId, input.workUnitId, input.attemptId, input.runtimeInstanceId, input.fencingToken, input.now, input.owner.taskId);
    if (Number(changed.changes) !== 1) throw new Error("workflow_admission.transfer_owner_changed");
    if (!this.isTransferredWithinTransaction(step.id, input.owner, input.runId, input)) {
      throw new Error("workflow_admission.transfer_receipt_changed");
    }
    return { status: "transferred", slots };
  }

  resumeChannelWorkflowStepStartAdmission(input: ResumeChannelWorkflowStepStartAdmissionInput): ResumeChannelWorkflowStepStartAdmissionResult {
    return this.transaction(() => {
      const step = this.currentStep(input.workflowStepId, input.owner);
      const admission = this.getChannelWorkflowStepStartAdmission(input.workflowStepId, input.owner);
      if (!step || !admission || admission.status !== "transferred" || admission.runId !== input.runId
        || step.workspaceId !== admission.workspaceId || step.status !== "running" || step.runId !== input.runId
        || step.metadata?.startOwner?.phase !== "linked" || this.ports.getTask(input.owner.taskId)?.currentRunId !== input.runId
        || workflowStepStartAuthorityBasis(this.ports, step) !== input.owner.authorityBasis) {
        return { status: "stale", code: "workflow_admission_owner_stale" };
      }
      const plan = normalizeWorkflowStepAdmissionPlan(input.admission);
      if (!plan || JSON.stringify(plan) !== JSON.stringify(admission.plan)) return { status: "invalid", code: "workflow_admission_plan_mismatch" };
      if (!canonical(input.now) || !canonical(input.expiresAt) || input.expiresAt <= input.now) {
        return { status: "invalid", code: "workflow_admission_deadline_invalid" };
      }
      if (!this.validLineage(step, input.owner, input.runId, input)) return { status: "stale", code: "workflow_admission_attempt_stale" };
      const continuation = this.ports.getRunnerContinuation(input.continuationId);
      const target = this.ports.getWorkUnitAttempt(input.attemptId)!;
      const source = this.ports.getWorkUnitAttempt(input.sourceFence.attemptId);
      if (!continuation || continuation.runId !== input.runId || continuation.workUnitId !== input.workUnitId
        || continuation.sourceAttemptId !== input.sourceFence.attemptId || continuation.targetAttemptId !== input.attemptId
        || !source || source.workUnitId !== input.workUnitId || !sameFence(toRuntimeAttemptFence(source), input.sourceFence)
        || source.attemptNumber >= target.attemptNumber || source.id === target.id
        || continuation.runnerId !== target.effectiveRunnerId
        || continuation.revision !== input.expectedContinuationRevision || continuation.state !== "claimed"
        || continuation.claimOwner !== input.claimOwner || continuation.claimToken !== input.claimToken
        || !continuation.claimExpiresAt || continuation.claimExpiresAt <= input.now) {
        return { status: "stale", code: "workflow_admission_continuation_stale" };
      }
      if (sameFence(admission.fence, input)) {
        const slots = this.transferredSlots(admission, input);
        return slots ? { status: "duplicate", slots } : { status: "stale", code: "workflow_admission_slots_changed" };
      }
      if (!sameFence(admission.fence, input.sourceFence)) return { status: "stale", code: "workflow_admission_attempt_stale" };
      if (!this.sourceStopped(input, target.createdAt)) return { status: "invalid", code: "workflow_admission_source_unconfirmed" };
      if (target.status !== "created" || target.startedAt || target.endedAt || target.lastHeartbeatAt || target.abortRequestedAt
        || !["queued", "running", "waiting_for_approval"].includes(this.ports.getRun(input.runId)!.status)
        || !plan.entries.filter(entry => entry.resourceType === "runner").every(entry => entry.resourceKey === target.effectiveRunnerId)
        || this.hasAttemptActivity(input.runId, input, target.createdAt)) {
        return { status: "stale", code: "workflow_admission_preparation_changed" };
      }
      const receipts = this.context.database.prepare(`SELECT entry.resource_type AS planned_resource_type,
        entry.resource_key AS planned_resource_key,entry.slot_id,slot.*
        FROM workflow_step_admission_entries AS entry LEFT JOIN runtime_semaphore_slots AS slot ON slot.id=entry.slot_id
        WHERE entry.task_id=?`).all(input.owner.taskId);
      if (receipts.length !== allEntries(plan).length || receipts.some(slot => slot.status !== "released"
        || slot.resource_type !== slot.planned_resource_type || slot.resource_key !== slot.planned_resource_key
        || slot.workspace_id !== step.workspaceId || slot.owner_type !== "work_unit_attempt" || slot.owner_id !== source.id
        || slot.work_unit_id !== input.sourceFence.workUnitId || slot.attempt_id !== input.sourceFence.attemptId
        || slot.runtime_instance_id !== input.sourceFence.runtimeInstanceId || slot.fencing_token !== input.sourceFence.fencingToken
        || typeof slot.released_at !== "string" || !canonical(slot.released_at) || slot.released_at > input.now)) {
        return { status: "stale", code: "workflow_admission_slots_changed" };
      }
      if (this.hasActiveAttemptSlots(input.attemptId)) return { status: "invalid", code: "workflow_admission_unplanned_attempt_slots" };
      for (const entry of allEntries(plan)) {
        const capacity = readRuntimeSemaphoreCapacity(this.context.database, { workspaceId: step.workspaceId, ...entry });
        if (capacity.occupied >= capacity.limit) return { status: "conflict", code: "workflow_admission_resource_conflict", ...entry };
      }
      const slots: RuntimeSemaphoreSlot[] = [];
      for (const entry of allEntries(plan)) {
        const result = this.semaphores.ensureRuntimeSemaphoreSlotForAttemptWithinTransaction({ ...entry,
          workUnitId: input.workUnitId, attemptId: input.attemptId, runtimeInstanceId: input.runtimeInstanceId, fencingToken: input.fencingToken,
          workspaceId: step.workspaceId, ownerType: "work_unit_attempt", ownerId: input.attemptId,
          acquiredAt: input.now, expiresAt: input.expiresAt });
        if (result.status !== "acquired") throw new Error("workflow_admission.resume_ownership_changed");
        const prior = receipts.find(receipt => receipt.planned_resource_type === entry.resourceType && receipt.planned_resource_key === entry.resourceKey);
        const changed = this.context.database.prepare(`UPDATE workflow_step_admission_entries SET slot_id=?
          WHERE task_id=? AND resource_type=? AND resource_key=? AND slot_id=?`)
          .run(result.slot.id, input.owner.taskId, entry.resourceType, entry.resourceKey, prior!.slot_id!);
        if (Number(changed.changes) !== 1) throw new Error("workflow_admission.resume_entry_changed");
        slots.push(result.slot);
      }
      const changed = this.context.database.prepare(`UPDATE workflow_step_admissions SET work_unit_id=?,attempt_id=?,
        runtime_instance_id=?,fencing_token=?,transferred_at=? WHERE task_id=? AND status='transferred'
        AND run_id=? AND work_unit_id=? AND attempt_id=? AND runtime_instance_id=? AND fencing_token=?`)
        .run(input.workUnitId, input.attemptId, input.runtimeInstanceId, input.fencingToken, input.now, input.owner.taskId,
          input.runId, input.sourceFence.workUnitId, input.sourceFence.attemptId, input.sourceFence.runtimeInstanceId, input.sourceFence.fencingToken);
      if (Number(changed.changes) !== 1 || !this.isTransferredWithinTransaction(step.id, input.owner, input.runId, input)) {
        throw new Error("workflow_admission.resume_receipt_changed");
      }
      return { status: "resumed", slots };
    });
  }

  isTransferredWithinTransaction(workflowStepId: string, owner: WorkflowStepStartOwnerV1, runId: string, fence: RuntimeAttemptFenceV1): boolean {
    const admission = this.getChannelWorkflowStepStartAdmission(workflowStepId, owner);
    const step = this.currentStep(workflowStepId, owner);
    return !!step && !!admission && this.validLineage(step, owner, runId, fence)
      && admission.status === "transferred" && admission.runId === runId
      && sameFence(admission.fence, fence) && !!this.transferredSlots(admission, fence);
  }

  releaseChannelWorkflowStepStartAdmission(input: ReleaseChannelWorkflowStepStartAdmissionInput): ReleaseChannelWorkflowStepStartAdmissionResult {
    return this.transaction(() => this.releaseWithinTransaction(input));
  }

  releaseWithinTransaction(input: ReleaseChannelWorkflowStepStartAdmissionInput): ReleaseChannelWorkflowStepStartAdmissionResult {
    const step = this.currentStep(input.workflowStepId, input.owner);
    const admission = this.getChannelWorkflowStepStartAdmission(input.workflowStepId, input.owner);
    if (!step || !admission) return { status: "stale", code: "workflow_admission_owner_stale" };
    if (input.dispatchState !== "not_dispatched") return { status: "retained", code: "workflow_admission_dispatch_unknown" };
    if (admission.fence && (!input.fence || admission.runId !== input.runId || !sameFence(admission.fence, input.fence))) {
      return { status: "stale", code: "workflow_admission_attempt_stale" };
    }
    const runs = this.context.database.prepare("SELECT id FROM run_sessions WHERE task_id=? ORDER BY id").all(input.owner.taskId);
    if (runs.length && (runs.length !== 1 || runs[0]!.id !== input.runId || !input.fence
      || !this.validLineage(step, input.owner, input.runId!, input.fence, true)
      || !this.notDispatched(step, input.owner, input.runId!, input.fence, true))) {
      return { status: "retained", code: "workflow_admission_dispatch_unproven" };
    }
    if (admission.status === "transferred" && (!input.fence || admission.runId !== input.runId || !sameFence(admission.fence, input.fence))) {
      return { status: "stale", code: "workflow_admission_attempt_stale" };
    }
    if (!runs.length && (input.runId || input.fence || admission.status === "transferred")) {
      return { status: "invalid", code: "workflow_admission_run_lineage_invalid" };
    }
    if (admission.status === "released") return { status: "duplicate", releasedSlots: 0 };
    this.context.database.exec("SAVEPOINT workflow_admission_release");
    try {
      const releasedSlots = input.fence
        ? this.semaphores.releaseRuntimeSemaphoreSlotsForAttempt(input.fence, input.now, input.reason) : 0;
      if (input.fence && this.hasActiveAttemptSlots(input.fence.attemptId)) {
        this.context.database.exec("ROLLBACK TO workflow_admission_release");
        this.context.database.exec("RELEASE workflow_admission_release");
        return { status: "retained", code: "workflow_admission_effects_unconfirmed" };
      }
      const changed = this.context.database.prepare(`UPDATE workflow_step_admissions SET status='released',released_at=?,release_reason=?
        WHERE task_id=? AND status IN ('preparing','transferred')`).run(input.now, input.reason, input.owner.taskId);
      if (Number(changed.changes) !== 1) throw new Error("workflow_admission.release_owner_changed");
      this.context.database.exec("RELEASE workflow_admission_release");
      return { status: "released", releasedSlots };
    } catch (error) {
      this.context.database.exec("ROLLBACK TO workflow_admission_release");
      this.context.database.exec("RELEASE workflow_admission_release");
      throw error;
    }
  }

  private row(workflowStepId: string, owner: WorkflowStepStartOwnerV1): Row | undefined {
    return this.context.database.prepare(`SELECT * FROM workflow_step_admissions
      WHERE workflow_step_id=? AND task_id=? AND lease_id=? AND authority_basis=?`)
      .get(workflowStepId, owner.taskId, owner.leaseId, owner.authorityBasis) as Row | undefined;
  }

  private currentStep(workflowStepId: string, owner: WorkflowStepStartOwnerV1): ChannelWorkflowStep | undefined {
    const step = this.ports.getChannelWorkflowStep(workflowStepId);
    return step?.taskId === owner.taskId && workflowStepStartOwnerMatches(step.metadata?.startOwner, owner) ? step : undefined;
  }

  private validLineage(step: ChannelWorkflowStep, owner: WorkflowStepStartOwnerV1, runId: string,
    fence: RuntimeAttemptFenceV1, releasing = false): boolean {
    const run = this.ports.getRun(runId), task = this.ports.getTask(owner.taskId);
    const unit = this.ports.getWorkUnit(fence.workUnitId), attempt = this.ports.getWorkUnitAttempt(fence.attemptId);
    const workflow = this.ports.getChannelWorkflow(step.workflowId);
    return !!run && !!task && !!unit && !!attempt && !!workflow
      && (releasing || ["running", "waiting_for_approval", "blocked"].includes(workflow.status))
      && (releasing || ["todo", "claimed", "running", "waiting_for_approval"].includes(task.status))
      && run.taskId === task.id && run.workflowStepId === step.id && run.channelId === step.channelId
      && run.teammateId === step.toParticipantId && run.workUnitId === unit.id
      && (!step.runId || step.runId === runId) && (!task.currentRunId || task.currentRunId === runId)
      && task.channelId === step.channelId && task.assigneeTeammateId === step.toParticipantId
      && unit.workspaceId === step.workspaceId && unit.kind === "task_run" && unit.ownerType === "task" && unit.ownerId === task.id
      && unit.taskId === task.id && unit.channelId === step.channelId && unit.teammateId === step.toParticipantId
      && unit.linkedRunId === runId && unit.activeAttemptId === attempt.id && attempt.workUnitId === unit.id
      && attempt.runtimeInstanceId === fence.runtimeInstanceId && attempt.fencingToken === fence.fencingToken
      && (!this.context.database.prepare("SELECT 1 FROM run_sessions WHERE task_id=? AND id<>? LIMIT 1").get(task.id, runId)
        || this.hasUserInputRunLineage(task.id, runId))
      && (releasing || ["created", "started", "waiting_for_approval", "cancelling"].includes(attempt.status));
  }

  private notDispatched(step: ChannelWorkflowStep, owner: WorkflowStepStartOwnerV1, runId: string,
    fence: RuntimeAttemptFenceV1, releasing = false): boolean {
    const run = this.ports.getRun(runId)!, unit = this.ports.getWorkUnit(fence.workUnitId)!, attempt = this.ports.getWorkUnitAttempt(fence.attemptId)!;
    const plan = this.getChannelWorkflowStepStartAdmission(step.id, owner)!.plan;
    return !run.startedAt && !unit.startedAt && !unit.lastHeartbeatAt && !attempt.startedAt && !attempt.lastHeartbeatAt
      && (releasing ? ["queued", "failed", "cancelled"].includes(run.status) : run.status === "queued" && !run.endedAt)
      && (releasing ? ["queued", "claimed", "failed", "cancelled"].includes(unit.status) : ["queued", "claimed"].includes(unit.status) && !unit.endedAt)
      && (releasing ? ["created", "failed", "cancelled"].includes(attempt.status) : attempt.status === "created" && !attempt.endedAt && !attempt.abortRequestedAt)
      && (releasing || plan.entries.filter(entry => entry.resourceType === "runner").every(entry => entry.resourceKey === attempt.effectiveRunnerId))
      && !this.context.database.prepare("SELECT 1 FROM host_attempt_completions WHERE run_id=? OR work_unit_id=? OR attempt_id=? LIMIT 1")
        .get(runId, fence.workUnitId, fence.attemptId)
      && !this.context.database.prepare("SELECT 1 FROM runtime_events WHERE work_unit_id=? AND type='work_unit_started' LIMIT 1").get(fence.workUnitId)
      && !this.context.database.prepare("SELECT 1 FROM runtime_heartbeats WHERE work_unit_id=? OR attempt_id=? LIMIT 1").get(fence.workUnitId, fence.attemptId)
      && !this.context.database.prepare("SELECT 1 FROM host_operations WHERE run_id=? OR attempt_id=? LIMIT 1").get(runId, fence.attemptId)
      && !this.context.database.prepare("SELECT 1 FROM harness_tool_executions WHERE run_id=? OR attempt_id=? LIMIT 1").get(runId, fence.attemptId)
      && !this.context.database.prepare("SELECT 1 FROM native_submissions WHERE run_id=? OR attempt_id=? LIMIT 1").get(runId, fence.attemptId)
      && !this.context.database.prepare(`SELECT 1 FROM run_events WHERE run_id=?
        AND type IN ('tool_start','tool_end','host_command_prepared','host_command_settled') LIMIT 1`).get(runId);
  }

  private attemptSlots(fence: RuntimeAttemptFenceV1): RuntimeSemaphoreSlot[] {
    return this.context.database.prepare(`SELECT * FROM runtime_semaphore_slots WHERE work_unit_id=? AND attempt_id=?
      AND runtime_instance_id=? AND fencing_token=? AND status='active' ORDER BY id`)
      .all(fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken)
      .map(row => mapRuntimeSemaphoreSlot(row as Row));
  }

  private hasAttemptActivity(runId: string, fence: RuntimeAttemptFenceV1, createdAt: string): boolean {
    return !!this.context.database.prepare(`SELECT 1 FROM host_attempt_completions WHERE attempt_id=?
      UNION ALL SELECT 1 FROM runtime_heartbeats WHERE attempt_id=?
      UNION ALL SELECT 1 FROM host_operations WHERE attempt_id=?
      UNION ALL SELECT 1 FROM harness_tool_executions WHERE attempt_id=?
      UNION ALL SELECT 1 FROM native_submissions WHERE attempt_id=?
      UNION ALL SELECT 1 FROM runtime_events WHERE work_unit_id=? AND type='work_unit_started' AND ts>=?
      UNION ALL SELECT 1 FROM run_events WHERE run_id=? AND ts>=?
        AND type IN ('tool_start','tool_end','host_command_prepared','host_command_settled') LIMIT 1`)
      .get(fence.attemptId, fence.attemptId, fence.attemptId, fence.attemptId, fence.attemptId, fence.workUnitId, createdAt, runId, createdAt);
  }

  private hasActiveAttemptSlots(attemptId: string): boolean {
    return !!this.context.database.prepare("SELECT 1 FROM runtime_semaphore_slots WHERE attempt_id=? AND status='active' LIMIT 1").get(attemptId);
  }

  private sourceStopped(input: ResumeChannelWorkflowStepStartAdmissionInput, targetCreatedAt: string): boolean {
    const source = this.ports.getWorkUnitAttempt(input.sourceFence.attemptId)!;
    if (!["succeeded", "failed", "cancelled", "lost", "yielded"].includes(source.status)
      || !source.endedAt || !canonical(source.endedAt) || source.endedAt > targetCreatedAt || source.endedAt > input.now
      || this.context.database.prepare(`SELECT 1 FROM runtime_semaphore_slots WHERE attempt_id=? AND status='active'
        UNION ALL SELECT 1 FROM resource_leases WHERE attempt_id=? AND status='active' LIMIT 1`).get(source.id, source.id)) return false;
    const sourceIdentity = { runId: input.runId, ...input.sourceFence };
    const completion = this.ports.getHostAttemptCompletion(sourceIdentity);
    if (completion) {
      if (!completion.drainedAt || !canonical(completion.drainedAt) || completion.drainedAt > input.now || !completion.effectCoverage) return false;
      try {
        assertUserInputDurableQuiescence(this.context.database, input.runId, input.sourceFence, Date.parse(input.now),
          hostAttemptReadScopeForSource(this.context.database, sourceIdentity));
        return true;
      } catch (error) {
        if (error instanceof UserInputStoreError && error.code === "not_quiescent") return false;
        throw error;
      }
    }
    // A replaced created Attempt may never have dispatched. Started legacy/unknown lifetimes cannot use this exception.
    const run = this.ports.getRun(input.runId)!, unit = this.ports.getWorkUnit(input.workUnitId)!;
    return !source.startedAt && !source.lastHeartbeatAt && !run.startedAt && !unit.startedAt && !unit.lastHeartbeatAt
      && !this.hasAttemptActivity(input.runId, input.sourceFence, run.createdAt);
  }

  private transferredSlots(admission: WorkflowStepStartAdmission, fence: RuntimeAttemptFenceV1): RuntimeSemaphoreSlot[] | undefined {
    const slots = this.attemptSlots(fence);
    const receipts = this.context.database.prepare(`SELECT resource_type,resource_key,slot_id FROM workflow_step_admission_entries
      WHERE task_id=?`).all(admission.owner.taskId);
    return slots.length === allEntries(admission.plan).length && slots.length === admission.slotIds.length
      && Number(this.context.database.prepare("SELECT COUNT(*) AS count FROM runtime_semaphore_slots WHERE attempt_id=? AND status='active'")
        .get(fence.attemptId)!.count) === slots.length
      && slots.every(slot => slot.workspaceId === admission.workspaceId && slot.ownerType === "work_unit_attempt"
        && slot.ownerId === fence.attemptId && receipts.some(receipt => receipt.slot_id === slot.id
          && receipt.resource_type === slot.resourceType && receipt.resource_key === slot.resourceKey)) ? slots : undefined;
  }

  private transaction<T>(operation: () => T): T {
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.context.database.exec("COMMIT"); return result; }
    catch (error) {
      try { this.context.database.exec("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Workflow admission transaction and rollback failed"); }
      throw error;
    }
  }
}
