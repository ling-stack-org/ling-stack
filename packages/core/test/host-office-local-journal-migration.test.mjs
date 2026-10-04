import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { applyHostOfficeLocalMigration } from "../dist/storage/sqlite/host-office-local-migration.js";
import { applyHostOfficeLocalTerminalMigration } from "../dist/storage/sqlite/host-office-local-terminal-migration.js";
import { applyHostOfficeLocalJournalMigration, HOST_OFFICE_LOCAL_JOURNAL_MIGRATION_VERSION }
  from "../dist/storage/sqlite/host-office-local-journal-migration.js";
import { at, digest, fixture as mediaFixture, insertOperation, migrationInput, snapshot as mediaSnapshot }
  from "./support/host-media-receipt-migration-fixture.mjs";

const roles = ["chain", "binary"];
const tableSqlQuery = "SELECT sql FROM sqlite_schema WHERE type='table' AND name='host_operations'";
const officeTables = ["host_office_local_executions", "host_office_local_effects", "host_office_local_terminals"];

function schema(database) {
  return database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
}
function snapshot(database) {
  return { ...mediaSnapshot(database), ...Object.fromEntries(officeTables.map(table => [table,
    database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map(row => ({ ...row }))])) };
}

/** Schema fixtures are historical facts only; they do not contain live Office tickets or safe proofs. */
function insertOfficeExecution(database, id) {
  insertOperation(database, `office-parent-${id}`, { kind: "mcp" });
  insertOperation(database, `office-producer-${id}`, { kind: "file_mutation",
    parent_operation_id: `office-parent-${id}`, producer_id: "office-local-binary" });
  database.prepare("INSERT INTO artifacts(id) VALUES(?)").run(`office-prepared-${id}`);
  database.prepare(`INSERT INTO host_office_local_executions(execution_id,schema_version,protocol,run_id,work_unit_id,
    attempt_id,runtime_instance_id,fencing_token,parent_operation_id,producer_operation_id,tool_call_id,tool_name,
    prepared_artifact_id,prepared_digest,identity_digest,prepared_at)
    VALUES(?,1,'ling-office-local-binary-v1','run','unit','attempt','runtime','fence',?,?,'office-call',
      'office_create_document',?,?,?,?)`).run(id, `office-parent-${id}`, `office-producer-${id}`,
    `office-prepared-${id}`, digest, digest, at);
}

async function fixture(t, options = {}) {
  const base = await mediaFixture(t, options); base.apply();
  applyHostOfficeLocalMigration(migrationInput(base.database));
  applyHostOfficeLocalTerminalMigration(migrationInput(base.database));
  if (options.populated !== false) {
    for (const id of ["a", "b"]) insertOfficeExecution(base.database, id);
    base.database.exec(`INSERT INTO artifacts(id) VALUES('office-terminal-a'),('office-observation-a');
      INSERT INTO host_office_local_effects(effect_id,execution_id,ordinal,descriptor_json,effect_digest,
        entered_at,observation_artifact_id,revision)
        VALUES('office-effect-a','a',0,'{}','${digest}','${at}','office-observation-a',1);
      INSERT INTO host_office_local_terminals(execution_id,schema_version,protocol,execution_identity_digest,
        terminal_artifact_id,terminal_digest,effect_set_digest,effect_count,sealed_at)
        VALUES('a',1,'ling-office-local-binary-v1','${digest}','office-terminal-a','${digest}','${digest}',1,'${at}');
      UPDATE host_media_executions SET terminal_artifact_id='receipt-a';
      UPDATE host_media_effects SET response_artifact_id='receipt-b';
      CREATE VIEW office_operation_view AS SELECT execution_id,parent_operation_id,producer_operation_id
        FROM host_office_local_executions JOIN host_operations ON operation_id=parent_operation_id;`);
  }
  return { path: base.path, get database() { return base.database; }, reopen: () => base.reopen(),
    apply: override => applyHostOfficeLocalJournalMigration(migrationInput(base.database, override)) };
}

