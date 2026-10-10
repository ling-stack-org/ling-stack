import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const RUN_EVALUATION_QA_MIGRATION_VERSION = 159;
export const RUN_EVALUATION_QA_MIGRATION_NAME = "create_run_evaluation_qa_v1";
interface Definition { readonly name: string; readonly type: "table" | "index" | "trigger"; readonly table: string; readonly sql: string }
const MAX = "9007199254740990";
const definitions: readonly Definition[] = [{
  name: "run_evaluation_qa_namespace", type: "table", table: "run_evaluation_qa_namespace",
  sql: `CREATE TABLE run_evaluation_qa_namespace (
    id TEXT PRIMARY KEY NOT NULL,
    singleton INTEGER NOT NULL UNIQUE CHECK(singleton=1),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    canonical_cwd TEXT NOT NULL,
    batch_limit INTEGER NOT NULL CHECK(batch_limit=3),
    rolling_limit INTEGER NOT NULL CHECK(rolling_limit=12),
    rolling_window_ms INTEGER NOT NULL CHECK(rolling_window_ms=86400000),
    clock_high_water_at TEXT NOT NULL,
    lane_state TEXT NOT NULL CHECK(lane_state IN ('available','held','quarantined')),
    lane_request_id TEXT REFERENCES run_evaluation_qa_requests(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND ${MAX}),
    CHECK((lane_state='available' AND lane_request_id IS NULL) OR (lane_state<>'available' AND lane_request_id IS NOT NULL))
  )`
}, {
  name: "run_evaluation_qa_batches", type: "table", table: "run_evaluation_qa_batches",
  sql: `CREATE TABLE run_evaluation_qa_batches (
    id TEXT PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    namespace_id TEXT NOT NULL REFERENCES run_evaluation_qa_namespace(id) ON DELETE RESTRICT,
    config_snapshot_ref TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    config_artifact_sha TEXT NOT NULL CHECK(length(config_artifact_sha)=64 AND config_artifact_sha NOT GLOB '*[^0-9a-f]*'),
    config_digest TEXT NOT NULL CHECK(length(config_digest)=64 AND config_digest NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL
  )`
}, {
  name: "run_evaluation_qa_enrollments", type: "table", table: "run_evaluation_qa_enrollments",
  sql: `CREATE TABLE run_evaluation_qa_enrollments (
    id TEXT PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    task_id TEXT NOT NULL REFERENCES run_evaluation_tasks(id) ON DELETE RESTRICT,
    batch_id TEXT NOT NULL REFERENCES run_evaluation_qa_batches(id) ON DELETE RESTRICT,
    evaluation_id TEXT NOT NULL REFERENCES run_evaluations(id) ON DELETE RESTRICT,
    evaluation_key TEXT NOT NULL,
    pins_json TEXT NOT NULL CHECK(json_valid(pins_json)),
    frozen_digest TEXT NOT NULL CHECK(length(frozen_digest)=64 AND frozen_digest NOT GLOB '*[^0-9a-f]*'),
    review_ref TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`
}, {
  name: "run_evaluation_qa_requests", type: "table", table: "run_evaluation_qa_requests",
  sql: `CREATE TABLE run_evaluation_qa_requests (
    id TEXT PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    namespace_id TEXT NOT NULL REFERENCES run_evaluation_qa_namespace(id) ON DELETE RESTRICT,
    batch_id TEXT NOT NULL REFERENCES run_evaluation_qa_batches(id) ON DELETE RESTRICT,
    enrollment_id TEXT NOT NULL REFERENCES run_evaluation_qa_enrollments(id) ON DELETE RESTRICT,
    task_id TEXT NOT NULL REFERENCES run_evaluation_tasks(id) ON DELETE RESTRICT,
    attempt_id TEXT NOT NULL REFERENCES run_evaluation_task_attempts(id) ON DELETE RESTRICT,
    invocation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
    scope_digest TEXT NOT NULL CHECK(length(scope_digest)=64 AND scope_digest NOT GLOB '*[^0-9a-f]*'),
    payload_sha TEXT NOT NULL CHECK(length(payload_sha)=64 AND payload_sha NOT GLOB '*[^0-9a-f]*'),
    payload_bytes INTEGER NOT NULL CHECK(typeof(payload_bytes)='integer' AND payload_bytes BETWEEN 1 AND 32768),
    estimated_input_tokens INTEGER NOT NULL CHECK(typeof(estimated_input_tokens)='integer' AND estimated_input_tokens BETWEEN 1 AND 8000),
    output_token_limit INTEGER NOT NULL CHECK(output_token_limit=1024),
    state TEXT NOT NULL CHECK(state IN ('admitted','completed','unknown')),
    receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
    usage_json TEXT NOT NULL CHECK(json_valid(usage_json)),
    charged_at TEXT NOT NULL,
    boot_epoch TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND ${MAX}),
    completed_at TEXT,
    released_at TEXT,
    release_kind TEXT CHECK(release_kind IS NULL OR release_kind IN ('host_callback_drained','host_explicit_reconciliation')),
    reconciliation_audit_ref TEXT,
    CHECK((state='admitted' AND completed_at IS NULL AND receipt_json IS NULL) OR (state<>'admitted' AND completed_at IS NOT NULL)),
    CHECK((state='completed' AND receipt_json IS NOT NULL) OR (state<>'completed' AND receipt_json IS NULL)),
    CHECK((released_at IS NULL)=(release_kind IS NULL)),
    CHECK(released_at IS NULL OR state<>'admitted'),
    CHECK((release_kind='host_explicit_reconciliation' AND reconciliation_audit_ref IS NOT NULL) OR (reconciliation_audit_ref IS NULL AND (release_kind IS NULL OR release_kind='host_callback_drained')))
  )`
}, ...[
  ["idx_evaluation_qa_enrollment_task", "run_evaluation_qa_enrollments", "UNIQUE", "task_id"],
  ["idx_evaluation_qa_enrollment_batch_task", "run_evaluation_qa_enrollments", "", "batch_id,task_id"],
  ["idx_evaluation_qa_request_attempt", "run_evaluation_qa_requests", "UNIQUE", "attempt_id"],
  ["idx_evaluation_qa_request_invocation", "run_evaluation_qa_requests", "UNIQUE", "invocation_id"],
  ["idx_evaluation_qa_request_window", "run_evaluation_qa_requests", "", "namespace_id,charged_at,id"],
  ["idx_evaluation_qa_request_batch", "run_evaluation_qa_requests", "", "batch_id,id"],
  ["idx_evaluation_qa_request_recovery", "run_evaluation_qa_requests", "", "namespace_id,released_at,state,id"],
].map(([name, table, unique, fields]) => ({ name: name!, table: table!, type: "index" as const, sql: `CREATE ${unique} INDEX ${name} ON ${table}(${fields})` })),
...["run_evaluation_qa_namespace", "run_evaluation_qa_batches", "run_evaluation_qa_enrollments", "run_evaluation_qa_requests"].map(table => ({
  name: `${table}_no_delete`, table, type: "trigger" as const,
  sql: `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'evaluation.qa_invalid'); END`
})), ...["run_evaluation_qa_batches", "run_evaluation_qa_enrollments"].map(table => ({
  name: `${table}_no_update`, table, type: "trigger" as const,
  sql: `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'evaluation.qa_invalid'); END`
})), ...[
  ["run_evaluation_qa_namespace", "id,singleton,schema_version,canonical_cwd,batch_limit,rolling_limit,rolling_window_ms"],
  ["run_evaluation_qa_requests", "id,schema_version,namespace_id,batch_id,enrollment_id,task_id,attempt_id,invocation_id,request_digest,scope_digest,payload_sha,payload_bytes,estimated_input_tokens,output_token_limit,charged_at,boot_epoch"],
].map(([table, fields]) => ({ name: `${table}_identity_immutable`, table: table!, type: "trigger" as const,
  sql: `CREATE TRIGGER ${table}_identity_immutable BEFORE UPDATE OF ${fields} ON ${table} BEGIN SELECT RAISE(ABORT,'evaluation.qa_invalid'); END`
})), {
  name: "run_evaluation_qa_requests_terminal_immutable", table: "run_evaluation_qa_requests", type: "trigger",
  sql: "CREATE TRIGGER run_evaluation_qa_requests_terminal_immutable BEFORE UPDATE OF state,receipt_json,usage_json,completed_at ON run_evaluation_qa_requests WHEN OLD.state<>'admitted' BEGIN SELECT RAISE(ABORT,'evaluation.qa_invalid'); END"
}, {
  name: "run_evaluation_qa_requests_release_immutable", table: "run_evaluation_qa_requests", type: "trigger",
  sql: "CREATE TRIGGER run_evaluation_qa_requests_release_immutable BEFORE UPDATE ON run_evaluation_qa_requests WHEN OLD.released_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'evaluation.qa_invalid'); END"
}];
export const RUN_EVALUATION_QA_SCHEMA_OBJECTS = [...definitions.map(item => item.name),
  ...["run_evaluation_qa_namespace", "run_evaluation_qa_batches", "run_evaluation_qa_enrollments", "run_evaluation_qa_requests"].map(table => `sqlite_autoindex_${table}_1`),
  "sqlite_autoindex_run_evaluation_qa_namespace_2"] as const;

