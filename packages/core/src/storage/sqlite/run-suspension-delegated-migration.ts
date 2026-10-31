import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const RUN_SUSPENSION_DELEGATED_MIGRATION_VERSION = 200;
const name = "create_host_delegated_suspension_activations_and_starts_v1";
const definitions = [
  ["table", "run_suspension_delegated_activations", `CREATE TABLE run_suspension_delegated_activations (
    id TEXT PRIMARY KEY NOT NULL,
    suspension_id TEXT NOT NULL UNIQUE REFERENCES run_suspensions(id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE RESTRICT,
    root_run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE RESTRICT,
    parent_run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE RESTRICT,
    step_id TEXT NOT NULL REFERENCES delegation_steps(id) ON DELETE RESTRICT,
    reservation_id TEXT NOT NULL REFERENCES delegation_budget_reservations(id) ON DELETE RESTRICT,
    source_attempt_id TEXT NOT NULL UNIQUE REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
    target_attempt_id TEXT NOT NULL UNIQUE REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
    parent_attempt_id TEXT NOT NULL REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
    artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
    digest TEXT NOT NULL CHECK(length(digest)=64),
    activated_at TEXT NOT NULL,
    CHECK(source_attempt_id<>target_attempt_id)
  )`],
  ["table", "run_suspension_delegated_starts", `CREATE TABLE run_suspension_delegated_starts (
    id TEXT PRIMARY KEY NOT NULL,
    suspension_id TEXT NOT NULL UNIQUE REFERENCES run_suspension_delegated_activations(suspension_id) ON DELETE RESTRICT,
    activation_id TEXT NOT NULL UNIQUE REFERENCES run_suspension_delegated_activations(id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE RESTRICT,
    target_attempt_id TEXT NOT NULL UNIQUE REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
    observation_id TEXT NOT NULL UNIQUE,
    artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
    digest TEXT NOT NULL CHECK(length(digest)=64),
    acknowledged_at TEXT NOT NULL
  )`],
  ["index", "idx_run_suspension_delegated_activation_target", "CREATE INDEX idx_run_suspension_delegated_activation_target ON run_suspension_delegated_activations(run_id,target_attempt_id)"],
  ["index", "idx_run_suspension_delegated_start_target", "CREATE INDEX idx_run_suspension_delegated_start_target ON run_suspension_delegated_starts(run_id,target_attempt_id)"],
  ["trigger", "run_suspension_delegated_activations_immutable", `CREATE TRIGGER run_suspension_delegated_activations_immutable
    BEFORE UPDATE ON run_suspension_delegated_activations BEGIN SELECT RAISE(ABORT,'run_suspension_delegated_activation_immutable'); END`],
  ["trigger", "run_suspension_delegated_activations_no_delete", `CREATE TRIGGER run_suspension_delegated_activations_no_delete
    BEFORE DELETE ON run_suspension_delegated_activations BEGIN SELECT RAISE(ABORT,'run_suspension_delegated_activation_immutable'); END`],
  // REPLACE does not invoke delete triggers when recursive_triggers is off.
  // Check every unique identity before SQLite can evict the original receipt.
  ["trigger", "run_suspension_delegated_activations_no_replace", `CREATE TRIGGER run_suspension_delegated_activations_no_replace
    BEFORE INSERT ON run_suspension_delegated_activations
    WHEN EXISTS (SELECT 1 FROM run_suspension_delegated_activations
      WHERE id=NEW.id OR suspension_id=NEW.suspension_id OR source_attempt_id=NEW.source_attempt_id
        OR target_attempt_id=NEW.target_attempt_id OR artifact_id=NEW.artifact_id)
    BEGIN SELECT RAISE(ABORT,'run_suspension_delegated_activation_immutable'); END`],
  ["trigger", "run_suspension_delegated_starts_immutable", `CREATE TRIGGER run_suspension_delegated_starts_immutable
    BEFORE UPDATE ON run_suspension_delegated_starts BEGIN SELECT RAISE(ABORT,'run_suspension_delegated_start_immutable'); END`],
  ["trigger", "run_suspension_delegated_starts_no_delete", `CREATE TRIGGER run_suspension_delegated_starts_no_delete
    BEFORE DELETE ON run_suspension_delegated_starts BEGIN SELECT RAISE(ABORT,'run_suspension_delegated_start_immutable'); END`],
  ["trigger", "run_suspension_delegated_starts_no_replace", `CREATE TRIGGER run_suspension_delegated_starts_no_replace
    BEFORE INSERT ON run_suspension_delegated_starts
    WHEN EXISTS (SELECT 1 FROM run_suspension_delegated_starts
      WHERE id=NEW.id OR suspension_id=NEW.suspension_id OR activation_id=NEW.activation_id
        OR target_attempt_id=NEW.target_attempt_id OR observation_id=NEW.observation_id OR artifact_id=NEW.artifact_id)
    BEGIN SELECT RAISE(ABORT,'run_suspension_delegated_start_immutable'); END`],
] as const;
const normalize = (sql: string): string => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

/** Additive source-bound history. Recorded authority with missing schema is never reconstructed. */
export function applyRunSuspensionDelegatedMigration(input: { readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): boolean {
  const db = input.database, version = RUN_SUSPENSION_DELEGATED_MIGRATION_VERSION;
  const inspect = (): boolean => {
    const markers = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?").all(version, name);
    if (markers.length > 1 || markers.some(row => row.version !== version || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(version)) throw new Error("run_suspension_delegated_migration_marker_conflict");
    for (const [type, id, sql] of definitions) {
      const row = db.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(id);
      if (row && (row.type !== type || typeof row.sql !== "string" || normalize(row.sql) !== normalize(sql))) throw new Error("run_suspension_delegated_migration_schema_conflict");
      if (markers.length && !row) throw new Error("run_suspension_delegated_migration_schema_missing");
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
    if (!inspect()) throw new Error("run_suspension_delegated_migration_postcondition");
    db.exec("COMMIT"); return true;
  } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
}
