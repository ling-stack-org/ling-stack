import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { rewindNodeRerunApprovalFixture } from "./node-rerun-approval-predecessor.ts";

/**
 * Return a current production database to the historical 222 boundary used
 * by older migration fixtures. The F5 overlays are empty in these fixtures;
 * their real predecessor schemas are restored by the dedicated helpers.
 */
export function rewindRemainingWorkSuccessors(db: DatabaseSync): void {
  const has = (version: number) => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version));
  if (has(227) || has(229)) rewindNodeRerunApprovalFixture(db);

  const future = [
    { version: 226, name: "node_rerun_intents", table: "node_rerun_intents" },
    { version: 225, name: "persist_rebuildable_context_view_lineage", table: "conversation_context_view_lineage" },
  ] as const;
  const remaining = future.filter((migration) => has(migration.version));
  if (remaining.length === 0) return;

  assert.equal(db.isTransaction, false);
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get()!.foreign_keys;
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    for (const migration of remaining) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM \"${migration.table}\"`).get()!.n, 0,
        `${migration.table} must be empty before rewinding`);
      db.exec(`DROP TABLE \"${migration.table}\"`);
      assert.equal(db.prepare("DELETE FROM schema_migrations WHERE version=? AND name=?")
        .run(migration.version, migration.name).changes, 1);
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec(`PRAGMA foreign_keys=${foreignKeys === 1 ? "ON" : "OFF"}`);
  }
}
