import type { SQLOutputValue } from "node:sqlite";
import {
  createRuntimeSemaphoreSlotId,
  type AcquireRuntimeSemaphoreSlotInput,
  type ListRuntimeSemaphoreSlotsOptions,
  type RuntimeAttemptFenceV1,
  type RuntimeSemaphoreSlot,
} from "../../runtime-supervisor-types.js";
import { readNumber } from "./helpers.js";
import { mapRuntimeSemaphoreSlot } from "./runtime-work-mappers.js";
import { runtimeSemaphoreSlotSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";
import { expireRuntimeResourcesWithCancellationVeto, withCancelledAttemptResourceVeto } from "./cancelled-attempt-resource-veto.js";

export class SqliteRuntimeSemaphoreStore {
  constructor(private readonly context: SqliteStoreContext) {}

  acquireRuntimeSemaphoreSlot(input: AcquireRuntimeSemaphoreSlotInput): RuntimeSemaphoreSlot | undefined {
    const id = createRuntimeSemaphoreSlotId();
    try {
      this.context.database.exec("BEGIN IMMEDIATE;");
      const current = this.context.database.prepare(`
        SELECT 1 FROM work_unit_attempts AS attempts
        JOIN work_units AS units ON units.id = attempts.work_unit_id
        WHERE attempts.id=? AND attempts.work_unit_id=? AND attempts.runtime_instance_id=?
          AND attempts.fencing_token=? AND units.active_attempt_id=attempts.id
          AND units.workspace_id=? AND attempts.status IN ('created','started','waiting_for_approval','cancelling')
      `).get(input.attemptId, input.workUnitId, input.runtimeInstanceId, input.fencingToken, input.workspaceId);
      if (!current || (input.ownerType === "work_unit_attempt" && input.ownerId !== input.attemptId)) {
        this.context.database.exec("ROLLBACK;");
        return undefined;
      }
      this.expireRuntimeSemaphoreSlots(input.acquiredAt);
      const activeCount = readNumber(
        this.context.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM runtime_semaphore_slots
            WHERE workspace_id = ? AND resource_type = ? AND resource_key = ? AND status = 'active'
          `)
          .get(input.workspaceId, input.resourceType, input.resourceKey) as Record<string, SQLOutputValue>,
        "count",
      );
      if (activeCount >= input.limit) {
        this.context.database.exec("ROLLBACK;");
        return undefined;
      }
      this.context.database
        .prepare(`
          INSERT INTO runtime_semaphore_slots (
            id,
            workspace_id,
            resource_type,
            resource_key,
            owner_type,
            owner_id,
            work_unit_id,
            attempt_id,
            runtime_instance_id,
            fencing_token,
            status,
            acquired_at,
            last_renewed_at,
            expires_at,
            released_at,
            release_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          input.workspaceId,
          input.resourceType,
          input.resourceKey,
          input.ownerType,
          input.ownerId,
          input.workUnitId,
          input.attemptId,
          input.runtimeInstanceId,
          input.fencingToken,
          input.acquiredAt,
          input.acquiredAt,
          input.expiresAt,
          null,
          null,
        );
      this.context.database.exec("COMMIT;");
    } catch {
      try {
        this.context.database.exec("ROLLBACK;");
      } catch {
        // Keep acquire fail-closed if rollback itself cannot complete.
      }
      return undefined;
    }
    const slot = this.context.database.prepare(runtimeSemaphoreSlotSelectSql("WHERE id = ?")).get(id);
    return slot ? mapRuntimeSemaphoreSlot(slot as Record<string, SQLOutputValue>) : undefined;
  }

  renewRuntimeSemaphoreSlotsForAttempt(fence: RuntimeAttemptFenceV1, renewedAt: string): number {
    const result = this.context.database
      .prepare(`
        UPDATE runtime_semaphore_slots
        SET last_renewed_at = ?
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
      .run(renewedAt, fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
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
    return expireRuntimeResourcesWithCancellationVeto(this.context.database, "runtime_semaphore_slots", now);
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
