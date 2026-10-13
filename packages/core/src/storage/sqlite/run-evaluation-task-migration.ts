import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
export const RUN_EVALUATION_TASK_MIGRATION_VERSION = 158;
export const RUN_EVALUATION_TASK_MIGRATION_NAME = "create_run_evaluation_tasks_v1";
interface Definition {
  readonly name: string;
  readonly type: "table" | "index" | "trigger";
  readonly table: string;
  readonly sql: string;
}
const MAX = "9007199254740990";
const definitions: readonly Definition[] = [{
  name: "run_evaluation_tasks",
  type: "table",
  table: "run_evaluation_tasks",
  sql: `CREATE TABLE run_evaluation_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    evaluation_id TEXT NOT NULL REFERENCES run_evaluations(id) ON DELETE RESTRICT,
    evaluation_key TEXT NOT NULL,
    grader_type TEXT NOT NULL CHECK(grader_type='model'),
    frozen_json TEXT NOT NULL CHECK(json_valid(frozen_json)),
    frozen_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    frozen_artifact_sha TEXT NOT NULL CHECK(length(frozen_artifact_sha)=64 AND frozen_artifact_sha NOT GLOB '*[^0-9a-f]*'),
    frozen_digest TEXT NOT NULL CHECK(length(frozen_digest)=64 AND frozen_digest NOT GLOB '*[^0-9a-f]*'),
    repeat_ordinal INTEGER NOT NULL CHECK(typeof(repeat_ordinal)='integer' AND repeat_ordinal BETWEEN 1 AND ${MAX}),
    idempotency_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','active','completed','failed','cancelled','unknown_outcome')),
    active_attempt_id TEXT REFERENCES run_evaluation_task_attempts(id) ON DELETE RESTRICT,
    next_attempt_at TEXT,
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND ${MAX}),
    failure_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    CHECK((state='queued' AND active_attempt_id IS NULL) OR (state<>'queued' AND active_attempt_id IS NOT NULL)),
    CHECK((state IN ('completed','failed','cancelled','unknown_outcome') AND completed_at IS NOT NULL) OR (state IN ('queued','active') AND completed_at IS NULL)),
    CHECK(state='queued' OR next_attempt_at IS NULL),
    CHECK(state<>'completed' OR failure_code IS NULL)
  )`
}, {
  name: "run_evaluation_task_attempts",
  type: "table",
  table: "run_evaluation_task_attempts",
  sql: `CREATE TABLE run_evaluation_task_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    task_id TEXT NOT NULL REFERENCES run_evaluation_tasks(id) ON DELETE RESTRICT,
    attempt_number INTEGER NOT NULL CHECK(typeof(attempt_number)='integer' AND attempt_number BETWEEN 1 AND ${MAX}),
    state TEXT NOT NULL CHECK(state IN ('claimed','dispatch_admitted','completed','failed','cancelled','abandoned_before_dispatch','unknown_outcome')),
    claim_owner TEXT NOT NULL,
    claim_token TEXT NOT NULL,
    claim_expires_at TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND ${MAX}),
    invocation_id TEXT,
    request_digest TEXT CHECK(request_digest IS NULL OR (length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*')),
    scope_digest TEXT CHECK(scope_digest IS NULL OR (length(scope_digest)=64 AND scope_digest NOT GLOB '*[^0-9a-f]*')),
    admitted_at TEXT,
    failure_code TEXT,
    claimed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    CHECK((state IN ('claimed','failed','cancelled','abandoned_before_dispatch') AND invocation_id IS NULL AND request_digest IS NULL AND scope_digest IS NULL AND admitted_at IS NULL) OR
      (state IN ('dispatch_admitted','completed','unknown_outcome') AND invocation_id IS NOT NULL AND request_digest IS NOT NULL AND scope_digest IS NOT NULL AND admitted_at IS NOT NULL)),
    CHECK((state IN ('claimed','dispatch_admitted') AND completed_at IS NULL) OR (state NOT IN ('claimed','dispatch_admitted') AND completed_at IS NOT NULL))
  )`
}, {
  name: "run_evaluation_task_results",
  type: "table",
  table: "run_evaluation_task_results",
  sql: `CREATE TABLE run_evaluation_task_results (
    id TEXT PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    authority TEXT NOT NULL CHECK(authority='unverified'),
    task_id TEXT NOT NULL REFERENCES run_evaluation_tasks(id) ON DELETE RESTRICT,
    attempt_id TEXT NOT NULL REFERENCES run_evaluation_task_attempts(id) ON DELETE RESTRICT,
    invocation_id TEXT NOT NULL,
    evaluation_key TEXT NOT NULL,
    frozen_digest TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    scope_digest TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK(verdict IN ('pass','fail','abstain','error')),
    score REAL CHECK(score IS NULL OR (score>=0 AND score<=1)),
    severity TEXT CHECK(severity IS NULL OR severity IN ('info','warning','error','critical')),
    raw_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    raw_artifact_sha TEXT NOT NULL,
    rationale_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    rationale_artifact_sha TEXT,
    input_tokens INTEGER CHECK(input_tokens IS NULL OR (typeof(input_tokens)='integer' AND input_tokens BETWEEN 0 AND ${MAX})),
    output_tokens INTEGER CHECK(output_tokens IS NULL OR (typeof(output_tokens)='integer' AND output_tokens BETWEEN 0 AND ${MAX})),
    amount_micros INTEGER CHECK(amount_micros IS NULL OR (typeof(amount_micros)='integer' AND amount_micros BETWEEN 0 AND ${MAX})),
    latency_ms INTEGER CHECK(latency_ms IS NULL OR (typeof(latency_ms)='integer' AND latency_ms BETWEEN 0 AND ${MAX})),
    result_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK((rationale_artifact_id IS NULL)=(rationale_artifact_sha IS NULL))
  )`
}, ...[
  ["idx_evaluation_tasks_identity", "run_evaluation_tasks", "UNIQUE", "idempotency_key"],
  ["idx_evaluation_tasks_semantic", "run_evaluation_tasks", "UNIQUE", "evaluation_id,frozen_digest,repeat_ordinal"],
  ["idx_evaluation_tasks_claimable", "run_evaluation_tasks", "", "state,COALESCE(next_attempt_at,created_at),created_at,id"],
  ["idx_evaluation_attempts_number", "run_evaluation_task_attempts", "UNIQUE", "task_id,attempt_number"],
  ["idx_evaluation_attempts_token", "run_evaluation_task_attempts", "UNIQUE", "task_id,claim_token"],
  ["idx_evaluation_attempts_invocation", "run_evaluation_task_attempts", "UNIQUE", "invocation_id"],
  ["idx_evaluation_attempts_expiry", "run_evaluation_task_attempts", "", "state,claim_expires_at,id"],
  ["idx_evaluation_results_task", "run_evaluation_task_results", "UNIQUE", "task_id"],
  ["idx_evaluation_results_attempt", "run_evaluation_task_results", "UNIQUE", "attempt_id"],
  ["idx_evaluation_results_invocation", "run_evaluation_task_results", "UNIQUE", "invocation_id"],
].map(([name, table, unique, columns]) => ({
  name: name!,
  table: table!,
  type: "index" as const,
  sql: `CREATE ${unique} INDEX ${name} ON ${table}(${columns})`
})), ...[
  ["run_evaluation_tasks", "id,schema_version,evaluation_id,evaluation_key,grader_type,frozen_json,frozen_artifact_id,frozen_artifact_sha,frozen_digest,repeat_ordinal,idempotency_key,created_at"],
  ["run_evaluation_task_attempts", "id,schema_version,task_id,attempt_number,claim_owner,claim_token,claimed_at"],
].map(([table, fields]) => ({
  name: `${table}_identity_immutable`,
  table: table!,
  type: "trigger" as const,
  sql: `CREATE TRIGGER ${table}_identity_immutable BEFORE UPDATE OF ${fields} ON ${table} BEGIN SELECT RAISE(ABORT,'evaluation.task_invalid'); END`
})), ...["run_evaluation_tasks", "run_evaluation_task_attempts", "run_evaluation_task_results"].map(table => ({
  name: `${table}_no_delete`,
  table,
  type: "trigger" as const,
  sql: `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'evaluation.task_invalid'); END`
})), {
  name: "run_evaluation_task_results_no_update",
  table: "run_evaluation_task_results",
  type: "trigger",
  sql: "CREATE TRIGGER run_evaluation_task_results_no_update BEFORE UPDATE ON run_evaluation_task_results BEGIN SELECT RAISE(ABORT,'evaluation.task_invalid'); END"
}, {
  name: "run_evaluation_task_attempts_dispatch_immutable",
  table: "run_evaluation_task_attempts",
  type: "trigger",
  sql: `CREATE TRIGGER run_evaluation_task_attempts_dispatch_immutable BEFORE UPDATE OF invocation_id,request_digest,scope_digest,admitted_at ON run_evaluation_task_attempts WHEN OLD.invocation_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'evaluation.task_invalid'); END`
}, ...["run_evaluation_tasks", "run_evaluation_task_attempts"].map(table => ({
  name: `${table}_terminal_immutable`,
  table,
  type: "trigger" as const,
  sql: `CREATE TRIGGER ${table}_terminal_immutable BEFORE UPDATE ON ${table} WHEN OLD.state NOT IN ('queued','active','claimed','dispatch_admitted') BEGIN SELECT RAISE(ABORT,'evaluation.task_invalid'); END`
})), {
  name: "run_evaluation_tasks_attempt_owner",
  table: "run_evaluation_tasks",
  type: "trigger",
  sql: `CREATE TRIGGER run_evaluation_tasks_attempt_owner BEFORE UPDATE OF active_attempt_id ON run_evaluation_tasks WHEN NEW.active_attempt_id IS NOT NULL BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM run_evaluation_task_attempts WHERE id=NEW.active_attempt_id AND task_id=NEW.id) THEN RAISE(ABORT,'evaluation.task_invalid') END; END`
}, {
  name: "run_evaluation_task_results_lineage",
  table: "run_evaluation_task_results",
  type: "trigger",
  sql: `CREATE TRIGGER run_evaluation_task_results_lineage BEFORE INSERT ON run_evaluation_task_results BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM run_evaluation_tasks t JOIN run_evaluation_task_attempts a ON a.id=t.active_attempt_id WHERE t.id=NEW.task_id AND a.id=NEW.attempt_id AND a.task_id=t.id AND t.state='active' AND a.state='dispatch_admitted' AND a.invocation_id=NEW.invocation_id AND t.evaluation_key=NEW.evaluation_key AND t.frozen_digest=NEW.frozen_digest AND a.request_digest=NEW.request_digest AND a.scope_digest=NEW.scope_digest) THEN RAISE(ABORT,'evaluation.task_invalid') END; END`
}];
export const RUN_EVALUATION_TASK_SCHEMA_OBJECTS: readonly string[] = [...definitions.map(item => item.name), ...["run_evaluation_tasks", "run_evaluation_task_attempts", "run_evaluation_task_results"].map(table => `sqlite_autoindex_${table}_1`)];

