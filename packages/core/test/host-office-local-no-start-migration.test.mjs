import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { applyHostOfficeLocalMigration } from "../dist/storage/sqlite/host-office-local-migration.js";
import { applyHostOfficeLocalTerminalMigration } from "../dist/storage/sqlite/host-office-local-terminal-migration.js";
import { applyHostOfficeLocalJournalMigration } from "../dist/storage/sqlite/host-office-local-journal-migration.js";
import { applyHostOfficeLocalNoStartMigration, HOST_OFFICE_LOCAL_NO_START_MIGRATION_VERSION }
  from "../dist/storage/sqlite/host-office-local-no-start-migration.js";
import { at, digest, fixture as mediaFixture, insertOperation, migrationInput, snapshot as mediaSnapshot }
  from "./support/host-media-receipt-migration-fixture.mjs";

const protocol = "ling-office-local-binary-v1";
const receiptTable = "host_office_local_no_start_receipts";
const officeTables = ["host_office_local_executions", "host_office_local_effects", "host_office_local_terminals"];
const constraintFailure = /CHECK constraint failed|NOT NULL constraint failed|malformed JSON/u;
const closedFailure = /host_office_local_execution_no_start_closed/u;
const hash = value => createHash("sha256").update(value).digest("hex");

function schema(database) {
  return database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
}
function snapshot(database) {
  const tables = ["artifacts", ...officeTables];
  if (migrationInput(database).hasTable(receiptTable)) tables.push(receiptTable);
  return { ...mediaSnapshot(database), ...Object.fromEntries(tables.map(table => [table,
    database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()])) };
}
function assertPragmas(database, foreignKeys = 1, legacyAlterTable = 0) {
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, foreignKeys);
  assert.equal(database.prepare("PRAGMA legacy_alter_table").get().legacy_alter_table, legacyAlterTable);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
}

function insertExecution(database, id) {
  insertOperation(database, `office-parent-${id}`, { kind: "mcp", tool_call_id: `office-call-${id}` });
  insertOperation(database, `office-producer-${id}`, { kind: "file_mutation", tool_call_id: `office-call-${id}`,
    parent_operation_id: `office-parent-${id}`, producer_id: "office-local-binary" });
  database.prepare("INSERT INTO artifacts(id) VALUES(?)").run(`office-prepared-${id}`);
  database.prepare(`INSERT INTO host_office_local_executions(execution_id,schema_version,protocol,run_id,work_unit_id,
    attempt_id,runtime_instance_id,fencing_token,parent_operation_id,producer_operation_id,tool_call_id,tool_name,
    prepared_artifact_id,prepared_digest,identity_digest,prepared_at)
    VALUES(?,1,?,'run','unit','attempt','runtime','fence',?,?,?,'office_create_document',?,?,?,?)`)
    .run(id, protocol, `office-parent-${id}`, `office-producer-${id}`, `office-call-${id}`,
      `office-prepared-${id}`, digest, digest, at);
}
function insertEffect(database, override = {}, verb = "INSERT") {
  const row = { effect_id: "office-effect-a", execution_id: "a", ordinal: 0, descriptor_json: "{}",
    effect_digest: digest, entered_at: null, observation_artifact_id: null, revision: 0, ...override };
  const names = Object.keys(row);
  database.prepare(`${verb} INTO host_office_local_effects(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`)
    .run(...Object.values(row));
}

