import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const RUN_SUSPENSION_MIGRATION_VERSION = 182;
const name = "create_host_run_suspensions_v1";
const definitions = [
  ["table", "run_suspensions", `CREATE TABLE run_suspensions (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE RESTRICT,
    work_unit_id TEXT NOT NULL REFERENCES work_units(id) ON DELETE RESTRICT,
    attempt_id TEXT NOT NULL UNIQUE REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
    runtime_instance_id TEXT NOT NULL, fencing_token TEXT NOT NULL,
    request_artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
    request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
    requested_event_seq INTEGER NOT NULL CHECK(requested_event_seq>=0),
    state TEXT NOT NULL CHECK(state IN ('requested','sealed')),
    seal_artifact_id TEXT UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
    seal_digest TEXT CHECK(seal_digest IS NULL OR length(seal_digest)=64),
    requested_at TEXT NOT NULL, sealed_at TEXT,
    CHECK((state='requested' AND seal_artifact_id IS NULL AND seal_digest IS NULL AND sealed_at IS NULL)
      OR (state='sealed' AND seal_artifact_id IS NOT NULL AND seal_digest IS NOT NULL AND sealed_at IS NOT NULL))
  )`],
  ["index", "idx_run_suspensions_source", "CREATE INDEX idx_run_suspensions_source ON run_suspensions(run_id,state)"],
  ["index", "idx_run_suspensions_requested", "CREATE INDEX idx_run_suspensions_requested ON run_suspensions(requested_at,id) WHERE state='requested'"],
  ["trigger", "run_suspensions_immutable", `CREATE TRIGGER run_suspensions_immutable BEFORE UPDATE ON run_suspensions
    WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.work_unit_id IS NOT OLD.work_unit_id
      OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.runtime_instance_id IS NOT OLD.runtime_instance_id
      OR NEW.fencing_token IS NOT OLD.fencing_token OR NEW.request_artifact_id IS NOT OLD.request_artifact_id
      OR NEW.request_digest IS NOT OLD.request_digest OR NEW.requested_event_seq IS NOT OLD.requested_event_seq
      OR NEW.requested_at IS NOT OLD.requested_at OR OLD.state='sealed'
    BEGIN SELECT RAISE(ABORT,'run_suspension_immutable'); END`],
] as const;
const normalize = (sql: string): string => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

/** Additive authority schema; a recorded but missing/drifted object is not repaired silently. */
export function applyRunSuspensionMigration(input: { readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): boolean {
  const db = input.database, version = RUN_SUSPENSION_MIGRATION_VERSION;
  const inspect = (): boolean => {
    const markers = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?").all(version, name);
    if (markers.length > 1 || markers.some(row => row.version !== version || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(version)) throw new Error("run_suspension_migration_marker_conflict");
    for (const [type, id, sql] of definitions) {
      const row = db.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(id);
      if (row && (row.type !== type || typeof row.sql !== "string" || normalize(row.sql) !== normalize(sql))) {
        throw new Error("run_suspension_migration_schema_conflict");
      }
      if (markers.length && !row) throw new Error("run_suspension_migration_schema_missing");
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
    if (!inspect()) throw new Error("run_suspension_migration_postcondition");
    db.exec("COMMIT"); return true;
  } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
}
