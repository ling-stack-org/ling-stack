import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { applyHostOfficeLocalMigration } from "../dist/storage/sqlite/host-office-local-migration.js";
import { applyHostOfficeLocalTerminalMigration, HOST_OFFICE_LOCAL_TERMINAL_MIGRATION_VERSION }
  from "../dist/storage/sqlite/host-office-local-terminal-migration.js";
import { at, digest, fixture as mediaFixture, insertOperation, migrationInput, snapshot as mediaSnapshot }
  from "./support/host-media-receipt-migration-fixture.mjs";

function schema(database) {
  return database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
}
function snapshot(database) {
  return { ...mediaSnapshot(database), ...Object.fromEntries(["host_office_local_executions", "host_office_local_effects"]
    .map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()])) };
}
function insertExecution(database, id) {
  insertOperation(database, `office-parent-${id}`, { kind: "mcp" });
  insertOperation(database, `office-producer-${id}`, { kind: "file_mutation",
    parent_operation_id: `office-parent-${id}`, producer_id: "office-local-binary" });
  database.prepare("INSERT INTO artifacts(id) VALUES(?)").run(`office-prepared-${id}`);
  database.prepare(`INSERT INTO host_office_local_executions(execution_id,schema_version,protocol,run_id,work_unit_id,
    attempt_id,runtime_instance_id,fencing_token,parent_operation_id,producer_operation_id,tool_call_id,tool_name,
    prepared_artifact_id,prepared_digest,identity_digest,prepared_at)
    VALUES(?,1,'ling-office-local-binary-v1','run','unit','attempt','runtime','fence',?,?,'office-call',
      'office_create_document',?,?,?,?)`).run(id, `office-parent-${id}`, `office-producer-${id}`, `office-prepared-${id}`, digest, digest, at);
}
function insertEffect(database, override = {}, verb = "INSERT") {
  const row = { effect_id: "office-effect-a", execution_id: "a", ordinal: 0, descriptor_json: "{}",
    effect_digest: digest, entered_at: null, observation_artifact_id: null, revision: 0, ...override };
  const names = Object.keys(row);
  database.prepare(`${verb} INTO host_office_local_effects(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`)
    .run(...Object.values(row));
}
function insertTerminal(database, override = {}, verb = "INSERT") {
  const row = { execution_id: "a", schema_version: 1, protocol: "ling-office-local-binary-v1",
    execution_identity_digest: digest, terminal_artifact_id: "office-terminal-a", terminal_digest: digest,
    effect_set_digest: digest, effect_count: 1, sealed_at: at, ...override };
  const names = Object.keys(row);
  database.prepare(`${verb} INTO host_office_local_terminals(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`)
    .run(...Object.values(row));
}

/** Real 145→147→148 isolated SQLite schema only; these rows are deliberately not live capabilities or safe receipts. */
async function fixture(t, options = {}) {
  const base = await mediaFixture(t, options); base.apply();
  applyHostOfficeLocalMigration(migrationInput(base.database));
  for (const id of ["a", "b"]) insertExecution(base.database, id);
  base.database.exec("INSERT INTO artifacts(id) VALUES('office-terminal-a'),('office-terminal-b'),('office-observation-a'),('office-observation-b')");
  insertEffect(base.database);
  return { get database() { return base.database; }, reopen: () => base.reopen(),
    apply: override => applyHostOfficeLocalTerminalMigration(migrationInput(base.database, override)) };
}

