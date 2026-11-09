import type { DatabaseSync } from "node:sqlite";

/** Retirement permanently fences old coordination, even if mutable workflow status is later reopened. */
export function workflowConflictRecoveryRetired(database: DatabaseSync, workflowId: string): boolean {
  const table = database.prepare("SELECT type FROM sqlite_master WHERE name='workflow_conflict_recoveries'").get();
  const installed = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
    && database.prepare("SELECT name FROM schema_migrations WHERE version=213").get();
  if (!table && !installed) return false;
  if (table?.type !== "table" || installed?.name !== "workflow_conflict_recoveries") throw new Error("workflow_recovery.schema_invalid");
  return !!database.prepare("SELECT 1 FROM workflow_conflict_recoveries WHERE predecessor_workflow_id=?").get(workflowId);
}
