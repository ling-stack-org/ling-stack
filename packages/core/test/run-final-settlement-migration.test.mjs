import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyRunFinalSettlementMigration } from "../dist/storage/sqlite/run-final-settlement-migration.js";

// Schema-only fixture; final settlement behavior uses real SQLite business lineage separately.
function fixture(t, recursive = 0) {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  database.exec(`PRAGMA foreign_keys=OFF; PRAGMA recursive_triggers=${recursive};
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL);`);
  const input = { database,
    hasMigration: version => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(version, name) };
  const migrate = () => applyRunFinalSettlementMigration(input);
  const schema = () => database.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return { database, input, migrate, schema };
}
const row = suffix => ({ id: `final-${suffix}`, run_id: "run", work_unit_id: "unit", attempt_id: `attempt-${suffix}`,
  runtime_instance_id: "runtime", fencing_token: "fence", artifact_id: `receipt-${suffix}`, digest: "a".repeat(64),
  model_view_artifact_id: `view-${suffix}`, model_view_sha256: "b".repeat(64), boundary_event_seq: 1, committed_at: "2026-10-23T00:00:00.000Z" });
function insert(database, value, verb = "INSERT") {
  database.prepare(`${verb} INTO run_final_settlements (${Object.keys(value).join(",")}) VALUES (${Object.keys(value).map(() => "?").join(",")})`).run(...Object.values(value));
}

test("additive187 migration is fresh, replay-stable and preserves other markers", t => {
  const f = fixture(t); f.database.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(186, "previous");
  assert.equal(f.migrate(), true); const before = f.schema(), markers = f.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  assert.equal(f.migrate(), false); assert.deepEqual(f.schema(), before);
  assert.deepEqual(f.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), markers);
});
for (const failure of ["missing", "schema-drift", "marker-name", "marker-version", "marker-callback"])
test(`additive187 rejects ${failure} without silent repair`, t => {
  const f = fixture(t); f.migrate();
  if (failure === "missing") f.database.exec("DROP TRIGGER run_final_settlements_identity");
  if (failure === "schema-drift") f.database.exec("DROP INDEX idx_run_final_settlements_run; CREATE INDEX idx_run_final_settlements_run ON run_final_settlements(attempt_id)");
  if (failure === "marker-name") f.database.exec("UPDATE schema_migrations SET name='foreign' WHERE version=187");
  if (failure === "marker-version") f.database.exec("UPDATE schema_migrations SET version=999 WHERE version=187");
  if (failure === "marker-callback") f.input.hasMigration = () => false;
  const before = f.schema(), markers = f.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  assert.throws(f.migrate, /migration_(?:schema|marker)/u);
  assert.deepEqual(f.schema(), before); assert.deepEqual(f.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), markers);
});
for (const failure of ["record-throws", "record-missing"])
test(`additive187 ${failure} rolls back all fresh schema`, t => {
  const f = fixture(t), before = f.schema();
  f.input.recordMigration = () => { if (failure === "record-throws") throw new Error("injected-marker"); };
  assert.throws(f.migrate, /injected-marker|postcondition/u); assert.deepEqual(f.schema(), before); assert.equal(f.database.isTransaction, false);
});
for (const recursive of [0, 1]) test(`187 guards every immutable identity including crossed artifacts, recursive_triggers=${recursive}`, t => {
  const f = fixture(t, recursive); f.migrate(); const original = row("first"); insert(f.database, original);
  const before = f.database.prepare("SELECT * FROM run_final_settlements").all();
  for (const [column, value] of [["id", original.id], ["attempt_id", original.attempt_id], ["artifact_id", original.artifact_id],
    ["model_view_artifact_id", original.model_view_artifact_id], ["artifact_id", original.model_view_artifact_id], ["model_view_artifact_id", original.artifact_id]])
    for (const verb of ["INSERT", "INSERT OR REPLACE", "INSERT OR IGNORE"]) {
      assert.throws(() => insert(f.database, { ...row(`other-${column}`), [column]: value }, verb), /identity_conflict/u);
      assert.deepEqual(f.database.prepare("SELECT * FROM run_final_settlements").all(), before);
    }
  assert.throws(() => f.database.exec("UPDATE run_final_settlements SET digest='" + "c".repeat(64) + "'"), /immutable/u);
  assert.throws(() => f.database.exec("DELETE FROM run_final_settlements"), /retained/u);
  insert(f.database, row("distinct")); assert.equal(f.database.prepare("SELECT count(*) n FROM run_final_settlements").get().n, 2);
});
