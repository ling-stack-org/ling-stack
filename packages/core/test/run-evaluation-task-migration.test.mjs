import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyRunEvaluationTaskMigration, RUN_EVALUATION_TASK_SCHEMA_OBJECTS, RUN_EVALUATION_TASK_MIGRATION_VERSION, RUN_EVALUATION_TASK_MIGRATION_NAME } from "../dist/storage/sqlite/run-evaluation-task-migration.js";
const now = "2026-10-10T00:00:00.000Z";
function fixture(t) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec("PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL); CREATE TABLE run_evaluations(id TEXT PRIMARY KEY); CREATE TABLE artifacts(id TEXT PRIMARY KEY);");
  database.prepare("INSERT INTO schema_migrations VALUES(157,'add_availability_incident_provenance',?)").run(now);
  const input = {
    database,
    hasMigration: version => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, name, now)
  };
  return {
    database,
    input
  };
}
function schema(database) {
  return database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
}
test("158 exact additive schema has all owned objects, empty facts and stable idempotent reopen", t => {
  const {
    database,
    input
  } = fixture(t);
  assert.equal(RUN_EVALUATION_TASK_MIGRATION_VERSION, 158);
  assert.equal(applyRunEvaluationTaskMigration(input), true);
  const after = schema(database);
  assert.equal(applyRunEvaluationTaskMigration({
    ...input,
    recordMigration: () => assert.fail("no duplicate marker")
  }), false);
  assert.deepEqual(schema(database), after);
  for (const name of RUN_EVALUATION_TASK_SCHEMA_OBJECTS) assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name));
  for (const table of ["run_evaluation_tasks", "run_evaluation_task_attempts", "run_evaluation_task_results"]) assert.equal(database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version=158").get().name, RUN_EVALUATION_TASK_MIGRATION_NAME);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});
for (const fault of ["ddl", "marker", "marker_missing", "commit"]) test(`158 own transaction rolls back every object and marker on ${fault}`, t => {
  const {
      database,
      input
    } = fixture(t),
    before = schema(database),
    markers = database.prepare("SELECT * FROM schema_migrations").all();
  const wrapped = {
    prepare: sql => database.prepare(sql),
    exec: sql => {
      if (fault === "ddl" && sql.includes("CREATE TABLE run_evaluation_task_attempts")) throw new Error("injected");
      if (fault === "commit" && sql === "COMMIT;") throw new Error("injected");
      return database.exec(sql);
    }
  };
  assert.throws(() => applyRunEvaluationTaskMigration({
    ...input,
    database: wrapped,
    recordMigration: (version, name) => {
      if (fault === "marker") throw new Error("injected");
      if (fault !== "marker_missing") input.recordMigration(version, name);
    }
  }));
  assert.equal(database.isTransaction, false);
  assert.deepEqual(schema(database), before);
  assert.deepEqual(database.prepare("SELECT * FROM schema_migrations").all(), markers);
});
for (const conflict of ["version_owner", "name_owner", "unmarked_table", "missing_marked_table", "fake_index", "fake_claimable_expression", "fake_trigger"]) test(`158 refuses ${conflict} without altering history`, t => {
  const {
    database,
    input
  } = fixture(t);
  if (conflict === "version_owner") database.prepare("INSERT INTO schema_migrations VALUES(158,'other',?)").run(now);else if (conflict === "name_owner") database.prepare("INSERT INTO schema_migrations VALUES(159,?,?)").run(RUN_EVALUATION_TASK_MIGRATION_NAME, now);else if (conflict === "unmarked_table") database.exec("CREATE TABLE run_evaluation_tasks(id TEXT PRIMARY KEY)");else {
    applyRunEvaluationTaskMigration(input);
    if (conflict === "missing_marked_table") database.exec("DROP TABLE run_evaluation_task_results");else if (conflict === "fake_index") database.exec("DROP INDEX idx_evaluation_tasks_semantic; CREATE INDEX idx_evaluation_tasks_semantic ON run_evaluation_tasks(repeat_ordinal)");else if (conflict === "fake_claimable_expression") database.exec("DROP INDEX idx_evaluation_tasks_claimable; CREATE INDEX idx_evaluation_tasks_claimable ON run_evaluation_tasks(state,COALESCE(created_at,next_attempt_at),created_at,id)");else database.exec("DROP TRIGGER run_evaluation_task_results_no_update; CREATE TRIGGER run_evaluation_task_results_no_update BEFORE UPDATE ON run_evaluation_task_results BEGIN SELECT 1; END");
  }
  const before = schema(database),
    markers = database.prepare("SELECT * FROM schema_migrations").all();
  assert.throws(() => applyRunEvaluationTaskMigration(input), /evaluation.task_migration_conflict/u);
  assert.deepEqual(schema(database), before);
  assert.deepEqual(database.prepare("SELECT * FROM schema_migrations").all(), markers);
});
test("158 failed nested BEGIN preserves caller-owned transaction", t => {
  const {
    database,
    input
  } = fixture(t);
  database.exec("BEGIN IMMEDIATE;");
  try {
    assert.throws(() => applyRunEvaluationTaskMigration(input), /transaction/u);
    assert.equal(database.isTransaction, true);
    assert.equal(database.prepare("SELECT 1 FROM schema_migrations WHERE version=158").get(), undefined);
  } finally {
    database.exec("ROLLBACK;");
  }
});
test("158 claimable expression index avoids a temporary full-queue ORDER BY sort", t => {
  const {
    database,
    input
  } = fixture(t);
  applyRunEvaluationTaskMigration(input);
  const plan = database.prepare("EXPLAIN QUERY PLAN SELECT * FROM run_evaluation_tasks WHERE state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY COALESCE(next_attempt_at,created_at),created_at,id LIMIT ?").all(now, 2).map(row => row.detail);
  assert.ok(plan.some(detail => detail.includes("idx_evaluation_tasks_claimable")), JSON.stringify(plan));
  assert.ok(plan.every(detail => !detail.includes("TEMP B-TREE")), JSON.stringify(plan));
  const metadata = database.prepare("PRAGMA index_xinfo(idx_evaluation_tasks_claimable)").all().filter(column => column.key === 1);
  assert.deepEqual(metadata.map(column => ({
    name: column.name,
    cid: column.cid,
    desc: column.desc,
    coll: column.coll
  })), [{
    name: "state",
    cid: 11,
    desc: 0,
    coll: "BINARY"
  }, {
    name: null,
    cid: -2,
    desc: 0,
    coll: "BINARY"
  }, {
    name: "created_at",
    cid: 16,
    desc: 0,
    coll: "BINARY"
  }, {
    name: "id",
    cid: 0,
    desc: 0,
    coll: "BINARY"
  }]);
});
for (const field of ["cid", "name", "desc", "coll"]) test(`158 rejects parsed expression index metadata drift in ${field}`, t => {
  const {
    database,
    input
  } = fixture(t);
  applyRunEvaluationTaskMigration(input);
  const before = schema(database);
  const wrapped = {
    exec: sql => database.exec(sql),
    prepare: sql => sql === "PRAGMA index_xinfo(idx_evaluation_tasks_claimable)" ? {
      all: () => database.prepare(sql).all().map(row => row.seqno === 1 ? {
        ...row,
        [field]: {
          cid: 0,
          name: "created_at",
          desc: 1,
          coll: "NOCASE"
        }[field]
      } : row)
    } : database.prepare(sql)
  };
  assert.throws(() => applyRunEvaluationTaskMigration({
    ...input,
    database: wrapped
  }), /evaluation.task_migration_index_invalid/u);
  assert.deepEqual(schema(database), before);
});
