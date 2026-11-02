import type { DatabaseSync } from "node:sqlite";
import type { WorkflowIsolationSelection } from "../../workflow-isolation-types.js";
import { workflowIsolationIdentity, workflowIsolationTime } from "../../workflow-isolation.js";

export function readWorkflowIsolationSelection(database: DatabaseSync, workflowId: string): WorkflowIsolationSelection | undefined {
  const object = database.prepare("SELECT type FROM sqlite_master WHERE name='workflow_isolation_selections'").get();
  const installed = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
    && database.prepare("SELECT 1 FROM schema_migrations WHERE version=211").get();
  if (!object && !installed) return undefined;
  if (object?.type !== "table" || !installed) throw new Error("workflow_isolation.selection_schema_invalid");
  const row = database.prepare("SELECT * FROM workflow_isolation_selections WHERE workflow_id=?").get(workflowId);
  if (!row) return undefined;
  if (row.workflow_id !== workflowId || row.profile !== "pi_host_isolated_files_v1"
    || !workflowIsolationIdentity(row.round_id) || row.phase !== "planning" && row.phase !== "ready"
    || !workflowIsolationTime(row.created_at) || !workflowIsolationTime(row.updated_at) || row.updated_at < row.created_at)
    throw new Error("workflow_isolation.selection_corrupt");
  return { workflowId, profile: row.profile, roundId: row.round_id, phase: row.phase,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Missing authority is not supplied by a metadata field. A selected plan cannot fall back to ordinary execution. */
export function workflowIsolationSelectionReady(database: DatabaseSync, workflowId: string): boolean {
  return readWorkflowIsolationSelection(database, workflowId)?.phase !== "planning";
}
