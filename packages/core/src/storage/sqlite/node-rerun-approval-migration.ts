import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { channelSessionApprovalAdmissionTriggers } from "./channel-session-migration.js";
import { applyNodeRerunIntentMigration, NODE_RERUN_INTENT_MIGRATION_VERSION } from "./node-rerun-intent-migration.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const NODE_RERUN_APPROVAL_MIGRATION_VERSION = 227;
export const NODE_RERUN_APPROVAL_MIGRATION_NAME = "node_rerun_approval_owner";

// The predecessor schemas include the decision and resume-basis columns installed before 221.
const requestPredecessorSql = `CREATE TABLE "approval_requests" (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          task_id TEXT,
          media_job_id TEXT,
          external_work_action_id TEXT,
          workflow_step_id TEXT,
          channel_id TEXT,
          tool_call_id TEXT,
          action_type TEXT NOT NULL,
          risk TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          resolved_at TEXT,
          resolved_by TEXT,
          decision_reason TEXT, available_decisions_json TEXT NOT NULL DEFAULT '["approve_once","deny"]', proposed_command_rule_json TEXT, decision_kind TEXT, decision_rule_id TEXT,
          CHECK (
            (run_id IS NOT NULL AND task_id IS NOT NULL AND media_job_id IS NULL AND external_work_action_id IS NULL AND workflow_step_id IS NULL)
            OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NOT NULL AND external_work_action_id IS NULL AND workflow_step_id IS NULL)
            OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NULL AND external_work_action_id IS NOT NULL AND workflow_step_id IS NULL)
            OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NULL AND external_work_action_id IS NULL AND workflow_step_id IS NOT NULL)
          ),
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE,
          FOREIGN KEY(external_work_action_id) REFERENCES external_work_actions(id) ON DELETE CASCADE,
          FOREIGN KEY(workflow_step_id) REFERENCES channel_workflow_steps(id) ON DELETE CASCADE
        )`;

const requestSql = `CREATE TABLE "approval_requests" (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          task_id TEXT,
          media_job_id TEXT,
          external_work_action_id TEXT,
          node_rerun_intent_id TEXT,
          workflow_step_id TEXT,
          channel_id TEXT,
          tool_call_id TEXT,
          action_type TEXT NOT NULL,
          risk TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          resolved_at TEXT,
          resolved_by TEXT,
          decision_reason TEXT, available_decisions_json TEXT NOT NULL DEFAULT '["approve_once","deny"]', proposed_command_rule_json TEXT, decision_kind TEXT, decision_rule_id TEXT,
          CHECK (
            (run_id IS NOT NULL AND task_id IS NOT NULL AND media_job_id IS NULL AND external_work_action_id IS NULL AND workflow_step_id IS NULL AND node_rerun_intent_id IS NULL)
            OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NOT NULL AND external_work_action_id IS NULL AND workflow_step_id IS NULL AND node_rerun_intent_id IS NULL)
            OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NULL AND external_work_action_id IS NOT NULL AND workflow_step_id IS NULL AND node_rerun_intent_id IS NULL)
            OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NULL AND external_work_action_id IS NULL AND workflow_step_id IS NOT NULL AND node_rerun_intent_id IS NULL)
            OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NULL AND external_work_action_id IS NULL AND workflow_step_id IS NULL AND node_rerun_intent_id IS NOT NULL)
          ),
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE,
          FOREIGN KEY(external_work_action_id) REFERENCES external_work_actions(id) ON DELETE CASCADE,
          FOREIGN KEY(node_rerun_intent_id) REFERENCES node_rerun_intents(id) ON DELETE CASCADE,
          FOREIGN KEY(workflow_step_id) REFERENCES channel_workflow_steps(id) ON DELETE CASCADE
        )`;

const checkpointPredecessorSql = `CREATE TABLE approval_checkpoints (
          id TEXT PRIMARY KEY,
          approval_id TEXT NOT NULL UNIQUE,
          run_id TEXT,
          task_id TEXT,
          media_job_id TEXT,
          external_work_action_id TEXT,
          workflow_step_id TEXT,
          channel_id TEXT,
          tool_call_id TEXT,
          action_type TEXT NOT NULL,
          risk TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL,
          side_effect_json TEXT NOT NULL,
          preview_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
          result_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
          runner_resume_handle_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          resolved_at TEXT,
          resumed_at TEXT,
          resume_failure_reason TEXT, revision INTEGER NOT NULL DEFAULT 0, resume_basis_json TEXT,
          FOREIGN KEY(approval_id) REFERENCES approval_requests(id) ON DELETE CASCADE
        )`;

