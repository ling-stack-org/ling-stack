import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyDelegationInstructionMigration,
  DELEGATION_INSTRUCTION_MIGRATION_VERSION,
} from "../dist/storage/sqlite/delegation-instruction-migration.js";

const now = "2026-10-22T00:00:00.000Z";
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "ling-delegation-instruction-schema-"));
  const db = new DatabaseSync(join(dir, "schema.sqlite"));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);
    CREATE TABLE run_sessions(id TEXT PRIMARY KEY);
    CREATE TABLE delegation_messages(id TEXT PRIMARY KEY);
    CREATE TABLE run_progress_checkpoints(id TEXT PRIMARY KEY);
    CREATE TABLE run_events(id TEXT PRIMARY KEY);
  `);
  const input = {
    database: db,
    hasMigration: version => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, name, now),
  };
  return { db, input, apply: () => applyDelegationInstructionMigration(input) };
}

test("178 installs one immutable receipt schema and reopens idempotently", async t => {
  const f = await fixture(t);
  assert.equal(DELEGATION_INSTRUCTION_MIGRATION_VERSION, 178);
  assert.equal(f.apply(), true);
  assert.equal(f.apply(), false);
  f.db.exec(`INSERT INTO run_sessions VALUES('run');
    INSERT INTO delegation_messages VALUES('message');
    INSERT INTO run_progress_checkpoints VALUES('checkpoint');
    INSERT INTO run_events VALUES('event');`);
  f.db.prepare("INSERT INTO delegation_instruction_receipts VALUES(?,?,?,?,?,?,?)")
    .run("message", "run", "checkpoint", "event", 1, "a".repeat(64), now);
  assert.throws(() => f.db.exec("UPDATE delegation_instruction_receipts SET model_view_index=2"), /immutable/u);
  assert.throws(() => f.db.exec("DELETE FROM delegation_instruction_receipts"), /immutable/u);
});

test("178 rejects conflicting markers and recorded missing schema", async t => {
  const f = await fixture(t);
  f.db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(178, "another-owner", now);
  assert.throws(() => f.apply(), /marker_conflict/u);
  f.db.prepare("DELETE FROM schema_migrations").run();
  f.apply();
  f.db.exec("DROP TABLE delegation_instruction_receipts");
  assert.throws(() => f.apply(), /schema_missing/u);
});

test("178 rejects altered trigger SQL and foreign rows", async t => {
  const f = await fixture(t);
  f.apply();
  f.db.exec(`DROP TRIGGER trg_delegation_instruction_receipts_no_update;
    CREATE TRIGGER trg_delegation_instruction_receipts_no_update
    BEFORE UPDATE ON delegation_instruction_receipts BEGIN SELECT 1; END;`);
  assert.throws(() => f.apply(), /schema_conflict/u);
});

test("178 rolls back schema objects when marker persistence fails", async t => {
  const f = await fixture(t);
  assert.throws(() => applyDelegationInstructionMigration({
    ...f.input,
    recordMigration: () => { throw new Error("injected marker failure"); },
  }), /injected marker failure/u);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='delegation_instruction_receipts'").get(), undefined);
  assert.equal(f.db.isTransaction, false);
});
