import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

const version = 222, name = "create_node_rerun_submissions_and_goal_supervision";
const sql = `CREATE TABLE node_rerun_submissions (
  id TEXT PRIMARY KEY, intent_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL UNIQUE,
  source_snapshot_digest TEXT NOT NULL UNIQUE, source_workflow_id TEXT NOT NULL UNIQUE REFERENCES channel_workflows(id),
  successor_workflow_id TEXT NOT NULL UNIQUE REFERENCES channel_workflows(id), submission_json TEXT NOT NULL)`;
export function applyAgentCompletionMigration(input: { database: DatabaseSync; hasMigration(version: number): boolean;
  recordMigration(version: number, name: string): void }): void {
  const db = input.database;
  const inspect = () => {
    const markers = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?").all(version, name);
    if (markers.length > 1 || markers.some(row => row.version !== version || row.name !== name)) throw new Error("agent_completion_migration_marker_conflict");
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name='node_rerun_submissions'").get();
    const normalize = (s: string) => s.trim().replace(/\s+/g, " ");
    if (row && normalize(String(row.sql)) !== normalize(sql)) throw new Error("agent_completion_migration_schema_conflict");
    const columns = db.prepare("PRAGMA table_info(ling_thread_goals)").all();
    if (markers.length && (!row || !columns.some(c => c.name === "acceptance_criteria_json") || !columns.some(c => c.name === "supervision_policy_json") || !columns.some(c => c.name === "acceptance_evidence_json")))
      throw new Error("agent_completion_migration_schema_missing");
    return markers.length > 0;
  };
  if (inspect()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='node_rerun_submissions'").get()) db.exec(sql);
      const columns = db.prepare("PRAGMA table_info(ling_thread_goals)").all();
      if (!columns.some(c => c.name === "acceptance_criteria_json")) db.exec("ALTER TABLE ling_thread_goals ADD COLUMN acceptance_criteria_json TEXT NOT NULL DEFAULT '[]'");
      if (!columns.some(c => c.name === "supervision_policy_json")) db.exec("ALTER TABLE ling_thread_goals ADD COLUMN supervision_policy_json TEXT");
      if (!columns.some(c => c.name === "acceptance_evidence_json")) db.exec("ALTER TABLE ling_thread_goals ADD COLUMN acceptance_evidence_json TEXT NOT NULL DEFAULT '[]'");
      input.recordMigration(version, name);
    }
    if (!inspect()) throw new Error("agent_completion_migration_postcondition");
    db.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
}