function completed(role) {
  return { phase: "safe", launched_at: at, settled_at: at, settlement_kind: `office_local_${role}_completed`,
    evidence_digest: digest, settlement_signature: `${role}-signature` };
}

function insertOfficeOperation(database, id, role, override = {}) {
  const parent = role === "binary" ? `${id}-parent` : null;
  if (parent !== null) insertOperation(database, parent, { kind: "mcp" });
  insertOperation(database, id, { kind: role === "chain" ? "mcp" : "file_mutation", parent_operation_id: parent,
    producer_id: role === "chain" ? null : "office-local-binary", evidence_kind: `office_local_${role}_execution`,
    evidence_id: `office-binding-${id}`, domain_identity_digest: digest, ...override });
}

function assertPragmas(database, foreignKeys = 1, legacyAlterTable = 0) {
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, foreignKeys);
  assert.equal(database.prepare("PRAGMA legacy_alter_table").get().legacy_alter_table, legacyAlterTable);
}

test("150 fresh registered store follows 149 without inventing Office binding or settlement facts", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-office-journal-fresh-")), store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  assert.equal(HOST_OFFICE_LOCAL_JOURNAL_MIGRATION_VERSION, 150);
  assert.deepEqual(store.database.prepare("SELECT version FROM schema_migrations WHERE version IN (145,146,147,148,149,150) ORDER BY version")
    .all().map(row => row.version), [145, 146, 147, 148, 149, 150]);
  for (const table of ["host_operations", ...officeTables]) {
    assert.equal(store.database.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
  assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);
  assertPragmas(store.database);
});

test("150 preserves populated 145→147→148→149 rows, self/external FKs, views and every index/trigger", async t => {
  const f = await fixture(t), before = snapshot(f.database), objects = schema(f.database); f.apply();
  const after = snapshot(f.database);
  for (const [table, rows] of Object.entries(before)) {
    if (table !== "schema_migrations") assert.deepEqual(after[table], rows);
  }
  assert.deepEqual(after.schema_migrations, [...before.schema_migrations,
    { version: 150, name: "add_host_office_local_journal_roles" }]);
  for (const object of objects) {
    if (object.type === "table" && object.name === "host_operations") continue;
    assert.deepEqual(f.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type=? AND name=?")
      .get(object.type, object.name), object);
  }
  assert.equal(f.database.prepare("SELECT operation_id FROM external_media_refs").get().operation_id, "transport");
  assert.equal(f.database.prepare("SELECT count(*) n FROM media_operation_view").get().n, before.host_operations.length);
  assert.equal(f.database.prepare("SELECT count(*) n FROM office_operation_view").get().n, 2);
  assert.throws(() => f.database.exec("UPDATE external_media_refs SET operation_id='foreign'"), /external_reference_guard_preserved/);
  assert.throws(() => f.database.exec("DELETE FROM host_operations WHERE operation_id='parent'"), /FOREIGN KEY constraint failed/);
  assert.throws(() => f.database.exec("DELETE FROM host_operations WHERE operation_id='office-parent-a'"), /FOREIGN KEY constraint failed/);
  assert.throws(() => f.database.exec("DELETE FROM host_operations WHERE operation_id='office-producer-a'"), /FOREIGN KEY constraint failed/);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []); assertPragmas(f.database);
});

