import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
export const RUN_EVALUATION_HUMAN_MIGRATION_VERSION = 160;
export const RUN_EVALUATION_HUMAN_MIGRATION_NAME = "create_run_evaluation_human_v1";
interface Definition { readonly name: string; readonly type: "table" | "index" | "trigger"; readonly table: string; readonly sql: string }
const MAX = "9007199254740990";
const definitions: readonly Definition[] = [{
  name: "run_evaluation_human_intents", type: "table", table: "run_evaluation_human_intents",
  sql: `CREATE TABLE run_evaluation_human_intents (
    id TEXT PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    request_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES run_evaluation_tasks(id) ON DELETE RESTRICT,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
    boot_epoch TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','consumed')),
    created_at TEXT NOT NULL,
    consumed_at TEXT,
    consumed_event_id TEXT REFERENCES run_evaluation_human_events(id) ON DELETE RESTRICT,
    CHECK((state='pending' AND consumed_at IS NULL AND consumed_event_id IS NULL) OR (state='consumed' AND consumed_at IS NOT NULL AND consumed_event_id IS NOT NULL))
  )`
}, {
  name: "run_evaluation_human_events", type: "table", table: "run_evaluation_human_events",
  sql: `CREATE TABLE run_evaluation_human_events (
    id TEXT PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    task_id TEXT NOT NULL REFERENCES run_evaluation_tasks(id) ON DELETE RESTRICT,
    enrollment_id TEXT NOT NULL REFERENCES run_evaluation_qa_enrollments(id) ON DELETE RESTRICT,
    evaluation_id TEXT NOT NULL REFERENCES run_evaluations(id) ON DELETE RESTRICT,
    intent_id TEXT NOT NULL REFERENCES run_evaluation_human_intents(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND ${MAX}),
    previous_event_id TEXT REFERENCES run_evaluation_human_events(id) ON DELETE RESTRICT,
    submission_json TEXT NOT NULL CHECK(json_valid(submission_json)),
    payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
    confirmation_json TEXT NOT NULL CHECK(json_valid(confirmation_json)),
    audit_seq INTEGER NOT NULL REFERENCES control_plane_events(seq) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    CHECK((revision=1 AND previous_event_id IS NULL AND json_extract(submission_json,'$.kind')='adjudicate') OR (revision>1 AND previous_event_id IS NOT NULL AND json_extract(submission_json,'$.kind') IN ('correct','revoke')))
  )`
}, {
  name: "run_evaluation_human_heads", type: "table", table: "run_evaluation_human_heads",
  sql: `CREATE TABLE run_evaluation_human_heads (
    task_id TEXT PRIMARY KEY NOT NULL REFERENCES run_evaluation_tasks(id) ON DELETE RESTRICT,
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    enrollment_id TEXT NOT NULL REFERENCES run_evaluation_qa_enrollments(id) ON DELETE RESTRICT,
    evaluation_id TEXT NOT NULL REFERENCES run_evaluations(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND ${MAX}),
    event_id TEXT NOT NULL REFERENCES run_evaluation_human_events(id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK(state IN ('active','revoked')),
    updated_at TEXT NOT NULL
  )`
}, ...[
  ["idx_evaluation_human_intent_request", "run_evaluation_human_intents", "UNIQUE", "request_id"],
  ["idx_evaluation_human_event_intent", "run_evaluation_human_events", "UNIQUE", "intent_id"],
  ["idx_evaluation_human_event_revision", "run_evaluation_human_events", "UNIQUE", "task_id,revision"],
  ["idx_evaluation_human_event_audit", "run_evaluation_human_events", "UNIQUE", "audit_seq"],
].map(([name, table, unique, fields]) => ({ name: name!, table: table!, type: "index" as const, sql: `CREATE ${unique} INDEX ${name} ON ${table}(${fields})` })),
... ["run_evaluation_human_intents", "run_evaluation_human_events", "run_evaluation_human_heads"].map(table => ({
  name: `${table}_no_delete`, table, type: "trigger" as const,
  sql: `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'evaluation.human_invalid'); END`
})), ...[
  ["run_evaluation_human_intents", "id=NEW.id OR request_id=NEW.request_id"],
  ["run_evaluation_human_events", "id=NEW.id OR intent_id=NEW.intent_id OR (task_id=NEW.task_id AND revision=NEW.revision) OR audit_seq=NEW.audit_seq"],
  ["run_evaluation_human_heads", "task_id=NEW.task_id"],
].map(([table, predicate]) => ({
  name: `${table}_no_replace`, table: table!, type: "trigger" as const,
  sql: `CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${predicate}) BEGIN SELECT RAISE(ABORT,'evaluation.human_invalid'); END`
})), {
  name: "run_evaluation_human_events_no_update", table: "run_evaluation_human_events", type: "trigger",
  sql: "CREATE TRIGGER run_evaluation_human_events_no_update BEFORE UPDATE ON run_evaluation_human_events BEGIN SELECT RAISE(ABORT,'evaluation.human_invalid'); END"
}, {
  name: "run_evaluation_human_intents_identity_immutable", table: "run_evaluation_human_intents", type: "trigger",
  sql: "CREATE TRIGGER run_evaluation_human_intents_identity_immutable BEFORE UPDATE OF id,schema_version,request_id,task_id,payload_json,payload_digest,boot_epoch,expires_at,created_at ON run_evaluation_human_intents BEGIN SELECT RAISE(ABORT,'evaluation.human_invalid'); END"
}, {
  name: "run_evaluation_human_intents_consumption", table: "run_evaluation_human_intents", type: "trigger",
  sql: `CREATE TRIGGER run_evaluation_human_intents_consumption BEFORE UPDATE ON run_evaluation_human_intents BEGIN
    SELECT CASE WHEN OLD.state<>'pending' OR NEW.state<>'consumed' OR NOT EXISTS(SELECT 1 FROM run_evaluation_human_events e WHERE e.id=NEW.consumed_event_id AND e.intent_id=OLD.id AND e.task_id=OLD.task_id AND e.payload_digest=OLD.payload_digest AND e.created_at=NEW.consumed_at) THEN RAISE(ABORT,'evaluation.human_invalid') END; END`
}, {
  name: "run_evaluation_human_events_lineage", table: "run_evaluation_human_events", type: "trigger",
  sql: `CREATE TRIGGER run_evaluation_human_events_lineage BEFORE INSERT ON run_evaluation_human_events BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM run_evaluation_human_intents i JOIN run_evaluation_qa_enrollments q ON q.task_id=i.task_id WHERE i.id=NEW.intent_id AND i.state='pending' AND i.task_id=NEW.task_id AND i.payload_digest=NEW.payload_digest AND q.id=NEW.enrollment_id AND q.evaluation_id=NEW.evaluation_id AND json_extract(i.payload_json,'$.expectedHeadRevision')=NEW.revision-1 AND json_extract(i.payload_json,'$.submission')=json(NEW.submission_json)) THEN RAISE(ABORT,'evaluation.human_invalid') END;
    SELECT CASE WHEN (NEW.revision=1 AND EXISTS(SELECT 1 FROM run_evaluation_human_heads WHERE task_id=NEW.task_id)) OR (NEW.revision>1 AND NOT EXISTS(SELECT 1 FROM run_evaluation_human_heads h WHERE h.task_id=NEW.task_id AND h.state='active' AND h.revision=NEW.revision-1 AND h.event_id=NEW.previous_event_id AND ((json_extract(NEW.submission_json,'$.kind')='correct' AND json_extract(NEW.submission_json,'$.supersedesEventId')=h.event_id) OR (json_extract(NEW.submission_json,'$.kind')='revoke' AND json_extract(NEW.submission_json,'$.revokesEventId')=h.event_id)))) THEN RAISE(ABORT,'evaluation.human_invalid') END; END`
}, {
  name: "run_evaluation_human_heads_identity_immutable", table: "run_evaluation_human_heads", type: "trigger",
  sql: "CREATE TRIGGER run_evaluation_human_heads_identity_immutable BEFORE UPDATE OF task_id,schema_version,enrollment_id,evaluation_id ON run_evaluation_human_heads BEGIN SELECT RAISE(ABORT,'evaluation.human_invalid'); END"
}, ...["INSERT", "UPDATE"].map(operation => ({
  name: `run_evaluation_human_heads_${operation.toLowerCase()}_lineage`, table: "run_evaluation_human_heads", type: "trigger" as const,
  sql: `CREATE TRIGGER run_evaluation_human_heads_${operation.toLowerCase()}_lineage BEFORE ${operation} ON run_evaluation_human_heads BEGIN
    ${operation === "UPDATE" ? "SELECT CASE WHEN OLD.state<>'active' OR NEW.revision<>OLD.revision+1 THEN RAISE(ABORT,'evaluation.human_invalid') END;" : "SELECT CASE WHEN NEW.revision<>1 THEN RAISE(ABORT,'evaluation.human_invalid') END;"}
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM run_evaluation_human_events e WHERE e.id=NEW.event_id AND e.task_id=NEW.task_id AND e.enrollment_id=NEW.enrollment_id AND e.evaluation_id=NEW.evaluation_id AND e.revision=NEW.revision AND e.created_at=NEW.updated_at AND ((NEW.state='revoked' AND json_extract(e.submission_json,'$.kind')='revoke') OR (NEW.state='active' AND json_extract(e.submission_json,'$.kind') IN ('adjudicate','correct'))) ${operation === "UPDATE" ? "AND e.previous_event_id=OLD.event_id" : "AND e.previous_event_id IS NULL"}) THEN RAISE(ABORT,'evaluation.human_invalid') END; END`
}))];
export const RUN_EVALUATION_HUMAN_SCHEMA_OBJECTS: readonly string[] = [...definitions.map(item => item.name), ...["run_evaluation_human_intents", "run_evaluation_human_events", "run_evaluation_human_heads"].map(table => `sqlite_autoindex_${table}_1`)];

