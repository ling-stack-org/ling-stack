import type { DatabaseSync } from "node:sqlite";
import { readWorkflowParallelParents } from "./workflow-parallel-parent-guard.js";

const permits = "workflow_merge_apply_permits";
const invalidLease = `lease.id IS NULL OR typeof(permit.lease_id)<>'text' OR length(permit.lease_id)=0
  OR typeof(permit.permit_id)<>'text' OR length(permit.permit_id)=0
  OR typeof(permit.created_at)<>'text' OR length(permit.created_at)=0
  OR typeof(permit.expires_at)<>'text' OR length(permit.expires_at)=0
  OR typeof(lease.workspace_id)<>'text' OR length(lease.workspace_id)=0
  OR lease.resource_type IS NOT 'bound_path' OR lease.owner_type IS NOT 'system'
  OR typeof(lease.resource_key)<>'text' OR length(lease.resource_key)=0
  OR generation.round_id IS NULL OR json_valid(generation.inputs_json) IS NOT 1
  OR lease.workspace_id IS NOT (CASE WHEN json_valid(generation.inputs_json)
    THEN json_extract(generation.inputs_json,'$.canonicalWorkspaceId') END)
  OR lease.resource_key IS NOT (CASE WHEN json_valid(generation.inputs_json)
    THEN json_extract(generation.inputs_json,'$.target.executionRoot') END)
  OR lease.owner_id IS NOT permit.permit_id OR lease.acquired_at IS NOT permit.created_at
  OR lease.expires_at IS NOT permit.expires_at
  OR lease.work_unit_id IS NOT NULL OR lease.attempt_id IS NOT NULL
  OR lease.runtime_instance_id IS NOT NULL OR lease.fencing_token IS NOT NULL
  OR lease.status IS NULL OR lease.status NOT IN ('active','released')`;
const blockingLease = `${invalidLease} OR (lease.workspace_id=? AND lease.status='active')`;
const permitLeases = `${permits} AS permit LEFT JOIN resource_leases AS lease ON lease.id=permit.lease_id
  LEFT JOIN workflow_integration_generations AS generation ON generation.round_id=permit.round_id AND generation.generation=permit.generation`;

function hasTable(database: DatabaseSync, name: string): boolean {
  const row = database.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name);
  if (!row) return false;
  if (row.type !== "table") throw new Error(`workflow_merge.lease_guard_schema_invalid:${name}`);
  return true;
}

/** SQL fragments for atomic resource admission and generic cleanup, never an authority grant. */
export function workflowMergeApplyLeaseSql(database: DatabaseSync): {
  readonly workspaceAvailable?: string;
  readonly leaseUnreferenced: string;
} {
  if (!hasTable(database, permits)) return { leaseUnreferenced: "1" };
  // Prepare even when there are no rows: a damaged overlay must not look like an absent migration.
  database.prepare(`SELECT permit.lease_id FROM ${permitLeases} WHERE ${blockingLease} LIMIT 1`);
  return {
    workspaceAvailable: `NOT EXISTS (SELECT 1 FROM ${permitLeases} WHERE ${blockingLease})`,
    leaseUnreferenced: `NOT EXISTS (SELECT 1 FROM ${permits} AS permit WHERE permit.lease_id=resource_leases.id)`,
  };
}

/** Caller owns the admission transaction. Expiration never proves an apply effect has stopped. */
export function hasActiveWorkflowMergeApplyLease(database: DatabaseSync, workspaceId: string): boolean {
  if (!hasTable(database, permits)) return false;
  const row = database.prepare(`SELECT permit.lease_id,CASE WHEN ${invalidLease} THEN 1 ELSE 0 END AS invalid
    FROM ${permitLeases} WHERE ${blockingLease} ORDER BY invalid DESC LIMIT 1`).get(workspaceId);
  if (row?.invalid === 1) throw new Error("workflow_merge.apply_lease_evidence_invalid");
  return Boolean(row);
}

/** Reverse admission guard; call before acquiring the apply lease, under the same write transaction. */
export function workflowMergeApplyWorkspaceBusy(database: DatabaseSync, workspaceId: string,
  ownRound?: { readonly roundId: string; readonly generation: number }): boolean {
  if (readWorkflowParallelParents(database).some(parent => parent.state === "held" && parent.workspaceId === workspaceId
    && (parent.roundId !== ownRound?.roundId || parent.generation !== ownRound.generation))) return true;
  if (hasActiveWorkflowMergeApplyLease(database, workspaceId)) return true;
  for (const [table, condition] of [
    ["resource_leases", "status='active' AND resource_type IN ('workspace','channel','bound_path')"],
    ["workflow_step_admissions", "status='preparing'"],
    ["runtime_semaphore_slots", "status='active'"],
  ] as const) {
    if (hasTable(database, table)
      && database.prepare(`SELECT 1 FROM ${table} WHERE workspace_id=? AND ${condition} LIMIT 1`).get(workspaceId)) return true;
  }
  return false;
}
