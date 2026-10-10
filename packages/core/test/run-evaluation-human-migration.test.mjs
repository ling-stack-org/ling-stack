import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyRunEvaluationTaskMigration } from "../dist/storage/sqlite/run-evaluation-task-migration.js";
import { applyRunEvaluationQaMigration } from "../dist/storage/sqlite/run-evaluation-qa-migration.js";
import { applyRunEvaluationHumanMigration, RUN_EVALUATION_HUMAN_SCHEMA_OBJECTS, RUN_EVALUATION_HUMAN_MIGRATION_NAME, RUN_EVALUATION_HUMAN_MIGRATION_VERSION } from "../dist/storage/sqlite/run-evaluation-human-migration.js";
const now = "2026-10-10T00:00:00.000Z";
function fixture(t) {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  database.exec("PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL); CREATE TABLE run_evaluations(id TEXT PRIMARY KEY); CREATE TABLE artifacts(id TEXT PRIMARY KEY); CREATE TABLE control_plane_events(seq INTEGER PRIMARY KEY);");
  const input = { database, hasMigration: version => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)), recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, name, now) };
  applyRunEvaluationTaskMigration(input); applyRunEvaluationQaMigration(input);
  return { database, input };
}
function schema(database) { return database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(); }
test("160 exactly owns three empty sidecars, durable audit FK and stable reopen without changing137/158/159", t => {
  const { database, input } = fixture(t), before = schema(database), markers = database.prepare("SELECT * FROM schema_migrations").all();
  assert.equal(RUN_EVALUATION_HUMAN_MIGRATION_VERSION, 160);
  assert.equal(applyRunEvaluationHumanMigration(input), true);
  const after = schema(database);
  assert.equal(applyRunEvaluationHumanMigration({ ...input, recordMigration: () => assert.fail("duplicate marker") }), false);
  assert.deepEqual(schema(database), after);
  for (const item of before) assert.deepEqual(after.find(row => row.name === item.name), item);
  assert.deepEqual(database.prepare("SELECT * FROM schema_migrations WHERE version<>160").all(), markers);
  assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version=160").get().name, RUN_EVALUATION_HUMAN_MIGRATION_NAME);
  for (const name of RUN_EVALUATION_HUMAN_SCHEMA_OBJECTS) assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name), name);
  for (const table of ["run_evaluation_human_intents", "run_evaluation_human_events", "run_evaluation_human_heads"]) assert.equal(database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  assert.ok(database.prepare("PRAGMA foreign_key_list(run_evaluation_human_events)").all().some(row => row.from === "audit_seq" && row.table === "control_plane_events" && row.to === "seq" && row.on_delete === "RESTRICT"));
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});
for (const fault of ["ddl", "marker", "marker_missing", "commit"]) test(`160 own transaction rolls every authored object/marker back on ${fault}`, t => {
  const { database, input } = fixture(t), before = schema(database), markers = database.prepare("SELECT * FROM schema_migrations").all();
  const wrapped = { prepare: sql => database.prepare(sql), exec: sql => {
    if (fault === "ddl" && sql.includes("CREATE TABLE run_evaluation_human_events")) throw new Error("injected");
    if (fault === "commit" && sql === "COMMIT;") throw new Error("injected");
    return database.exec(sql);
  } };
  assert.throws(() => applyRunEvaluationHumanMigration({ ...input, database: wrapped, recordMigration: (version, name) => { if (fault === "marker") throw new Error("injected"); if (fault !== "marker_missing") input.recordMigration(version, name); } }));
  assert.deepEqual(schema(database), before); assert.deepEqual(database.prepare("SELECT * FROM schema_migrations").all(), markers);
});
for (const conflict of ["version_owner", "name_owner", "unmarked_table", "missing_table", "fake_index", "fake_trigger"]) test(`160 rejects ${conflict}; no silent schema repair or historical changes`, t => {
  const { database, input } = fixture(t);
  if (conflict === "version_owner") database.prepare("INSERT INTO schema_migrations VALUES(160,'other',?)").run(now);
  else if (conflict === "name_owner") database.prepare("INSERT INTO schema_migrations VALUES(161,?,?)").run(RUN_EVALUATION_HUMAN_MIGRATION_NAME, now);
  else if (conflict === "unmarked_table") database.exec("CREATE TABLE run_evaluation_human_intents(id TEXT PRIMARY KEY)");
  else {
    applyRunEvaluationHumanMigration(input);
    if (conflict === "missing_table") database.exec("DROP TABLE run_evaluation_human_heads");
    else if (conflict === "fake_index") database.exec("DROP INDEX idx_evaluation_human_event_revision; CREATE INDEX idx_evaluation_human_event_revision ON run_evaluation_human_events(revision)");
    else database.exec("DROP TRIGGER run_evaluation_human_intents_consumption; CREATE TRIGGER run_evaluation_human_intents_consumption BEFORE UPDATE ON run_evaluation_human_intents BEGIN SELECT 1; END");
  }
  const before = schema(database), markers = database.prepare("SELECT * FROM schema_migrations").all();
  assert.throws(() => applyRunEvaluationHumanMigration(input), /evaluation.human_migration_conflict/u);
  assert.deepEqual(schema(database), before); assert.deepEqual(database.prepare("SELECT * FROM schema_migrations").all(), markers);
});
test("160 failed nested BEGIN never rolls back caller transaction", t => {
  const { database, input } = fixture(t); database.exec("BEGIN IMMEDIATE;");
  try {
    database.prepare("INSERT INTO schema_migrations VALUES(999,'caller',?)").run(now);
    assert.throws(() => applyRunEvaluationHumanMigration(input), /transaction/u);
    assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version=999").get().name, "caller");
    assert.equal(database.prepare("SELECT 1 FROM schema_migrations WHERE version=160").get(), undefined);
  } finally { database.exec("ROLLBACK;"); }
});
for (const field of ["cid", "name", "desc", "coll"]) test(`160 rejects parsed head-event revision index ${field} drift`, t => {
  const { database, input } = fixture(t); applyRunEvaluationHumanMigration(input); const before = schema(database);
  const wrapped = { exec: sql => database.exec(sql), prepare: sql => sql === "PRAGMA index_xinfo(idx_evaluation_human_event_revision)" ? { all: () => database.prepare(sql).all().map(row => row.seqno === 1 ? { ...row, [field]: { cid: -2, name: "id", desc: 1, coll: "NOCASE" }[field] } : row) } : database.prepare(sql) };
  assert.throws(() => applyRunEvaluationHumanMigration({ ...input, database: wrapped }), /evaluation.human_migration_index_invalid/u);
  assert.deepEqual(schema(database), before);
});
test("160 rejects parsed audit FK target drift", t => {
  const { database, input } = fixture(t); applyRunEvaluationHumanMigration(input);
  const wrapped = { exec: sql => database.exec(sql), prepare: sql => sql === "PRAGMA foreign_key_list(run_evaluation_human_events)" ? { all: () => database.prepare(sql).all().map(row => row.from === "audit_seq" ? { ...row, to: "id" } : row) } : database.prepare(sql) };
  assert.throws(() => applyRunEvaluationHumanMigration({ ...input, database: wrapped }), /evaluation.human_migration_foreign_key_invalid/u);
});
test("160 refuses malformed referenced audit primary key and rolls schema/marker fully back", t => {
  const { database, input } = fixture(t);
  database.exec("DROP TABLE control_plane_events; CREATE TABLE control_plane_events(seq INTEGER)");
  const before = schema(database);
  assert.throws(() => applyRunEvaluationHumanMigration(input), /evaluation.human_migration_foreign_key_invalid/u);
  assert.deepEqual(schema(database), before); assert.equal(database.prepare("SELECT 1 FROM schema_migrations WHERE version=160").get(), undefined);
});
test("160 bounded task-event pagination uses the authored task+revision unique index", t => {
  const { database, input } = fixture(t); applyRunEvaluationHumanMigration(input);
  const plan = database.prepare("EXPLAIN QUERY PLAN SELECT * FROM run_evaluation_human_events WHERE task_id=? AND revision>? ORDER BY revision LIMIT ?").all("task", 1, 5).map(row => row.detail);
  assert.ok(plan.some(detail => detail.includes("idx_evaluation_human_event_revision")), JSON.stringify(plan));
  assert.ok(plan.every(detail => !detail.includes("TEMP B-TREE")), JSON.stringify(plan));
});
