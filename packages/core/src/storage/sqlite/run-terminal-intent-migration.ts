import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const RUN_TERMINAL_INTENT_MIGRATION_VERSION = 202;
export const RUN_TERMINAL_INTENT_MIGRATION_NAME = "create_host_run_terminal_intents_v1";
const version = RUN_TERMINAL_INTENT_MIGRATION_VERSION, name = RUN_TERMINAL_INTENT_MIGRATION_NAME;
const definitions = [
  ["table", "run_terminal_intents", `CREATE TABLE run_terminal_intents (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE RESTRICT,
    work_unit_id TEXT NOT NULL REFERENCES work_units(id) ON DELETE RESTRICT,
    attempt_id TEXT NOT NULL UNIQUE REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
    runtime_instance_id TEXT NOT NULL, fencing_token TEXT NOT NULL,
    artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
    digest TEXT NOT NULL CHECK(length(digest)=64),
    state TEXT NOT NULL CHECK(state IN ('pending','committed')),
    created_at TEXT NOT NULL, completed_at TEXT, notified_at TEXT,
    CHECK((state='pending' AND completed_at IS NULL AND notified_at IS NULL) OR (state='committed' AND completed_at IS NOT NULL))
  )`],
  ["index", "idx_run_terminal_intents_pending", "CREATE INDEX idx_run_terminal_intents_pending ON run_terminal_intents(created_at,id) WHERE state='pending'"],
  ["index", "idx_run_terminal_intents_run", "CREATE INDEX idx_run_terminal_intents_run ON run_terminal_intents(run_id,state)"],
  ["index", "idx_run_terminal_intents_unnotified", "CREATE INDEX idx_run_terminal_intents_unnotified ON run_terminal_intents(created_at,id) WHERE notified_at IS NULL"],
  ["trigger", "run_terminal_intents_immutable", `CREATE TRIGGER run_terminal_intents_immutable BEFORE UPDATE ON run_terminal_intents
    WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.work_unit_id IS NOT OLD.work_unit_id
      OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.runtime_instance_id IS NOT OLD.runtime_instance_id
      OR NEW.fencing_token IS NOT OLD.fencing_token OR NEW.artifact_id IS NOT OLD.artifact_id
      OR NEW.digest IS NOT OLD.digest OR NEW.created_at IS NOT OLD.created_at
      OR (OLD.state='committed' AND (NEW.state IS NOT OLD.state OR NEW.completed_at IS NOT OLD.completed_at
        OR OLD.notified_at IS NOT NULL OR NEW.notified_at IS NULL))
    BEGIN SELECT RAISE(ABORT,'run_terminal_intent_immutable'); END`],
] as const;
const normalize = (sql: string): string => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

/** Additive, validated migration. Missing recorded authority is never silently reconstructed. */
export function applyRunTerminalIntentMigration(input: {
  readonly database: DatabaseSync; readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): boolean {
  const db = input.database;
  const inspect = (): boolean => {
    const markers = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?").all(version, name);
    if (markers.length > 1 || markers.some(row => row.version !== version || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(version)) throw new Error("run_terminal_intent_migration_marker_conflict");
    for (const [type, id, sql] of definitions) {
      const row = db.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(id);
      if (row && (row.type !== type || typeof row.sql !== "string" || normalize(row.sql) !== normalize(sql))) {
        throw new Error("run_terminal_intent_migration_schema_conflict");
      }
      if (markers.length && !row) throw new Error("run_terminal_intent_migration_schema_missing");
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
    if (!inspect()) throw new Error("run_terminal_intent_migration_postcondition");
    db.exec("COMMIT"); return true;
  } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
}
