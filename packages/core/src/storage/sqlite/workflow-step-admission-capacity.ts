import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSemaphoreResourceType } from "../../runtime-supervisor-types.js";

/** Call under the caller's write transaction. TTL alone never subtracts a preparing owner. */
export function readRuntimeSemaphoreCapacity(database: DatabaseSync, input: {
  readonly workspaceId: string;
  readonly resourceType: RuntimeSemaphoreResourceType;
  readonly resourceKey: string;
  readonly limit: number;
  readonly excludePreparingTaskId?: string;
}): { readonly occupied: number; readonly limit: number } {
  const slots = database.prepare(`SELECT COUNT(*) AS count FROM runtime_semaphore_slots
    WHERE workspace_id=? AND resource_type=? AND resource_key=? AND status='active'`)
    .get(input.workspaceId, input.resourceType, input.resourceKey)!;
  const reservations = database.prepare(`SELECT
      COALESCE(SUM(CASE WHEN admission.status='preparing' AND admission.task_id<>? THEN 1 ELSE 0 END),0) AS count,
      MIN(entry.capacity_limit) AS capacity_limit
    FROM workflow_step_admission_entries AS entry
    JOIN workflow_step_admissions AS admission ON admission.task_id=entry.task_id
    LEFT JOIN runtime_semaphore_slots AS slot ON slot.id=entry.slot_id
    WHERE admission.workspace_id=? AND entry.resource_type=? AND entry.resource_key=?
      AND (admission.status='preparing' OR admission.status='transferred' AND slot.status='active')`)
    .get(input.excludePreparingTaskId ?? "", input.workspaceId, input.resourceType, input.resourceKey)!;
  return { occupied: Number(slots.count) + Number(reservations.count),
    limit: Math.min(input.resourceType === "workflow_resource" ? 1 : input.limit,
      reservations.capacity_limit === null ? input.limit : Number(reservations.capacity_limit)) };
}
