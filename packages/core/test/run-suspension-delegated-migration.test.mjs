import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyRunSuspensionDelegatedMigration } from "../dist/storage/sqlite/run-suspension-delegated-migration.js";

// Schema-only fixture: business lineage is exercised by the real SDK tree test.
// Foreign keys are deliberately off so each unique conflict can be isolated.
function fixture(t, recursive) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(`PRAGMA foreign_keys=OFF; PRAGMA recursive_triggers=${recursive};
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL);`);
  const migration = () => applyRunSuspensionDelegatedMigration({ database,
    hasMigration: version => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(version, name) });
  assert.equal(migration(), true);
  assert.equal(migration(), false);
  const insert = (table, row, verb = "INSERT") => database.prepare(`${verb} INTO ${table}
    (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  return { database, migration, insert };
}

const activation = suffix => ({ id: `activation-${suffix}`, suspension_id: `suspension-${suffix}`,
  run_id: "child", root_run_id: "root", parent_run_id: "parent", step_id: "step", reservation_id: "reservation",
  source_attempt_id: `source-${suffix}`, target_attempt_id: `target-${suffix}`, parent_attempt_id: "parent-attempt",
  artifact_id: `activation-artifact-${suffix}`, digest: "a".repeat(64), activated_at: "2026-10-23T00:00:00.000Z" });
const start = suffix => ({ id: `start-${suffix}`, suspension_id: `suspension-${suffix}`,
  activation_id: `activation-${suffix}`, run_id: "child", target_attempt_id: `target-${suffix}`,
  observation_id: `observation-${suffix}`, artifact_id: `start-artifact-${suffix}`,
  digest: "b".repeat(64), acknowledged_at: "2026-10-23T00:00:01.000Z" });

for (const recursive of [0, 1]) {
  for (const [table, make, unique] of [
    ["run_suspension_delegated_activations", activation,
      ["id", "suspension_id", "source_attempt_id", "target_attempt_id", "artifact_id"]],
    ["run_suspension_delegated_starts", start,
      ["id", "suspension_id", "activation_id", "target_attempt_id", "observation_id", "artifact_id"]],
  ]) test(`${table} rejects replacement on every identity with recursive_triggers=${recursive}`, t => {
    const f = fixture(t, recursive), original = make("original");
    f.insert(table, original);
    const before = f.database.prepare(`SELECT * FROM ${table}`).all();
    for (const column of unique) {
      const collision = { ...make(`other-${column}`), [column]: original[column] };
      for (const verb of ["INSERT OR REPLACE", "INSERT", "INSERT OR IGNORE"]) {
        assert.throws(() => f.insert(table, collision, verb), /immutable/u, `${verb}: ${column}`);
        assert.deepEqual(f.database.prepare(`SELECT * FROM ${table}`).all(), before);
      }
    }
    for (const sql of [`UPDATE ${table} SET digest='${"c".repeat(64)}'`, `DELETE FROM ${table}`]) {
      assert.throws(() => f.database.exec(sql), /immutable/u);
      assert.deepEqual(f.database.prepare(`SELECT * FROM ${table}`).all(), before);
    }
    f.insert(table, make("distinct"));
    assert.equal(f.database.prepare(`SELECT count(*) n FROM ${table}`).get().n, 2);
  });
}

test("a recorded186 schema cannot silently reconstruct a missing replacement guard", t => {
  const f = fixture(t, 0);
  f.database.exec("DROP TRIGGER run_suspension_delegated_activations_no_replace");
  assert.throws(f.migration, /migration_schema_missing/u);
  assert.equal(f.database.prepare("SELECT 1 FROM sqlite_master WHERE name='run_suspension_delegated_activations_no_replace'").get(), undefined);
});
