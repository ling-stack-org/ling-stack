import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyRunnerIdMigration,
  CANONICAL_PI_RUNNER_ID,
  RUNNER_ID_MIGRATION_VERSION,
  normalizeRunnerIdsInJson,
} from "../dist/storage/sqlite/runner-id-migration.js";

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE work_units (id TEXT PRIMARY KEY, runner_id TEXT, requested_runner_id TEXT, effective_runner_id TEXT, request_json TEXT NOT NULL);
    CREATE TABLE work_unit_attempts (id TEXT PRIMARY KEY, runner_id TEXT, requested_runner_id TEXT, effective_runner_id TEXT);
    CREATE TABLE ai_teammates (id TEXT PRIMARY KEY, runner_id TEXT);
    CREATE TABLE run_sessions (id TEXT PRIMARY KEY, task_snapshot_json TEXT NOT NULL, provider_snapshot_json TEXT NOT NULL, request_snapshot_json TEXT NOT NULL);
    CREATE TABLE channel_workflows (id TEXT PRIMARY KEY, metadata_json TEXT);
    CREATE TABLE channel_workflow_steps (id TEXT PRIMARY KEY, metadata_json TEXT);
    CREATE TABLE runner_continuations (id TEXT PRIMARY KEY, runner_id TEXT NOT NULL);
  `);
  return database;
}

function input(database, overrides = {}) {
  return {
    database,
    hasMigration: version => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    hasTable: table => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)),
    recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, name, "2026-10-28T00:00:00.000Z"),
    ...overrides,
  };
}

test("runner JSON normalization only changes runner identity fields", () => {
  const result = normalizeRunnerIdsInJson({
    runnerId: "pi-coding-agent",
    nested: [{ effectiveRunnerId: "pi-coding-agent" }],
    prompt: "keep pi-coding-agent in user text",
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.value, {
    runnerId: CANONICAL_PI_RUNNER_ID,
    nested: [{ effectiveRunnerId: CANONICAL_PI_RUNNER_ID }],
    prompt: "keep pi-coding-agent in user text",
  });
});

test("178 canonicalizes runner columns and historical snapshots", () => {
  const database = fixture();
  try {
    database.prepare("INSERT INTO work_units VALUES (?,?,?,?,?)").run("unit", "pi-coding-agent", "pi-coding-agent", "pi-coding-agent", JSON.stringify({ runnerId: "pi-coding-agent", prompt: "keep" }));
    database.prepare("INSERT INTO work_unit_attempts VALUES (?,?,?,?)").run("attempt", "pi-coding-agent", null, "pi-coding-agent");
    database.prepare("INSERT INTO ai_teammates VALUES (?,?)").run("teammate", "pi-coding-agent");
    database.prepare("INSERT INTO run_sessions VALUES (?,?,?,?)").run("run", JSON.stringify({ runnerId: "pi-coding-agent" }), "{}", JSON.stringify({ execution: { effectiveRunnerId: "pi-coding-agent" } }));
    database.prepare("INSERT INTO channel_workflows VALUES (?,?)").run("workflow", JSON.stringify({ requestedRunnerId: "pi-coding-agent" }));
    database.prepare("INSERT INTO channel_workflow_steps VALUES (?,?)").run("step", JSON.stringify({ text: "pi-coding-agent" }));
    database.prepare("INSERT INTO runner_continuations VALUES (?,?)").run("continuation", "pi-coding-agent");

    assert.equal(applyRunnerIdMigration(input(database)), true);
    assert.deepEqual({ ...database.prepare("SELECT runner_id, requested_runner_id, effective_runner_id, request_json FROM work_units").get() }, {
      runner_id: "pi", requested_runner_id: "pi", effective_runner_id: "pi", request_json: JSON.stringify({ runnerId: "pi", prompt: "keep" }),
    });
    assert.deepEqual({ ...database.prepare("SELECT runner_id, requested_runner_id, effective_runner_id FROM work_unit_attempts").get() }, {
      runner_id: "pi", requested_runner_id: null, effective_runner_id: "pi",
    });
    assert.equal(database.prepare("SELECT runner_id FROM ai_teammates").get().runner_id, "pi");
    assert.equal(database.prepare("SELECT request_snapshot_json FROM run_sessions").get().request_snapshot_json, JSON.stringify({ execution: { effectiveRunnerId: "pi" } }));
    assert.equal(database.prepare("SELECT metadata_json FROM channel_workflows").get().metadata_json, JSON.stringify({ requestedRunnerId: "pi" }));
    assert.equal(database.prepare("SELECT metadata_json FROM channel_workflow_steps").get().metadata_json, JSON.stringify({ text: "pi-coding-agent" }));
    assert.equal(database.prepare("SELECT runner_id FROM runner_continuations").get().runner_id, "pi");
    assert.equal(applyRunnerIdMigration(input(database)), false);
    assert.equal(database.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=?").get(RUNNER_ID_MIGRATION_VERSION).count, 1);
  } finally {
    database.close();
  }
});

test("178 rolls back scalar and JSON updates when a snapshot is malformed", () => {
  const database = fixture();
  try {
    database.prepare("INSERT INTO work_units VALUES (?,?,?,?,?)").run("unit", "pi-coding-agent", null, null, '{"runnerId":"pi-coding-agent"');
    assert.throws(() => applyRunnerIdMigration(input(database)), /runner_id_migration_invalid_json:work_units.request_json/u);
    assert.equal(database.prepare("SELECT runner_id FROM work_units").get().runner_id, "pi-coding-agent");
    assert.equal(database.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=?").get(RUNNER_ID_MIGRATION_VERSION).count, 0);
  } finally {
    database.close();
  }
});
