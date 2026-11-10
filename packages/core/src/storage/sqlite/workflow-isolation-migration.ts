import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const WORKFLOW_ISOLATION_MIGRATION_VERSION = 204;
const name = "workflow_isolation_foundation";
const phases = "'preparing','collecting','integrating','verifying','awaiting_approval','applying','applied','conflicted','failed','blocked'";
const definitions = [
  { type: "table", name: "workflow_integration_rounds", sql: `CREATE TABLE workflow_integration_rounds (
    round_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES channel_workflows(id),
    current_generation INTEGER NOT NULL CHECK(typeof(current_generation)='integer' AND current_generation>0),
    created_at TEXT NOT NULL
  )` },
  { type: "table", name: "workflow_integration_generations", sql: `CREATE TABLE workflow_integration_generations (
    round_id TEXT NOT NULL REFERENCES workflow_integration_rounds(round_id),
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0),
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),
    inputs_json TEXT NOT NULL CHECK(json_valid(inputs_json)),
    inputs_digest TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN (${phases})),
    last_confirmed_phase TEXT NOT NULL CHECK(last_confirmed_phase IN (${phases})),
    writer_binding_id TEXT REFERENCES workflow_isolation_bindings(binding_id),
    open_intent_id TEXT UNIQUE REFERENCES workflow_isolation_intents(intent_id),
    candidate_json TEXT CHECK(candidate_json IS NULL OR json_valid(candidate_json)),
    outstanding_approval_id TEXT REFERENCES approval_requests(id),
    reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(round_id,generation)
  )` },
  { type: "table", name: "workflow_isolation_scope_plans", sql: `CREATE TABLE workflow_isolation_scope_plans (
    plan_id TEXT PRIMARY KEY,
    plan_digest TEXT NOT NULL,
    workflow_id TEXT NOT NULL REFERENCES channel_workflows(id),
    workflow_step_id TEXT NOT NULL REFERENCES channel_workflow_steps(id),
    canonical_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    round_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    step_generation INTEGER NOT NULL CHECK(typeof(step_generation)='integer' AND step_generation>0),
    common_dir TEXT NOT NULL,
    execution_root TEXT NOT NULL UNIQUE,
    worktree_id TEXT NOT NULL UNIQUE,
    branch_ref TEXT NOT NULL,
    authority_basis TEXT NOT NULL,
    plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
    created_at TEXT NOT NULL,
    FOREIGN KEY(round_id,generation) REFERENCES workflow_integration_generations(round_id,generation),
    UNIQUE(common_dir,branch_ref),
    UNIQUE(workflow_step_id,step_generation)
  )` },
  { type: "table", name: "workflow_isolation_bindings", sql: `CREATE TABLE workflow_isolation_bindings (
    binding_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),
    plan_id TEXT NOT NULL UNIQUE REFERENCES workflow_isolation_scope_plans(plan_id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    lease_id TEXT NOT NULL REFERENCES resource_leases(id),
    authority_basis TEXT NOT NULL,
    start_owner_json TEXT NOT NULL CHECK(json_valid(start_owner_json)),
    run_id TEXT NOT NULL REFERENCES run_sessions(id),
    work_unit_id TEXT NOT NULL REFERENCES work_units(id),
    attempt_id TEXT NOT NULL UNIQUE REFERENCES work_unit_attempts(id),
    runtime_instance_id TEXT NOT NULL,
    fencing_token TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('planned','ready','blocked')),
    creation_receipt_id TEXT UNIQUE REFERENCES workflow_isolation_receipts(receipt_id),
    open_intent_id TEXT UNIQUE REFERENCES workflow_isolation_intents(intent_id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(status<>'ready' OR creation_receipt_id IS NOT NULL),
    UNIQUE(binding_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token)
  )` },
  { type: "table", name: "workflow_isolation_intents", sql: `CREATE TABLE workflow_isolation_intents (
    intent_id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE,
    intent_digest TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK(scope_type IN ('binding','round')),
    scope_binding_id TEXT REFERENCES workflow_isolation_bindings(binding_id),
    round_id TEXT,
    generation INTEGER,
    scope_revision INTEGER NOT NULL CHECK(typeof(scope_revision)='integer' AND scope_revision>=0),
    writer_binding_id TEXT NOT NULL,
    work_unit_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    runtime_instance_id TEXT NOT NULL,
    fencing_token TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('worktree_create','branch_capture','integration_create','integrate_branch','candidate_verify','target_apply')),
    before_json TEXT NOT NULL CHECK(json_valid(before_json)),
    after_json TEXT NOT NULL CHECK(json_valid(after_json)),
    status TEXT NOT NULL CHECK(status IN ('pending','confirmed','blocked','effect_unknown')),
    created_at TEXT NOT NULL,
    FOREIGN KEY(writer_binding_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token)
      REFERENCES workflow_isolation_bindings(binding_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token),
    FOREIGN KEY(round_id,generation) REFERENCES workflow_integration_generations(round_id,generation),
    CHECK((scope_type='binding' AND scope_binding_id IS NOT NULL AND scope_binding_id=writer_binding_id AND round_id IS NULL AND generation IS NULL)
      OR (scope_type='round' AND scope_binding_id IS NULL AND round_id IS NOT NULL AND generation IS NOT NULL))
  )` },
  { type: "table", name: "workflow_isolation_receipts", sql: `CREATE TABLE workflow_isolation_receipts (
    receipt_id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL REFERENCES workflow_isolation_intents(intent_id),
    receipt_digest TEXT NOT NULL,
    scope_revision INTEGER NOT NULL CHECK(typeof(scope_revision)='integer' AND scope_revision>=0),
    outcome TEXT NOT NULL CHECK(outcome IN ('confirmed','blocked','effect_unknown')),
    observed_json TEXT NOT NULL CHECK(json_valid(observed_json)),
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    created_at TEXT NOT NULL
  )` },
  { type: "table", name: "workflow_isolation_commands", sql: `CREATE TABLE workflow_isolation_commands (
    command_kind TEXT NOT NULL,
    command_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    writer_binding_id TEXT NOT NULL REFERENCES workflow_isolation_bindings(binding_id),
    result_json TEXT NOT NULL CHECK(json_valid(result_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(command_kind,command_id)
  )` },
  { type: "index", name: "idx_workflow_isolation_receipt_confirmed", sql: `CREATE UNIQUE INDEX idx_workflow_isolation_receipt_confirmed
    ON workflow_isolation_receipts(intent_id) WHERE outcome='confirmed'` },
  { type: "index", name: "idx_workflow_isolation_intent_pending", sql: `CREATE INDEX idx_workflow_isolation_intent_pending
    ON workflow_isolation_intents(status,round_id,generation,writer_binding_id)` },
  { type: "trigger", name: "trg_workflow_isolation_plan_immutable", sql: `CREATE TRIGGER trg_workflow_isolation_plan_immutable
    BEFORE UPDATE ON workflow_isolation_scope_plans BEGIN SELECT RAISE(ABORT,'workflow_isolation.plan_immutable'); END` },
  { type: "trigger", name: "trg_workflow_isolation_generation_immutable", sql: `CREATE TRIGGER trg_workflow_isolation_generation_immutable
    BEFORE UPDATE ON workflow_integration_generations WHEN NEW.round_id<>OLD.round_id OR NEW.generation<>OLD.generation
      OR NEW.inputs_json<>OLD.inputs_json OR NEW.inputs_digest<>OLD.inputs_digest OR NEW.created_at<>OLD.created_at
      OR (OLD.writer_binding_id IS NOT NULL AND NEW.writer_binding_id IS NOT OLD.writer_binding_id)
      OR (OLD.candidate_json IS NOT NULL AND NEW.candidate_json IS NOT OLD.candidate_json)
      OR NEW.revision<>OLD.revision+1
    BEGIN SELECT RAISE(ABORT,'workflow_isolation.generation_immutable'); END` },
  { type: "trigger", name: "trg_workflow_isolation_round_immutable", sql: `CREATE TRIGGER trg_workflow_isolation_round_immutable
    BEFORE UPDATE ON workflow_integration_rounds WHEN NEW.round_id<>OLD.round_id OR NEW.workflow_id<>OLD.workflow_id
      OR NEW.created_at<>OLD.created_at OR NEW.current_generation<>OLD.current_generation+1
    BEGIN SELECT RAISE(ABORT,'workflow_isolation.round_immutable'); END` },
  { type: "trigger", name: "trg_workflow_isolation_binding_immutable", sql: `CREATE TRIGGER trg_workflow_isolation_binding_immutable
    BEFORE UPDATE ON workflow_isolation_bindings WHEN NEW.binding_id<>OLD.binding_id OR NEW.plan_id<>OLD.plan_id
      OR NEW.task_id<>OLD.task_id OR NEW.lease_id<>OLD.lease_id OR NEW.authority_basis<>OLD.authority_basis
      OR NEW.start_owner_json<>OLD.start_owner_json OR NEW.run_id<>OLD.run_id OR NEW.work_unit_id<>OLD.work_unit_id
      OR NEW.attempt_id<>OLD.attempt_id OR NEW.runtime_instance_id<>OLD.runtime_instance_id OR NEW.fencing_token<>OLD.fencing_token
      OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1
      OR (OLD.creation_receipt_id IS NOT NULL AND NEW.creation_receipt_id IS NOT OLD.creation_receipt_id)
    BEGIN SELECT RAISE(ABORT,'workflow_isolation.binding_immutable'); END` },
  { type: "trigger", name: "trg_workflow_isolation_intent_immutable", sql: `CREATE TRIGGER trg_workflow_isolation_intent_immutable
    BEFORE UPDATE ON workflow_isolation_intents WHEN NEW.intent_id<>OLD.intent_id OR NEW.command_id<>OLD.command_id
      OR NEW.intent_digest<>OLD.intent_digest OR NEW.scope_type<>OLD.scope_type OR NEW.scope_binding_id IS NOT OLD.scope_binding_id
      OR NEW.round_id IS NOT OLD.round_id OR NEW.generation IS NOT OLD.generation OR NEW.scope_revision<>OLD.scope_revision
      OR NEW.writer_binding_id<>OLD.writer_binding_id OR NEW.work_unit_id<>OLD.work_unit_id OR NEW.attempt_id<>OLD.attempt_id
      OR NEW.runtime_instance_id<>OLD.runtime_instance_id OR NEW.fencing_token<>OLD.fencing_token
      OR NEW.kind<>OLD.kind OR NEW.before_json<>OLD.before_json OR NEW.after_json<>OLD.after_json OR NEW.created_at<>OLD.created_at
      OR OLD.status='confirmed'
    BEGIN SELECT RAISE(ABORT,'workflow_isolation.intent_immutable'); END` },
  ...["receipts", "commands"].map(table => ({ type: "trigger", name: `trg_workflow_isolation_${table}_immutable`,
    sql: `CREATE TRIGGER trg_workflow_isolation_${table}_immutable BEFORE UPDATE ON workflow_isolation_${table}
      BEGIN SELECT RAISE(ABORT,'workflow_isolation.journal_immutable'); END` })),
];
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