const checkpointSql = `CREATE TABLE approval_checkpoints (
          id TEXT PRIMARY KEY,
          approval_id TEXT NOT NULL UNIQUE,
          run_id TEXT,
          task_id TEXT,
          media_job_id TEXT,
          external_work_action_id TEXT,
          workflow_step_id TEXT,
          channel_id TEXT,
          tool_call_id TEXT,
          action_type TEXT NOT NULL,
          risk TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL,
          side_effect_json TEXT NOT NULL,
          preview_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
          result_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
          runner_resume_handle_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          resolved_at TEXT,
          resumed_at TEXT,
          resume_failure_reason TEXT, revision INTEGER NOT NULL DEFAULT 0, resume_basis_json TEXT,
          node_rerun_intent_id TEXT, FOREIGN KEY(approval_id) REFERENCES approval_requests(id) ON DELETE CASCADE
        )`;

const postCommitPredecessorSql = `CREATE TABLE approval_postcommit_effects (
      approval_id TEXT NOT NULL,
      effect_kind TEXT NOT NULL CHECK(effect_kind IN ('decision_event', 'owner', 'control_plane_event')),
      owner_kind TEXT CHECK(owner_kind IN ('run', 'workflow_step', 'media_job', 'external_work_action')),
      owner_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'completed', 'blocked', 'effect_unknown')),
      revision INTEGER NOT NULL DEFAULT 0,
      claim_token TEXT,
      claim_expires_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(approval_id, effect_kind),
      FOREIGN KEY(approval_id) REFERENCES approval_requests(id) ON DELETE CASCADE
    )`;

const postCommitSql = `CREATE TABLE approval_postcommit_effects (
      approval_id TEXT NOT NULL,
      effect_kind TEXT NOT NULL CHECK(effect_kind IN ('decision_event', 'owner', 'control_plane_event')),
      owner_kind TEXT CHECK(owner_kind IN ('run', 'workflow_step', 'media_job', 'external_work_action', 'node_rerun_intent')),
      owner_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'completed', 'blocked', 'effect_unknown')),
      revision INTEGER NOT NULL DEFAULT 0,
      claim_token TEXT,
      claim_expires_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(approval_id, effect_kind),
      FOREIGN KEY(approval_id) REFERENCES approval_requests(id) ON DELETE CASCADE
    )`;

