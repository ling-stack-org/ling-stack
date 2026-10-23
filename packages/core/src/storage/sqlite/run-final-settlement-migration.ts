import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const RUN_FINAL_SETTLEMENT_MIGRATION_VERSION = 187;
const name = "create_host_run_final_settlements_v1";
const definitions = [
  ["table", "run_final_settlements", `CREATE TABLE run_final_settlements (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE RESTRICT,
    work_unit_id TEXT NOT NULL REFERENCES work_units(id) ON DELETE RESTRICT,
    attempt_id TEXT NOT NULL UNIQUE REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
    runtime_instance_id TEXT NOT NULL, fencing_token TEXT NOT NULL,
    artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
    digest TEXT NOT NULL CHECK(length(digest)=64),
    model_view_artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
    model_view_sha256 TEXT NOT NULL CHECK(length(model_view_sha256)=64),
    boundary_event_seq INTEGER NOT NULL CHECK(boundary_event_seq>0),
    committed_at TEXT NOT NULL,
    CHECK(artifact_id<>model_view_artifact_id)
  )`],
  ["index", "idx_run_final_settlements_run", "CREATE INDEX idx_run_final_settlements_run ON run_final_settlements(run_id,boundary_event_seq)"],
  ["trigger", "run_final_settlements_identity", `CREATE TRIGGER run_final_settlements_identity BEFORE INSERT ON run_final_settlements
    WHEN EXISTS (SELECT 1 FROM run_final_settlements WHERE id=NEW.id OR attempt_id=NEW.attempt_id
      OR artifact_id IN (NEW.artifact_id,NEW.model_view_artifact_id)
      OR model_view_artifact_id IN (NEW.artifact_id,NEW.model_view_artifact_id))
    BEGIN SELECT RAISE(ABORT,'run_final_settlement_identity_conflict'); END`],
  ["trigger", "run_final_settlements_immutable", `CREATE TRIGGER run_final_settlements_immutable BEFORE UPDATE ON run_final_settlements
    BEGIN SELECT RAISE(ABORT,'run_final_settlement_immutable'); END`],
  ["trigger", "run_final_settlements_retained", `CREATE TRIGGER run_final_settlements_retained BEFORE DELETE ON run_final_settlements
    BEGIN SELECT RAISE(ABORT,'run_final_settlement_retained'); END`],
] as const;
const normalize = (sql: string): string => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

/** Additive immutable authority. Recorded schema drift is never silently repaired. */
export function applyRunFinalSettlementMigration(input: { readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): boolean {
  const db = input.database, version = RUN_FINAL_SETTLEMENT_MIGRATION_VERSION;
  const inspect = (): boolean => {
    const markers = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?").all(version, name);
    if (markers.length > 1 || markers.some(row => row.version !== version || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(version)) throw new Error("run_final_settlement_migration_marker_conflict");
    for (const [type, id, sql] of definitions) {
      const row = db.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(id);
      if (row && (row.type !== type || typeof row.sql !== "string" || normalize(row.sql) !== normalize(sql))) throw new Error("run_final_settlement_migration_schema_conflict");
      if (markers.length && !row) throw new Error("run_final_settlement_migration_schema_missing");
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
    if (!inspect()) throw new Error("run_final_settlement_migration_postcondition");
    db.exec("COMMIT"); return true;
  } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
}
