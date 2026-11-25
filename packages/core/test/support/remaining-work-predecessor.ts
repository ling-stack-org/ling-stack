import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { rewindNodeRerunApprovalFixture } from "./node-rerun-approval-predecessor.ts";

const appServerMarkers = [
  [235, "add_work_item_control_projection"],
  [236, "create_work_item_evidence"],
  [237, "create_app_server_state"],
] as const;

const workItemControlDefaults = [
  ["revision", 1],
  ["plan_revision", null],
  ["control_state", "active"],
  ["control_generation", 0],
  ["control_receipt_json", null],
  ["control_unresolved_effect_ids_json", "[]"],
  ["control_recovery_owner", null],
  ["holds_json", "[]"],
] as const;

/** Restore the Work Item schema of an owned temporary predecessor fixture. */
export function rewindAppServerFixture(db: DatabaseSync): void {
  const markers = db.prepare("SELECT version, name FROM schema_migrations WHERE version IN (235, 236, 237) ORDER BY version").all();
  if (markers.length === 0) return;
  assert.deepEqual(markers.map(({ version, name }) => [version, name]), appServerMarkers);
  const file = db.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file;
  assert.ok(typeof file === "string" && realpathSync(file).startsWith(`${realpathSync(tmpdir())}${sep}`),
    "App Server rewind requires an owned temporary database");
  assert.equal(db.isTransaction, false);
  db.exec("BEGIN IMMEDIATE");
  try {
    const changedControls = workItemControlDefaults.map(([column]) => `${column} IS NOT ?`).join(" OR ");
    assert.equal(db.prepare(`SELECT id FROM work_items WHERE ${changedControls} LIMIT 1`)
      .get(...workItemControlDefaults.map(([, value]) => value)), undefined, "Work Item controls must hold their initial values");
    for (const [table, index] of [
      ["app_server_state", "idx_app_server_state_kind_updated"],
      ["work_item_evidence", "idx_work_item_evidence_item_sequence"],
    ]) {
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE tbl_name=? AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all(table as string).map(row => row.name), [table, index].sort());
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0, `${table} must be empty before rewinding`);
      db.exec(`DROP TABLE ${table}`);
    }
    for (const [column] of [...workItemControlDefaults].reverse()) db.exec(`ALTER TABLE work_items DROP COLUMN ${column}`);
    for (const [version, name] of appServerMarkers) {
      assert.equal(db.prepare("DELETE FROM schema_migrations WHERE version=? AND name=?").run(version, name).changes, 1);
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Return a current production database to the historical 222 boundary used
 * by older migration fixtures. The F5 overlays are empty in these fixtures;
 * their real predecessor schemas are restored by the dedicated helpers.
 */
export function rewindRemainingWorkSuccessors(db: DatabaseSync): void {
  rewindAppServerFixture(db);
  const has = (version: number) => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version));
  if (has(227) || has(229)) rewindNodeRerunApprovalFixture(db);

  const future = [
    { version: 238, name: "conversation_visualizations", table: "conversation_visualizations" },
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
