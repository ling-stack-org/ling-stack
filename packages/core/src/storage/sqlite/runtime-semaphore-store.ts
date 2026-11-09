import type { SQLOutputValue } from "node:sqlite";
import {
  createRuntimeSemaphoreSlotId,
  type AcquireRuntimeSemaphoreSlotInput,
  type AcquireRuntimeSemaphoreSlotsResult,
  type ListRuntimeSemaphoreSlotsOptions,
  type RuntimeAttemptFenceV1,
  type RuntimeSemaphoreSlot,
  type RuntimeResourceRenewal,
  type RuntimeSemaphoreResourceType,
} from "../../runtime-supervisor-types.js";
import { assertRuntimeResourceRenewal } from "../../runtime-resource-renewal.js";
import { mapRuntimeSemaphoreSlot } from "./runtime-work-mappers.js";
import { runtimeSemaphoreSlotSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";
import { withCancelledAttemptResourceVeto } from "./cancelled-attempt-resource-veto.js";
import { readRuntimeSemaphoreCapacity } from "./workflow-step-admission-capacity.js";
import { hasActiveWorkflowMergeApplyLease } from "./workflow-merge-lease-guard.js";
import { readWorkflowParallelParents, workflowParallelSlotAllowed, type WorkflowParallelReadPorts } from "./workflow-parallel-parent-guard.js";
import { readRuntimeRunCapacityConflict } from "./runtime-run-capacity.js";
import { recordRuntimeDelegationAttemptCapacityAdmission } from "./runtime-delegation-capacity-admission.js";

export class SqliteRuntimeSemaphoreStore {
  constructor(private readonly context: SqliteStoreContext, private readonly parallelPorts?: WorkflowParallelReadPorts) {}

  /**
   * Atomically reuses or creates the one active slot admitted for an exact
   * Attempt/resource pair. This is intentionally separate from ordinary
   * acquisition: only durable pre-start recovery may reuse an existing slot.
   */
  ensureRuntimeSemaphoreSlotForAttempt(input: AcquireRuntimeSemaphoreSlotInput):
    | { readonly status: "acquired" | "existing"; readonly slot: RuntimeSemaphoreSlot }
    | { readonly status: "full" | "changed" } {
    try {
      this.context.database.exec("BEGIN IMMEDIATE;");
      this.expireRuntimeSemaphoreSlots(input.acquiredAt);
      const result = this.ensureRuntimeSemaphoreSlotForAttemptWithinTransaction(input);
      this.context.database.exec(result.status === "acquired" || result.status === "existing" ? "COMMIT;" : "ROLLBACK;");
      return result;
    } catch {
      try {
        this.context.database.exec("ROLLBACK;");
      } catch {
        // Keep recovery fail-closed if rollback itself cannot complete.
      }
      return { status: "changed" };
    }
  }

  acquireRuntimeSemaphoreSlot(input: AcquireRuntimeSemaphoreSlotInput): RuntimeSemaphoreSlot | undefined {
    try {
      this.context.database.exec("BEGIN IMMEDIATE;");
      this.expireRuntimeSemaphoreSlots(input.acquiredAt);
      const result = this.acquireWithinTransaction(input, false);
      this.context.database.exec(result.status === "acquired" ? "COMMIT;" : "ROLLBACK;");
      return result.status === "acquired" ? result.slot : undefined;
    } catch {
      try {
        this.context.database.exec("ROLLBACK;");
      } catch {
        // Keep acquire fail-closed if rollback itself cannot complete.
      }
      return undefined;
    }
  }

  /** Ordinary admission creates a fresh group; only pre-start recovery may reuse slots. */
  acquireRuntimeSemaphoreSlots(inputs: readonly AcquireRuntimeSemaphoreSlotInput[]): AcquireRuntimeSemaphoreSlotsResult {
    let began = false;
    try {
      if (this.context.database.isTransaction) return { status: "changed" };
      this.context.database.exec("BEGIN IMMEDIATE;");
      began = true;
      if (!validRuntimeSemaphoreBatch(inputs)) {
        this.context.database.exec("ROLLBACK;");
        return { status: "changed" };
      }
      this.expireRuntimeSemaphoreSlots(inputs[0]!.acquiredAt);
      const existing = this.context.database.prepare(`SELECT 1 FROM runtime_semaphore_slots
        WHERE workspace_id=? AND resource_type=? AND resource_key=? AND owner_type=? AND owner_id=?
          AND work_unit_id=? AND attempt_id=? AND runtime_instance_id=? AND fencing_token=? AND status='active' LIMIT 1`);
      if (inputs.some(input => existing.get(input.workspaceId, input.resourceType, input.resourceKey, input.ownerType, input.ownerId,
        input.workUnitId, input.attemptId, input.runtimeInstanceId, input.fencingToken))) {
        this.context.database.exec("ROLLBACK;");
        return { status: "changed" };
      }
      const slots: RuntimeSemaphoreSlot[] = [];
      for (const input of inputs) {
        const result = this.acquireWithinTransaction(input, false);
        if (result.status !== "acquired") {
          this.context.database.exec("ROLLBACK;");
          return result.status === "full"
            ? { status: "full", resourceType: result.resourceType ?? input.resourceType, resourceKey: result.resourceKey ?? input.resourceKey }
            : { status: "changed" };
        }
        slots.push(result.slot);
      }
      this.context.database.exec("COMMIT;");
      return { status: "acquired", slots };
    } catch {
      if (began) {
        try {
          this.context.database.exec("ROLLBACK;");
        } catch {
          // Keep admission fail-closed if rollback itself cannot complete.
        }
      }
      return { status: "changed" };
    }
  }

  /** The caller owns BEGIN/COMMIT. Only an exact validated admission handoff may exclude its reservation. */
  ensureRuntimeSemaphoreSlotForAttemptWithinTransaction(input: AcquireRuntimeSemaphoreSlotInput, excludePreparingTaskId?: string):
    | { readonly status: "acquired" | "existing"; readonly slot: RuntimeSemaphoreSlot }
    | { readonly status: "full" | "changed" } {
    if (input.ownerType !== "work_unit_attempt" || input.ownerId !== input.attemptId) return { status: "changed" };
    const result = this.acquireWithinTransaction(input, true, excludePreparingTaskId);
    return result.status === "full" ? { status: "full" } : result;
  }

  private acquireWithinTransaction(input: AcquireRuntimeSemaphoreSlotInput, reuse: boolean, excludePreparingTaskId?: string):
    | { readonly status: "acquired" | "existing"; readonly slot: RuntimeSemaphoreSlot }
    | { readonly status: "full"; readonly resourceType?: RuntimeSemaphoreResourceType; readonly resourceKey?: string }
    | { readonly status: "changed" } {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) return { status: "changed" };
    try {
      if (hasActiveWorkflowMergeApplyLease(this.context.database, input.workspaceId)) return { status: "changed" };
      if (!workflowParallelSlotAllowed(this.context.database, this.parallelPorts, input, excludePreparingTaskId)) return { status: "changed" };
    } catch {
      // Invalid apply evidence vetoes admission without rolling back the caller's transaction.
      return { status: "changed" };
    }
    const current = this.context.database.prepare(`
      SELECT 1 FROM work_unit_attempts AS attempts JOIN work_units AS units ON units.id=attempts.work_unit_id
      WHERE attempts.id=? AND attempts.work_unit_id=? AND attempts.runtime_instance_id=? AND attempts.fencing_token=?
        AND units.active_attempt_id=attempts.id AND units.workspace_id=?
        AND attempts.status IN ('created','started','waiting_for_approval','cancelling')
    `).get(input.attemptId, input.workUnitId, input.runtimeInstanceId, input.fencingToken, input.workspaceId);
    if (!current || input.ownerType === "work_unit_attempt" && input.ownerId !== input.attemptId) return { status: "changed" };
    if (!reuse && readWorkflowParallelParents(this.context.database).some(parent => parent.state === "held" && parent.workspaceId === input.workspaceId)
      && this.context.database.prepare(`SELECT 1 FROM runtime_semaphore_slots WHERE workspace_id=? AND attempt_id=?
        AND resource_type=? AND resource_key=? AND status='active' LIMIT 1`).get(input.workspaceId, input.attemptId, input.resourceType, input.resourceKey))
      return { status: "changed" };
    if (reuse) {
      const rows = this.context.database.prepare(`${runtimeSemaphoreSlotSelectSql(`WHERE workspace_id=? AND resource_type=?
        AND resource_key=? AND owner_id=? AND status='active'`)} ORDER BY id LIMIT 2`)
        .all(input.workspaceId, input.resourceType, input.resourceKey, input.ownerId) as Record<string, SQLOutputValue>[];
      if (rows.length) {
        const slot = rows.length === 1 ? mapRuntimeSemaphoreSlot(rows[0]!) : undefined;
        return slot && sameExactAttemptSlot(slot, input) ? { status: "existing", slot } : { status: "changed" };
      }
    }
    if (input.resourceType === "provider" || input.resourceType === "runner") {
      const conflict = readRuntimeRunCapacityConflict(this.context.database, {
        workspaceId: input.workspaceId, fence: input, excludePreparingTaskId, now: input.acquiredAt,
      });
      if (conflict) return { status: "full", ...conflict };
    }
    const capacity = readRuntimeSemaphoreCapacity(this.context.database, { ...input, fence: input, excludePreparingTaskId, now: input.acquiredAt });
    if (capacity.occupied >= capacity.limit) return { status: "full" };
    const id = createRuntimeSemaphoreSlotId();
    this.context.database.prepare(`INSERT INTO runtime_semaphore_slots (
      id,workspace_id,resource_type,resource_key,owner_type,owner_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,
      status,acquired_at,last_renewed_at,expires_at,released_at,release_reason
    ) VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?,?,NULL,NULL)`)
      .run(id, input.workspaceId, input.resourceType, input.resourceKey, input.ownerType, input.ownerId,
        input.workUnitId, input.attemptId, input.runtimeInstanceId, input.fencingToken, input.acquiredAt, input.acquiredAt, input.expiresAt);
    if (input.resourceType === "provider" || input.resourceType === "runner")
      recordRuntimeDelegationAttemptCapacityAdmission(this.context.database, input, input.acquiredAt);
    const row = this.context.database.prepare(runtimeSemaphoreSlotSelectSql("WHERE id=?")).get(id)!;
    return { status: "acquired", slot: mapRuntimeSemaphoreSlot(row as Record<string, SQLOutputValue>) };
  }

  renewRuntimeSemaphoreSlotsForAttempt(fence: RuntimeAttemptFenceV1, renewal: RuntimeResourceRenewal): number {
    assertRuntimeResourceRenewal(renewal);
    const result = this.context.database
      .prepare(`
        UPDATE runtime_semaphore_slots
        SET last_renewed_at = MAX(last_renewed_at, ?), expires_at = MAX(expires_at, ?)
        WHERE work_unit_id = ?
          AND attempt_id = ?
          AND runtime_instance_id = ?
          AND fencing_token = ?
          AND status = 'active'
          AND EXISTS (
            SELECT 1
            FROM work_unit_attempts AS attempts
            JOIN work_units AS units ON units.id = attempts.work_unit_id
            WHERE attempts.id = runtime_semaphore_slots.attempt_id
              AND attempts.work_unit_id = runtime_semaphore_slots.work_unit_id
              AND attempts.runtime_instance_id = runtime_semaphore_slots.runtime_instance_id
              AND attempts.fencing_token = runtime_semaphore_slots.fencing_token
              AND units.active_attempt_id = attempts.id
              AND units.workspace_id = runtime_semaphore_slots.workspace_id
              AND attempts.status IN ('created','started','waiting_for_approval','cancelling')
          )
      `)
      .run(renewal.renewedAt, renewal.expiresAt, fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
    return Number(result.changes);
  }

  releaseRuntimeSemaphoreSlotsForAttempt(
    fence: RuntimeAttemptFenceV1,
    releasedAt: string,
    releaseReason: string,
  ): number {
    return withCancelledAttemptResourceVeto(this.context.database, fence, releasedAt, () => {
      const result = this.context.database
        .prepare(`
        UPDATE runtime_semaphore_slots
        SET status = 'released', released_at = ?, release_reason = ?
        WHERE work_unit_id = ?
          AND attempt_id = ?
          AND runtime_instance_id = ?
          AND fencing_token = ?
          AND status = 'active'
          AND EXISTS (
            SELECT 1
            FROM work_unit_attempts AS attempts
            JOIN work_units AS units ON units.id = attempts.work_unit_id
            WHERE attempts.id = runtime_semaphore_slots.attempt_id
              AND attempts.work_unit_id = runtime_semaphore_slots.work_unit_id
              AND attempts.runtime_instance_id = runtime_semaphore_slots.runtime_instance_id
              AND attempts.fencing_token = runtime_semaphore_slots.fencing_token
              AND units.active_attempt_id = attempts.id
          )
        `)
        .run(
          releasedAt,
          releaseReason,
          fence.workUnitId,
          fence.attemptId,
          fence.runtimeInstanceId,
          fence.fencingToken,
        );
      return Number(result.changes);
    });
  }

  expireRuntimeSemaphoreSlots(now: string): number {
    const rows = this.context.database.prepare(`
      SELECT id, work_unit_id, attempt_id, runtime_instance_id, fencing_token
      FROM runtime_semaphore_slots
      WHERE status = 'active' AND expires_at <= ?
        AND resource_type <> 'workflow_resource'
        AND NOT EXISTS (SELECT 1 FROM workflow_step_admission_entries AS entry WHERE entry.slot_id=runtime_semaphore_slots.id)
        AND EXISTS (
          SELECT 1 FROM work_unit_attempts AS attempts
          JOIN work_units AS units ON units.id = attempts.work_unit_id
          WHERE attempts.id = runtime_semaphore_slots.attempt_id
            AND attempts.work_unit_id = runtime_semaphore_slots.work_unit_id
            AND attempts.runtime_instance_id = runtime_semaphore_slots.runtime_instance_id
            AND attempts.fencing_token = runtime_semaphore_slots.fencing_token
            AND units.workspace_id = runtime_semaphore_slots.workspace_id
            AND attempts.status IN ('succeeded','failed','cancelled','lost','yielded')
            AND attempts.ended_at IS NOT NULL
        )
      ORDER BY id
    `).all(now) as Record<string, SQLOutputValue>[];
    let count = 0;
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.work_unit_id !== "string" || typeof row.attempt_id !== "string"
        || typeof row.runtime_instance_id !== "string" || typeof row.fencing_token !== "string") continue;
      const fence = { workUnitId: row.work_unit_id, attemptId: row.attempt_id,
        runtimeInstanceId: row.runtime_instance_id, fencingToken: row.fencing_token };
      count += withCancelledAttemptResourceVeto(this.context.database, fence, now, () =>
        Number(this.context.database.prepare(`
          UPDATE runtime_semaphore_slots
          SET status = 'expired', released_at = ?, release_reason = COALESCE(release_reason, 'expired')
          WHERE id = ? AND status = 'active' AND expires_at <= ?
            AND resource_type <> 'workflow_resource'
            AND NOT EXISTS (SELECT 1 FROM workflow_step_admission_entries AS entry WHERE entry.slot_id=runtime_semaphore_slots.id)
            AND work_unit_id = ? AND attempt_id = ? AND runtime_instance_id = ? AND fencing_token = ?
            AND EXISTS (
              SELECT 1 FROM work_unit_attempts AS attempts
              JOIN work_units AS units ON units.id = attempts.work_unit_id
              WHERE attempts.id = runtime_semaphore_slots.attempt_id
                AND attempts.work_unit_id = runtime_semaphore_slots.work_unit_id
                AND attempts.runtime_instance_id = runtime_semaphore_slots.runtime_instance_id
                AND attempts.fencing_token = runtime_semaphore_slots.fencing_token
                AND units.workspace_id = runtime_semaphore_slots.workspace_id
                AND attempts.status IN ('succeeded','failed','cancelled','lost','yielded')
                AND attempts.ended_at IS NOT NULL
            )
        `).run(now, row.id, now, fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken).changes));
    }
    return count;
  }

  listRuntimeSemaphoreSlots(options: ListRuntimeSemaphoreSlotsOptions = {}): RuntimeSemaphoreSlot[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.resourceType) {
      clauses.push("resource_type = ?");
      params.push(options.resourceType);
    }
    if (options.resourceKey) {
      clauses.push("resource_key = ?");
      params.push(options.resourceKey);
    }
    if (options.ownerId) {
      clauses.push("owner_id = ?");
      params.push(options.ownerId);
    }
    if (options.workUnitId) {
      clauses.push("work_unit_id = ?");
      params.push(options.workUnitId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.context.database
      .prepare(`${runtimeSemaphoreSlotSelectSql(whereClause)} ORDER BY acquired_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapRuntimeSemaphoreSlot(row as Record<string, SQLOutputValue>));
  }
}

function validRuntimeSemaphoreBatch(inputs: readonly AcquireRuntimeSemaphoreSlotInput[]): boolean {
  if (!Array.isArray(inputs) || inputs.length === 0) return false;
  const first = inputs[0];
  const commonFields = ["workspaceId", "ownerType", "ownerId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken",
    "acquiredAt", "expiresAt"] as const;
  if (!first || commonFields.some(field => typeof first[field] !== "string" || !first[field].length || first[field].trim() !== first[field])
    || first.ownerType !== "work_unit_attempt" && first.ownerType !== "system"
    || first.ownerType === "work_unit_attempt" && first.ownerId !== first.attemptId) return false;
  const acquiredAt = Date.parse(first.acquiredAt), expiresAt = Date.parse(first.expiresAt);
  if (!Number.isFinite(acquiredAt) || !Number.isFinite(expiresAt) || expiresAt <= acquiredAt
    || new Date(acquiredAt).toISOString() !== first.acquiredAt || new Date(expiresAt).toISOString() !== first.expiresAt) return false;
  const resources = new Set<string>();
  for (const input of inputs) {
    if (!input || commonFields.some(field => input[field] !== first[field])
      || !["provider", "runner", "channel_parallel", "media_provider", "workflow_resource"].includes(input.resourceType)
      || typeof input.resourceKey !== "string" || !input.resourceKey.length || input.resourceKey.trim() !== input.resourceKey
      || !Number.isSafeInteger(input.limit) || input.limit < 1) return false;
    const key = JSON.stringify([input.resourceType, input.resourceKey]);
    if (resources.has(key)) return false;
    resources.add(key);
  }
  return true;
}

function sameExactAttemptSlot(slot: RuntimeSemaphoreSlot, input: AcquireRuntimeSemaphoreSlotInput): boolean {
  return slot.workspaceId === input.workspaceId
    && slot.resourceType === input.resourceType
    && slot.resourceKey === input.resourceKey
    && slot.ownerType === input.ownerType
    && slot.ownerId === input.ownerId
    && slot.workUnitId === input.workUnitId
    && slot.attemptId === input.attemptId
    && slot.runtimeInstanceId === input.runtimeInstanceId
    && slot.fencingToken === input.fencingToken;
}