/** These schema-only rows mirror SQL columns, not Core-verified digests or live settlement capabilities. */
function receiptPayload(row) {
  const effects = Number.isSafeInteger(row.effect_count) && row.effect_count >= 0 && row.effect_count <= 1025
    ? Array.from({ length: row.effect_count }, (_, ordinal) => ({ ordinal, effectId: `schema-effect-${ordinal}`, effectDigest: digest })) : [];
  const requiredDescendants = Number.isSafeInteger(row.descendant_count) && row.descendant_count >= 0 && row.descendant_count <= 1025
    ? Array.from({ length: row.descendant_count }, (_, index) => ({ operationId: `schema-child-${index}`, evidenceDigest: digest })) : [];
  return { schemaVersion: row.schema_version, protocol: row.protocol, kind: "office_local_no_start_v1",
    executionId: row.execution_id, executionIdentityDigest: row.execution_identity_digest,
    source: { runId: "run", workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "runtime", fencingToken: "fence" },
    parentOperationId: `office-parent-${row.execution_id}`, producerOperationId: `office-producer-${row.execution_id}`,
    toolCallId: `office-call-${row.execution_id}`, preparedArtifactId: row.prepared_artifact_id,
    preparedDigest: row.prepared_digest, effects, requiredDescendants, closedAt: row.closed_at, receiptDigest: row.receipt_digest };
}
function receiptRow(override = {}) {
  const executionId = override.execution_id ?? "a";
  const row = { execution_id: executionId, schema_version: 1, protocol,
    execution_identity_digest: digest, prepared_artifact_id: `office-prepared-${executionId}`, prepared_digest: digest,
    receipt_digest: hash(`schema-receipt-${executionId}`), effect_set_digest: digest, effect_count: 1,
    descendant_set_digest: digest, descendant_count: 0, closed_at: at, ...override };
  return { ...row, receipt_json: Object.hasOwn(override, "receipt_json") ? override.receipt_json : JSON.stringify(receiptPayload(row)) };
}
function insertReceipt(database, override = {}, verb = "INSERT") {
  const row = receiptRow(override), names = Object.keys(row);
  database.prepare(`${verb} INTO ${receiptTable}(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`)
    .run(...Object.values(row));
}

/** Real isolated 145→150 history with unentered, entered and sealed facts; never grants a live ticket or public safety. */
async function fixture(t, options = {}) {
  const base = await mediaFixture(t, options); base.apply();
  applyHostOfficeLocalMigration(migrationInput(base.database));
  applyHostOfficeLocalTerminalMigration(migrationInput(base.database));
  if (options.populated !== false) {
    for (const id of ["a", "b", "entered", "sealed"]) insertExecution(base.database, id);
    base.database.exec("INSERT INTO artifacts(id) VALUES('office-observation-a'),('office-observation-b'),('office-terminal-sealed')");
    insertEffect(base.database);
    insertEffect(base.database, { effect_id: "office-effect-entered", execution_id: "entered", entered_at: at,
      observation_artifact_id: "office-observation-b" });
    insertEffect(base.database, { effect_id: "office-effect-sealed", execution_id: "sealed" });
    base.database.prepare(`INSERT INTO host_office_local_terminals(execution_id,schema_version,protocol,execution_identity_digest,
      terminal_artifact_id,terminal_digest,effect_set_digest,effect_count,sealed_at) VALUES('sealed',1,?,?,?,?,?,1,?)`)
      .run(protocol, digest, "office-terminal-sealed", digest, digest, at);
  }
  applyHostOfficeLocalJournalMigration(migrationInput(base.database));
  if (options.populated !== false) {
    for (const id of ["a", "b", "entered", "sealed"]) {
      for (const [role, evidenceKind] of [["parent", "office_local_chain_execution"], ["producer", "office_local_binary_execution"]]) {
        base.database.prepare("UPDATE host_operations SET evidence_kind=?,evidence_id=?,domain_identity_digest=?,revision=revision+1 WHERE operation_id=?")
          .run(evidenceKind, id, digest, `office-${role}-${id}`);
      }
    }
  }
  return { path: base.path, get database() { return base.database; }, reopen: () => base.reopen(),
    apply: override => applyHostOfficeLocalNoStartMigration(migrationInput(base.database, override)) };
}

