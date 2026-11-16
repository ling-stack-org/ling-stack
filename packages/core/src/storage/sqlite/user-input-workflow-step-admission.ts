import { isDeepStrictEqual } from "node:util";
import type { SQLOutputValue } from "node:sqlite";
import type { RunStore } from "../../run-types.js";
import { toRuntimeAttemptFence, type AcquireRuntimeSemaphoreSlotInput, type RuntimeSemaphoreSlot } from "../../runtime-supervisor-types.js";
import type { UserInputContinuationSeed } from "../../user-input-continuation-types.js";
import type { RecoverUserInputContinuationPrestart, UserInputContinuationBinding } from "../../user-input-host-continuation-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import { isWorkflowStepStartOwnerV1, workflowStepStartAuthorityBasis, workflowStepStartOwnerMatches,
  type WorkflowStepStartReadStore } from "../../workflow-step-start-owner.js";
import type { SqliteStoreContext } from "./store-context.js";
import { normalizeWorkflowStepAdmissionPlan, type SqliteWorkflowStepAdmissionStore } from "./workflow-step-admission-store.js";
import { assertUserInputQuiescence } from "./user-input-wait-evidence.js";

type Ports = WorkflowStepStartReadStore & Pick<RunStore, "getWorkUnit" | "getWorkUnitAttempt" | "getUserInputWait">;
type Row = Record<string, SQLOutputValue>;
type BindingReader = (threadId: string, deliveryId: string) => UserInputContinuationBinding | undefined;
type SeedReader = (threadId: string, deliveryId: string) => UserInputContinuationSeed | undefined;

export type UserInputWorkflowAdmissionRecoveryPlan =
  | { readonly status: "changed" }
  | { readonly status: "planned"; readonly semaphores: readonly AcquireRuntimeSemaphoreSlotInput[];
      readonly commit: (slots: readonly RuntimeSemaphoreSlot[]) => boolean };