/** Exact additive human-authority sidecars. No historical grades, identities or promotion backfill. */
export function applyRunEvaluationHumanMigration(input: { readonly database: DatabaseSync; readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): boolean {
  const { database } = input;
  const inspect = (): boolean => {
    const markers = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?").all(160, RUN_EVALUATION_HUMAN_MIGRATION_NAME);
    if (markers.length > 1 || markers.some(row => row.version !== 160 || row.name !== RUN_EVALUATION_HUMAN_MIGRATION_NAME) || input.hasMigration(160) !== (markers.length === 1)) throw new Error("evaluation.human_migration_conflict");
    for (const item of definitions) {
      const row = database.prepare("SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?").get(item.name);
      if (markers.length ? !row || row.type !== item.type || row.tbl_name !== item.table || normalize(String(row.sql)) !== normalize(item.sql) : row !== undefined) throw new Error("evaluation.human_migration_conflict");
    }
    return markers.length === 1;
  };
  if (inspect()) { assertMetadata(database); return false; }
  // Never roll back a caller-owned transaction when nested BEGIN fails.
  database.exec("BEGIN IMMEDIATE;");
  try {
    if (inspect()) { database.exec("COMMIT;"); return false; }
    for (const item of definitions) database.exec(item.sql);
    input.recordMigration(160, RUN_EVALUATION_HUMAN_MIGRATION_NAME);
    if (!inspect()) throw new Error("evaluation.human_migration_marker_missing");
    assertMetadata(database); database.exec("COMMIT;"); return true;
  } catch (error) { rollbackOwnedSqliteTransaction(database); throw error; }
}
function normalize(sql: string): string { return sql.trim().replace(/;$/u, "").replace(/'[^']*(?:''[^']*)*'|\s+/gu, token => token.startsWith("'") ? token : " "); }
function assertMetadata(database: DatabaseSync): void {
  for (const item of definitions.filter(definition => definition.type === "table")) {
    const expected = item.sql.split("\n").flatMap(line => {
      const match = /^\s+(\w+) (TEXT|INTEGER)\b(.*)$/u.exec(line);
      const reference = match && /REFERENCES (\w+)\((\w+)\)/u.exec(match[3]!);
      return match ? [{ name: match[1]!, type: match[2]!, notnull: match[3]!.includes("NOT NULL") ? 1 : 0, pk: match[3]!.includes("PRIMARY KEY") ? 1 : 0, reference: reference ? { table: reference[1]!, column: reference[2]! } : undefined }] : [];
    });
    const columns = database.prepare(`PRAGMA table_xinfo(${item.table})`).all();
    if (columns.length !== expected.length || columns.some((column, i) => column.cid !== i || column.name !== expected[i]!.name || column.type !== expected[i]!.type || column.notnull !== expected[i]!.notnull || column.pk !== expected[i]!.pk || column.hidden !== 0 || column.dflt_value !== null)) throw new Error("evaluation.human_migration_columns_invalid");
    const references = expected.filter(column => column.reference), keys = database.prepare(`PRAGMA foreign_key_list(${item.table})`).all();
    if (keys.length !== references.length || references.some(column => !keys.some(key => key.from === column.name && key.table === column.reference!.table && key.to === column.reference!.column && key.seq === 0 && key.on_update === "NO ACTION" && key.on_delete === "RESTRICT" && key.match === "NONE"))) throw new Error("evaluation.human_migration_foreign_key_invalid");
    for (const ref of references) if (!database.prepare(`PRAGMA table_info(${ref.reference!.table})`).all().some(column => column.name === ref.reference!.column && column.pk === 1)) throw new Error("evaluation.human_migration_foreign_key_invalid");
    if (database.prepare(`PRAGMA foreign_key_check(${item.table})`).all().length) throw new Error("evaluation.human_migration_foreign_key_invalid");
  }
  for (const item of definitions.filter(definition => definition.type === "index")) {
    const index = database.prepare(`PRAGMA index_list(${item.table})`).all().find(row => row.name === item.name);
    const fields = /\(([^)]+)\)$/u.exec(item.sql)![1]!.split(","), columns = database.prepare(`PRAGMA index_xinfo(${item.name})`).all().filter(column => column.key === 1);
    if (!index || index.unique !== 1 || columns.length !== fields.length || columns.some((column, i) => column.seqno !== i || column.name !== fields[i] || typeof column.cid !== "number" || column.cid < 0 || column.desc !== 0 || column.coll !== "BINARY")) throw new Error("evaluation.human_migration_index_invalid");
  }
}
