import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const WORKFLOW_STEP_ADMISSION_MIGRATION_VERSION = 203;
const name = "workflow_step_preparing_admission";
const definitions = [
  { name: "workflow_step_admissions", type: "table", sql: `CREATE TABLE workflow_step_admissions (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    workspace_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL REFERENCES channel_workflows(id),
    workflow_step_id TEXT NOT NULL REFERENCES channel_workflow_steps(id),
    lease_id TEXT NOT NULL,
    authority_basis TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('preparing','transferred','released')),
    run_id TEXT,
    work_unit_id TEXT,
    attempt_id TEXT,
    runtime_instance_id TEXT,
    fencing_token TEXT,
    created_at TEXT NOT NULL,
    transferred_at TEXT,
    released_at TEXT,
    release_reason TEXT,
    CHECK((run_id IS NULL AND work_unit_id IS NULL AND attempt_id IS NULL AND runtime_instance_id IS NULL AND fencing_token IS NULL)
      OR (run_id IS NOT NULL AND work_unit_id IS NOT NULL AND attempt_id IS NOT NULL AND runtime_instance_id IS NOT NULL AND fencing_token IS NOT NULL)),
    CHECK(status<>'transferred' OR transferred_at IS NOT NULL)
  )` },
  { name: "workflow_step_admission_entries", type: "table", sql: `CREATE TABLE workflow_step_admission_entries (
    task_id TEXT NOT NULL REFERENCES workflow_step_admissions(task_id),
    resource_type TEXT NOT NULL CHECK(resource_type IN ('provider','runner','channel_parallel','media_provider','workflow_resource')),
    resource_key TEXT NOT NULL,
    capacity_limit INTEGER NOT NULL CHECK(typeof(capacity_limit)='integer' AND capacity_limit>0),
    slot_id TEXT UNIQUE REFERENCES runtime_semaphore_slots(id),
    PRIMARY KEY(task_id,resource_type,resource_key)
  )` },
  { name: "idx_workflow_step_admission_preparing", type: "index", sql: `CREATE UNIQUE INDEX idx_workflow_step_admission_preparing
    ON workflow_step_admissions(workflow_step_id) WHERE status='preparing'` },
  { name: "idx_workflow_step_admission_capacity", type: "index", sql: `CREATE INDEX idx_workflow_step_admission_capacity
    ON workflow_step_admission_entries(resource_type,resource_key,task_id)` },
];
const normalize = (value: string) => value.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

/** Additive ownership ledger. No expiry, backfill, or implicit recovery release. */
export function applyWorkflowStepAdmissionMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const inspect = () => {
    const markers = input.database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(WORKFLOW_STEP_ADMISSION_MIGRATION_VERSION, name);
    if (markers.length > 1 || markers.some(row => row.version !== WORKFLOW_STEP_ADMISSION_MIGRATION_VERSION || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(WORKFLOW_STEP_ADMISSION_MIGRATION_VERSION)) {
      throw new Error("workflow_admission.migration_marker_conflict");
    }
    for (const definition of definitions) {
      const actual = input.database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(definition.name);
      if (actual && (actual.type !== definition.type || typeof actual.sql !== "string" || normalize(actual.sql) !== normalize(definition.sql))) {
        throw new Error("workflow_admission.migration_schema_conflict");
      }
      if (markers.length && !actual) throw new Error("workflow_admission.migration_schema_missing");
    }
    return Boolean(markers.length);
  };
  if (inspect()) return;
  input.database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const definition of definitions) {
        if (!input.database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(definition.name)) input.database.exec(definition.sql);
      }
      input.recordMigration(WORKFLOW_STEP_ADMISSION_MIGRATION_VERSION, name);
    }
    if (!inspect()) throw new Error("workflow_admission.migration_postcondition");
    input.database.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(input.database); throw error; }
}
