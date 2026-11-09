import type { DatabaseSync } from "node:sqlite";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { SqliteRuntimeConcurrencyPolicyStore } from "./runtime-concurrency-policy-store.js";

/** The receipt belongs to one execution lifetime, not the child's reusable token budget. */
export function recordRuntimeDelegationCapacityAdmission(database: DatabaseSync, input: {
  readonly reservationId: string;
  readonly attemptNumber: number;
  readonly workspaceId: string;
  readonly providerKey: string;
  readonly runnerId: string;
  readonly now: string;
}): void {
  if (!database.isTransaction) throw new Error("runtime_delegation_capacity_admission.transaction_required");
  const policy = new SqliteRuntimeConcurrencyPolicyStore({ database }).getRuntimeConcurrencyPolicy(input.workspaceId);
  if (!policy?.enabled) return;
  const existing = database.prepare(`SELECT workspace_id,provider_key,runner_id FROM runtime_delegation_capacity_admissions
    WHERE reservation_id=? AND attempt_number=?`).get(input.reservationId, input.attemptNumber);
  if (existing) {
    if (existing.workspace_id !== input.workspaceId || existing.provider_key !== input.providerKey || existing.runner_id !== input.runnerId)
      throw new Error("runtime_delegation_capacity_admission.identity_changed");
    return;
  }
  database.prepare(`INSERT INTO runtime_delegation_capacity_admissions
    (reservation_id,attempt_number,workspace_id,provider_key,runner_id,policy_revision,admitted_at) VALUES (?,?,?,?,?,?,?)`)
    .run(input.reservationId, input.attemptNumber, input.workspaceId, input.providerKey, input.runnerId, policy.revision, input.now);
}

/** An enabled partial slot handoff also seals a legacy child's exact execution admission. */
export function recordRuntimeDelegationAttemptCapacityAdmission(database: DatabaseSync, fence: RuntimeAttemptFenceV1, now: string): void {
  const row = database.prepare(`SELECT reservation.id,unit.workspace_id,attempt.attempt_number,
      COALESCE(child.provider_preset_id,child.provider_name || ':' || child.provider_model) AS provider_key,
      COALESCE(unit.effective_runner_id,unit.runner_id) AS runner_id
    FROM delegation_budget_reservations reservation JOIN run_sessions child ON child.id=reservation.child_run_id
    JOIN work_units unit ON unit.id=child.work_unit_id AND unit.linked_run_id=child.id
    JOIN delegation_steps step ON step.id=reservation.delegation_step_id
      AND unit.owner_type='delegation_step' AND unit.owner_id=step.id
    JOIN work_unit_attempts attempt ON attempt.id=unit.active_attempt_id AND attempt.work_unit_id=unit.id
    WHERE unit.id=? AND attempt.id=? AND attempt.runtime_instance_id=? AND attempt.fencing_token=?
      AND reservation.state IN ('reserved','unresolved')`)
    .get(fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
  if (!row) return;
  if (typeof row.id !== "string" || typeof row.workspace_id !== "string" || typeof row.provider_key !== "string"
    || typeof row.runner_id !== "string" || typeof row.attempt_number !== "number")
    throw new Error("runtime_delegation_capacity_admission.identity_invalid");
  recordRuntimeDelegationCapacityAdmission(database, { reservationId: row.id, attemptNumber: row.attempt_number,
    workspaceId: row.workspace_id, providerKey: row.provider_key, runnerId: row.runner_id, now });
}
