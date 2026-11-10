import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const DELEGATION_MIGRATION_VERSION = 154;
// The unversioned name belongs to historical development marker 139. This
// unpublished V1 overlay must not reuse its identity or reinterpret its schema.
export const DELEGATION_MIGRATION_NAME = "create_delegation_tree_v1";

export interface DelegationMigrationInput {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

interface RequiredDefinition {
  readonly type: "table" | "index" | "trigger";
  readonly name: string;
  readonly table: "delegation_steps" | "delegation_messages";
  readonly sql: string;
}

const stepColumns = [
  "id", "schema_version", "root_run_id", "parent_run_id", "parent_attempt_id", "workflow_id",
  "workflow_step_id", "parent_delegation_step_id", "child_run_id", "spawn_call_id",
  "objective_artifact_id", "required", "state", "depth", "permission_snapshot_artifact_id",
  "tool_allowlist_artifact_id", "workspace_scope_artifact_id", "provider_policy_artifact_id",
  "token_budget", "cost_budget_micros", "wall_time_budget_ms", "idempotency_key", "revision",
  "failure_code", "created_at", "updated_at", "completed_at",
] as const;
const messageColumns = [
  "id", "schema_version", "delegation_step_id", "direction", "kind", "body_artifact_id",
  "digest", "idempotency_key", "created_at",
] as const;
const integerColumns = new Set<string>([
  "schema_version", "required", "depth", "token_budget", "cost_budget_micros", "wall_time_budget_ms", "revision",
]);
const nullableStepColumns = new Set<string>([
  "workflow_id", "workflow_step_id", "parent_delegation_step_id", "child_run_id", "token_budget",
  "cost_budget_micros", "wall_time_budget_ms", "failure_code", "completed_at",
]);
const stepForeignKeys = [
  ["root_run_id", "run_sessions"], ["parent_run_id", "run_sessions"],
  ["parent_attempt_id", "work_unit_attempts"], ["workflow_id", "channel_workflows"],
  ["workflow_step_id", "channel_workflow_steps"], ["parent_delegation_step_id", "delegation_steps"],
  ["child_run_id", "run_sessions"], ["objective_artifact_id", "artifacts"],
  ["permission_snapshot_artifact_id", "artifacts"], ["tool_allowlist_artifact_id", "artifacts"],
  ["workspace_scope_artifact_id", "artifacts"], ["provider_policy_artifact_id", "artifacts"],
] as const;
const messageForeignKeys = [["delegation_step_id", "delegation_steps"], ["body_artifact_id", "artifacts"]] as const;

const stepTableSql = `CREATE TABLE delegation_steps (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) > 0 AND instr(id, char(0)) = 0),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  root_run_id TEXT NOT NULL CHECK(length(root_run_id) > 0),
  parent_run_id TEXT NOT NULL CHECK(length(parent_run_id) > 0),
  parent_attempt_id TEXT NOT NULL CHECK(length(parent_attempt_id) > 0),
  workflow_id TEXT CHECK(workflow_id IS NULL OR length(workflow_id) > 0),
  workflow_step_id TEXT CHECK(workflow_step_id IS NULL OR length(workflow_step_id) > 0),
  parent_delegation_step_id TEXT CHECK(parent_delegation_step_id IS NULL OR length(parent_delegation_step_id) > 0),
  child_run_id TEXT CHECK(child_run_id IS NULL OR length(child_run_id) > 0),
  spawn_call_id TEXT NOT NULL CHECK(length(spawn_call_id) > 0 AND instr(spawn_call_id, char(0)) = 0),
  objective_artifact_id TEXT NOT NULL CHECK(length(objective_artifact_id) > 0),
  required INTEGER NOT NULL CHECK(typeof(required) = 'integer' AND required IN (0, 1)),
  state TEXT NOT NULL CHECK(state IN (
    'planned', 'spawning', 'running', 'waiting', 'interrupting', 'interrupted', 'resuming',
    'succeeded', 'failed', 'cancelled', 'lost'
  )),
  depth INTEGER NOT NULL CHECK(typeof(depth) = 'integer' AND depth BETWEEN 1 AND 9007199254740991),
  permission_snapshot_artifact_id TEXT NOT NULL CHECK(length(permission_snapshot_artifact_id) > 0),
  tool_allowlist_artifact_id TEXT NOT NULL CHECK(length(tool_allowlist_artifact_id) > 0),
  workspace_scope_artifact_id TEXT NOT NULL CHECK(length(workspace_scope_artifact_id) > 0),
  provider_policy_artifact_id TEXT NOT NULL CHECK(length(provider_policy_artifact_id) > 0),
  token_budget INTEGER CHECK(token_budget IS NULL OR (typeof(token_budget) = 'integer' AND token_budget BETWEEN 0 AND 9007199254740991)),
  cost_budget_micros INTEGER CHECK(cost_budget_micros IS NULL OR (typeof(cost_budget_micros) = 'integer' AND cost_budget_micros BETWEEN 0 AND 9007199254740991)),
  wall_time_budget_ms INTEGER CHECK(wall_time_budget_ms IS NULL OR (typeof(wall_time_budget_ms) = 'integer' AND wall_time_budget_ms BETWEEN 0 AND 9007199254740991)),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) > 0 AND instr(idempotency_key, char(0)) = 0),
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
  failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN (
    'delegation.capability_escalation', 'delegation.budget_exhausted', 'delegation.depth_exceeded',
    'delegation.cycle_detected', 'delegation.child_lost', 'delegation.required_child_failed'
  )),
  created_at TEXT NOT NULL CHECK(length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK(length(updated_at) > 0),
  completed_at TEXT CHECK(completed_at IS NULL OR length(completed_at) > 0),
  CHECK(workflow_step_id IS NULL OR workflow_id IS NOT NULL),
  CHECK(parent_delegation_step_id IS NULL OR parent_delegation_step_id <> id),
  CHECK(child_run_id IS NULL OR (child_run_id <> parent_run_id AND child_run_id <> root_run_id)),
  CHECK(state <> 'planned' OR child_run_id IS NULL),
  CHECK(state NOT IN ('running', 'waiting', 'interrupting', 'interrupted', 'resuming', 'succeeded') OR child_run_id IS NOT NULL),
  CHECK((state IN ('succeeded', 'failed', 'cancelled', 'lost') AND completed_at IS NOT NULL)
    OR (state NOT IN ('succeeded', 'failed', 'cancelled', 'lost') AND completed_at IS NULL)),
  CHECK(state <> 'succeeded' OR failure_code IS NULL),
  FOREIGN KEY(root_run_id) REFERENCES run_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY(parent_run_id) REFERENCES run_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY(parent_attempt_id) REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
  FOREIGN KEY(workflow_id) REFERENCES channel_workflows(id) ON DELETE RESTRICT,
  FOREIGN KEY(workflow_step_id) REFERENCES channel_workflow_steps(id) ON DELETE RESTRICT,
  FOREIGN KEY(parent_delegation_step_id) REFERENCES delegation_steps(id) ON DELETE RESTRICT,
  FOREIGN KEY(child_run_id) REFERENCES run_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY(objective_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
  FOREIGN KEY(permission_snapshot_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
  FOREIGN KEY(tool_allowlist_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_scope_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
  FOREIGN KEY(provider_policy_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT
)`;

const messageTableSql = `CREATE TABLE delegation_messages (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) > 0 AND instr(id, char(0)) = 0),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  delegation_step_id TEXT NOT NULL CHECK(length(delegation_step_id) > 0),
  direction TEXT NOT NULL CHECK(direction IN ('parent_to_child', 'child_to_parent')),
  kind TEXT NOT NULL CHECK(kind IN ('instruction', 'progress', 'result', 'control')),
  body_artifact_id TEXT NOT NULL CHECK(length(body_artifact_id) > 0),
  digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*' AND instr(digest, char(0)) = 0),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) > 0 AND instr(idempotency_key, char(0)) = 0),
  created_at TEXT NOT NULL CHECK(length(created_at) > 0),
  FOREIGN KEY(delegation_step_id) REFERENCES delegation_steps(id) ON DELETE RESTRICT,
  FOREIGN KEY(body_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT
)`;

const requiredDefinitions: readonly RequiredDefinition[] = [
  { type: "table", name: "delegation_steps", table: "delegation_steps", sql: stepTableSql },
  { type: "table", name: "delegation_messages", table: "delegation_messages", sql: messageTableSql },
  { type: "index", name: "idx_delegation_steps_root_created", table: "delegation_steps",
    sql: "CREATE INDEX idx_delegation_steps_root_created ON delegation_steps(root_run_id, created_at, id)" },
  { type: "index", name: "idx_delegation_steps_root_state_created", table: "delegation_steps",
    sql: "CREATE INDEX idx_delegation_steps_root_state_created ON delegation_steps(root_run_id, state, created_at, id)" },
  { type: "index", name: "idx_delegation_steps_root_parent_created", table: "delegation_steps",
    sql: "CREATE INDEX idx_delegation_steps_root_parent_created ON delegation_steps(root_run_id, parent_delegation_step_id, created_at, id)" },
  { type: "index", name: "idx_delegation_steps_parent_created", table: "delegation_steps",
    sql: "CREATE INDEX idx_delegation_steps_parent_created ON delegation_steps(parent_run_id, created_at, id)" },
  { type: "index", name: "idx_delegation_steps_parent_state_created", table: "delegation_steps",
    sql: "CREATE INDEX idx_delegation_steps_parent_state_created ON delegation_steps(parent_run_id, state, created_at, id)" },
  { type: "index", name: "idx_delegation_steps_parent_delegation_created", table: "delegation_steps",
    sql: "CREATE INDEX idx_delegation_steps_parent_delegation_created ON delegation_steps(parent_delegation_step_id, created_at, id)" },
  { type: "index", name: "idx_delegation_steps_state_created", table: "delegation_steps",
    sql: "CREATE INDEX idx_delegation_steps_state_created ON delegation_steps(state, created_at, id)" },
  { type: "index", name: "idx_delegation_steps_child_run", table: "delegation_steps",
    sql: "CREATE UNIQUE INDEX idx_delegation_steps_child_run ON delegation_steps(child_run_id) WHERE child_run_id IS NOT NULL" },
  { type: "index", name: "idx_delegation_steps_idempotency", table: "delegation_steps",
    sql: "CREATE UNIQUE INDEX idx_delegation_steps_idempotency ON delegation_steps(idempotency_key)" },
  { type: "index", name: "idx_delegation_steps_spawn_call", table: "delegation_steps",
    sql: "CREATE UNIQUE INDEX idx_delegation_steps_spawn_call ON delegation_steps(parent_attempt_id, spawn_call_id)" },
  { type: "index", name: "idx_delegation_messages_step_created", table: "delegation_messages",
    sql: "CREATE INDEX idx_delegation_messages_step_created ON delegation_messages(delegation_step_id, created_at, id)" },
  { type: "index", name: "idx_delegation_messages_idempotency", table: "delegation_messages",
    sql: "CREATE UNIQUE INDEX idx_delegation_messages_idempotency ON delegation_messages(idempotency_key)" },
  { type: "trigger", name: "trg_delegation_steps_identity_immutable", table: "delegation_steps", sql: `
    CREATE TRIGGER trg_delegation_steps_identity_immutable BEFORE UPDATE ON delegation_steps
    WHEN OLD.id IS NOT NEW.id OR OLD.schema_version IS NOT NEW.schema_version
      OR OLD.root_run_id IS NOT NEW.root_run_id OR OLD.parent_run_id IS NOT NEW.parent_run_id
      OR OLD.parent_attempt_id IS NOT NEW.parent_attempt_id OR OLD.workflow_id IS NOT NEW.workflow_id
      OR OLD.workflow_step_id IS NOT NEW.workflow_step_id OR OLD.parent_delegation_step_id IS NOT NEW.parent_delegation_step_id
      OR OLD.spawn_call_id IS NOT NEW.spawn_call_id OR OLD.objective_artifact_id IS NOT NEW.objective_artifact_id
      OR OLD.required IS NOT NEW.required OR OLD.depth IS NOT NEW.depth
      OR OLD.permission_snapshot_artifact_id IS NOT NEW.permission_snapshot_artifact_id
      OR OLD.tool_allowlist_artifact_id IS NOT NEW.tool_allowlist_artifact_id
      OR OLD.workspace_scope_artifact_id IS NOT NEW.workspace_scope_artifact_id
      OR OLD.provider_policy_artifact_id IS NOT NEW.provider_policy_artifact_id
      OR OLD.token_budget IS NOT NEW.token_budget OR OLD.cost_budget_micros IS NOT NEW.cost_budget_micros
      OR OLD.wall_time_budget_ms IS NOT NEW.wall_time_budget_ms OR OLD.idempotency_key IS NOT NEW.idempotency_key
      OR OLD.created_at IS NOT NEW.created_at
    BEGIN SELECT RAISE(ABORT, 'delegation step identity is immutable'); END` },
  { type: "trigger", name: "trg_delegation_steps_tree_edge", table: "delegation_steps", sql: `
    CREATE TRIGGER trg_delegation_steps_tree_edge BEFORE INSERT ON delegation_steps
    WHEN (NEW.parent_delegation_step_id IS NULL AND NEW.depth <> 1)
      OR (NEW.parent_delegation_step_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM delegation_steps AS parent
        WHERE parent.id = NEW.parent_delegation_step_id AND parent.root_run_id = NEW.root_run_id
          AND parent.child_run_id = NEW.parent_run_id AND NEW.depth = parent.depth + 1
      ))
    BEGIN SELECT RAISE(ABORT, 'delegation tree edge is invalid'); END` },
  { type: "trigger", name: "trg_delegation_steps_child_binding", table: "delegation_steps", sql: `
    CREATE TRIGGER trg_delegation_steps_child_binding BEFORE UPDATE ON delegation_steps
    WHEN (OLD.child_run_id IS NOT NEW.child_run_id AND NOT (
      OLD.child_run_id IS NULL AND NEW.child_run_id IS NOT NULL
      AND OLD.state = 'spawning' AND NEW.state = 'running' AND NEW.revision = OLD.revision + 1
    )) OR (NEW.child_run_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM delegation_steps WHERE child_run_id = NEW.child_run_id AND id <> OLD.id
    ))
    BEGIN SELECT RAISE(ABORT, 'delegation child can only be bound once at spawn commit'); END` },
  { type: "trigger", name: "trg_delegation_steps_transition", table: "delegation_steps", sql: `
    CREATE TRIGGER trg_delegation_steps_transition BEFORE UPDATE ON delegation_steps
    WHEN OLD.state IN ('succeeded', 'failed', 'cancelled', 'lost')
      OR NEW.revision IS NOT OLD.revision + 1
      OR (OLD.state IS NOT NEW.state AND NOT (
        (OLD.state = 'planned' AND NEW.state IN ('spawning', 'cancelled', 'failed'))
        OR (OLD.state = 'spawning' AND NEW.state IN ('running', 'failed', 'cancelled', 'lost'))
        OR (OLD.state = 'running' AND NEW.state IN ('waiting', 'interrupting', 'succeeded', 'failed', 'cancelled', 'lost'))
        OR (OLD.state = 'waiting' AND NEW.state IN ('running', 'interrupting', 'succeeded', 'failed', 'cancelled', 'lost'))
        OR (OLD.state = 'interrupting' AND NEW.state IN ('interrupted', 'failed', 'lost'))
        OR (OLD.state = 'interrupted' AND NEW.state IN ('resuming', 'cancelled', 'failed', 'lost'))
        OR (OLD.state = 'resuming' AND NEW.state IN ('running', 'failed', 'cancelled', 'lost'))
      ))
    BEGIN SELECT RAISE(ABORT, 'delegation state or revision transition is invalid'); END` },
  { type: "trigger", name: "trg_delegation_steps_no_replace", table: "delegation_steps", sql: `
    CREATE TRIGGER trg_delegation_steps_no_replace BEFORE INSERT ON delegation_steps
    WHEN EXISTS (SELECT 1 FROM delegation_steps WHERE id = NEW.id OR idempotency_key = NEW.idempotency_key
      OR (parent_attempt_id = NEW.parent_attempt_id AND spawn_call_id = NEW.spawn_call_id)
      OR (NEW.child_run_id IS NOT NULL AND child_run_id = NEW.child_run_id))
    BEGIN SELECT RAISE(ABORT, 'delegation steps cannot be replaced'); END` },
  { type: "trigger", name: "trg_delegation_steps_no_delete", table: "delegation_steps", sql: `
    CREATE TRIGGER trg_delegation_steps_no_delete BEFORE DELETE ON delegation_steps
    BEGIN SELECT RAISE(ABORT, 'delegation steps are durable records'); END` },
  { type: "trigger", name: "trg_delegation_messages_no_replace", table: "delegation_messages", sql: `
    CREATE TRIGGER trg_delegation_messages_no_replace BEFORE INSERT ON delegation_messages
    WHEN EXISTS (SELECT 1 FROM delegation_messages WHERE id = NEW.id OR idempotency_key = NEW.idempotency_key)
    BEGIN SELECT RAISE(ABORT, 'delegation messages are append-only'); END` },
  { type: "trigger", name: "trg_delegation_messages_no_update", table: "delegation_messages", sql: `
    CREATE TRIGGER trg_delegation_messages_no_update BEFORE UPDATE ON delegation_messages
    BEGIN SELECT RAISE(ABORT, 'delegation messages are append-only'); END` },
  { type: "trigger", name: "trg_delegation_messages_no_delete", table: "delegation_messages", sql: `
    CREATE TRIGGER trg_delegation_messages_no_delete BEFORE DELETE ON delegation_messages
    BEGIN SELECT RAISE(ABORT, 'delegation messages are append-only'); END` },
];

/**
 * Installs the V1 durable delegation overlay without inventing children or retiring history.
 * Missing indexes/triggers may be repaired, but an incompatible table/object or marker is refused.
 * This schema does not reserve root budget, authenticate artifacts, validate current Attempt fences,
 * or create a child Run atomically; those remain responsibilities of the later delegation Store.
 */
export function applyDelegationMigration(input: DelegationMigrationInput): boolean {
  const { database } = input;
  const recorded = readMigrationMarker(database);
  if (input.hasMigration(DELEGATION_MIGRATION_VERSION) !== recorded) {
    throw new Error("Delegation migration marker state mismatch.");
  }
  const missing = inspectDefinitions(database, recorded);
  if (recorded && missing.length === 0) {
    assertPostconditions(database);
    return false;
  }

  // BEGIN is outside the catch: failure to acquire our own transaction must not
  // roll back a caller-owned transaction (including a failed nested BEGIN).
  database.exec("BEGIN IMMEDIATE;");
  try {
    const currentMarker = readMigrationMarker(database);
    const currentMissing = inspectDefinitions(database, currentMarker);
    for (const definition of currentMissing) database.exec(definition.sql);
    assertPostconditions(database);
    if (!currentMarker) input.recordMigration(DELEGATION_MIGRATION_VERSION, DELEGATION_MIGRATION_NAME);
    if (!readMigrationMarker(database) || !input.hasMigration(DELEGATION_MIGRATION_VERSION)) {
      throw new Error("Delegation migration marker postcondition failed.");
    }
    assertPostconditions(database);
    database.exec("COMMIT;");
    return !currentMarker || currentMissing.length > 0;
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}

/** Reject both a conflicting version owner and a reused migration name at another version. */
function readMigrationMarker(database: DatabaseSync): boolean {
  const rows = database.prepare("SELECT version, name FROM schema_migrations WHERE version = ? OR name = ?")
    .all(DELEGATION_MIGRATION_VERSION, DELEGATION_MIGRATION_NAME) as Array<{ readonly version: number; readonly name: string }>;
  if (rows.some(row => row.version !== DELEGATION_MIGRATION_VERSION || row.name !== DELEGATION_MIGRATION_NAME)
    || rows.length > 1) throw new Error("Delegation migration marker conflicts with existing history.");
  return rows.length === 1;
}

/** Whitespace outside quoted literals is irrelevant; literal spelling remains part of the contract. */
function normalizedSql(sql: string): string {
  return sql.trim().replace(/;$/u, "").replace(/'[^']*(?:''[^']*)*'|\s+/gu,
    token => token.startsWith("'") ? token : " ");
}

/** Compare every authored constraint, FK, index predicate and trigger body, not just its name. */
function inspectDefinitions(database: DatabaseSync, recorded: boolean): readonly RequiredDefinition[] {
  const missing: RequiredDefinition[] = [];
  for (const definition of requiredDefinitions) {
    const rows = database.prepare("SELECT type, tbl_name, sql FROM sqlite_master WHERE name = ?")
      .all(definition.name) as Array<{ readonly type: string; readonly tbl_name: string; readonly sql: string | null }>;
    if (rows.length === 0) {
      if (recorded && definition.type === "table") {
        throw new Error(`Delegation migration recorded table is missing: ${definition.name}`);
      }
      missing.push(definition);
    } else if (rows.length !== 1 || rows[0]?.type !== definition.type || rows[0]?.tbl_name !== definition.table
      || typeof rows[0]?.sql !== "string" || normalizedSql(rows[0].sql) !== normalizedSql(definition.sql)) {
      throw new Error(`Delegation migration schema definition mismatch: ${definition.name}`);
    }
  }
  return missing;
}

/** Verify SQLite's parsed column/FK metadata as well as the exact authored SQL and referential data. */
function assertPostconditions(database: DatabaseSync): void {
  if (inspectDefinitions(database, true).length !== 0) throw new Error("Delegation migration schema postcondition failed.");
  for (const [table, columns, foreignKeys] of [
    ["delegation_steps", stepColumns, stepForeignKeys],
    ["delegation_messages", messageColumns, messageForeignKeys],
  ] as const) {
    const parsedColumns = database.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{
      readonly cid: number; readonly name: string; readonly type: string; readonly notnull: number;
      readonly dflt_value: string | null; readonly pk: number; readonly hidden: number;
    }>;
    if (parsedColumns.length !== columns.length || parsedColumns.some((column, index) =>
      column.cid !== index || column.name !== columns[index]
      || column.type !== (integerColumns.has(column.name) ? "INTEGER" : "TEXT")
      || column.notnull !== (table === "delegation_steps" && nullableStepColumns.has(column.name) ? 0 : 1)
      || column.dflt_value !== null || column.pk !== (column.name === "id" ? 1 : 0) || column.hidden !== 0)) {
      throw new Error(`Delegation migration column postcondition failed: ${table}`);
    }
    const parsedForeignKeys = database.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      readonly seq: number; readonly from: string; readonly table: string; readonly to: string;
      readonly on_update: string; readonly on_delete: string; readonly match: string;
    }>;
    if (parsedForeignKeys.length !== foreignKeys.length || foreignKeys.some(([column, target]) =>
      !parsedForeignKeys.some(key => key.seq === 0 && key.from === column && key.table === target
        && key.to === "id" && key.on_update === "NO ACTION" && key.on_delete === "RESTRICT" && key.match === "NONE"))) {
      throw new Error(`Delegation migration foreign-key definition postcondition failed: ${table}`);
    }
    for (const target of new Set(foreignKeys.map(([, name]) => name))) {
      const parentColumns = database.prepare(`PRAGMA table_info(${target})`).all() as Array<{ readonly name: string; readonly pk: number }>;
      if (!parentColumns.some(column => column.name === "id" && column.pk === 1)) {
        throw new Error(`Delegation migration referenced identity is missing: ${target}`);
      }
    }
    if (database.prepare(`PRAGMA foreign_key_check(${table})`).all().length !== 0) {
      throw new Error(`Delegation migration foreign-key data postcondition failed: ${table}`);
    }
  }
  const invalidTreeEdge = database.prepare(`
    SELECT 1 FROM delegation_steps AS child
    WHERE (child.parent_delegation_step_id IS NULL AND child.depth <> 1)
      OR (child.parent_delegation_step_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM delegation_steps AS parent WHERE parent.id = child.parent_delegation_step_id
          AND parent.root_run_id = child.root_run_id AND parent.child_run_id = child.parent_run_id
          AND child.depth = parent.depth + 1
      ))
    LIMIT 1
  `).get();
  if (invalidTreeEdge) throw new Error("Delegation migration tree-edge data postcondition failed.");
}
