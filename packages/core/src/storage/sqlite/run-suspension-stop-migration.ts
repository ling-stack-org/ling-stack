import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const RUN_SUSPENSION_STOP_MIGRATION_VERSION = 183;
const name = "create_host_run_suspension_stop_provenance_v1";
const definitions = [
  ["table", "run_suspension_stops", `CREATE TABLE run_suspension_stops (
    suspension_id TEXT PRIMARY KEY NOT NULL REFERENCES run_suspensions(id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE RESTRICT,
    work_unit_id TEXT NOT NULL REFERENCES work_units(id) ON DELETE RESTRICT,
    attempt_id TEXT NOT NULL UNIQUE REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
    runtime_instance_id TEXT NOT NULL, fencing_token TEXT NOT NULL,
    begin_artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
    begin_digest TEXT NOT NULL CHECK(length(begin_digest)=64),
    state TEXT NOT NULL CHECK(state IN ('stopping','stopped')),
    receipt_artifact_id TEXT UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
    receipt_digest TEXT CHECK(receipt_digest IS NULL OR length(receipt_digest)=64),
    begun_at TEXT NOT NULL, stopped_at TEXT,
    CHECK((state='stopping' AND receipt_artifact_id IS NULL AND receipt_digest IS NULL AND stopped_at IS NULL)
      OR (state='stopped' AND receipt_artifact_id IS NOT NULL AND receipt_digest IS NOT NULL AND stopped_at IS NOT NULL))
  )`],
  ["index", "idx_run_suspension_stops_source", "CREATE INDEX idx_run_suspension_stops_source ON run_suspension_stops(run_id,state)"],
  ["trigger", "run_suspension_stops_immutable", `CREATE TRIGGER run_suspension_stops_immutable BEFORE UPDATE ON run_suspension_stops
    WHEN NEW.suspension_id IS NOT OLD.suspension_id OR NEW.run_id IS NOT OLD.run_id
      OR NEW.work_unit_id IS NOT OLD.work_unit_id OR NEW.attempt_id IS NOT OLD.attempt_id
      OR NEW.runtime_instance_id IS NOT OLD.runtime_instance_id OR NEW.fencing_token IS NOT OLD.fencing_token
      OR NEW.begin_artifact_id IS NOT OLD.begin_artifact_id OR NEW.begin_digest IS NOT OLD.begin_digest
      OR NEW.begun_at IS NOT OLD.begun_at OR OLD.state='stopped'
    BEGIN SELECT RAISE(ABORT,'run_suspension_stop_immutable'); END`],
] as const;
const normalize = (sql: string): string => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

export function applyRunSuspensionStopMigration(input: { readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): boolean {
  const db = input.database, version = RUN_SUSPENSION_STOP_MIGRATION_VERSION;
  const inspect = (): boolean => {
    const markers = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?").all(version, name);
    if (markers.length > 1 || markers.some(row => row.version !== version || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(version)) throw new Error("run_suspension_stop_migration_marker_conflict");
    for (const [type, id, sql] of definitions) {
      const row = db.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(id);
      if (row && (row.type !== type || typeof row.sql !== "string" || normalize(row.sql) !== normalize(sql))) {
        throw new Error("run_suspension_stop_migration_schema_conflict");
      }
      if (markers.length && !row) throw new Error("run_suspension_stop_migration_schema_missing");
    }
    return markers.length === 1;
  };
  if (inspect()) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const [, id, sql] of definitions) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(id)) db.exec(sql);
      input.recordMigration(version, name);
    }
    if (!inspect()) throw new Error("run_suspension_stop_migration_postcondition");
    db.exec("COMMIT"); return true;
  } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
}