test("151 fresh real store registers no-start schema without inventing receipts or safe operations", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-office-no-start-migration-fresh-")), store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  assert.equal(HOST_OFFICE_LOCAL_NO_START_MIGRATION_VERSION, 151);
  assert.deepEqual(store.database.prepare("SELECT version FROM schema_migrations WHERE version IN (148,149,150,151) ORDER BY version")
    .all().map(row => row.version), [148, 149, 150, 151]);
  for (const table of ["host_operations", ...officeTables, receiptTable]) {
    assert.equal(store.database.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
  assertPragmas(store.database);
});

test("151 preserves populated 150 facts and every existing schema object without backfilling zero-effect authority", async t => {
  const f = await fixture(t), before = snapshot(f.database), objects = schema(f.database); f.apply();
  const after = snapshot(f.database);
  for (const [table, rows] of Object.entries(before)) {
    if (table !== "schema_migrations") assert.deepEqual(after[table], rows);
  }
  assert.deepEqual(after.schema_migrations, [...before.schema_migrations,
    { version: 151, name: "seal_host_office_local_no_start_receipts" }]);
  for (const object of objects) {
    assert.deepEqual(f.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type=? AND name=?")
      .get(object.type, object.name), object);
  }
  assert.equal(f.database.prepare(`SELECT count(*) n FROM ${receiptTable}`).get().n, 0);
  assert.equal(f.database.prepare("SELECT count(*) n FROM host_operations WHERE operation_id LIKE 'office-%' AND phase='admitted'").get().n, 8);
  assert.equal(f.database.prepare("SELECT count(*) n FROM host_office_local_effects WHERE execution_id='b'").get().n, 0);
  assertPragmas(f.database);
});

for (const populated of [false, true]) {
  test(`151 repeated apply and reopen preserve ${populated ? "populated" : "empty"} rows, schema and version`, async t => {
    const f = await fixture(t, { populated }); f.apply(); if (populated) insertReceipt(f.database);
    const before = snapshot(f.database), objects = schema(f.database), version = f.database.prepare("PRAGMA schema_version").get().schema_version;
    f.apply({ recordMigration: () => assert.fail("must not record 151 twice") });
    f.reopen(); f.apply({ recordMigration: () => assert.fail("must not record 151 after reopen") });
    assert.deepEqual(snapshot(f.database), before); assert.deepEqual(schema(f.database), objects);
    assert.equal(f.database.prepare("PRAGMA schema_version").get().schema_version, version);
    assert.equal(f.database.prepare("SELECT count(*) n FROM schema_migrations WHERE version=151").get().n, 1);
    assertPragmas(f.database);
  });
}

for (const foreignKeys of [0, 1]) {
  for (const legacyAlterTable of [0, 1]) {
    test(`151 post-record failure rolls back all new schema/version with FK=${foreignKeys}, legacy=${legacyAlterTable}`, async t => {
      const f = await fixture(t, { foreignKeys, legacyAlterTable }), before = snapshot(f.database), objects = schema(f.database);
      const record = migrationInput(f.database).recordMigration;
      assert.throws(() => f.apply({ recordMigration: (version, name) => { record(version, name); throw new Error("151 post-record failure"); } }),
        /151 post-record failure/u);
      assert.deepEqual(snapshot(f.database), before); assert.deepEqual(schema(f.database), objects);
      assertPragmas(f.database, foreignKeys, legacyAlterTable); f.apply();
      assert.equal(f.database.prepare("SELECT count(*) n FROM schema_migrations WHERE version=151").get().n, 1);
      assertPragmas(f.database, foreignKeys, legacyAlterTable);
    });
  }
}

test("151 RELEASE failure before native return removes all new schema and remains retryable", async t => {
  const f = await fixture(t), before = snapshot(f.database), objects = schema(f.database), exec = f.database.exec.bind(f.database);
  let injected = false;
  f.database.exec = sql => {
    if (sql === "RELEASE host_office_local_no_start_migration" && !injected) {
      injected = true; throw new Error("151 RELEASE refused before native");
    }
    return exec(sql);
  };
  t.after(() => { f.database.exec = exec; });
  assert.throws(() => f.apply(), /151 RELEASE refused before native/u); assert.equal(injected, true);
  assert.deepEqual(snapshot(f.database), before); assert.deepEqual(schema(f.database), objects); assertPragmas(f.database);
  f.database.exec = exec; f.apply(); assertPragmas(f.database);
});

test("151 failed inner savepoint preserves the caller transaction and its original writes", async t => {
  const f = await fixture(t), objects = schema(f.database);
  f.database.exec("BEGIN IMMEDIATE; INSERT INTO artifacts(id) VALUES('caller-owned')");
  const before = snapshot(f.database);
  assert.throws(() => f.apply({ recordMigration: () => { throw new Error("151 inner record failed"); } }), /151 inner record failed/u);
  assert.deepEqual(snapshot(f.database), before); assert.deepEqual(schema(f.database), objects);
  assert.equal(f.database.prepare("SELECT id FROM artifacts WHERE id='caller-owned'").get().id, "caller-owned");
  f.database.exec("COMMIT");
  assert.equal(f.database.prepare("SELECT id FROM artifacts WHERE id='caller-owned'").get().id, "caller-owned");
  f.apply(); assertPragmas(f.database);
});

test("151 successful inner savepoint belongs to the outer transaction and rolls back with it", async t => {
  const f = await fixture(t), before = snapshot(f.database), objects = schema(f.database);
  f.database.exec("BEGIN IMMEDIATE; INSERT INTO artifacts(id) VALUES('outer-rollback')"); f.apply();
  assert.equal(f.database.prepare("SELECT count(*) n FROM schema_migrations WHERE version=151").get().n, 1);
  assert.equal(migrationInput(f.database).hasTable(receiptTable), true);
  f.database.exec("ROLLBACK");
  assert.deepEqual(snapshot(f.database), before); assert.deepEqual(schema(f.database), objects);
  f.apply(); assertPragmas(f.database);
});

test("151 inserting a schema exclusion row freezes it but never updates either original operation into safe", async t => {
  const f = await fixture(t); f.apply(); const before = snapshot(f.database); insertReceipt(f.database);
  assert.deepEqual(f.database.prepare("SELECT * FROM host_operations ORDER BY 1").all().map(row => ({ ...row })), before.host_operations);
  assert.deepEqual(f.database.prepare("SELECT * FROM host_office_local_effects ORDER BY 1").all(), before.host_office_local_effects);
  const receipts = f.database.prepare(`SELECT * FROM ${receiptTable}`).all();
  assert.throws(() => f.database.exec(`UPDATE ${receiptTable} SET receipt_digest=receipt_digest`), /host_office_local_no_start_immutable/u);
  assert.throws(() => f.database.exec(`DELETE FROM ${receiptTable}`), /host_office_local_no_start_append_only/u);
  assert.deepEqual(f.database.prepare(`SELECT * FROM ${receiptTable}`).all(), receipts); assertPragmas(f.database);
});

for (const column of ["execution_identity_digest", "prepared_digest", "receipt_digest", "effect_set_digest", "descendant_set_digest"]) {
  for (const [label, value] of [["short", "a".repeat(63)], ["long", "a".repeat(65)], ["nonhex", "g".repeat(64)],
    ["uppercase", "A".repeat(64)], ["trailing NUL", `${digest}\0`], ["NULL", null], ["BLOB", Buffer.from(digest)]]) {
    test(`151 rejects ${column} ${label} without leaving any receipt`, async t => {
      const f = await fixture(t); f.apply();
      assert.throws(() => insertReceipt(f.database, { [column]: value }), constraintFailure);
      assert.equal(f.database.prepare(`SELECT count(*) n FROM ${receiptTable}`).get().n, 0);
    });
  }
}

for (const [column, values] of [["effect_count", [-1, 1025, 0.5, "non-count", null]],
  ["descendant_count", [-1, 0.5, "non-count", null]]]) {
  for (const value of values) {
    test(`151 rejects ${column}=${String(value)} as a nonvalid count`, async t => {
      const f = await fixture(t); f.apply();
      assert.throws(() => insertReceipt(f.database, { [column]: value }), constraintFailure);
      assert.equal(f.database.prepare(`SELECT count(*) n FROM ${receiptTable}`).get().n, 0);
    });
  }
}
for (const effectCount of [0, 1024]) {
  test(`151 permits effect_count=${effectCount} only as a schema fact, not public safety`, async t => {
    const f = await fixture(t); f.apply(); insertReceipt(f.database, { effect_count: effectCount, descendant_count: 1 });
    const row = f.database.prepare(`SELECT effect_count,descendant_count FROM ${receiptTable}`).get();
    assert.equal(row.effect_count, effectCount); assert.equal(row.descendant_count, 1);
    assert.equal(f.database.prepare("SELECT phase FROM host_operations WHERE operation_id='office-parent-a'").get().phase, "admitted");
  });
}

for (const [label, change] of [["wrong schema", { schema_version: 2 }], ["wrong protocol", { protocol: "ling-apply-patch-v1" }],
  ["NULL execution", { execution_id: null }], ["NULL prepared artifact", { prepared_artifact_id: null }],
  ["NULL clock", { closed_at: null }], ["empty clock", { closed_at: "" }], ["clock NUL", { closed_at: `${at}\0` }]]) {
  test(`151 rejects fixed receipt ${label}`, async t => {
    const f = await fixture(t); f.apply(); assert.throws(() => insertReceipt(f.database, change), constraintFailure);
    assert.equal(f.database.prepare(`SELECT count(*) n FROM ${receiptTable}`).get().n, 0);
  });
}

for (const [label, value] of [["invalid JSON", "{"], ["JSON NULL", "null"], ["array root", "[]"], ["string root", "\"receipt\""], ["SQL NULL", null],
  ["real schemaVersion", JSON.stringify(receiptPayload(receiptRow())).replace('"schemaVersion":1', '"schemaVersion":1.0')]]) {
  test(`151 rejects receipt_json ${label}`, async t => {
    const f = await fixture(t); f.apply(); assert.throws(() => insertReceipt(f.database, { receipt_json: value }), constraintFailure);
    assert.equal(f.database.prepare(`SELECT count(*) n FROM ${receiptTable}`).get().n, 0);
  });
}
for (const key of ["schemaVersion", "protocol", "kind", "executionId", "executionIdentityDigest", "preparedArtifactId",
  "preparedDigest", "receiptDigest", "source", "effects", "requiredDescendants", "closedAt"]) {
  test(`151 rejects receipt_json missing ${key} instead of accepting NULL CHECK leakage`, async t => {
    const f = await fixture(t); f.apply(); const payload = receiptPayload(receiptRow()); delete payload[key];
    assert.throws(() => insertReceipt(f.database, { receipt_json: JSON.stringify(payload) }), constraintFailure);
  });
}
for (const [label, change] of [["string schema", { schemaVersion: "1" }], ["real schema", { schemaVersion: 1.5 }],
  ["wrong kind", { kind: "office_local_terminal_v1" }], ["wrong execution", { executionId: "b" }],
  ["wrong identity", { executionIdentityDigest: hash("different identity") }], ["wrong prepared artifact", { preparedArtifactId: "office-prepared-b" }],
  ["wrong prepared digest", { preparedDigest: hash("different prepared") }], ["wrong receipt digest", { receiptDigest: hash("different receipt") }],
  ["wrong protocol", { protocol: "ling-apply-patch-v1" }], ["wrong clock", { closedAt: "2026-10-05T00:00:00.000Z" }],
  ["NULL source", { source: null }], ["array source", { source: [] }], ["object effects", { effects: {} }],
  ["NULL effects", { effects: null }], ["effect count mismatch", { effects: [] }],
  ["object descendants", { requiredDescendants: {} }], ["NULL descendants", { requiredDescendants: null }],
  ["descendant count mismatch", { requiredDescendants: [{ operationId: "extra", evidenceDigest: digest }] }]]) {
  test(`151 rejects receipt_json ${label} independently of column constraints`, async t => {
    const f = await fixture(t); f.apply(); const payload = { ...receiptPayload(receiptRow()), ...change };
    assert.throws(() => insertReceipt(f.database, { receipt_json: JSON.stringify(payload) }), constraintFailure);
    assert.equal(f.database.prepare(`SELECT count(*) n FROM ${receiptTable}`).get().n, 0);
  });
}

test("151 preserves exact execution/artifact RESTRICT foreign keys and receipt identity uniqueness", async t => {
  const f = await fixture(t); f.apply();
  assert.throws(() => insertReceipt(f.database, { execution_id: "missing", prepared_artifact_id: "office-prepared-a" }), /FOREIGN KEY constraint failed/u);
  assert.throws(() => insertReceipt(f.database, { prepared_artifact_id: "missing" }), /FOREIGN KEY constraint failed/u);
  insertReceipt(f.database);
  assert.throws(() => f.database.exec("DELETE FROM artifacts WHERE id='office-prepared-a'"), /FOREIGN KEY constraint failed/u);
  assert.deepEqual(f.database.prepare(`PRAGMA foreign_key_list(${receiptTable})`).all().map(row => [row.table, row.from, row.on_delete]).sort(),
    [["artifacts", "prepared_artifact_id", "RESTRICT"], ["host_office_local_executions", "execution_id", "RESTRICT"]].sort());
  const uniqueColumns = f.database.prepare(`PRAGMA index_list(${receiptTable})`).all().filter(row => row.unique === 1)
    .map(row => f.database.prepare(`PRAGMA index_info(${row.name})`).all().map(column => column.name));
  assert.deepEqual(uniqueColumns.sort(), [["execution_id"], ["prepared_artifact_id"], ["receipt_digest"]].sort()); assertPragmas(f.database);
});

for (const mode of ["forward", "cleanup"]) {
  test(`151 raw ${mode} effect INSERT cannot extend the closed execution roster`, async t => {
    const f = await fixture(t); f.apply(); insertReceipt(f.database); const before = snapshot(f.database);
    assert.throws(() => insertEffect(f.database, { effect_id: "late-effect", ordinal: 1, descriptor_json: JSON.stringify({ kind: "unlink", mode }) }), closedFailure);
    assert.deepEqual(snapshot(f.database), before);
  });
}
for (const assignment of ["entered_at='2026-10-05T00:00:00.000Z'", "observation_artifact_id='office-observation-a'", "revision=revision+1", "revision=revision"]) {
  test(`151 raw closed effect UPDATE ${assignment} cannot alter the exact exclusion history`, async t => {
    const f = await fixture(t); f.apply(); insertReceipt(f.database); const before = snapshot(f.database);
    assert.throws(() => f.database.exec(`UPDATE host_office_local_effects SET ${assignment} WHERE execution_id='a'`), closedFailure);
    assert.deepEqual(snapshot(f.database), before);
  });
}

test("151 closing one execution leaves another original execution's permitted effect writes unchanged", async t => {
  const f = await fixture(t); f.apply(); insertReceipt(f.database);
  const protectedRows = f.database.prepare("SELECT * FROM host_office_local_effects WHERE execution_id='a'").all();
  insertEffect(f.database, { effect_id: "office-effect-b", execution_id: "b" });
  f.database.exec("UPDATE host_office_local_effects SET entered_at='2026-10-05T00:00:00.000Z',observation_artifact_id='office-observation-a',revision=revision+1 WHERE execution_id='b'");
  assert.equal(f.database.prepare("SELECT revision FROM host_office_local_effects WHERE execution_id='b'").get().revision, 1);
  assert.deepEqual(f.database.prepare("SELECT * FROM host_office_local_effects WHERE execution_id='a'").all(), protectedRows); assertPragmas(f.database);
});

for (const recursive of [0, 1]) {
  test(`151 receipt OR REPLACE cannot evict execution, artifact or digest identity with recursive_triggers=${recursive}`, async t => {
    const f = await fixture(t); f.apply(); f.database.exec(`PRAGMA recursive_triggers=${recursive}`); insertReceipt(f.database);
    const before = snapshot(f.database);
    for (const change of [{ prepared_artifact_id: "office-prepared-b", receipt_digest: hash("replacement") },
      { execution_id: "b", prepared_artifact_id: "office-prepared-a" },
      { execution_id: "b", receipt_digest: receiptRow().receipt_digest }]) {
      assert.throws(() => insertReceipt(f.database, change, "INSERT OR REPLACE"), /host_office_local_no_start_append_only/u);
      assert.deepEqual(snapshot(f.database), before);
    }
  });
  test(`151 effect OR REPLACE cannot evict a closed PK or ordinal with recursive_triggers=${recursive}`, async t => {
    const f = await fixture(t); f.apply(); f.database.exec(`PRAGMA recursive_triggers=${recursive}`); insertReceipt(f.database);
    const before = snapshot(f.database);
    for (const change of [{ effect_digest: hash("replacement effect") }, { execution_id: "b" }, { effect_id: "other", ordinal: 0 }]) {
      assert.throws(() => insertEffect(f.database, change, "INSERT OR REPLACE"), closedFailure);
      assert.deepEqual(snapshot(f.database), before);
    }
  });
  test(`151 INSERT/UPDATE OR REPLACE cannot steal a protected observation UNIQUE with recursive_triggers=${recursive}`, async t => {
    const f = await fixture(t); f.apply(); f.database.exec(`PRAGMA recursive_triggers=${recursive}`);
    // Deliberately contradictory schema history exercises the collision guard, not a legitimate Core no-start receipt.
    f.database.exec("UPDATE host_office_local_effects SET observation_artifact_id='office-observation-a' WHERE execution_id='a'");
    insertReceipt(f.database); insertEffect(f.database, { effect_id: "office-effect-b", execution_id: "b" });
    const before = snapshot(f.database);
    assert.throws(() => insertEffect(f.database, { effect_id: "other", execution_id: "b", ordinal: 1,
      observation_artifact_id: "office-observation-a" }, "INSERT OR REPLACE"), closedFailure);
    assert.deepEqual(snapshot(f.database), before);
    assert.throws(() => f.database.exec("UPDATE OR REPLACE host_office_local_effects SET entered_at='2026-10-05T00:00:00.000Z',observation_artifact_id='office-observation-a',revision=revision+1 WHERE execution_id='b'"), closedFailure);
    assert.deepEqual(snapshot(f.database), before); assertPragmas(f.database);
  });
}
