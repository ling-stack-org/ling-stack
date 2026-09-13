import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "../dist/index.js";
import {
  applyRunnerContinuationMigration,
  RUNNER_CONTINUATION_MIGRATION_NAME,
  RUNNER_CONTINUATION_MIGRATION_VERSION,
} from "../dist/storage/sqlite/runner-continuation-migration.js";

const appliedAt = "2026-09-13T00:00:00.000Z";

test("schema 134 upgrades to runner continuation schema 135 and reruns idempotently", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-runner-continuation-upgrade-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let store = createSqliteRunStore(cwd);
  store.close();
  const path = resolveRuntimePaths(cwd).databasePath;
  let database = new DatabaseSync(path);
  database.exec(`
    DROP TABLE runner_continuations;
    DELETE FROM schema_migrations WHERE version = 135;
  `);
  assert.equal(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 134);
  database.close();

  store = createSqliteRunStore(cwd);
  store.close();
  database = new DatabaseSync(path);
  t.after(() => database.close());
  assert.equal(
    database.prepare("SELECT name FROM schema_migrations WHERE version = 135").get().name,
    RUNNER_CONTINUATION_MIGRATION_NAME,
  );
  const columns = new Set(database.prepare("PRAGMA table_info(runner_continuations)").all().map((row) => row.name));
  assert.ok(columns.has("claim_token"));
  assert.ok(columns.has("target_attempt_id"));
  assert.equal(database.prepare("PRAGMA foreign_key_check(runner_continuations)").all().length, 0);
  assert.equal(applyRunnerContinuationMigration(migrationInput(database)), false);
});

for (const fault of ["ddl", "marker", "marker_missing", "commit"]) {
  test(`runner continuation migration fully rolls back on ${fault} failure`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), `ling-runner-continuation-${fault}-`));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const database = new DatabaseSync(join(cwd, "fixture.sqlite"));
    t.after(() => database.close());
    createSchema134Fixture(database);
    const wrapped = {
      prepare: (sql) => database.prepare(sql),
      exec: (sql) => {
        if (fault === "ddl" && sql.includes("CREATE TABLE IF NOT EXISTS runner_continuations")) {
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
    assert.throws(() => applyRunnerContinuationMigration(input), /failure|postcondition/u);
    assert.equal(database.isTransaction, false);
    assert.equal(
      database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runner_continuations'").get(),
      undefined,
    );
    assert.equal(
      database.prepare("SELECT 1 FROM schema_migrations WHERE version=135").get(),
      undefined,
    );
  });
}

function createSchema134Fixture(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations (version, name, applied_at) VALUES (134, 'add_teammate_direct_system_purpose', '${appliedAt}');
    CREATE TABLE run_sessions (id TEXT PRIMARY KEY);
    CREATE TABLE work_units (id TEXT PRIMARY KEY);
    CREATE TABLE work_unit_attempts (id TEXT PRIMARY KEY);
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
