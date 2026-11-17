import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

// Frozen production 220 table; predecessor fixtures retain all capacity history and incoming references.
const predecessor = JSON.parse(readFileSync(new URL("./node-rerun-capacity-predecessor.json", import.meta.url), "utf8")) as { readonly sql: string };
const table = "runtime_host_capacity_intents", replacement = "fixture_capacity_predecessor";
const normalize = (sql: string) => sql.replaceAll('"', "").replace(/\s+/gu, "").replace(/;$/u, "");
let installedSql: string | undefined;

/** Rewind an owned temporary database only when no rerun capacity owner would be discarded. */
export function rewindNodeRerunCapacityFixture(db: DatabaseSync): void {
  assert.equal(db.isTransaction, false);
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=229").get()) return;
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get()!.foreign_keys;
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    rewindNodeRerunCapacityFixtureWithinTransaction(db);
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  finally { db.exec(`PRAGMA foreign_keys=${foreignKeys}`); }
}

/** Join the predecessor fixture's owned transaction so any later rewind failure restores this overlay too. */
export function rewindNodeRerunCapacityFixtureWithinTransaction(db: DatabaseSync): void {
  const databaseFile = db.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file;
  assert.ok(databaseFile === "" || typeof databaseFile === "string" && /(?:\/tmp\/|\/T\/)/u.test(databaseFile), "requires an owned temporary database");
  assert.equal(db.isTransaction, true);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 0);
  const marker = db.prepare("SELECT name FROM schema_migrations WHERE version=229").get();
  if (!marker) return;
  assert.equal(marker.name, "runtime_host_capacity_node_rerun");
  assert.equal(db.prepare(`SELECT count(*) n FROM ${table} WHERE owner_kind='node_rerun_target'`).get()!.n, 0);
  const definition = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table)!.sql;
  assert.equal(typeof definition, "string");
  if (installedSql) assert.equal(normalize(definition as string), normalize(installedSql));
  else installedSql = definition as string;
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE tbl_name=? AND name<>? AND sql IS NOT NULL").all(table, table), []);
  const data = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  db.exec(predecessor.sql.replace(`"${table}"`, replacement));
  db.exec(`INSERT INTO ${replacement} SELECT * FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${replacement} RENAME TO ${table}`);
  assert.equal(db.prepare("DELETE FROM schema_migrations WHERE version=229 AND name='runtime_host_capacity_node_rerun'").run().changes, 1);
  assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), data);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
}

export function predecessorCapacitySchema<T extends { readonly name?: unknown; readonly sql?: unknown }>(schema: readonly T[]): T[] {
  return schema.map(row => row.name === table && typeof row.sql === "string" && installedSql
    && normalize(row.sql) === normalize(installedSql)
    ? Object.assign(Object.create(Object.getPrototypeOf(row)), row, { sql: predecessor.sql }) : row);
}
