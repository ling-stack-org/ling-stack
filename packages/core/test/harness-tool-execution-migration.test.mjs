import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "../dist/index.js";
import {
  applyHarnessToolExecutionMigration,
  HARNESS_TOOL_EXECUTION_MIGRATION_NAME,
  HARNESS_TOOL_EXECUTION_MIGRATION_VERSION,
} from "../dist/storage/sqlite/harness-tool-execution-migration.js";

const appliedAt = "2026-09-13T00:00:00.000Z";

test("schema 135 upgrades to ToolExecution schema 136 and reruns idempotently", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-tool-execution-upgrade-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let store = createSqliteRunStore(cwd);
  store.close();
  const path = resolveRuntimePaths(cwd).databasePath;
  let database = new DatabaseSync(path);
  database.exec(`
    DROP TABLE harness_tool_execution_artifacts;
    DROP TABLE harness_tool_executions;
    DELETE FROM schema_migrations WHERE version = 136;
  `);
  assert.equal(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 135);
  database.close();

  store = createSqliteRunStore(cwd);
  store.close();
  database = new DatabaseSync(path);
  t.after(() => database.close());
  assert.equal(
    database.prepare("SELECT name FROM schema_migrations WHERE version = 136").get().name,
    HARNESS_TOOL_EXECUTION_MIGRATION_NAME,
  );
  const columns = new Set(database.prepare("PRAGMA table_info(harness_tool_executions)").all().map((row) => row.name));
  assert.ok(columns.has("claim_token"));
  assert.ok(columns.has("side_effect_fingerprint"));
  assert.equal(database.prepare("PRAGMA foreign_key_check(harness_tool_executions)").all().length, 0);
  assert.equal(applyHarnessToolExecutionMigration(migrationInput(database)), false);
});

for (const fault of ["ddl", "marker", "marker_missing", "commit"]) {
  test(`ToolExecution migration fully rolls back on ${fault} failure`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), `ling-tool-execution-${fault}-`));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const database = new DatabaseSync(join(cwd, "fixture.sqlite"));
    t.after(() => database.close());
    createSchema135Fixture(database);
    const wrapped = {
      prepare: (sql) => database.prepare(sql),
      exec: (sql) => {
        if (fault === "ddl" && sql.includes("CREATE TABLE IF NOT EXISTS harness_tool_executions")) {
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
    assert.throws(() => applyHarnessToolExecutionMigration(input), /failure|postcondition/u);
    assert.equal(database.isTransaction, false);
    assert.equal(
      database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='harness_tool_executions'").get(),
      undefined,
    );
    assert.equal(database.prepare("SELECT 1 FROM schema_migrations WHERE version=136").get(), undefined);
  });
}

test("a recorded marker with a missing ToolExecution index is repaired", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-tool-execution-repair-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const database = new DatabaseSync(join(cwd, "fixture.sqlite"));
  t.after(() => database.close());
  createSchema135Fixture(database);
  assert.equal(applyHarnessToolExecutionMigration(migrationInput(database)), true);
  database.exec("DROP INDEX idx_harness_tool_executions_side_effect");
  assert.equal(applyHarnessToolExecutionMigration(migrationInput(database)), true);
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_harness_tool_executions_side_effect'").get());
});

function createSchema135Fixture(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations (version, name, applied_at) VALUES (135, 'create_runner_continuations', '${appliedAt}');
    CREATE TABLE run_sessions (id TEXT PRIMARY KEY);
    CREATE TABLE work_units (id TEXT PRIMARY KEY);
    CREATE TABLE work_unit_attempts (id TEXT PRIMARY KEY);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY);
    CREATE TABLE approval_requests (id TEXT PRIMARY KEY);
    CREATE TABLE runner_continuations (id TEXT PRIMARY KEY);
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