/** Composition only: caller owns BEGIN IMMEDIATE, current binding, delivery claim and rollback. */
export function prepareUserInputWorkflowStepAdmissionRecovery(context: SqliteStoreContext, ports: Ports,
  admissions: SqliteWorkflowStepAdmissionStore, seed: UserInputContinuationSeed | undefined,
  input: RecoverUserInputContinuationPrestart, binding: UserInputContinuationBinding): UserInputWorkflowAdmissionRecoveryPlan {
  const changed = { status: "changed" } as const;
  if (!seed) return changed;
  const source = seed.source, taskId = source.taskBinding.taskId;
  const row = context.database.prepare("SELECT * FROM workflow_step_admissions WHERE task_id=?").get(taskId) as Row | undefined;
  if (!row) return input.workflowAdmission === undefined
    ? { status: "planned", semaphores: input.semaphores, commit: () => true } : changed;
  const step = source.workflowStepId ? ports.getChannelWorkflowStep(source.workflowStepId) : undefined;
  const owner = binding.workflowStartOwner;
  const plan = input.workflowAdmission && normalizeWorkflowStepAdmissionPlan(input.workflowAdmission);
  if (!step || !owner || !plan || !isDeepStrictEqual(plan, JSON.parse(String(row.plan_json)))
    || row.status !== "transferred" || row.workflow_step_id !== step.id || row.workflow_id !== step.workflowId
    || row.workspace_id !== source.workspaceId || step.workspaceId !== source.workspaceId || step.channelId !== source.channelId
    || owner.taskId !== taskId || step.taskId !== taskId || step.runId !== binding.runId || step.status !== "running"
    || owner.phase !== "linked" || !workflowStepStartOwnerMatches(step.metadata?.startOwner, owner)
    || workflowStepStartAuthorityBasis(ports, step) !== owner.authorityBasis
    || binding.runId !== seed.successorRunId || binding.seedRef.id !== seed.id || binding.seedRef.fingerprint !== seed.fingerprint
    || !isDeepStrictEqual(binding.fence, input.sourceFence)) return changed;
  const sourceRun = ports.getRun(source.runId), targetRun = ports.getRun(binding.runId), task = ports.getTask(taskId);
  const unit = ports.getWorkUnit(binding.fence.workUnitId), target = ports.getWorkUnitAttempt(binding.fence.attemptId);
  const prior = ports.getWorkUnitAttempt(source.fence.attemptId), wait = ports.getUserInputWait(source.threadId, seed.request.requestId);
  const snapshot = sourceRun?.requestSnapshot;
  const sourceOwner = isRecord(snapshot) ? snapshot.workflowStartOwner : undefined;
  if (!sourceRun || !targetRun || !task || !unit || !target || !prior || !wait || !isWorkflowStepStartOwnerV1(sourceOwner)
    || sourceOwner.taskId !== taskId || sourceOwner.leaseId === owner.leaseId || sourceOwner.authorityBasis !== owner.authorityBasis
    || sourceRun.status !== "yielded" || prior.status !== "yielded" || prior.endedAt !== seed.checkpoint.quiescence.stoppedAt
    || sourceRun.endedAt !== prior.endedAt || prior.endedAt > target.createdAt || prior.endedAt > input.now
    || !isDeepStrictEqual(toRuntimeAttemptFence(prior), source.fence) || prior.attemptNumber >= target.attemptNumber
    || sourceRun.taskId !== taskId || sourceRun.workflowStepId !== step.id || sourceRun.workUnitId !== unit.id
    || sourceRun.channelId !== step.channelId || sourceRun.teammateId !== step.toParticipantId
    || targetRun.parentRunId !== sourceRun.id || targetRun.continuationReason !== "user_input_answer"
    || targetRun.taskId !== taskId || targetRun.workflowStepId !== step.id || targetRun.workUnitId !== unit.id
    || targetRun.channelId !== step.channelId || targetRun.teammateId !== step.toParticipantId
    || targetRun.status !== "queued" || targetRun.startedAt || targetRun.endedAt || task.currentRunId !== targetRun.id
    || !["claimed", "running"].includes(task.status) || task.assigneeTeammateId !== step.toParticipantId
    || unit.workspaceId !== step.workspaceId || unit.ownerType !== "task" || unit.ownerId !== taskId || unit.taskId !== taskId
    || unit.channelId !== step.channelId || unit.teammateId !== step.toParticipantId || unit.kind !== "task_run"
    || unit.status !== "claimed" || unit.endedAt || unit.linkedRunId !== targetRun.id || unit.activeAttemptId !== target.id
    || target.status !== "created" || target.startedAt || target.endedAt || target.lastHeartbeatAt || target.abortRequestedAt
    || !isDeepStrictEqual(toRuntimeAttemptFence(target), binding.fence)
    || plan.entries.filter(entry => entry.resourceType === "runner").some(entry => entry.resourceKey !== target.effectiveRunnerId)
    || wait.status !== "resuming" || wait.revision !== binding.waitRevision || !isDeepStrictEqual(wait.checkpoint, seed.checkpoint)
    || context.database.prepare(`SELECT 1 FROM runtime_semaphore_slots WHERE attempt_id=? AND status='active'
      UNION ALL SELECT 1 FROM resource_leases WHERE attempt_id=? AND status='active' LIMIT 1`).get(prior.id, prior.id)
    || context.database.prepare(`SELECT 1 FROM host_attempt_completions WHERE attempt_id=?
      UNION ALL SELECT 1 FROM runtime_heartbeats WHERE attempt_id=?
      UNION ALL SELECT 1 FROM host_operations WHERE attempt_id=?
      UNION ALL SELECT 1 FROM harness_tool_executions WHERE attempt_id=?
      UNION ALL SELECT 1 FROM native_submissions WHERE attempt_id=?
      UNION ALL SELECT 1 FROM runtime_events WHERE work_unit_id=? AND type='work_unit_started' AND ts>=?
      UNION ALL SELECT 1 FROM run_events WHERE run_id=?
        AND type IN ('tool_start','tool_end','host_command_prepared','host_command_settled') LIMIT 1`)
      .get(target.id, target.id, target.id, target.id, target.id, unit.id, target.createdAt, targetRun.id)) return changed;
  const lease = context.database.prepare(`SELECT 1 FROM resource_leases WHERE id=? AND workspace_id=?
    AND resource_type='workflow_step' AND resource_key=? AND owner_type='workflow_step' AND owner_id=?
    AND status=? AND attempt_id IS NULL AND work_unit_id IS NULL AND runtime_instance_id IS NULL AND fencing_token IS NULL
    AND (status='released' AND release_reason='user_input_yielded' AND released_at<=? OR status='active' AND expires_at>?)`);
  if (!lease.get(sourceOwner.leaseId, step.workspaceId, step.id, step.id, "released", input.now, input.now)
    || !lease.get(owner.leaseId, step.workspaceId, step.id, step.id, "active", input.now, input.now)) return changed;
  try {
    assertUserInputQuiescence(context.database, sourceRun.id, seed.checkpoint.quiescence, input.now, source.fence);
  } catch (error) {
    if (error instanceof UserInputStoreError && error.code === "not_quiescent") return changed;
    throw error;
  }
  const alreadyBound = row.lease_id === owner.leaseId && row.authority_basis === owner.authorityBasis
    && row.run_id === binding.runId && sameRowFence(row, binding.fence);
  if (!alreadyBound && (row.lease_id !== sourceOwner.leaseId || row.authority_basis !== sourceOwner.authorityBasis
    || row.run_id !== sourceRun.id || !sameRowFence(row, source.fence))) return changed;
  // Getter validates the normalized plan against every durable entry, including exclusive keys.
  const admission = admissions.getChannelWorkflowStepStartAdmission(step.id, alreadyBound ? owner : sourceOwner);
  if (!admission) return changed;
  const semaphores: AcquireRuntimeSemaphoreSlotInput[] = [
    ...plan.entries, ...plan.resourceKeys.map(resourceKey => ({ resourceType: "workflow_resource" as const, resourceKey, limit: 1 })),
  ].map(entry => ({ ...entry, workspaceId: step.workspaceId, ...binding.fence, ownerType: "work_unit_attempt" as const,
    ownerId: target.id, acquiredAt: input.now, expiresAt: input.expiresAt }));
  const resourceKey = (value: { resourceType: string; resourceKey: string }) => JSON.stringify([value.resourceType, value.resourceKey]);
  if (new Set(input.semaphores.map(resourceKey)).size !== input.semaphores.length
    || input.semaphores.some(value => !semaphores.some(expected => resourceKey(expected) === resourceKey(value)
      && value.workspaceId === expected.workspaceId && value.ownerType === expected.ownerType && value.ownerId === expected.ownerId
      && value.limit === expected.limit && sameFence(value, binding.fence)))) return changed;
  const receipts = context.database.prepare(`SELECT entry.resource_type AS planned_type,entry.resource_key AS planned_key,entry.slot_id,slot.*
    FROM workflow_step_admission_entries AS entry LEFT JOIN runtime_semaphore_slots AS slot ON slot.id=entry.slot_id WHERE entry.task_id=?`)
    .all(taskId);
  const receiptFence = alreadyBound ? binding.fence : source.fence;
  if (receipts.length !== semaphores.length || receipts.some(receipt => receipt.workspace_id !== step.workspaceId
    || receipt.resource_type !== receipt.planned_type || receipt.resource_key !== receipt.planned_key
    || receipt.owner_type !== "work_unit_attempt" || receipt.owner_id !== receiptFence.attemptId || !sameRowFence(receipt, receiptFence)
    || (receipt.status === "active" ? !alreadyBound || receipt.released_at !== null
      : receipt.status !== "released" || typeof receipt.released_at !== "string" || receipt.released_at > input.now))) return changed;
  const activeTarget = context.database.prepare("SELECT * FROM runtime_semaphore_slots WHERE (attempt_id=? OR owner_id=?) AND status='active'")
    .all(target.id, target.id);
  if (activeTarget.some(slot => !alreadyBound || !receipts.some(receipt => receipt.slot_id === slot.id))) return changed;
  return { status: "planned", semaphores, commit: slots => {
    if (slots.length !== semaphores.length || new Set(slots.map(slot => slot.id)).size !== slots.length
      || slots.some(slot => slot.status !== "active" || !semaphores.some(expected => resourceKey(expected) === resourceKey(slot)
        && slot.workspaceId === expected.workspaceId && slot.ownerType === expected.ownerType && slot.ownerId === expected.ownerId
        && sameFence(slot, binding.fence)))) return false;
    for (const slot of slots) {
      const receipt = receipts.find(value => value.planned_type === slot.resourceType && value.planned_key === slot.resourceKey)!;
      const updated = context.database.prepare(`UPDATE workflow_step_admission_entries SET slot_id=?
        WHERE task_id=? AND resource_type=? AND resource_key=? AND slot_id=?`)
        .run(slot.id, taskId, slot.resourceType, slot.resourceKey, receipt.slot_id!);
      if (Number(updated.changes) !== 1) return false;
    }
    const updated = context.database.prepare(`UPDATE workflow_step_admissions SET lease_id=?,authority_basis=?,run_id=?,
      work_unit_id=?,attempt_id=?,runtime_instance_id=?,fencing_token=?,transferred_at=?
      WHERE task_id=? AND status='transferred' AND lease_id=? AND authority_basis=? AND run_id=?
        AND work_unit_id=? AND attempt_id=? AND runtime_instance_id=? AND fencing_token=?`)
      .run(owner.leaseId, owner.authorityBasis, binding.runId, binding.fence.workUnitId, target.id, binding.fence.runtimeInstanceId,
        binding.fence.fencingToken, input.now, taskId, row.lease_id!, row.authority_basis!, row.run_id!, row.work_unit_id!,
        row.attempt_id!, row.runtime_instance_id!, row.fencing_token!);
    return Number(updated.changes) === 1
      && admissions.isTransferredWithinTransaction(step.id, owner, binding.runId, binding.fence);
  } };
}

