import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applyHostOfficeLocalDirectoryV2Migration } from "../dist/storage/sqlite/host-office-local-directory-v2-migration.js";

function fixture(t) {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE run_sessions(id TEXT PRIMARY KEY); CREATE TABLE work_units(id TEXT PRIMARY KEY); CREATE TABLE work_unit_attempts(id TEXT PRIMARY KEY);
    CREATE TABLE host_operations(operation_id TEXT PRIMARY KEY); CREATE TABLE artifacts(id TEXT PRIMARY KEY);
    CREATE TABLE host_office_local_executions(execution_id TEXT PRIMARY KEY,schema_version INTEGER CHECK(schema_version=1),
      protocol TEXT CHECK(protocol='ling-office-local-binary-v1'),parent_operation_id TEXT,producer_operation_id TEXT,prepared_artifact_id TEXT);
    INSERT INTO run_sessions VALUES('run'); INSERT INTO work_units VALUES('work'); INSERT INTO work_unit_attempts VALUES('attempt');
    INSERT INTO host_operations VALUES('p-a'),('q-a'),('p-b'),('q-b'); INSERT INTO artifacts VALUES('prep-a'),('prep-b'),('terminal-a'),('terminal-b'),('obs-a'),('obs-b');`);
  const context = { database, hasMigration: version => !!database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version),
    hasTable: name => !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
    recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(version, name) };
  const apply = overrides => applyHostOfficeLocalDirectoryV2Migration({ ...context, ...overrides });
  const execution = (id = "a", verb = "INSERT", overrides = {}) => {
    const row = { execution_id: id, schema_version: 2, protocol: "ling-office-local-binary-v2", run_id: "run", work_unit_id: "work", attempt_id: "attempt",
      runtime_instance_id: "runtime", fencing_token: "fence", parent_operation_id: "p-" + id, producer_operation_id: "q-" + id, tool_call_id: "call", tool_name: "office_create_document",
      prepared_artifact_id: "prep-" + id, prepared_digest: "a".repeat(64), identity_digest: "b".repeat(64), prepared_at: "2026-10-05T00:00:00.000Z", ...overrides };
    database.prepare(`${verb} INTO host_office_local_directory_v2_executions(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  };
  const effect = (id = "a", verb = "INSERT", overrides = {}) => database.prepare(`${verb} INTO host_office_local_directory_v2_effects(effect_id,execution_id,ordinal,descriptor_json,effect_digest,observation_artifact_id)
    VALUES(?,?,?,?,?,?)`).run(overrides.effectId ?? "effect-" + id, id, overrides.ordinal ?? 0, "{}", "c".repeat(64), overrides.artifactId ?? null);
  const terminal = (id = "a", verb = "INSERT", artifactId = "terminal-" + id) => database.prepare(`${verb} INTO host_office_local_directory_v2_terminals VALUES(?,2,?,?,?,?,?,?,?)`)
    .run(id, "ling-office-local-binary-v2", "b".repeat(64), artifactId, "d".repeat(64), "e".repeat(64), 1, "2026-10-05T00:00:00.000Z");
  return { database, apply, execution, effect, terminal };
}
test("152 appends independent tables/guards, preserves original v1 SQL and is idempotent", t => {
  const f = fixture(t), sql = f.database.prepare("SELECT sql FROM sqlite_master WHERE name='host_office_local_executions'").get().sql;
  f.apply(); f.execution(); f.effect(); f.terminal();
  const before = f.database.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
  f.apply({ recordMigration: () => assert.fail("not twice") });
  assert.deepEqual(f.database.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all(), before);
  assert.equal(f.database.prepare("SELECT sql FROM sqlite_master WHERE name='host_office_local_executions'").get().sql, sql);
  assert.equal(f.database.prepare("SELECT version FROM schema_migrations").get().version, 152);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});
for (const recursive of [0, 1]) test(`152 rejects execution/effect/terminal OR REPLACE including UNIQUE eviction with recursive_triggers=${recursive}`, t => {
  const f = fixture(t); f.apply(); f.database.exec(`PRAGMA recursive_triggers=${recursive}`); f.execution(); f.execution("b"); f.effect("a", "INSERT", { artifactId: "obs-a" }); f.effect("b"); f.terminal();
  assert.throws(() => f.execution("a", "INSERT OR REPLACE"), /append_only/);
  assert.throws(() => f.execution("b", "INSERT OR REPLACE", { parent_operation_id: "p-a" }), /append_only/);
  assert.throws(() => f.effect("a", "INSERT OR REPLACE"), /append_only/);
  assert.throws(() => f.effect("b", "INSERT OR REPLACE", { effectId: "other", ordinal: 1, artifactId: "obs-a" }), /append_only/);
  assert.throws(() => f.database.exec("UPDATE OR REPLACE host_office_local_directory_v2_effects SET observation_artifact_id='obs-a',revision=revision+1 WHERE execution_id='b'"), /effect_immutable/);
  assert.throws(() => f.terminal("a", "INSERT OR REPLACE"), /append_only/);
  assert.throws(() => f.terminal("b", "INSERT OR REPLACE", "terminal-a"), /append_only/);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});
for (const direction of ["v1-first", "v2-first"]) for (const collision of ["execution-id", "parent", "producer", "cross-role"]) {
  test(`152 rejects ${direction} cross-version ${collision} reuse under actual SQLite trigger`, t => {
    const f = fixture(t); f.apply();
    const id = collision === "execution-id" ? "a" : "legacy", parent = collision === "parent" || collision === "cross-role" ? "p-a" : "legacy-p",
      producer = collision === "producer" ? "q-a" : collision === "cross-role" ? "p-a" : "legacy-q";
    const legacy = () => f.database.prepare("INSERT INTO host_office_local_executions VALUES(?,1,'ling-office-local-binary-v1',?,?,?)").run(id, parent, producer, "legacy-prep");
    if (direction === "v1-first") { legacy(); assert.throws(() => f.execution(), /cross_version_identity_conflict/); }
    else { f.execution(); assert.throws(legacy, /cross_version_identity_conflict/); }
  });
}
test("152 sealed effects cannot enter, append, change observation or mutate any identity; deleting rows is blocked", t => {
  const f = fixture(t); f.apply(); f.execution(); f.effect(); f.terminal();
  for (const sql of ["UPDATE host_office_local_directory_v2_executions SET revision=revision", "DELETE FROM host_office_local_directory_v2_executions",
    "UPDATE host_office_local_directory_v2_effects SET entered_at='later',revision=revision+1", "DELETE FROM host_office_local_directory_v2_effects",
    "UPDATE host_office_local_directory_v2_terminals SET effect_count=effect_count", "DELETE FROM host_office_local_directory_v2_terminals"]) assert.throws(() => f.database.exec(sql), /immutable|append_only/);
  assert.throws(() => f.effect("a", "INSERT", { effectId: "late", ordinal: 1 }), /append_only/);
});
test("152 failed migration record rolls back its schema/guards and preserves caller-owned transaction", t => {
  const f = fixture(t), before = f.database.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
  f.database.exec("BEGIN IMMEDIATE; INSERT INTO artifacts VALUES('caller-owned')");
  assert.throws(() => f.apply({ recordMigration: () => { throw new Error("actual migration record failed"); } }), /actual migration record failed/);
  assert.deepEqual(f.database.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all(), before);
  assert.equal(f.database.prepare("SELECT id FROM artifacts WHERE id='caller-owned'").get().id, "caller-owned");
  f.database.exec("COMMIT"); f.apply(); assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});
