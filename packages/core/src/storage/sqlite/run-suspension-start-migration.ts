import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const RUN_SUSPENSION_START_MIGRATION_VERSION = 199;
const name = "create_host_root_suspension_starts_v1";
const definitions = [
  ["table", "run_suspension_root_starts", `CREATE TABLE run_suspension_root_starts (
    id TEXT PRIMARY KEY NOT NULL,
    suspension_id TEXT NOT NULL UNIQUE REFERENCES run_suspension_root_activations(suspension_id) ON DELETE RESTRICT,
    activation_id TEXT NOT NULL UNIQUE REFERENCES run_suspension_root_activations(id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE RESTRICT,
    target_attempt_id TEXT NOT NULL UNIQUE REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
    continuation_id TEXT NOT NULL UNIQUE REFERENCES runner_continuations(id) ON DELETE RESTRICT,
    observation_id TEXT NOT NULL UNIQUE,
    artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
    digest TEXT NOT NULL CHECK(length(digest)=64),
    acknowledged_at TEXT NOT NULL
  )`],
  ["index", "idx_run_suspension_root_start_target", "CREATE INDEX idx_run_suspension_root_start_target ON run_suspension_root_starts(run_id,target_attempt_id)"],
  ["trigger", "run_suspension_root_starts_immutable", `CREATE TRIGGER run_suspension_root_starts_immutable
    BEFORE UPDATE ON run_suspension_root_starts BEGIN SELECT RAISE(ABORT,'run_suspension_root_start_immutable'); END`],
] as const;
const normalize = (sql: string): string => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

export function applyRunSuspensionStartMigration(input: { readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): boolean {
  const db = input.database, version = RUN_SUSPENSION_START_MIGRATION_VERSION;
  const inspect = (): boolean => {
    const markers = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?").all(version, name);
    if (markers.length > 1 || markers.some(row => row.version !== version || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(version)) throw new Error("run_suspension_start_migration_marker_conflict");
    for (const [type, id, sql] of definitions) {
      const row = db.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(id);
      if (row && (row.type !== type || typeof row.sql !== "string" || normalize(row.sql) !== normalize(sql))) throw new Error("run_suspension_start_migration_schema_conflict");
      if (markers.length && !row) throw new Error("run_suspension_start_migration_schema_missing");
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
    if (!inspect()) throw new Error("run_suspension_start_migration_postcondition");
    db.exec("COMMIT"); return true;
  } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
}
