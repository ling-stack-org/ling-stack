import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "../dist/index.js";
import {
  applyRunEvaluationMigration,
  RUN_EVALUATION_MIGRATION_NAME,
} from "../dist/storage/sqlite/run-evaluation-migration.js";

const appliedAt = "2026-09-14T00:00:00.000Z";

test("schema 136 upgrades to evaluation schema 137 and reruns idempotently", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-evaluation-upgrade-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let store = createSqliteRunStore(cwd);
  store.close();
  const path = resolveRuntimePaths(cwd).databasePath;
  let database = new DatabaseSync(path);
  database.exec(`
    DROP TABLE run_evaluation_grades;
    DROP TABLE run_evaluations;
    DELETE FROM schema_migrations WHERE version = 137;
  `);
  assert.equal(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 136);
  database.close();

  store = createSqliteRunStore(cwd);
  store.close();
  database = new DatabaseSync(path);
  t.after(() => database.close());
  assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version = 137").get().name,
    RUN_EVALUATION_MIGRATION_NAME);
  const columns = new Set(database.prepare("PRAGMA table_info(run_evaluations)").all().map((row) => row.name));
  assert.ok(columns.has("suite_digest"));
  assert.ok(columns.has("candidate_digest"));
  assert.ok(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_run_evaluation_grades_no_update'",
  ).get());
  assert.equal(database.prepare("PRAGMA foreign_key_check(run_evaluations)").all().length, 0);
  assert.equal(applyRunEvaluationMigration(migrationInput(database)), false);
});

for (const fault of ["ddl", "marker", "marker_missing", "commit"]) {
  test(`evaluation migration fully rolls back on ${fault} failure`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), `ling-evaluation-${fault}-`));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const database = new DatabaseSync(join(cwd, "fixture.sqlite"));
    t.after(() => database.close());
    createSchema136Fixture(database);
    const wrapped = {
      prepare: (sql) => database.prepare(sql),
      exec: (sql) => {
        if (fault === "ddl" && sql.includes("CREATE TABLE IF NOT EXISTS run_evaluations")) {
          throw new Error("injected ddl failure");
        }
        if (fault === "commit" && sql.trim() === "COMMIT;") throw new Error("injected commit failure");
        return database.exec(sql);
      },
    };
    const input = {
      database: wrapped,
      hasMigration: (version) => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)),
      recordMigration: (version, name) => {
        if (fault === "marker") throw new Error("injected marker failure");
        if (fault !== "marker_missing") {
          database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
            .run(version, name, appliedAt);
        }
      },
    };
    assert.throws(() => applyRunEvaluationMigration(input), /failure|postcondition/u);
    assert.equal(database.isTransaction, false);
    assert.equal(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='run_evaluations'",
    ).get(), undefined);
    assert.equal(database.prepare("SELECT 1 FROM schema_migrations WHERE version=137").get(), undefined);
  });
}

test("a recorded marker with a missing evaluation index and trigger is repaired", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-evaluation-repair-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const database = new DatabaseSync(join(cwd, "fixture.sqlite"));
  t.after(() => database.close());
  createSchema136Fixture(database);
  assert.equal(applyRunEvaluationMigration(migrationInput(database)), true);
  database.exec(`
    DROP INDEX idx_run_evaluations_lineage;
    DROP TRIGGER trg_run_evaluation_grades_no_update;
  `);
  assert.equal(applyRunEvaluationMigration(migrationInput(database)), true);
  assert.ok(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_run_evaluations_lineage'",
  ).get());
  assert.ok(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_run_evaluation_grades_no_update'",
  ).get());
});

function createSchema136Fixture(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations (version, name, applied_at) VALUES (136, 'create_harness_tool_executions', '${appliedAt}');
    CREATE TABLE run_sessions (id TEXT PRIMARY KEY);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY);
  `);
}

function migrationInput(database) {
  return {
    database,
    hasMigration: (version) => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)),
    recordMigration: (version, name) => database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(version, name, appliedAt),
  };
}