const bindingSql = `CREATE TABLE node_rerun_approval_requests (
  intent_id TEXT PRIMARY KEY REFERENCES node_rerun_intents(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL UNIQUE,
  basis_json TEXT NOT NULL CHECK(json_valid(basis_json)),
  basis_sha256 TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;
const indexSql = "CREATE INDEX idx_approval_requests_node_rerun_intent ON approval_requests(node_rerun_intent_id)";
const normalize = (sql: string) => sql.replaceAll('"', "").replace(/\s+/gu, "").replace(/;$/u, "");
const affectedTables = ["approval_requests", "approval_checkpoints", "approval_postcommit_effects"] as const;
type ObjectRow = { type: string; name: string; tbl_name: string; sql: string | null };
const objects = (db: DatabaseSync, name: string) => db.prepare(`SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE name=? COLLATE NOCASE
  UNION ALL SELECT type,name,tbl_name,sql FROM temp.sqlite_master WHERE name=? COLLATE NOCASE`).all(name, name) as ObjectRow[];

function verifySql(db: DatabaseSync, name: string, type: string, sql: string): void {
  const actual = objects(db, name);
  if (actual.length !== 1 || actual[0]!.type !== type || !actual[0]!.sql || normalize(actual[0]!.sql) !== normalize(sql))
    throw new Error(`node_rerun_approval.migration_schema_conflict:${name}`);
}

/** Rebuild one table with its rows and every application index/trigger intact. */
function rebuild(db: DatabaseSync, table: string, sql: string): void {
  const next = `${table}_node_rerun_next`;
  if (objects(db, next).length) throw new Error(`node_rerun_approval.migration_name_collision:${next}`);
  const auxiliary = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")
    .all(table) as { type: string; name: string; sql: string }[];
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all().map(row => String(row.name));
  const columnSql = columns.map(column => `"${column}"`).join(",");
  db.exec(sql.replace(/CREATE TABLE (?:"[^"]+"|\w+)/u, `CREATE TABLE "${next}"`));
  db.exec(`INSERT INTO "${next}" (${columnSql}) SELECT ${columnSql} FROM "${table}"`);
  // EXCEPT in both directions verifies values, not only the row count.
  if (db.prepare(`SELECT 1 FROM (SELECT ${columnSql} FROM "${table}" EXCEPT SELECT ${columnSql} FROM "${next}")
    UNION ALL SELECT 1 FROM (SELECT ${columnSql} FROM "${next}" EXCEPT SELECT ${columnSql} FROM "${table}") LIMIT 1`).get())
    throw new Error("node_rerun_approval.migration_copy_conflict");
  db.exec(`DROP TABLE "${table}"`);
  db.exec(`ALTER TABLE "${next}" RENAME TO "${table}"`);
  for (const object of auxiliary) db.exec(object.sql);
  for (const object of auxiliary) verifySql(db, object.name, object.type, object.sql);
}

/** Adds independent rerun consent while retaining the old owners and their durable projections. */
export function applyNodeRerunApprovalMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasColumn: (tableName: string, columnName: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const db = input.database;
  const inspect = (): boolean => {
    const predecessor = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name='node_rerun_intents'")
      .all(NODE_RERUN_INTENT_MIGRATION_VERSION);
    if (predecessor.length !== 1 || predecessor[0]!.version !== NODE_RERUN_INTENT_MIGRATION_VERSION
      || predecessor[0]!.name !== "node_rerun_intents" || !input.hasMigration(NODE_RERUN_INTENT_MIGRATION_VERSION))
      throw new Error("node_rerun_approval.migration_predecessor_missing");
    applyNodeRerunIntentMigration(input);
    const marker = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(NODE_RERUN_APPROVAL_MIGRATION_VERSION, NODE_RERUN_APPROVAL_MIGRATION_NAME);
    if (marker.length > 1 || marker.some(row => row.version !== NODE_RERUN_APPROVAL_MIGRATION_VERSION || row.name !== NODE_RERUN_APPROVAL_MIGRATION_NAME)
      || input.hasMigration(NODE_RERUN_APPROVAL_MIGRATION_VERSION) !== (marker.length === 1))
      throw new Error("node_rerun_approval.migration_marker_conflict");
    const installed = marker.length === 1;
    verifySql(db, "approval_requests", "table", installed ? requestSql : requestPredecessorSql);
    verifySql(db, "approval_checkpoints", "table", installed ? checkpointSql : checkpointPredecessorSql);
    verifySql(db, "approval_postcommit_effects", "table", installed ? postCommitSql : postCommitPredecessorSql);
    if (input.hasMigration(180)) for (const trigger of channelSessionApprovalAdmissionTriggers({ nodeRerun: installed }))
      verifySql(db, trigger.name, "trigger", trigger.sql);
    if (installed) {
      verifySql(db, "node_rerun_approval_requests", "table", bindingSql);
      verifySql(db, "idx_approval_requests_node_rerun_intent", "index", indexSql);
    } else if (objects(db, "node_rerun_approval_requests").length || objects(db, "idx_approval_requests_node_rerun_intent").length) {
      throw new Error("node_rerun_approval.migration_unmarked_schema");
    }
    for (const table of affectedTables) if (db.prepare(`PRAGMA foreign_key_check("${table}")`).all().length)
      throw new Error(`node_rerun_approval.migration_fk_conflict:${table}`);
    if (installed && db.prepare("PRAGMA foreign_key_check(node_rerun_approval_requests)").all().length)
      throw new Error("node_rerun_approval.migration_fk_conflict:node_rerun_approval_requests");
    return installed;
  };
  if (inspect()) return;
  if (db.isTransaction) throw new Error("node_rerun_approval.migration_caller_transaction");
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get()!.foreign_keys as SQLOutputValue;
  const legacyAlter = db.prepare("PRAGMA legacy_alter_table").get()!.legacy_alter_table as SQLOutputValue;
  let began = false;
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("PRAGMA legacy_alter_table=ON");
    if (db.prepare("PRAGMA foreign_keys").get()!.foreign_keys !== 0) throw new Error("node_rerun_approval.migration_caller_transaction");
    db.exec("BEGIN IMMEDIATE");
    began = true;
    if (!inspect()) {
      rebuild(db, "approval_requests", requestSql);
      db.exec("ALTER TABLE approval_checkpoints ADD COLUMN node_rerun_intent_id TEXT");
      rebuild(db, "approval_postcommit_effects", postCommitSql);
      db.exec(bindingSql);
      db.exec(indexSql);
      // Historical 179/180 triggers retain their original SQL until the owner column exists.
      if (input.hasMigration(180)) for (const trigger of channelSessionApprovalAdmissionTriggers({ nodeRerun: true })) {
        db.exec(`DROP TRIGGER "${trigger.name}"`);
        db.exec(trigger.sql);
      }
      input.recordMigration(NODE_RERUN_APPROVAL_MIGRATION_VERSION, NODE_RERUN_APPROVAL_MIGRATION_NAME);
    }
    if (!inspect()) throw new Error("node_rerun_approval.migration_postcondition");
    db.exec("COMMIT");
    began = false;
  } catch (error) {
    if (began) rollbackOwnedSqliteTransaction(db);
    throw error;
  } finally {
    db.exec(`PRAGMA legacy_alter_table=${legacyAlter}`);
    db.exec(`PRAGMA foreign_keys=${foreignKeys}`);
  }
}
