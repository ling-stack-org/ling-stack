import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { predecessorCapacitySchema, rewindNodeRerunCapacityFixtureWithinTransaction } from "./node-rerun-capacity-predecessor.ts";

interface SchemaObject { readonly type: string; readonly name: string; readonly tbl_name: string; readonly sql: string }
// Captured from the production 226 constructor before the independent approval owner existed.
const predecessor = JSON.parse(readFileSync(new URL("./node-rerun-approval-predecessor.json", import.meta.url), "utf8")) as SchemaObject[];
export const nodeRerunApprovalSchemaNames = ["approval_requests", "approval_checkpoints", "approval_postcommit_effects",
  "trg_channel_session_approval_admission", "trg_channel_session_approval_retry_admission", "idx_approval_requests_node_rerun_intent"];
const nodeRerunTargetSchemaNames = ["node_rerun_targets", "idx_node_rerun_targets_active_source"];
const installedSql = new Map<string, string>();
const normalize = (sql: string) => sql.replaceAll('"', "").replace(/\s+/gu, "").replace(/;$/u, "");
const objects = (db: DatabaseSync) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as unknown as SchemaObject[];

function assertOwnedDatabase(db: DatabaseSync): void {
  const databaseFile = db.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file;
  assert.ok(databaseFile === "" || typeof databaseFile === "string" && /(?:\/tmp\/|\/T\/)/u.test(databaseFile), "requires an owned temporary database");
}

/** Restore the real owner schema inside a caller-owned transaction. */
export function rewindNodeRerunApprovalFixtureWithinTransaction(db: DatabaseSync, onRewound?: () => void): void {
  assertOwnedDatabase(db);
  assert.equal(db.isTransaction, true);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 0);
  const marker = db.prepare("SELECT name FROM schema_migrations WHERE version=227").get();
  assert.equal(marker?.name, "node_rerun_approval_owner");
  const targetMarker = db.prepare("SELECT name FROM schema_migrations WHERE version=228").get();
  if (targetMarker) {
    assert.equal(targetMarker.name, "node_rerun_targets");
    assert.equal(db.prepare("SELECT count(*) n FROM node_rerun_targets").get()!.n, 0);
    assert.deepEqual(db.prepare("SELECT type,name,tbl_name FROM sqlite_master WHERE tbl_name='node_rerun_targets' AND name NOT LIKE 'sqlite_%' ORDER BY type,name")
      .all().map(row => ({ ...row })), [
      { type: "index", name: "idx_node_rerun_targets_active_source", tbl_name: "node_rerun_targets" },
      { type: "table", name: "node_rerun_targets", tbl_name: "node_rerun_targets" },
    ]);
  }
  assert.equal(db.prepare("SELECT count(*) n FROM node_rerun_approval_requests").get()!.n, 0);
  for (const table of ["approval_requests", "approval_checkpoints"])
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table} WHERE node_rerun_intent_id IS NOT NULL`).get()!.n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM approval_postcommit_effects WHERE owner_kind='node_rerun_intent'").get()!.n, 0);
  const before = objects(db);
  for (const row of before.filter(row => nodeRerunApprovalSchemaNames.includes(row.name))) {
    if (installedSql.has(row.name)) assert.equal(normalize(row.sql), normalize(installedSql.get(row.name)!));
    else installedSql.set(row.name, row.sql);
  }
  rewindNodeRerunCapacityFixtureWithinTransaction(db);
  if (targetMarker) {
    db.exec("DROP TABLE node_rerun_targets");
    db.prepare("DELETE FROM schema_migrations WHERE version=228 AND name='node_rerun_targets'").run();
  }
  db.exec("DROP TABLE node_rerun_approval_requests");
  for (const table of predecessor.filter(row => row.type === "table")) {
    const auxiliary = before.filter(row => row.tbl_name === table.name && row.type !== "table" && row.name !== "idx_approval_requests_node_rerun_intent");
    db.exec(`CREATE TEMP TABLE fixture_approval_copy AS SELECT * FROM ${table.name}`);
    db.exec(`DROP TABLE ${table.name}`);
    db.exec(table.sql);
    const columns = db.prepare(`PRAGMA table_info(${table.name})`).all().map(row => String(row.name)).join(",");
    db.exec(`INSERT INTO ${table.name} (${columns}) SELECT ${columns} FROM fixture_approval_copy`);
    db.exec("DROP TABLE fixture_approval_copy");
    for (const object of auxiliary) db.exec(predecessor.find(row => row.name === object.name)?.sql ?? object.sql);
  }
  db.prepare("DELETE FROM schema_migrations WHERE version=227 AND name='node_rerun_approval_owner'").run();
  const expected = predecessorCapacitySchema(before.filter(row => !["node_rerun_approval_requests", "idx_approval_requests_node_rerun_intent", ...nodeRerunTargetSchemaNames].includes(row.name))
    .map(row => { const old = predecessor.find(old => old.name === row.name); return old ? Object.assign(Object.create(null), old) : row; }));
  assert.deepEqual(objects(db).map(row => ({ ...row, sql: normalize(row.sql) })), expected.map(row => ({ ...row, sql: normalize(row.sql) })), "predecessor must retain every other schema object");
  onRewound?.();
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
}

/** Restore the real owner schema before removing 226; only empty rerun state may be rewound. */
export function rewindNodeRerunApprovalFixture(db: DatabaseSync, onRewound?: () => void): void {
  assertOwnedDatabase(db);
  assert.equal(db.isTransaction, false);
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get()!.foreign_keys;
  const legacyAlter = db.prepare("PRAGMA legacy_alter_table").get()!.legacy_alter_table;
  db.exec("PRAGMA foreign_keys=OFF"); db.exec("PRAGMA legacy_alter_table=ON");
  try {
    db.exec("BEGIN IMMEDIATE");
    rewindNodeRerunApprovalFixtureWithinTransaction(db, onRewound);
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  finally { db.exec(`PRAGMA legacy_alter_table=${legacyAlter}`); db.exec(`PRAGMA foreign_keys=${foreignKeys}`); }
}

/** The 227/228/229 suites verify their overlays separately from older predecessor schema comparisons. */
export function predecessorApprovalSchema<T extends { readonly name: string; readonly sql: unknown }>(schema: readonly T[]): T[] {
  return predecessorCapacitySchema(schema).filter(row => !["node_rerun_approval_requests", "idx_approval_requests_node_rerun_intent", ...nodeRerunTargetSchemaNames].includes(row.name))
    .map(row => { const old = predecessor.find(old => old.name === row.name); return old && typeof row.sql === "string" && installedSql.has(row.name) && normalize(row.sql) === normalize(installedSql.get(row.name)!)
      ? Object.assign(Object.create(Object.getPrototypeOf(row)), row, { sql: old.sql }) : row; });
}