test("150 empty real 145→150 sequence creates no backfill, and repeated reopen does not rebuild", async t => {
  const f = await fixture(t, { populated: false }); f.apply();
  for (const table of ["host_operations", "host_media_executions", "host_media_effects", ...officeTables]) {
    assert.equal(f.database.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
  assert.deepEqual(f.database.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
    .map(row => row.version), [145, 146, 147, 148, 149, 150]);
  insertOfficeOperation(f.database, "fresh-chain", "chain");
  const before = snapshot(f.database), objects = schema(f.database);
  const version = f.database.prepare("PRAGMA schema_version").get().schema_version;
  f.reopen(); f.apply({ recordMigration: () => assert.fail("must not record 150 twice") });
  assert.deepEqual(snapshot(f.database), before); assert.deepEqual(schema(f.database), objects);
  assert.equal(f.database.prepare("PRAGMA schema_version").get().schema_version, version);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

for (const role of roles) {
  test(`150 permits exact Office ${role} admitted, launched, completed, no-start and unknown roles`, async t => {
    const f = await fixture(t); f.apply();
    insertOfficeOperation(f.database, `${role}-admitted`, role);
    insertOfficeOperation(f.database, `${role}-launched`, role, { phase: "launched", launched_at: at });
    insertOfficeOperation(f.database, `${role}-completed`, role, completed(role));
    insertOfficeOperation(f.database, `${role}-no-start`, role, { phase: "safe", settled_at: at,
      settlement_kind: "known_no_start", evidence_digest: digest, settlement_signature: "no-start" });
    insertOfficeOperation(f.database, `${role}-unknown`, role, { phase: "unknown_outcome", launched_at: at,
      settled_at: at, settlement_kind: "unknown_outcome", settlement_signature: "unknown", code: "uncertain" });
    const terminal = f.database.prepare("SELECT phase,settlement_kind FROM host_operations WHERE operation_id=?").get(`${role}-unknown`);
    assert.deepEqual({ ...terminal }, { phase: "unknown_outcome", settlement_kind: "unknown_outcome" });
    assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
  });

  for (const [field, value] of [["settlement_kind", null], ["evidence_kind", null], ["evidence_id", null],
    ["domain_identity_digest", null], ["domain_identity_digest", "short"], ["evidence_digest", null],
    ["evidence_digest", "short"], ["launched_at", null], ["settled_at", null], ["settlement_signature", null]]) {
    test(`150 Office ${role} completed rejects ${field}=${String(value)} without NULL CHECK leakage`, async t => {
      const f = await fixture(t); f.apply();
      assert.throws(() => insertOfficeOperation(f.database, "bad-completed", role, { ...completed(role), [field]: value }),
        /CHECK constraint failed|NOT NULL constraint failed/);
    });
  }

  for (const evidenceKind of ["harness_tool_execution", "host_command", "media_chain_execution", "media_transport_execution",
    `office_local_${role === "chain" ? "binary" : "chain"}_execution`]) {
    test(`150 Office ${role} completed rejects substituted ${evidenceKind} authority`, async t => {
      const f = await fixture(t); f.apply();
      assert.throws(() => insertOfficeOperation(f.database, "wrong-evidence", role,
        { ...completed(role), evidence_kind: evidenceKind }), /CHECK constraint failed/);
    });
  }

  for (const settlement of ["file_completed", "media_response_completed", "media_remote_terminal", "media_chain_completed",
    `office_local_${role === "chain" ? "binary" : "chain"}_completed`, "unknown_outcome"]) {
    test(`150 Office ${role} evidence cannot be washed safe by ${settlement}`, async t => {
      const f = await fixture(t); f.apply();
      assert.throws(() => insertOfficeOperation(f.database, "wrong-safe", role,
        { ...completed(role), settlement_kind: settlement }), /CHECK constraint failed/);
    });
  }

  for (const phase of ["admitted", "launched", "unknown_outcome", "failed"]) {
    test(`150 Office ${role} completed cannot occupy ${phase}`, async t => {
      const f = await fixture(t); f.apply();
      assert.throws(() => insertOfficeOperation(f.database, "wrong-phase", role,
        { ...completed(role), phase, code: phase === "unknown_outcome" ? "uncertain" : null }), /CHECK constraint failed/);
    });
  }

  for (const [label, fields] of [["launch", { launched_at: at }], ["NULL digest", { evidence_digest: null }],
    ["NULL identity", { domain_identity_digest: null }], ["NULL settlement", { settlement_kind: null }]]) {
    test(`150 Office ${role} known-no-start rejects ${label}`, async t => {
      const f = await fixture(t); f.apply();
      assert.throws(() => insertOfficeOperation(f.database, "bad-no-start", role, { phase: "safe", settled_at: at,
        settlement_kind: "known_no_start", evidence_digest: digest, settlement_signature: "no-start", ...fields }), /CHECK constraint failed/);
    });
  }

  for (const settlementKind of [null, `office_local_${role}_completed`, "known_no_start"]) {
    test(`150 Office ${role} unknown requires explicit unknown settlement, not ${String(settlementKind)}`, async t => {
      const f = await fixture(t); f.apply();
      assert.throws(() => insertOfficeOperation(f.database, "bad-unknown", role, { phase: "unknown_outcome", launched_at: at,
        settled_at: at, settlement_kind: settlementKind, settlement_signature: "unknown", code: "uncertain" }), /CHECK constraint failed/);
    });
  }
}

for (const [label, fields] of [["wrong kind", { kind: "file_mutation" }],
  ["child role", { parent_operation_id: "parent", producer_id: "office-local-binary" }],
  ["parent-only", { parent_operation_id: "parent" }], ["producer-only", { producer_id: "office-local-binary" }]]) {
  test(`150 Office chain rejects ${label} even while admitted`, async t => {
    const f = await fixture(t); f.apply();
    assert.throws(() => insertOfficeOperation(f.database, "bad-chain", "chain", fields), /CHECK constraint failed/);
  });
}
for (const [label, fields] of [["wrong kind", { kind: "mcp" }], ["NULL parent", { parent_operation_id: null }],
  ["NULL producer", { producer_id: null }], ["wrong producer", { producer_id: "media-http-chain" }],
  ["root role", { parent_operation_id: null, producer_id: null }]]) {
  test(`150 Office binary rejects ${label} even while admitted`, async t => {
    const f = await fixture(t); f.apply();
    assert.throws(() => insertOfficeOperation(f.database, "bad-binary", "binary", fields), /CHECK constraint failed/);
  });
}
for (const role of roles) {
  test(`150 Office ${role} preserves evidence UNIQUE and immutable identity/binding/settlement triggers`, async t => {
    const f = await fixture(t); f.apply();
    insertOfficeOperation(f.database, "bound", role);
    assert.throws(() => insertOfficeOperation(f.database, "duplicate-binding", role, { evidence_id: "office-binding-bound" }), /UNIQUE constraint failed/);
    assert.throws(() => f.database.exec("UPDATE host_operations SET producer_id='wrong' WHERE operation_id='bound'"), /host_operation_identity_immutable/);
    assert.throws(() => f.database.exec("UPDATE host_operations SET evidence_id='wrong' WHERE operation_id='bound'"), /host_operation_binding_immutable/);
    insertOfficeOperation(f.database, "terminal", role, completed(role));
    assert.throws(() => f.database.exec("UPDATE host_operations SET revision=revision+1 WHERE operation_id='terminal'"), /host_operation_settlement_immutable/);
    assert.throws(() => f.database.exec("UPDATE host_operations SET code='custom-forbidden' WHERE operation_id='parent'"), /custom_guard_preserved/);
  });
}

for (const [settlementKind, evidenceKind] of [["media_response_completed", "media_transport_execution"],
  ["media_remote_terminal", "media_transport_execution"], ["media_chain_completed", "media_chain_execution"]]) {
  test(`150 retains 147 ${settlementKind} launch, role and NULL-closed requirements`, async t => {
    const f = await fixture(t); f.apply();
    const safe = { phase: "safe", launched_at: at, settled_at: at, settlement_kind: settlementKind,
      evidence_kind: evidenceKind, evidence_id: `media-${settlementKind}`, domain_identity_digest: digest,
      evidence_digest: digest, settlement_signature: "media" };
    insertOperation(f.database, "valid-media", safe);
    for (const [index, fields] of [{ settlement_kind: null }, { evidence_digest: null }, { domain_identity_digest: null },
      { launched_at: null }, { evidence_kind: null }, { kind: "mcp" }, { evidence_kind: "harness_tool_execution" },
      { settlement_kind: "file_completed" }].entries()) {
      assert.throws(() => insertOperation(f.database, `invalid-media-${index}`, { ...safe, evidence_id: `invalid-media-${index}`, ...fields }),
        /CHECK constraint failed/);
    }
  });
}

for (const evidenceKind of ["media_chain_execution", "media_transport_execution"]) {
  test(`150 retains 147 ${evidenceKind} no-start/unknown NULL closure and immutable receipt rules`, async t => {
    const f = await fixture(t); f.apply();
    insertOperation(f.database, "media-no-start", { phase: "safe", settled_at: at, settlement_kind: "known_no_start",
      evidence_kind: evidenceKind, evidence_id: "media-no-start", domain_identity_digest: digest,
      evidence_digest: digest, settlement_signature: "no-start" });
    assert.throws(() => insertOperation(f.database, "media-null-unknown", { phase: "unknown_outcome", launched_at: at,
      settled_at: at, settlement_kind: null, evidence_kind: evidenceKind, evidence_id: "media-null-unknown",
      domain_identity_digest: digest, settlement_signature: "unknown", code: "uncertain" }), /CHECK constraint failed/);
    assert.throws(() => f.database.exec("UPDATE host_media_executions SET terminal_artifact_id='receipt-b'"), /host_media_receipt_immutable/);
    assert.throws(() => f.database.exec("UPDATE host_media_effects SET no_start_artifact_id='receipt-a'"), /host_media_effect_receipt_conflict/);
    assert.throws(() => f.database.exec("DELETE FROM artifacts WHERE id='receipt-a'"), /FOREIGN KEY constraint failed/);
    assert.throws(() => f.database.exec("UPDATE host_office_local_effects SET revision=revision+1"), /host_office_local_execution_sealed/);
    assert.throws(() => f.database.exec("DELETE FROM host_office_local_terminals"), /host_office_local_terminal_append_only/);
  });
}

test("150 retains original closed enums, unique roots/producers and legacy valid safe rows", async t => {
  const f = await fixture(t); f.apply();
  assert.throws(() => insertOperation(f.database, "future-kind", { kind: "future" }), /CHECK constraint failed/);
  assert.throws(() => insertOperation(f.database, "future-evidence", { evidence_kind: "future", evidence_id: "future", domain_identity_digest: digest }), /CHECK constraint failed/);
  assert.throws(() => insertOperation(f.database, "future-safe", { phase: "safe", settled_at: at,
    settlement_kind: "future", evidence_digest: digest, settlement_signature: "future" }), /CHECK constraint failed/);
  assert.throws(() => insertOperation(f.database, "duplicate-root", { tool_call_id: "parent" }), /UNIQUE constraint failed/);
  assert.throws(() => insertOperation(f.database, "duplicate-producer", { parent_operation_id: "parent", producer_id: "media-http-chain" }), /UNIQUE constraint failed/);
  assert.equal(f.database.prepare("SELECT settlement_kind FROM host_operations WHERE operation_id='safe-file'").get().settlement_kind, "file_completed");
  assert.equal(f.database.prepare("SELECT settlement_kind FROM host_operations WHERE operation_id='safe-no-start'").get().settlement_kind, "known_no_start");
  assert.equal(f.database.prepare("SELECT phase FROM host_operations WHERE operation_id='unknown'").get().phase, "unknown_outcome");
});

for (const foreignKeys of [0, 1]) {
  for (const legacyAlterTable of [0, 1]) {
    test(`150 record failure rolls back every schema/row/version and restores FK=${foreignKeys}, legacy=${legacyAlterTable}`, async t => {
      const f = await fixture(t, { foreignKeys, legacyAlterTable }), before = snapshot(f.database), objects = schema(f.database);
      assert.throws(() => f.apply({ recordMigration: () => { throw new Error("record unavailable"); } }), /record unavailable/);
      assert.deepEqual(snapshot(f.database), before); assert.deepEqual(schema(f.database), objects);
      assertPragmas(f.database, foreignKeys, legacyAlterTable);
      f.apply(); assertPragmas(f.database, foreignKeys, legacyAlterTable);
      assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
    });
  }
  test(`150 rejects caller-owned transaction with FK=${foreignKeys} without closing or rolling it back`, async t => {
    const f = await fixture(t, { foreignKeys }), before = schema(f.database);
    f.database.exec("BEGIN IMMEDIATE; INSERT INTO artifacts VALUES('caller-owned')");
    assert.throws(() => f.apply()); assert.equal(f.database.isOpen, true);
    assert.equal(f.database.prepare("SELECT id FROM artifacts WHERE id='caller-owned'").get().id, "caller-owned");
    assert.deepEqual(schema(f.database), before); assertPragmas(f.database, foreignKeys);
    f.database.exec("COMMIT");
    assert.equal(f.database.prepare("SELECT count(*) n FROM schema_migrations WHERE version=150").get().n, 0);
    f.apply();
  });
}

for (const stage of ["copy", "drop", "commit"]) {
  test(`150 injected ${stage} failure rolls back old schema/data and safely retries`, async t => {
    const f = await fixture(t), before = snapshot(f.database), objects = schema(f.database);
    const original = f.database.exec.bind(f.database); let injected = false;
    f.database.exec = sql => {
      if (!injected && ((stage === "commit" && sql === "COMMIT")
        || (stage !== "commit" && sql.includes("INSERT INTO host_operations_office_local_new SELECT * FROM host_operations")))) {
        injected = true;
        if (stage === "drop") original("INSERT INTO host_operations_office_local_new SELECT * FROM host_operations");
        throw new Error(`${stage} unavailable`);
      }
      return original(sql);
    };
    assert.throws(() => f.apply(), new RegExp(`${stage} unavailable`));
    assert.deepEqual(snapshot(f.database), before); assert.deepEqual(schema(f.database), objects); assertPragmas(f.database);
    f.apply(); assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
  });
}

test("150 rejects broken historical external FK before commit instead of legitimizing it", async t => {
  const f = await fixture(t);
  f.database.exec("PRAGMA foreign_keys=OFF; INSERT INTO external_media_refs VALUES('broken','missing'); PRAGMA foreign_keys=ON");
  const before = snapshot(f.database), objects = schema(f.database);
  assert.throws(() => f.apply(), /host_office_local_journal_foreign_key_invalid/);
  assert.deepEqual(snapshot(f.database), before); assert.deepEqual(schema(f.database), objects); assertPragmas(f.database);
  assert.equal(f.database.prepare("PRAGMA foreign_key_check").all().length, 1);
});

for (const [label, drift] of [
  ["enum addition", sql => sql.replace("'harness_tool_execution','host_command'", "'harness_tool_execution','host_command','future'")],
  ["Media forward NULL closure removed", sql => sql.replace("phase='safe' AND settlement_kind IS NOT NULL AND evidence_digest IS NOT NULL", "phase='safe' AND evidence_digest IS NOT NULL")],
  ["Media reverse identity NULL closure removed", sql => sql.replace("AND evidence_kind IS NOT NULL AND evidence_id IS NOT NULL AND domain_identity_digest IS NOT NULL", "AND evidence_kind IS NOT NULL AND evidence_id IS NOT NULL")],
  ["self FK weakened", sql => sql.replace("parent_operation_id TEXT REFERENCES host_operations(operation_id) ON DELETE RESTRICT", "parent_operation_id TEXT")],
  ["new column", sql => sql.replace("operation_id TEXT PRIMARY KEY,", "operation_id TEXT PRIMARY KEY, unfamiliar TEXT,")],
  ["launch CHECK weakened", sql => sql.replace("CHECK(phase!='launched' OR launched_at IS NOT NULL)", "CHECK(1)")],
]) {
  test(`150 schema drift (${label}) fails closed with unchanged real rows/schema/PRAGMAs`, async t => {
    const f = await fixture(t), before = snapshot(f.database), objects = schema(f.database);
    const original = f.database.prepare.bind(f.database);
    f.database.prepare = sql => {
      const statement = original(sql);
      if (sql === tableSqlQuery) return { get: () => { const value = statement.get().sql;
        const changed = drift(value); assert.notEqual(changed, value, "fixture must exercise actual schema drift"); return { sql: changed }; } };
      return statement;
    };
    assert.throws(() => f.apply(), /host_office_local_journal_migration_journal_schema_mismatch/);
    assert.deepEqual(snapshot(f.database), before); assert.deepEqual(schema(f.database), objects); assertPragmas(f.database);
    f.database.prepare = original; f.apply();
  });
}

test("150 COMMIT returned failure after real commit quarantines and reopens coherently without replay", async t => {
  const f = await fixture(t), original = f.database.exec.bind(f.database); let injected = false;
  f.database.exec = sql => {
    const result = original(sql);
    if (sql === "COMMIT" && !injected) { injected = true; throw new Error("post-commit uncertainty"); }
    return result;
  };
  assert.throws(() => f.apply(), error => error instanceof AggregateError
    && error.errors.some(cause => /post-commit uncertainty/.test(cause.message)));
  assert.equal(f.database.isOpen, false); f.reopen(); assertPragmas(f.database);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(f.database.prepare("SELECT count(*) n FROM schema_migrations WHERE version=150").get().n, 1);
  const committed = snapshot(f.database), objects = schema(f.database);
  f.apply({ recordMigration: () => assert.fail("committed migration must not replay") });
  assert.deepEqual(snapshot(f.database), committed); assert.deepEqual(schema(f.database), objects);
});

test("150 checks FK-disable readback before starting and restores a rejected top-level attempt", async t => {
  const f = await fixture(t), before = snapshot(f.database), objects = schema(f.database);
  const original = f.database.exec.bind(f.database); let began = false;
  f.database.exec = sql => {
    if (sql === "PRAGMA foreign_keys=OFF") return;
    if (sql === "BEGIN IMMEDIATE") began = true;
    return original(sql);
  };
  assert.throws(() => f.apply(), /host_office_local_journal_migration_requires_top_level/);
  assert.equal(began, false); assert.equal(f.database.isOpen, true);
  assert.deepEqual(snapshot(f.database), before); assert.deepEqual(schema(f.database), objects); assertPragmas(f.database);
  f.database.exec = original; f.apply();
});

test("150 FK-disable read failure restores without taking a transaction or altering history", async t => {
  const f = await fixture(t), before = snapshot(f.database), original = f.database.prepare.bind(f.database);
  let reads = 0;
  f.database.prepare = sql => { if (sql === "PRAGMA foreign_keys" && ++reads === 2) throw new Error("disable read unavailable"); return original(sql); };
  assert.throws(() => f.apply(), /disable read unavailable/); assert.equal(f.database.isOpen, true);
  assert.deepEqual(snapshot(f.database), before); assertPragmas(f.database); f.apply();
});

test("150 tries FK restoration even when legacy restore reports failure after succeeding", async t => {
  const f = await fixture(t), original = f.database.exec.bind(f.database); let injected = false;
  f.database.exec = sql => {
    const result = original(sql);
    if (sql === "PRAGMA legacy_alter_table=0" && !injected) { injected = true; throw new Error("legacy restore reported failure"); }
    return result;
  };
  assert.throws(() => f.apply(), error => error instanceof AggregateError
    && error.errors.some(cause => /legacy restore reported failure/.test(cause.message)));
  assert.equal(f.database.isOpen, true); assertPragmas(f.database);
  f.apply(); assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("150 actual legacy restore failure closes its owned handle after independently restoring FK", async t => {
  const f = await fixture(t), original = f.database.exec.bind(f.database); let foreignRestored = false;
  f.database.exec = sql => {
    if (sql === "PRAGMA legacy_alter_table=0") throw new Error("legacy restore unavailable");
    if (sql === "PRAGMA foreign_keys=1") foreignRestored = true;
    return original(sql);
  };
  assert.throws(() => f.apply(), /host_office_local_journal_pragma_restore_failed/);
  assert.equal(foreignRestored, true); assert.equal(f.database.isOpen, false);
  f.reopen(); assertPragmas(f.database); f.apply();
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("150 a silently refused FK restore quarantines its own active connection", async t => {
  const f = await fixture(t), original = f.database.exec.bind(f.database);
  f.database.exec = sql => { if (sql === "PRAGMA foreign_keys=1") original("BEGIN IMMEDIATE"); return original(sql); };
  assert.throws(() => f.apply(), /host_office_local_journal_pragma_restore_failed/);
  assert.equal(f.database.isOpen, false); f.reopen(); assertPragmas(f.database); f.apply();
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("150 failed rollback closes only its owned unsafe transaction and leaves persistent history retryable", async t => {
  const f = await fixture(t), before = snapshot(f.database), objects = schema(f.database), original = f.database.exec.bind(f.database);
  f.database.exec = sql => { if (sql === "ROLLBACK") throw new Error("rollback unavailable"); return original(sql); };
  assert.throws(() => f.apply({ recordMigration: () => { throw new Error("record unavailable"); } }), error => error instanceof AggregateError
    && error.errors.some(cause => /rollback unavailable/.test(cause.message)));
  assert.equal(f.database.isOpen, false); f.reopen();
  assert.deepEqual(snapshot(f.database), before); assert.deepEqual(schema(f.database), objects); assertPragmas(f.database);
  f.apply(); assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("150 restore readback failure quarantines an owned handle even after committed work", async t => {
  const f = await fixture(t), original = f.database.prepare.bind(f.database); let reads = 0;
  f.database.prepare = sql => { if (sql === "PRAGMA foreign_keys" && ++reads === 3) throw new Error("restore read unavailable"); return original(sql); };
  assert.throws(() => f.apply(), /host_office_local_journal_pragma_restore_failed/);
  assert.equal(f.database.isOpen, false); f.reopen(); assertPragmas(f.database); f.apply();
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

for (const foreignKeys of [0, 1]) {
  test(`150 restore readback failure must not close rejected caller-owned transaction with FK=${foreignKeys}`, async t => {
    const f = await fixture(t, { foreignKeys }), original = f.database.prepare.bind(f.database);
    f.database.exec("BEGIN IMMEDIATE; INSERT INTO artifacts VALUES('outer-transaction')"); let reads = 0;
    f.database.prepare = sql => { if (sql === "PRAGMA foreign_keys" && ++reads === 3) throw new Error("outer restore read unavailable"); return original(sql); };
    assert.throws(() => f.apply(), error => error instanceof AggregateError); assert.equal(f.database.isOpen, true);
    assert.equal(f.database.prepare("SELECT id FROM artifacts WHERE id='outer-transaction'").get().id, "outer-transaction");
    f.database.exec("COMMIT"); f.reopen(); assertPragmas(f.database, foreignKeys);
    assert.equal(f.database.prepare("SELECT id FROM artifacts WHERE id='outer-transaction'").get().id, "outer-transaction");
    assert.equal(f.database.prepare("SELECT count(*) n FROM schema_migrations WHERE version=150").get().n, 0);
    f.apply();
  });
}
