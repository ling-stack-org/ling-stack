import type { DatabaseSync } from "node:sqlite";
import type { RuntimeAttemptFenceV1, RuntimeSemaphoreResourceType } from "../../runtime-supervisor-types.js";
import { SqliteRuntimeConcurrencyPolicyStore } from "./runtime-concurrency-policy-store.js";
import { readRuntimeDelegationCapacityReservations, sameRuntimeCapacityFence } from "./runtime-delegation-capacity.js";

/** Call under the caller's write transaction. TTL alone never subtracts a preparing owner. */
export function readRuntimeSemaphoreCapacity(database: DatabaseSync, input: {
  readonly workspaceId: string;
  readonly resourceType: RuntimeSemaphoreResourceType;
  readonly resourceKey: string;
  readonly limit: number;
  readonly excludePreparingTaskId?: string;
  readonly fence?: RuntimeAttemptFenceV1;
  readonly excludeDelegationRunId?: string;
  readonly now?: string;
}): { readonly occupied: number; readonly limit: number } {
  const slots = database.prepare(`SELECT COUNT(*) AS count FROM runtime_semaphore_slots
    WHERE workspace_id=? AND resource_type=? AND resource_key=? AND status='active'`)
    .get(input.workspaceId, input.resourceType, input.resourceKey)!;
  const reservations = database.prepare(`SELECT
      COALESCE(SUM(CASE WHEN admission.status='preparing' AND admission.task_id<>? THEN 1 ELSE 0 END),0) AS count,
      MAX(CASE WHEN admission.status='preparing' AND admission.task_id=? THEN 1 ELSE 0 END) AS retained,
      MIN(entry.capacity_limit) AS capacity_limit
    FROM workflow_step_admission_entries AS entry
    JOIN workflow_step_admissions AS admission ON admission.task_id=entry.task_id
    LEFT JOIN runtime_semaphore_slots AS slot ON slot.id=entry.slot_id
    WHERE admission.workspace_id=? AND entry.resource_type=? AND entry.resource_key=?
      AND (admission.status='preparing' OR admission.status='transferred' AND slot.status='active')`)
    .get(input.excludePreparingTaskId ?? "", input.excludePreparingTaskId ?? "", input.workspaceId, input.resourceType, input.resourceKey)!;
  const policy = new SqliteRuntimeConcurrencyPolicyStore({ database }).getRuntimeConcurrencyPolicy(input.workspaceId);
  const limits = policy?.enabled ? policy.limits : undefined;
  const currentLimit = input.resourceType === "provider" ? limits?.maxRunsPerProvider
    : input.resourceType === "runner" ? limits?.maxRunsPerRunner : undefined;
  let delegated = 0, retainedDelegation = false;
  if (input.resourceType === "provider" || input.resourceType === "runner") {
    for (const reservation of readRuntimeDelegationCapacityReservations(database, input.workspaceId, input.now)) {
      if (!limits && !reservation.hasOperationalAdmission) continue;
      const matches = input.resourceType === "provider"
        ? reservation.providerKey === input.resourceKey && !reservation.hasProviderSlot
        : reservation.runnerId === input.resourceKey && !reservation.hasRunnerSlot;
      if (!matches) continue;
      if (reservation.runId === input.excludeDelegationRunId || sameRuntimeCapacityFence(input.fence, reservation.fence)) retainedDelegation = true;
      else delegated++;
    }
  }
  const occupied = Number(slots.count) + Number(reservations.count) + delegated;
  // Operational Provider/Runner caps do not rewrite the frozen semantic resource plan.
  const limit = currentLimit ?? Math.min(input.resourceType === "workflow_resource" ? 1 : input.limit,
    reservations.capacity_limit === null ? input.limit : Number(reservations.capacity_limit));
  const retainedOperational = (input.resourceType === "provider" || input.resourceType === "runner")
    && (Number(reservations.retained) === 1 || retainedDelegation);
  return { occupied, limit: retainedOperational
    ? Math.max(limit, occupied + 1) : limit };
}
