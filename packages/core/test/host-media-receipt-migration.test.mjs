import assert from "node:assert/strict";
import test from "node:test";
import { at, digest, effectRefs, executionRefs, fixture, HOST_MEDIA_RECEIPT_MIGRATION_VERSION, insertOperation, snapshot }
  from "./support/host-media-receipt-migration-fixture.mjs";

test("147 preserves populated 145/146 facts, all operation indexes/triggers and foreign references", async t => {
  const f = await fixture(t), before = snapshot(f.database);
  const objects = f.database.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='host_operations' AND sql IS NOT NULL AND type IN ('index','trigger') ORDER BY name").all();
  f.apply();
  const after = snapshot(f.database);
  assert.deepEqual(after.host_operations, before.host_operations);
  for (const table of ["host_media_executions", "host_media_effects"]) {
    const refs = table === "host_media_executions" ? executionRefs : effectRefs;
    assert.deepEqual(after[table], before[table].map(row => ({ ...row, ...Object.fromEntries(refs.map(name => [name, null])) })));
  }
  assert.deepEqual(f.database.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='host_operations' AND sql IS NOT NULL AND type IN ('index','trigger') ORDER BY name").all(), objects);
  assert.equal(f.database.prepare("SELECT operation_id FROM external_media_refs").get().operation_id, "transport");
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM media_operation_view").get().n, before.host_operations.length);
  assert.throws(() => f.database.exec("UPDATE external_media_refs SET operation_id='foreign'"), /external_reference_guard_preserved/);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(f.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(after.schema_migrations.at(-1).version, HOST_MEDIA_RECEIPT_MIGRATION_VERSION);
});

for (const [kind, evidence] of [["media_response_completed", "media_transport_execution"],
  ["media_remote_terminal", "media_transport_execution"], ["media_chain_completed", "media_chain_execution"]]) {
  test(`147 permits exact new safe ${kind} evidence, without weakening launch or evidence requirements`, async t => {
    const f = await fixture(t); f.apply();
    const safe = { phase: "safe", launched_at: at, settled_at: at, settlement_kind: kind,
      evidence_kind: evidence, evidence_id: `new-${kind}`, domain_identity_digest: digest, evidence_digest: digest,
      settlement_signature: `signature-${kind}` };
    insertOperation(f.database, kind, safe);
    assert.throws(() => insertOperation(f.database, "unlaunched", { ...safe, evidence_id: "unlaunched", launched_at: null }), /CHECK constraint failed/);
    assert.throws(() => insertOperation(f.database, "no-digest", { ...safe, evidence_id: "no-digest", evidence_digest: null }), /CHECK constraint failed/);
    assert.throws(() => insertOperation(f.database, "wrong-evidence", { ...safe, evidence_id: "wrong-evidence", evidence_kind: "host_command" }), /CHECK constraint failed/);
    assert.throws(() => insertOperation(f.database, "wrong-kind", { ...safe, evidence_id: "wrong-kind", kind: "command" }), /CHECK constraint failed/);
    assert.throws(() => insertOperation(f.database, "missing-identity", { ...safe, evidence_id: "missing-identity", domain_identity_digest: null }), /CHECK constraint failed/);
    assert.throws(() => insertOperation(f.database, "duplicate", { ...safe, tool_call_id: "duplicate" }), /UNIQUE constraint failed/);
  });
}

test("147 keeps original closed enums, identity/binding/terminal immutability, uniqueness and RESTRICT", async t => {
  const f = await fixture(t); f.apply(); const db = f.database;
  assert.throws(() => insertOperation(db, "bad-kind", { kind: "future-tool" }), /CHECK constraint failed/);
  assert.throws(() => insertOperation(db, "bad-evidence", { evidence_kind: "future-evidence", evidence_id: "future", domain_identity_digest: digest }), /CHECK constraint failed/);
  assert.throws(() => insertOperation(db, "media-null-identity", { evidence_kind: "media_chain_execution", evidence_id: "new", domain_identity_digest: null }), /CHECK constraint failed/);
  assert.throws(() => insertOperation(db, "bad-settlement", { phase: "safe", settled_at: at, settlement_kind: "future-safe", evidence_digest: digest, settlement_signature: "future" }), /CHECK constraint failed/);
  assert.throws(() => insertOperation(db, "duplicate-root", { tool_call_id: "parent" }), /UNIQUE constraint failed/);
  assert.throws(() => insertOperation(db, "duplicate-child", { parent_operation_id: "parent", producer_id: "media-http-chain" }), /UNIQUE constraint failed/);
  assert.throws(() => db.exec("UPDATE host_operations SET tool_call_id='different' WHERE operation_id='parent'"), /host_operation_identity_immutable/);
  assert.throws(() => db.exec("UPDATE host_operations SET evidence_id='different' WHERE operation_id='unknown'"), /host_operation_binding_immutable|host_operation_settlement_immutable/);
  assert.throws(() => db.exec("UPDATE host_operations SET revision=revision+1 WHERE operation_id='safe-file'"), /host_operation_settlement_immutable/);
  assert.throws(() => db.exec("UPDATE host_operations SET code='custom-forbidden' WHERE operation_id='parent'"), /custom_guard_preserved/);
  assert.throws(() => db.exec("DELETE FROM host_operations WHERE operation_id='parent'"), /FOREIGN KEY constraint failed/);
  assert.throws(() => db.exec("DELETE FROM artifacts WHERE id='prepared'"), /FOREIGN KEY constraint failed/);
  assert.throws(() => db.exec("DELETE FROM host_media_executions"), /host_media_execution_append_only/);
  assert.throws(() => db.exec("DELETE FROM host_media_effects"), /host_media_effect_append_only/);
});

for (const evidenceKind of ["media_chain_execution", "media_transport_execution"]) {
  test(`147 ${evidenceKind} terminal CHECKs reject NULL rather than accepting SQLite unknown truth`, async t => {
    const f = await fixture(t); f.apply(); const db = f.database;
    const safe = { phase: "safe", settled_at: at, evidence_kind: evidenceKind, evidence_id: "bad-safe",
      domain_identity_digest: digest, settlement_signature: "signature" };
    assert.throws(() => insertOperation(db, "null-settlement", { ...safe, settlement_kind: null }), /CHECK constraint failed/);
    assert.throws(() => insertOperation(db, "null-digest", { ...safe, settlement_kind: "known_no_start", evidence_digest: null }), /CHECK constraint failed/);
    assert.throws(() => insertOperation(db, "wrong-settlement", { ...safe, settlement_kind: "file_completed", launched_at: at, evidence_digest: digest }), /CHECK constraint failed/);
    assert.throws(() => insertOperation(db, "unknown-null-settlement", { ...safe, phase: "unknown_outcome", launched_at: at,
      settlement_kind: null, code: "uncertain" }), /CHECK constraint failed/);
    insertOperation(db, "bound-no-start", { ...safe, settlement_kind: "known_no_start", evidence_digest: digest });
    assert.equal(db.prepare("SELECT settlement_kind FROM host_operations WHERE operation_id='bound-no-start'").get().settlement_kind, "known_no_start");
  });
}

for (const [table, refs] of [["host_media_executions", executionRefs], ["host_media_effects", effectRefs]]) {
  for (const column of refs) {
    test(`147 ${table}.${column} is nullable, first-writer-wins and artifact DELETE RESTRICT`, async t => {
      const f = await fixture(t); f.apply(); const db = f.database;
      assert.equal(db.prepare(`SELECT ${column} FROM ${table}`).get()[column], null);
      assert.throws(() => db.exec(`UPDATE ${table} SET ${column}='missing-artifact'`), /FOREIGN KEY constraint failed/);
      db.exec(`UPDATE ${table} SET ${column}='receipt-a'`);
      db.exec(`UPDATE ${table} SET ${column}='receipt-a'`);
      assert.throws(() => db.exec(`UPDATE ${table} SET ${column}='receipt-b'`), /host_media_receipt_immutable/);
      assert.throws(() => db.exec(`UPDATE ${table} SET ${column}=NULL`), /host_media_receipt_immutable/);
      assert.throws(() => db.exec("DELETE FROM artifacts WHERE id='receipt-a'"), /FOREIGN KEY constraint failed/);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      f.reopen(); assert.equal(f.database.prepare(`SELECT ${column} FROM ${table}`).get()[column], "receipt-a");
    });
  }
}

test("147 response and no-start receipts cannot coexist on INSERT or in either UPDATE order", async t => {
  const f = await fixture(t); f.apply(); const db = f.database;
  assert.throws(() => db.exec("UPDATE host_media_effects SET response_artifact_id='receipt-a',no_start_artifact_id='receipt-b'"), /host_media_effect_receipt_conflict/);
  db.exec("UPDATE host_media_effects SET response_artifact_id='receipt-a'");
  assert.throws(() => db.exec("UPDATE host_media_effects SET no_start_artifact_id='receipt-b'"), /host_media_effect_receipt_conflict/);
  const insert = db.prepare(`INSERT INTO host_media_effects(effect_id,schema_version,execution_id,ordinal,kind,method,
    route_digest,wire_digest,prepared_at,response_artifact_id,no_start_artifact_id) VALUES(?,1,'execution',?,'image_request','POST',?,?,?, ?,?)`);
  assert.throws(() => insert.run("both", 1, digest, digest, at, "receipt-a", "receipt-b"), /host_media_effect_receipt_conflict/);
  insert.run("no-start", 1, digest, digest, at, null, "receipt-b");
  assert.throws(() => db.exec("UPDATE host_media_effects SET response_artifact_id='receipt-a' WHERE effect_id='no-start'"), /host_media_effect_receipt_conflict/);
});

test("147 reopen/idempotent application does not rebuild, rewrite rows or duplicate migration", async t => {
  const f = await fixture(t); f.apply();
  f.database.exec("UPDATE host_media_executions SET terminal_artifact_id='receipt-a'");
  const before = snapshot(f.database), schemaVersion = f.database.prepare("PRAGMA schema_version").get().schema_version;
  f.reopen(); f.apply({ recordMigration: () => assert.fail("must not record 147 twice") });
  assert.deepEqual(snapshot(f.database), before);
  assert.equal(f.database.prepare("PRAGMA schema_version").get().schema_version, schemaVersion);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

for (const foreignKeys of [0, 1]) {
  test(`147 rolls back a real record failure and restores foreign_keys=${foreignKeys}, then retries`, async t => {
    const f = await fixture(t, { foreignKeys }), before = snapshot(f.database);
    const schema = f.database.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all();
    assert.throws(() => f.apply({ recordMigration: () => { throw new Error("record failure"); } }), /record failure/);
    assert.deepEqual(snapshot(f.database), before);
    assert.deepEqual(f.database.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all(), schema);
    assert.equal(f.database.prepare("PRAGMA foreign_keys").get().foreign_keys, foreignKeys);
    f.apply(); assert.equal(f.database.prepare("PRAGMA foreign_keys").get().foreign_keys, foreignKeys);
    assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
  });
  test(`147 rejects an existing outer transaction with foreign_keys=${foreignKeys} without owning its rollback`, async t => {
    const f = await fixture(t, { foreignKeys }); f.database.exec("BEGIN IMMEDIATE");
    f.database.exec("INSERT INTO artifacts VALUES('outer-transaction')");
    assert.throws(() => f.apply());
    assert.equal(f.database.prepare("PRAGMA foreign_keys").get().foreign_keys, foreignKeys);
    assert.equal(f.database.prepare("SELECT id FROM artifacts WHERE id='outer-transaction'").get().id, "outer-transaction");
    f.database.exec("COMMIT");
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE version=147").get().n, 0);
    f.apply();
  });
}

test("147 a failed COMMIT rolls back schema/rows/version, restores FK, and remains safely retryable", async t => {
  const f = await fixture(t), before = snapshot(f.database), original = f.database.exec.bind(f.database);
  let failCommit = true;
  f.database.exec = sql => { if (sql === "COMMIT" && failCommit) { failCommit = false; throw new Error("commit failure"); } return original(sql); };
  assert.throws(() => f.apply(), /commit failure/);
  assert.deepEqual(snapshot(f.database), before);
  assert.equal(f.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  f.apply(); assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("147 detects existing broken external FK before commit and never legitimizes corrupt history", async t => {
  const f = await fixture(t); f.database.exec("PRAGMA foreign_keys=OFF; INSERT INTO external_media_refs VALUES('broken','missing'); PRAGMA foreign_keys=ON");
  const before = snapshot(f.database);
  assert.throws(() => f.apply(), /host_media_receipt_foreign_key_invalid/);
  assert.deepEqual(snapshot(f.database), before);
  assert.equal(f.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(f.database.prepare("PRAGMA foreign_key_check").all().length, 1);
});

test("147 upgrades an empty new database through the real 145→146→147 sequence without backfill", async t => {
  const f = await fixture(t, { populated: false }); f.apply();
  for (const table of ["host_operations", "host_media_executions", "host_media_effects"]) {
    assert.equal(f.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  }
  assert.deepEqual(f.database.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map(row => row.version), [145, 146, 147]);
  insertOperation(f.database, "new-parent");
  insertOperation(f.database, "new-child", { parent_operation_id: "new-parent", producer_id: "producer" });
  assert.throws(() => f.database.exec("DELETE FROM host_operations WHERE operation_id='new-parent'"), /FOREIGN KEY constraint failed/);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

for (const foreignKeys of [0, 1]) {
  test(`147 success and rollback restore legacy_alter_table=1 with foreign_keys=${foreignKeys}`, async t => {
    const f = await fixture(t, { foreignKeys, legacyAlterTable: 1 });
    assert.throws(() => f.apply({ recordMigration: () => { throw new Error("legacy record failure"); } }), /legacy record failure/);
    assert.equal(f.database.prepare("PRAGMA legacy_alter_table").get().legacy_alter_table, 1);
    assert.equal(f.database.prepare("PRAGMA foreign_keys").get().foreign_keys, foreignKeys);
    f.apply(); assert.equal(f.database.prepare("PRAGMA legacy_alter_table").get().legacy_alter_table, 1);
    assert.equal(f.database.prepare("PRAGMA foreign_keys").get().foreign_keys, foreignKeys);
    assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
  });
}

test("147 copy/schema failure restores the original schema, rows, view, triggers and FK setting", async t => {
  const f = await fixture(t), before = snapshot(f.database);
  const schema = f.database.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all();
  const original = f.database.exec.bind(f.database); let failDrop = true;
  f.database.exec = sql => {
    if (sql.includes("DROP TABLE host_operations") && failDrop) {
      failDrop = false;
      original("INSERT INTO host_operations_media_receipt_new SELECT * FROM host_operations");
      throw new Error("drop failure");
    }
    return original(sql);
  };
  assert.throws(() => f.apply(), /drop failure/);
  assert.deepEqual(snapshot(f.database), before);
  assert.deepEqual(f.database.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all(), schema);
  assert.equal(f.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(f.database.prepare("PRAGMA legacy_alter_table").get().legacy_alter_table, 0);
  f.apply(); assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("147 schema mismatch fails closed instead of dropping or weakening an unfamiliar CHECK", async t => {
  const f = await fixture(t), before = snapshot(f.database), original = f.database.prepare.bind(f.database);
  f.database.prepare = sql => {
    const statement = original(sql);
    if (sql === "SELECT sql FROM sqlite_schema WHERE type='table' AND name='host_operations'") {
      return { get: () => ({ sql: statement.get().sql.replace("'harness_tool_execution','host_command'", "'harness_tool_execution','host_command','future_kind'") }) };
    }
    return statement;
  };
  assert.throws(() => f.apply(), /host_media_receipt_migration_journal_schema_mismatch/);
  assert.deepEqual(snapshot(f.database), before);
  assert.equal(f.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(f.database.prepare("PRAGMA legacy_alter_table").get().legacy_alter_table, 0);
});

test("147 committed-then-reported-failed state is coherent, restores FK and safely reopens without replay", async t => {
  const f = await fixture(t), original = f.database.exec.bind(f.database); let failAfterCommit = true;
  f.database.exec = sql => {
    const result = original(sql);
    if (sql === "COMMIT" && failAfterCommit) { failAfterCommit = false; throw new Error("post-commit uncertainty"); }
    return result;
  };
  assert.throws(() => f.apply(), error => error instanceof AggregateError
    && error.errors.some(cause => /post-commit uncertainty/.test(cause.message)));
  assert.equal(f.database.isOpen, false); f.reopen();
  assert.equal(f.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(f.database.prepare("PRAGMA legacy_alter_table").get().legacy_alter_table, 0);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
  const committed = snapshot(f.database); f.reopen(); f.apply();
  assert.deepEqual(snapshot(f.database), committed);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE version=147").get().n, 1);
});

test("147 attempts foreign-key restoration even when legacy PRAGMA restoration throws", async t => {
  const f = await fixture(t), original = f.database.exec.bind(f.database); let failRestore = true;
  f.database.exec = sql => {
    const result = original(sql);
    if (sql === "PRAGMA legacy_alter_table=0" && failRestore) { failRestore = false; throw new Error("legacy restore failure"); }
    return result;
  };
  assert.throws(() => f.apply(), error => error instanceof AggregateError
    && error.errors.some(cause => /legacy restore failure/.test(cause.message)));
  assert.equal(f.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(f.database.prepare("PRAGMA legacy_alter_table").get().legacy_alter_table, 0);
  f.apply(); assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("147 a rollback failure closes its own unsafe connection instead of leaking an active FK-disabled transaction", async t => {
  const f = await fixture(t), before = snapshot(f.database), original = f.database.exec.bind(f.database);
  f.database.exec = sql => { if (sql === "ROLLBACK") throw new Error("rollback unavailable"); return original(sql); };
  assert.throws(() => f.apply({ recordMigration: () => { throw new Error("record unavailable"); } }), error => error instanceof AggregateError);
  assert.equal(f.database.isOpen, false);
  f.reopen(); assert.deepEqual(snapshot(f.database), before);
  assert.equal(f.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
  f.apply();
});

test("147 an FK restore silently refused by SQLite quarantines the handle instead of reporting it restored", async t => {
  const f = await fixture(t), original = f.database.exec.bind(f.database);
  f.database.exec = sql => {
    if (sql === "PRAGMA foreign_keys=1") original("BEGIN IMMEDIATE");
    return original(sql);
  };
  assert.throws(() => f.apply(), /host_media_receipt_pragma_restore_failed/);
  assert.equal(f.database.isOpen, false);
  f.reopen(); assert.equal(f.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
  f.apply();
});

for (const foreignKeys of [0, 1]) {
  test(`147 restore-read failure cannot close a rejected caller-owned transaction with FK=${foreignKeys}`, async t => {
    const f = await fixture(t, { foreignKeys }), original = f.database.prepare.bind(f.database);
    f.database.exec("BEGIN IMMEDIATE; INSERT INTO artifacts VALUES('caller-owned')");
    let foreignReads = 0;
    f.database.prepare = sql => {
      if (sql === "PRAGMA foreign_keys" && ++foreignReads === 3) throw new Error("restore read unavailable");
      return original(sql);
    };
    assert.throws(() => f.apply(), error => error instanceof AggregateError);
    assert.equal(f.database.isOpen, true);
    assert.equal(f.database.prepare("SELECT id FROM artifacts WHERE id='caller-owned'").get().id, "caller-owned");
    f.database.exec("COMMIT"); f.reopen();
    assert.equal(f.database.prepare("SELECT id FROM artifacts WHERE id='caller-owned'").get().id, "caller-owned");
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE version=147").get().n, 0);
    f.apply();
  });
}
