import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyHarnessRecoveryIndexMigration, HARNESS_RECOVERY_INDEX_MIGRATION_VERSION } from "../dist/storage/sqlite/harness-recovery-index-migration.js";

const migrationName = "create_harness_recovery_discovery_indexes_v1";
const indexNames = ["idx_harness_delegation_charge_reservation", "idx_harness_delegation_reservation_created",
  "idx_harness_work_units_discovery", "idx_harness_continuations_due", "idx_harness_continuations_scheduled_due"];
function fixture(t) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT);
    CREATE TABLE delegation_budget_charges(id TEXT PRIMARY KEY,reservation_id TEXT);
    CREATE TABLE delegation_budget_reservations(id TEXT PRIMARY KEY,created_at TEXT);
    CREATE TABLE work_units(id TEXT PRIMARY KEY,kind TEXT,status TEXT,created_at TEXT);
    CREATE TABLE runner_continuations(id TEXT PRIMARY KEY,state TEXT,next_attempt_at TEXT,created_at TEXT);
    INSERT INTO work_units VALUES('preserved','task_run','stale','2026-10-22T00:00:00.000Z');`);
  const input = { database,
    hasMigration: version => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, name, "2026-10-22T00:00:00.000Z") };
  const schema = () => database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
  return { database, input, schema };
}

test("recovery indexes are additive, atomic and idempotent without rewriting domain rows", t => {
  const f = fixture(t), rows = f.database.prepare("SELECT * FROM work_units").all();
  assert.equal(HARNESS_RECOVERY_INDEX_MIGRATION_VERSION, 196);
  assert.equal(applyHarnessRecoveryIndexMigration(f.input), true);
  assert.equal(applyHarnessRecoveryIndexMigration(f.input), false);
  assert.deepEqual(f.database.prepare("SELECT * FROM work_units").all(), rows);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'idx_harness_%'").get().n, 5);
  assert.equal(f.database.prepare("SELECT name FROM schema_migrations WHERE version=196").get().name, migrationName);
});

test("all indexes and the marker roll back when recording fails", t => {
  const f = fixture(t), before = f.schema();
  assert.throws(() => applyHarnessRecoveryIndexMigration({ ...f.input, recordMigration() { throw new Error("record_fault"); } }), /record_fault/);
  assert.deepEqual(f.schema(), before);
  assert.equal(f.input.hasMigration(HARNESS_RECOVERY_INDEX_MIGRATION_VERSION), false);
  assert.equal(applyHarnessRecoveryIndexMigration(f.input), true);
});

for (const name of indexNames) test(`a missing committed ${name} is rejected, not silently repaired`, t => {
  const f = fixture(t);
  applyHarnessRecoveryIndexMigration(f.input);
  f.database.exec(`DROP INDEX ${name}`);
  const before = f.schema();
  assert.throws(() => applyHarnessRecoveryIndexMigration(f.input), /harness_recovery_index_migration_schema_missing/);
  assert.deepEqual(f.schema(), before);
});

for (const kind of ["wrong_version", "wrong_name", "wrong_index", "conflicting_table"]) {
  test(`recovery migration refuses ${kind} without changing existing objects`, t => {
    const f = fixture(t);
    if (kind === "wrong_version") f.input.recordMigration(181, migrationName);
    if (kind === "wrong_name") f.input.recordMigration(HARNESS_RECOVERY_INDEX_MIGRATION_VERSION, "foreign");
    if (kind === "wrong_index") f.database.exec(`CREATE INDEX ${indexNames[0]} ON delegation_budget_charges(id)`);
    if (kind === "conflicting_table") f.database.exec(`CREATE TABLE ${indexNames[0]}(id TEXT)`);
    const before = f.schema(), markers = f.database.prepare("SELECT * FROM schema_migrations").all();
    assert.throws(() => applyHarnessRecoveryIndexMigration(f.input), /harness_recovery_index_migration_(marker_conflict|schema_conflict)/);
    assert.deepEqual(f.schema(), before);
    assert.deepEqual(f.database.prepare("SELECT * FROM schema_migrations").all(), markers);
  });
}
