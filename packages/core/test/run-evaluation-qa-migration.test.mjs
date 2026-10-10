import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyRunEvaluationTaskMigration } from "../dist/storage/sqlite/run-evaluation-task-migration.js";
import { applyRunEvaluationQaMigration, RUN_EVALUATION_QA_SCHEMA_OBJECTS, RUN_EVALUATION_QA_MIGRATION_NAME, RUN_EVALUATION_QA_MIGRATION_VERSION } from "../dist/storage/sqlite/run-evaluation-qa-migration.js";
const now = "2026-10-10T00:00:00.000Z";
function fixture(t) {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  database.exec("PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL); CREATE TABLE run_evaluations(id TEXT PRIMARY KEY); CREATE TABLE artifacts(id TEXT PRIMARY KEY);");
  const input = { database, hasMigration: version => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)), recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, name, now) };
  applyRunEvaluationTaskMigration(input);
  return { database, input };
}
function schema(database) { return database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(); }
test("159 exactly owns four empty sidecars and reopens idempotently without changing158", t => {
  const { database, input } = fixture(t), before = schema(database), markers = database.prepare("SELECT * FROM schema_migrations").all();
  assert.equal(RUN_EVALUATION_QA_MIGRATION_VERSION, 159);
  assert.equal(applyRunEvaluationQaMigration(input), true);
  const after = schema(database);
  assert.equal(applyRunEvaluationQaMigration({ ...input, recordMigration: () => assert.fail("duplicate marker") }), false);
  assert.deepEqual(schema(database), after);
  for (const item of before) assert.deepEqual(after.find(row => row.name === item.name), item);
  assert.deepEqual(database.prepare("SELECT * FROM schema_migrations WHERE version=158").all(), markers);
  assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version=159").get().name, RUN_EVALUATION_QA_MIGRATION_NAME);
  for (const name of RUN_EVALUATION_QA_SCHEMA_OBJECTS) assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name), name);
  for (const table of ["run_evaluation_qa_namespace", "run_evaluation_qa_batches", "run_evaluation_qa_enrollments", "run_evaluation_qa_requests"]) assert.equal(database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});
for (const fault of ["ddl", "marker", "marker_missing", "commit"]) test(`159 own transaction rolls back all objects/marker on ${fault}`, t => {
  const { database, input } = fixture(t), before = schema(database), markers = database.prepare("SELECT * FROM schema_migrations").all();
  const wrapped = { prepare: sql => database.prepare(sql), exec: sql => {
    if (fault === "ddl" && sql.includes("CREATE TABLE run_evaluation_qa_enrollments")) throw new Error("injected");
    if (fault === "commit" && sql === "COMMIT;") throw new Error("injected");
    return database.exec(sql);
  } };
  assert.throws(() => applyRunEvaluationQaMigration({ ...input, database: wrapped, recordMigration: (version, name) => { if (fault === "marker") throw new Error("injected"); if (fault !== "marker_missing") input.recordMigration(version, name); } }));
  assert.equal(database.isTransaction, false);
  assert.deepEqual(schema(database), before);
  assert.deepEqual(database.prepare("SELECT * FROM schema_migrations").all(), markers);
});
for (const conflict of ["version_owner", "name_owner", "unmarked_table", "missing_table", "fake_index", "fake_trigger"]) test(`159 refuses ${conflict} without silently repairing schema`, t => {
  const { database, input } = fixture(t);
  if (conflict === "version_owner") database.prepare("INSERT INTO schema_migrations VALUES(159,'other',?)").run(now);
  else if (conflict === "name_owner") database.prepare("INSERT INTO schema_migrations VALUES(160,?,?)").run(RUN_EVALUATION_QA_MIGRATION_NAME, now);
  else if (conflict === "unmarked_table") database.exec("CREATE TABLE run_evaluation_qa_namespace(id TEXT PRIMARY KEY)");
  else {
    applyRunEvaluationQaMigration(input);
    if (conflict === "missing_table") database.exec("DROP TABLE run_evaluation_qa_requests");
    else if (conflict === "fake_index") database.exec("DROP INDEX idx_evaluation_qa_request_window; CREATE INDEX idx_evaluation_qa_request_window ON run_evaluation_qa_requests(charged_at)");
    else database.exec("DROP TRIGGER run_evaluation_qa_requests_release_immutable; CREATE TRIGGER run_evaluation_qa_requests_release_immutable BEFORE UPDATE ON run_evaluation_qa_requests BEGIN SELECT 1; END");
  }
  const before = schema(database), markers = database.prepare("SELECT * FROM schema_migrations").all();
  assert.throws(() => applyRunEvaluationQaMigration(input), /evaluation.qa_migration_conflict/u);
  assert.deepEqual(schema(database), before);
  assert.deepEqual(database.prepare("SELECT * FROM schema_migrations").all(), markers);
});
test("159 failed nested BEGIN never rolls back caller-owned transaction", t => {
  const { database, input } = fixture(t); database.exec("BEGIN IMMEDIATE;");
  try { assert.throws(() => applyRunEvaluationQaMigration(input), /transaction/u); assert.equal(database.isTransaction, true); assert.equal(database.prepare("SELECT 1 FROM schema_migrations WHERE version=159").get(), undefined); }
  finally { database.exec("ROLLBACK;"); }
});
for (const field of ["cid", "name", "desc", "coll"]) test(`159 rejects parsed quota index metadata drift in ${field}`, t => {
  const { database, input } = fixture(t); applyRunEvaluationQaMigration(input); const before = schema(database);
  const wrapped = { exec: sql => database.exec(sql), prepare: sql => sql === "PRAGMA index_xinfo(idx_evaluation_qa_request_window)" ? { all: () => database.prepare(sql).all().map(row => row.seqno === 1 ? { ...row, [field]: { cid: -2, name: "id", desc: 1, coll: "NOCASE" }[field] } : row) } : database.prepare(sql) };
  assert.throws(() => applyRunEvaluationQaMigration({ ...input, database: wrapped }), /evaluation.qa_migration_index_invalid/u);
  assert.deepEqual(schema(database), before);
});
test("159 rolling and batch quota scans use their authored leading-key indexes", t => {
  const { database, input } = fixture(t); applyRunEvaluationQaMigration(input);
  for (const [sql, params, index] of [
    ["SELECT COUNT(*) AS n FROM run_evaluation_qa_requests WHERE namespace_id=? AND charged_at>?", ["scope", now], "idx_evaluation_qa_request_window"],
    ["SELECT COUNT(*) AS n FROM run_evaluation_qa_requests WHERE batch_id=?", ["batch"], "idx_evaluation_qa_request_batch"],
  ]) {
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail);
    assert.ok(plan.some(detail => detail.includes(index)), JSON.stringify(plan));
  }
});
