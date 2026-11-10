import type { DatabaseSync } from "node:sqlite";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { hasDelegationStoppedHandoff } from "./delegation-stopped-handoff.js";

interface DelegationCapacityReservation {
  readonly runId: string;
  readonly providerKey: string;
  readonly runnerId: string;
  readonly fence?: RuntimeAttemptFenceV1;
  readonly hasExecutionSlot: boolean;
  readonly hasProviderSlot: boolean;
  readonly hasRunnerSlot: boolean;
  readonly hasOperationalAdmission: boolean;
}

export function sameRuntimeCapacityFence(left: RuntimeAttemptFenceV1 | undefined, right: RuntimeAttemptFenceV1 | undefined): boolean {
  return !!left && !!right && left.workUnitId === right.workUnitId && left.attemptId === right.attemptId
    && left.runtimeInstanceId === right.runtimeInstanceId && left.fencingToken === right.fencingToken;
}

/** Budget reservation and child identity commit together before any claim or physical dispatch. */
export function readRuntimeDelegationCapacityReservations(database: DatabaseSync, workspaceId: string, now?: string): readonly DelegationCapacityReservation[] {
  const capacityTable = database.prepare("SELECT type FROM sqlite_master WHERE name=?").get("runtime_delegation_capacity_admissions");
  if (!capacityTable) return [];
  if (capacityTable.type !== "table") throw new Error("runtime_concurrency_delegation_reservation_schema_invalid");
  const rows = database.prepare(`SELECT child.id,step.state,unit.id AS work_unit_id,
      COALESCE(child.provider_preset_id,child.provider_name || ':' || child.provider_model) AS provider_key,
      COALESCE(unit.effective_runner_id,unit.runner_id) AS runner_id,
      EXISTS (SELECT 1 FROM runtime_delegation_capacity_admissions admission
        WHERE admission.reservation_id=reservation.id AND admission.workspace_id=unit.workspace_id
          AND admission.attempt_number=COALESCE(attempt.attempt_number,CASE WHEN unit.attempt_count=0 THEN 1 END)
          AND admission.provider_key=COALESCE(child.provider_preset_id,child.provider_name || ':' || child.provider_model)
          AND admission.runner_id=COALESCE(unit.effective_runner_id,unit.runner_id)) AS has_operational_admission,
      attempt.id AS attempt_id,attempt.runtime_instance_id,attempt.fencing_token,
      EXISTS (SELECT 1 FROM runtime_semaphore_slots slot WHERE slot.workspace_id=unit.workspace_id
        AND slot.work_unit_id=unit.id AND slot.attempt_id=attempt.id AND slot.runtime_instance_id=attempt.runtime_instance_id
        AND slot.fencing_token=attempt.fencing_token AND slot.status='active' AND slot.resource_type IN ('provider','runner')) AS has_execution_slot,
      EXISTS (SELECT 1 FROM runtime_semaphore_slots slot WHERE slot.workspace_id=unit.workspace_id
        AND slot.work_unit_id=unit.id AND slot.attempt_id=attempt.id AND slot.runtime_instance_id=attempt.runtime_instance_id
        AND slot.fencing_token=attempt.fencing_token AND slot.status='active' AND slot.resource_type='provider'
        AND slot.resource_key=COALESCE(child.provider_preset_id,child.provider_name || ':' || child.provider_model)) AS has_provider_slot,
      EXISTS (SELECT 1 FROM runtime_semaphore_slots slot WHERE slot.workspace_id=unit.workspace_id
        AND slot.work_unit_id=unit.id AND slot.attempt_id=attempt.id AND slot.runtime_instance_id=attempt.runtime_instance_id
        AND slot.fencing_token=attempt.fencing_token AND slot.status='active' AND slot.resource_type='runner'
        AND slot.resource_key=COALESCE(unit.effective_runner_id,unit.runner_id)) AS has_runner_slot
    FROM delegation_budget_reservations reservation
    JOIN run_sessions child ON child.id=reservation.child_run_id
    JOIN work_units unit ON unit.id=child.work_unit_id AND unit.linked_run_id=child.id
    JOIN delegation_steps step ON step.id=reservation.delegation_step_id
      AND unit.owner_type='delegation_step' AND unit.owner_id=step.id
    LEFT JOIN work_unit_attempts attempt ON attempt.id=unit.active_attempt_id AND attempt.work_unit_id=unit.id
    WHERE unit.workspace_id=? AND reservation.state IN ('reserved','unresolved')`).all(workspaceId);
  const reservations: DelegationCapacityReservation[] = [];
  for (const row of rows) {
    if (typeof row.id !== "string" || typeof row.provider_key !== "string" || typeof row.runner_id !== "string") {
      throw new Error("runtime_concurrency_delegation_reservation_invalid");
    }
    const fence = typeof row.attempt_id === "string" && typeof row.runtime_instance_id === "string" && typeof row.fencing_token === "string"
      ? { workUnitId: String(row.work_unit_id), attemptId: row.attempt_id,
        runtimeInstanceId: row.runtime_instance_id, fencingToken: row.fencing_token } : undefined;
    if (row.state === "interrupted" && fence && now && hasDelegationStoppedHandoff(database, fence, now)) continue;
    reservations.push({ runId: row.id, providerKey: row.provider_key, runnerId: row.runner_id, fence,
      hasExecutionSlot: Number(row.has_execution_slot) === 1, hasProviderSlot: Number(row.has_provider_slot) === 1,
      hasRunnerSlot: Number(row.has_runner_slot) === 1, hasOperationalAdmission: Number(row.has_operational_admission) === 1 });
  }
  return reservations;
}