/** Exact additive sidecar; never rewrites 137 or synthesizes historical invocation facts. */
export function applyRunEvaluationTaskMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): boolean {
  const {
    database
  } = input;
  const inspect = (): boolean => {
    const markers = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?").all(RUN_EVALUATION_TASK_MIGRATION_VERSION, RUN_EVALUATION_TASK_MIGRATION_NAME);
    if (markers.some(row => row.version !== RUN_EVALUATION_TASK_MIGRATION_VERSION || row.name !== RUN_EVALUATION_TASK_MIGRATION_NAME) || markers.length > 1 || input.hasMigration(158) !== (markers.length === 1)) throw new Error("evaluation.task_migration_conflict");
    for (const item of definitions) {
      const row = database.prepare("SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?").get(item.name);
      if (markers.length ? !row || row.type !== item.type || row.tbl_name !== item.table || normalize(String(row.sql)) !== normalize(item.sql) : row !== undefined) throw new Error("evaluation.task_migration_conflict");
    }
    return markers.length === 1;
  };
  if (inspect()) {
    assertForeignKeys(database);
    return false;
  }
  database.exec("BEGIN IMMEDIATE;");
  try {
    if (inspect()) {
      database.exec("COMMIT;");
      return false;
    }
    for (const item of definitions) database.exec(item.sql);
    input.recordMigration(158, RUN_EVALUATION_TASK_MIGRATION_NAME);
    if (!inspect()) throw new Error("evaluation.task_migration_marker_missing");
    assertForeignKeys(database);
    database.exec("COMMIT;");
    return true;
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}
function normalize(sql: string): string {
  return sql.trim().replace(/;$/u, "").replace(/'[^']*(?:''[^']*)*'|\s+/gu, token => token.startsWith("'") ? token : " ");
}
function assertForeignKeys(database: DatabaseSync): void {
  for (const definition of definitions.filter(item => item.type === "table")) {
    const expected = definition.sql.split("\n").flatMap(line => {
      const match = /^\s+(\w+) (TEXT|INTEGER|REAL)\b(.*)$/u.exec(line);
      return match ? [{
        name: match[1]!,
        type: match[2]!,
        notnull: match[3]!.includes("NOT NULL") ? 1 : 0,
        pk: match[3]!.includes("PRIMARY KEY") ? 1 : 0,
        reference: /REFERENCES (\w+)\(id\)/u.exec(match[3]!)?.[1]
      }] : [];
    });
    const columns = database.prepare(`PRAGMA table_xinfo(${definition.table})`).all();
    if (columns.length !== expected.length || columns.some((column, index) => column.cid !== index || column.name !== expected[index]!.name || column.type !== expected[index]!.type || column.notnull !== expected[index]!.notnull || column.pk !== expected[index]!.pk || column.hidden !== 0 || column.dflt_value !== null)) throw new Error("evaluation.task_migration_columns_invalid");
    const references = expected.filter(column => column.reference);
    const keys = database.prepare(`PRAGMA foreign_key_list(${definition.table})`).all();
    if (keys.length !== references.length || references.some(column => !keys.some(key => key.from === column.name && key.table === column.reference && key.to === "id" && key.seq === 0 && key.on_update === "NO ACTION" && key.on_delete === "RESTRICT" && key.match === "NONE"))) throw new Error("evaluation.task_migration_foreign_key_invalid");
    for (const target of new Set(references.map(column => column.reference!))) if (!database.prepare(`PRAGMA table_info(${target})`).all().some(column => column.name === "id" && column.pk === 1)) throw new Error("evaluation.task_migration_foreign_key_invalid");
    if (database.prepare(`PRAGMA foreign_key_check(${definition.table})`).all().length) throw new Error("evaluation.task_migration_foreign_key_invalid");
  }
  for (const definition of definitions.filter(item => item.type === "index")) {
    const index = database.prepare(`PRAGMA index_list(${definition.table})`).all().find(row => row.name === definition.name);
    if (!index || index.unique !== (/CREATE UNIQUE/u.test(definition.sql) ? 1 : 0)) throw new Error("evaluation.task_migration_index_invalid");
    // The authored SQL check above pins the exact expression. SQLite metadata
    // additionally distinguishes an expression key (cid=-2) from an ordinary
    // column and validates the order/collation used by the queue scan.
    const names = definition.name === "idx_evaluation_tasks_claimable"
      ? ["state", null, "created_at", "id"]
      : /\(([^)]+)\)$/u.exec(definition.sql)![1]!.split(",");
    const columns = database.prepare(`PRAGMA index_xinfo(${definition.name})`).all().filter(column => column.key === 1);
    if (columns.length !== names.length || columns.some((column, index) => (
      column.seqno !== index
      || column.name !== names[index]
      || (names[index] === null ? column.cid !== -2 : typeof column.cid !== "number" || column.cid < 0)
      || column.desc !== 0
      || column.coll !== "BINARY"
    ))) throw new Error("evaluation.task_migration_index_invalid");
  }
}