/** Exact sidecars only. Conflicting or partially authored schemas fail closed. */
export function applyRunEvaluationQaMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): boolean {
  const { database } = input;
  const inspect = (): boolean => {
    const markers = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?").all(159, RUN_EVALUATION_QA_MIGRATION_NAME);
    if (markers.length > 1 || markers.some(row => row.version !== 159 || row.name !== RUN_EVALUATION_QA_MIGRATION_NAME) || input.hasMigration(159) !== (markers.length === 1)) throw new Error("evaluation.qa_migration_conflict");
    for (const item of definitions) {
      const row = database.prepare("SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?").get(item.name);
      if (markers.length ? !row || row.type !== item.type || row.tbl_name !== item.table || normalize(String(row.sql)) !== normalize(item.sql) : row !== undefined) throw new Error("evaluation.qa_migration_conflict");
    }
    return markers.length === 1;
  };
  if (inspect()) { assertMetadata(database); return false; }
  // BEGIN deliberately outside try: never roll back a caller-owned transaction.
  database.exec("BEGIN IMMEDIATE;");
  try {
    if (inspect()) { database.exec("COMMIT;"); return false; }
    for (const item of definitions) database.exec(item.sql);
    input.recordMigration(159, RUN_EVALUATION_QA_MIGRATION_NAME);
    if (!inspect()) throw new Error("evaluation.qa_migration_marker_missing");
    assertMetadata(database);
    database.exec("COMMIT;");
    return true;
  } catch (error) { rollbackOwnedSqliteTransaction(database); throw error; }
}
function normalize(sql: string): string { return sql.trim().replace(/;$/u, "").replace(/'[^']*(?:''[^']*)*'|\s+/gu, token => token.startsWith("'") ? token : " "); }
function assertMetadata(database: DatabaseSync): void {
  for (const item of definitions.filter(definition => definition.type === "table")) {
    const expected = item.sql.split("\n").flatMap(line => {
      const match = /^\s+(\w+) (TEXT|INTEGER)\b(.*)$/u.exec(line);
      return match ? [{ name: match[1]!, type: match[2]!, notnull: match[3]!.includes("NOT NULL") ? 1 : 0, pk: match[3]!.includes("PRIMARY KEY") ? 1 : 0, reference: /REFERENCES (\w+)\(id\)/u.exec(match[3]!)?.[1] }] : [];
    });
    const columns = database.prepare(`PRAGMA table_xinfo(${item.table})`).all();
    if (columns.length !== expected.length || columns.some((column, index) => column.cid !== index || column.name !== expected[index]!.name || column.type !== expected[index]!.type || column.notnull !== expected[index]!.notnull || column.pk !== expected[index]!.pk || column.hidden !== 0 || column.dflt_value !== null)) throw new Error("evaluation.qa_migration_columns_invalid");
    const references = expected.filter(column => column.reference);
    const keys = database.prepare(`PRAGMA foreign_key_list(${item.table})`).all();
    if (keys.length !== references.length || references.some(column => !keys.some(key => key.from === column.name && key.table === column.reference && key.to === "id" && key.seq === 0 && key.on_update === "NO ACTION" && key.on_delete === "RESTRICT" && key.match === "NONE"))) throw new Error("evaluation.qa_migration_foreign_key_invalid");
    for (const target of new Set(references.map(column => column.reference!))) if (!database.prepare(`PRAGMA table_info(${target})`).all().some(column => column.name === "id" && column.pk === 1)) throw new Error("evaluation.qa_migration_foreign_key_invalid");
    if (database.prepare(`PRAGMA foreign_key_check(${item.table})`).all().length) throw new Error("evaluation.qa_migration_foreign_key_invalid");
  }
  for (const item of definitions.filter(definition => definition.type === "index")) {
    const index = database.prepare(`PRAGMA index_list(${item.table})`).all().find(row => row.name === item.name);
    const fields = /\(([^)]+)\)$/u.exec(item.sql)![1]!.split(",");
    const columns = database.prepare(`PRAGMA index_xinfo(${item.name})`).all().filter(column => column.key === 1);
    if (!index || index.unique !== (/CREATE UNIQUE/u.test(item.sql) ? 1 : 0) || columns.length !== fields.length || columns.some((column, i) => column.seqno !== i || column.name !== fields[i] || typeof column.cid !== "number" || column.cid < 0 || column.desc !== 0 || column.coll !== "BINARY")) throw new Error("evaluation.qa_migration_index_invalid");
  }
}