/** Only the complete immutable user-input ancestry can replace the no-sibling rule; arbitrary sibling Runs remain invalid. */
export function hasUserInputWorkflowTaskRunLineage(context: SqliteStoreContext, ports: Pick<RunStore, "getRun">,
  readBinding: BindingReader, readSeed: SeedReader, taskId: string, runId: string): boolean {
  const remaining = new Set(context.database.prepare("SELECT id FROM run_sessions WHERE task_id=?").all(taskId).map(row => String(row.id)));
  let current = ports.getRun(runId);
  while (current && remaining.delete(current.id)) {
    if (!current.parentRunId || current.continuationReason !== "user_input_answer") return remaining.size === 0;
    const rows = context.database.prepare(`SELECT delivery.delivery_id,request.thread_id FROM user_input_deliveries AS delivery
      JOIN user_input_answers AS answer ON answer.answer_id=delivery.answer_id
      JOIN user_input_requests AS request ON request.request_id=answer.request_id WHERE delivery.successor_run_id=?`).all(current.id);
    if (rows.length !== 1) return false;
    const binding = readBinding(String(rows[0]!.thread_id), String(rows[0]!.delivery_id));
    const seed = readSeed(String(rows[0]!.thread_id), String(rows[0]!.delivery_id));
    if (!binding || !seed || binding.runId !== current.id || binding.fence.workUnitId !== current.workUnitId
      || seed.source.runId !== current.parentRunId || seed.source.taskBinding.taskId !== taskId
      || seed.source.fence.workUnitId !== current.workUnitId) return false;
    current = ports.getRun(current.parentRunId);
  }
  return false;
}

function sameRowFence(row: Row, fence: UserInputContinuationBinding["fence"]): boolean {
  return row.work_unit_id === fence.workUnitId && row.attempt_id === fence.attemptId
    && row.runtime_instance_id === fence.runtimeInstanceId && row.fencing_token === fence.fencingToken;
}

function sameFence(value: UserInputContinuationBinding["fence"], fence: UserInputContinuationBinding["fence"]): boolean {
  return value.workUnitId === fence.workUnitId && value.attemptId === fence.attemptId
    && value.runtimeInstanceId === fence.runtimeInstanceId && value.fencingToken === fence.fencingToken;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