test("149 fresh real store registers terminal schema after 148 without inventing terminal facts", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-office-terminal-fresh-")), store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  assert.equal(HOST_OFFICE_LOCAL_TERMINAL_MIGRATION_VERSION, 149);
  assert.deepEqual(store.database.prepare("SELECT version FROM schema_migrations WHERE version IN (147,148,149) ORDER BY version").all()
    .map(row => row.version), [147, 148, 149]);
  assert.equal(store.database.prepare("SELECT count(*) n FROM host_office_local_terminals").get().n, 0);
  assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("149 upgrades populated 148 while preserving every 147 role CHECK, UNIQUE, index, trigger and prior fact", async t => {
  const f = await fixture(t), before = snapshot(f.database), objects = schema(f.database); f.apply();
  const after = snapshot(f.database);
  for (const [table, rows] of Object.entries(before)) {
    if (table !== "schema_migrations") assert.deepEqual(after[table], rows);
  }
  for (const object of objects) {
    assert.deepEqual(f.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type=? AND name=?").get(object.type, object.name), object);
  }
  assert.deepEqual(after.schema_migrations, [...before.schema_migrations,
    { version: 149, name: "seal_host_office_local_effect_sets" }]);
  assert.equal(f.database.prepare("SELECT count(*) n FROM host_office_local_terminals").get().n, 0);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("149 reopen and idempotent application preserve rows and do not rewrite any schema object", async t => {
  const f = await fixture(t); f.apply(); insertTerminal(f.database);
  const before = snapshot(f.database), objects = schema(f.database);
  const terminal = f.database.prepare("SELECT * FROM host_office_local_terminals").all(), version = f.database.prepare("PRAGMA schema_version").get().schema_version;
  f.reopen(); f.apply({ recordMigration: () => assert.fail("must not record 149 twice") });
  assert.deepEqual(snapshot(f.database), before); assert.deepEqual(schema(f.database), objects);
  assert.deepEqual(f.database.prepare("SELECT * FROM host_office_local_terminals").all(), terminal);
  assert.equal(f.database.prepare("PRAGMA schema_version").get().schema_version, version);
  assert.equal(f.database.prepare("SELECT count(*) n FROM schema_migrations WHERE version=149").get().n, 1);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("149 terminal INSERT freezes facts but never mutates original scopes into safe", async t => {
  const f = await fixture(t); f.apply();
  const before = f.database.prepare("SELECT * FROM host_operations ORDER BY operation_id").all();
  insertTerminal(f.database);
  assert.deepEqual(f.database.prepare("SELECT * FROM host_operations ORDER BY operation_id").all(), before);
  for (const statement of ["UPDATE host_office_local_terminals SET effect_count=effect_count", "DELETE FROM host_office_local_terminals"]) {
    assert.throws(() => f.database.exec(statement), /host_office_local_terminal_immutable|host_office_local_terminal_append_only/);
  }
  assert.throws(() => f.database.exec("UPDATE host_office_local_executions SET revision=revision+1"), /host_office_local_identity_immutable/);
  assert.throws(() => f.database.exec("DELETE FROM host_office_local_effects"), /host_office_local_effect_append_only/);
});

for (const mode of ["forward", "cleanup"]) {
  test(`149 refuses ${mode} effect INSERT after the original execution is sealed`, async t => {
    const f = await fixture(t); f.apply(); insertTerminal(f.database);
    const before = f.database.prepare("SELECT * FROM host_office_local_effects ORDER BY effect_id").all();
    assert.throws(() => insertEffect(f.database, { effect_id: "late-effect", ordinal: 1, descriptor_json: JSON.stringify({ kind: "unlink", mode }) }),
      /host_office_local_execution_sealed/);
    assert.deepEqual(f.database.prepare("SELECT * FROM host_office_local_effects ORDER BY effect_id").all(), before);
  });
}
for (const assignment of ["entered_at='2026-10-04T00:00:01.000Z'", "observation_artifact_id='office-observation-a'", "revision=revision+1", "revision=revision"]) {
  test(`149 refuses sealed effect UPDATE ${assignment}, including late observation or no-op`, async t => {
    const f = await fixture(t); f.apply(); insertTerminal(f.database);
    const before = f.database.prepare("SELECT * FROM host_office_local_effects").all();
    assert.throws(() => f.database.exec(`UPDATE host_office_local_effects SET ${assignment}`), /host_office_local_execution_sealed/);
    assert.deepEqual(f.database.prepare("SELECT * FROM host_office_local_effects").all(), before);
  });
}

test("149 sealing one execution leaves a different execution's original allowed writes unchanged", async t => {
  const f = await fixture(t); f.apply(); insertTerminal(f.database);
  insertEffect(f.database, { effect_id: "office-effect-b", execution_id: "b" });
  f.database.exec("UPDATE host_office_local_effects SET entered_at='2026-10-04T00:00:01.000Z',observation_artifact_id='office-observation-b',revision=revision+1 WHERE execution_id='b'");
  assert.equal(f.database.prepare("SELECT revision FROM host_office_local_effects WHERE execution_id='b'").get().revision, 1);
  assert.equal(f.database.prepare("SELECT observation_artifact_id FROM host_office_local_effects WHERE execution_id='a'").get().observation_artifact_id, null);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

for (const recursive of [0, 1]) {
  test(`149 terminal OR REPLACE cannot overwrite PK or artifact UNIQUE when recursive_triggers=${recursive}`, async t => {
    const f = await fixture(t); f.apply(); f.database.exec(`PRAGMA recursive_triggers=${recursive}`); insertTerminal(f.database);
    const before = f.database.prepare("SELECT * FROM host_office_local_terminals").all();
    assert.throws(() => insertTerminal(f.database, { terminal_digest: "b".repeat(64) }, "INSERT OR REPLACE"), /host_office_local_terminal_append_only/);
    assert.throws(() => insertTerminal(f.database, { execution_id: "b" }, "INSERT OR REPLACE"), /host_office_local_terminal_append_only/);
    assert.deepEqual(f.database.prepare("SELECT * FROM host_office_local_terminals").all(), before);
  });
  test(`149 effect replacement cannot evict sealed PK or observation UNIQUE when recursive_triggers=${recursive}`, async t => {
    const f = await fixture(t); f.apply(); f.database.exec(`PRAGMA recursive_triggers=${recursive}`);
    f.database.exec("UPDATE host_office_local_effects SET observation_artifact_id='office-observation-a'"); insertTerminal(f.database);
    insertEffect(f.database, { effect_id: "office-effect-b", execution_id: "b" });
    const before = f.database.prepare("SELECT * FROM host_office_local_effects ORDER BY effect_id").all();
    assert.throws(() => insertEffect(f.database, {}, "INSERT OR REPLACE"), /host_office_local_execution_sealed/);
    assert.throws(() => insertEffect(f.database, { execution_id: "b", ordinal: 1 }, "INSERT OR REPLACE"), /host_office_local_execution_sealed/);
    assert.throws(() => insertEffect(f.database, { effect_id: "other", execution_id: "b", ordinal: 1, observation_artifact_id: "office-observation-a" }, "INSERT OR REPLACE"),
      /host_office_local_execution_sealed/);
    assert.throws(() => f.database.exec("UPDATE OR REPLACE host_office_local_effects SET observation_artifact_id='office-observation-a' WHERE execution_id='b'"),
      /host_office_local_execution_sealed/);
    assert.deepEqual(f.database.prepare("SELECT * FROM host_office_local_effects ORDER BY effect_id").all(), before);
  });
}

for (const column of ["execution_identity_digest", "terminal_digest", "effect_set_digest"]) {
  for (const [label, value] of [["short", "a".repeat(63)], ["long", "a".repeat(65)], ["nonhex", "g".repeat(64)],
    ["uppercase", "A".repeat(64)], ["trailing NUL", `${digest}\0`], ["NULL", null]]) {
    test(`149 rejects ${column} ${label} instead of accepting a non-SHA256 fact`, async t => {
      const f = await fixture(t); f.apply();
      assert.throws(() => insertTerminal(f.database, { [column]: value }), /CHECK constraint failed|NOT NULL constraint failed/);
      assert.equal(f.database.prepare("SELECT count(*) n FROM host_office_local_terminals").get().n, 0);
    });
  }
}
for (const value of [-1, 1025, 0.5, "non-count", null]) {
  test(`149 rejects nonbounded integer effect_count ${String(value)}`, async t => {
    const f = await fixture(t); f.apply();
    assert.throws(() => insertTerminal(f.database, { effect_count: value }), /CHECK constraint failed|NOT NULL constraint failed/);
  });
}
for (const value of [0, 1024]) {
  test(`149 permits effect_count ${value} as a schema fact without granting verification authority`, async t => {
    const f = await fixture(t); f.apply(); insertTerminal(f.database, { effect_count: value });
    assert.equal(f.database.prepare("SELECT effect_count FROM host_office_local_terminals").get().effect_count, value);
    assert.equal(f.database.prepare("SELECT phase FROM host_operations WHERE operation_id='office-parent-a'").get().phase, "admitted");
  });
}
for (const change of [{ schema_version: 2 }, { protocol: "ling-apply-patch-v1" }, { execution_id: null },
  { terminal_artifact_id: null }, { sealed_at: null }]) {
  test(`149 rejects invalid fixed terminal ${Object.keys(change)[0]}`, async t => {
    const f = await fixture(t); f.apply();
    assert.throws(() => insertTerminal(f.database, change), /CHECK constraint failed|NOT NULL constraint failed/);
  });
}

test("149 keeps execution/artifact RESTRICT references and execution/artifact uniqueness", async t => {
  const f = await fixture(t); f.apply();
  assert.throws(() => insertTerminal(f.database, { execution_id: "missing" }), /FOREIGN KEY constraint failed/);
  assert.throws(() => insertTerminal(f.database, { terminal_artifact_id: "missing" }), /FOREIGN KEY constraint failed/);
  insertTerminal(f.database);
  assert.throws(() => insertTerminal(f.database), /host_office_local_terminal_append_only/);
  assert.throws(() => insertTerminal(f.database, { execution_id: "b" }), /host_office_local_terminal_append_only/);
  assert.throws(() => f.database.exec("DELETE FROM artifacts WHERE id='office-terminal-a'"), /FOREIGN KEY constraint failed/);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_list(host_office_local_terminals)").all()
    .map(row => [row.table, row.from, row.on_delete]).sort(),
  [["artifacts", "terminal_artifact_id", "RESTRICT"], ["host_office_local_executions", "execution_id", "RESTRICT"]].sort());
  const uniqueColumns = f.database.prepare("PRAGMA index_list(host_office_local_terminals)").all().filter(row => row.unique === 1)
    .map(row => f.database.prepare(`PRAGMA index_info(${row.name})`).all().map(column => column.name));
  assert.deepEqual(uniqueColumns.sort(), [["execution_id"], ["terminal_artifact_id"]].sort());
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

for (const foreignKeys of [0, 1]) {
  test(`149 real record failure rolls back only its schema/version and leaves foreign_keys=${foreignKeys}`, async t => {
    const f = await fixture(t, { foreignKeys }), before = snapshot(f.database), objects = schema(f.database);
    assert.throws(() => f.apply({ recordMigration: () => { throw new Error("149 record failed"); } }), /149 record failed/);
    assert.deepEqual(snapshot(f.database), before); assert.deepEqual(schema(f.database), objects);
    assert.equal(f.database.prepare("PRAGMA foreign_keys").get().foreign_keys, foreignKeys);
    f.apply(); assert.equal(f.database.prepare("SELECT count(*) n FROM schema_migrations WHERE version=149").get().n, 1);
  });
}

test("149 RELEASE failure before return rolls back its table, guards and version and remains retryable", async t => {
  const f = await fixture(t), before = snapshot(f.database), objects = schema(f.database), exec = f.database.exec.bind(f.database);
  let fail = true;
  f.database.exec = sql => {
    if (sql === "RELEASE host_office_local_terminal_migration" && fail) { fail = false; throw new Error("149 release failed"); }
    return exec(sql);
  };
  assert.throws(f.apply, /149 release failed/);
  assert.deepEqual(snapshot(f.database), before); assert.deepEqual(schema(f.database), objects);
  f.database.exec = exec; f.apply(); assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("149 failed inner savepoint does not roll back a caller-owned transaction", async t => {
  const f = await fixture(t), objects = schema(f.database);
  f.database.exec("BEGIN IMMEDIATE; INSERT INTO artifacts(id) VALUES('caller-owned')");
  assert.throws(() => f.apply({ recordMigration: () => { throw new Error("inner record failed"); } }), /inner record failed/);
  assert.deepEqual(schema(f.database), objects);
  assert.equal(f.database.prepare("SELECT id FROM artifacts WHERE id='caller-owned'").get().id, "caller-owned");
  f.database.exec("COMMIT"); f.reopen();
  assert.equal(f.database.prepare("SELECT id FROM artifacts WHERE id='caller-owned'").get().id, "caller-owned");
  f.apply(); assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("149 successful inner savepoint still belongs to the caller's outer rollback", async t => {
  const f = await fixture(t), before = snapshot(f.database), objects = schema(f.database);
  f.database.exec("BEGIN IMMEDIATE"); f.apply(); insertTerminal(f.database); f.database.exec("ROLLBACK");
  assert.deepEqual(snapshot(f.database), before); assert.deepEqual(schema(f.database), objects);
  f.reopen(); f.apply(); assert.equal(f.database.prepare("SELECT count(*) n FROM host_office_local_terminals").get().n, 0);
});