/** Independent additive migration. Never backfills authority or adopts a foreign transaction. */
export function applyWorkflowIsolationMigration(input: { readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): void {
  const inspect = () => {
    if (input.database.prepare("SELECT name FROM schema_migrations WHERE version=203").get()?.name !== "workflow_step_preparing_admission") {
      throw new Error("workflow_isolation.migration_predecessor_missing");
    }
    const markers = input.database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(WORKFLOW_ISOLATION_MIGRATION_VERSION, name);
    if (markers.length > 1 || markers.some(row => row.version !== WORKFLOW_ISOLATION_MIGRATION_VERSION || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(WORKFLOW_ISOLATION_MIGRATION_VERSION)) throw new Error("workflow_isolation.migration_marker_conflict");
    const known = new Set(definitions.map(definition => definition.name));
    for (const definition of definitions) {
      const actual = input.database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(definition.name);
      if (actual && (actual.type !== definition.type || typeof actual.sql !== "string" || normalize(actual.sql) !== normalize(definition.sql))) {
        throw new Error(`workflow_isolation.migration_schema_conflict:${definition.name}`);
      }
      if (markers.length && !actual) throw new Error(`workflow_isolation.migration_schema_missing:${definition.name}`);
    }
    for (const table of definitions.filter(definition => definition.type === "table")) {
      const unexpected = input.database.prepare("SELECT name FROM sqlite_master WHERE tbl_name=? AND name NOT LIKE 'sqlite_autoindex_%'")
        .all(table.name).some(row => !known.has(String(row.name)));
      if (unexpected) throw new Error(`workflow_isolation.migration_unexpected_object:${table.name}`);
      if (markers.length && input.database.prepare(`PRAGMA foreign_key_check(${table.name})`).all().length) {
        throw new Error(`workflow_isolation.migration_fk_conflict:${table.name}`);
      }
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
      input.recordMigration(WORKFLOW_ISOLATION_MIGRATION_VERSION, name);
    }
    if (!inspect()) throw new Error("workflow_isolation.migration_postcondition");
    input.database.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(input.database); throw error; }
}
