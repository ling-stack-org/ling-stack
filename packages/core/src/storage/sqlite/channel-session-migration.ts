import { channelSessionNotificationEligibleSql } from "./channel-session-notification.js";
import { channelSessionWorkflowSourceSql, channelSessionRunSourceSql, channelSessionThreadSourceSql, channelSessionTopicLineageValidSql, channelSessionWorkSourceSql, channelSessionApprovalSourceSql, channelSessionInputWaitSourceSql } from "./channel-session-lineage.js";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export const CHANNEL_SESSION_MIGRATION_VERSION = 179;
export const CHANNEL_SESSION_LINEAGE_MIGRATION_VERSION = 180;
export const CHANNEL_SESSION_NOTIFICATION_MIGRATION_VERSION = 181;

/** Forward-only classification. Ambiguous old directories remain intact and are reported. */
export function applyChannelSessionMigration(input: {
  readonly database: DatabaseSync;
  readonly backupPath?: string;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  if (input.hasMigration(CHANNEL_SESSION_MIGRATION_VERSION)) {
    if (input.hasMigration(CHANNEL_SESSION_LINEAGE_MIGRATION_VERSION) && input.hasMigration(CHANNEL_SESSION_NOTIFICATION_MIGRATION_VERSION)) return;
    input.database.exec("SAVEPOINT channel_session_lineage_migration");
    try {
      if (!input.hasMigration(CHANNEL_SESSION_LINEAGE_MIGRATION_VERSION)) {
        input.database.exec(channelSessionAdmissionTriggersSql());
        input.recordMigration(CHANNEL_SESSION_LINEAGE_MIGRATION_VERSION, "channel_session_topic_ownership");
      }
      if (!input.hasMigration(CHANNEL_SESSION_NOTIFICATION_MIGRATION_VERSION)) {
        input.database.exec(channelSessionNotificationTriggersSql());
        input.recordMigration(CHANNEL_SESSION_NOTIFICATION_MIGRATION_VERSION, "channel_session_topic_notifications");
      }
      input.database.exec("RELEASE channel_session_lineage_migration");
    } catch (error) {
      input.database.exec("ROLLBACK TO channel_session_lineage_migration; RELEASE channel_session_lineage_migration");
      throw error;
    }
    return;
  }
  const db = input.database;
  // SQLite makes a consistent copy including WAL state; never overwrite the original rollback point.
  if (input.backupPath && !existsSync(input.backupPath) && db.prepare("SELECT 1 FROM channels LIMIT 1").get()) {
    db.prepare("VACUUM INTO ?").run(input.backupPath);
  }
  db.exec("SAVEPOINT channel_session_migration");
  try {
    db.exec(`
      ALTER TABLE ling_threads ADD COLUMN session_title_source TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE ling_threads ADD COLUMN session_notification_revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ling_threads ADD COLUMN session_activity_at TEXT;
      CREATE TABLE channel_session_requests (
        workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL, thread_id TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, channel_id, idempotency_key),
        FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
      );
      CREATE TABLE channel_session_diagnostics (
        branch_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, code TEXT NOT NULL,
        FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
      );
      INSERT INTO channel_session_diagnostics(branch_id, channel_id, code)
      SELECT b.id, b.channel_id,
        CASE WHEN b.root_thread_id IS NULL THEN 'missing_thread'
          WHEN t.id IS NULL THEN 'missing_thread'
          WHEN t.channel_id IS NOT b.channel_id THEN 'channel_mismatch'
          WHEN t.surface_kind = 'channel_root' THEN 'default_registered_as_named'
          WHEN t.kind != 'channel_discussion' OR t.task_id IS NOT NULL OR t.teammate_id IS NOT NULL
            OR t.workflow_id IS NOT NULL OR t.workflow_step_id IS NOT NULL OR t.external_work_id IS NOT NULL THEN 'mixed_owner'
          WHEN (SELECT COUNT(*) FROM channel_branches other WHERE other.root_thread_id = b.root_thread_id
            AND other.deleted_at IS NULL) > 1 THEN 'duplicate_directory'
          ELSE 'invalid_topology' END
      FROM channel_branches b LEFT JOIN ling_threads t ON t.id = b.root_thread_id
      WHERE b.deleted_at IS NULL AND (b.root_thread_id IS NULL OR t.id IS NULL OR t.channel_id IS NOT b.channel_id
        OR t.surface_kind = 'channel_root' OR t.kind != 'channel_discussion'
        OR t.task_id IS NOT NULL OR t.teammate_id IS NOT NULL OR t.workflow_id IS NOT NULL
        OR t.workflow_step_id IS NOT NULL OR t.external_work_id IS NOT NULL
        OR (SELECT COUNT(*) FROM channel_branches other WHERE other.root_thread_id = b.root_thread_id
          AND other.deleted_at IS NULL) > 1
        OR t.surface_kind NOT IN ('work', 'channel_session', 'branch')
        OR (t.surface_kind = 'work' AND (t.parent_thread_id IS NOT NULL OR t.parent_turn_id IS NOT NULL
          OR t.anchor_item_id IS NOT NULL OR t.fork_context_snapshot_id IS NOT NULL OR t.forked_from_run_id IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM ling_turns turn JOIN ling_threads parent ON parent.id = turn.thread_id
            JOIN conversation_context_snapshots snapshot ON snapshot.thread_id = parent.id
            WHERE turn.id = t.parent_turn_id AND parent.id = t.parent_thread_id
              AND parent.channel_id = t.channel_id AND snapshot.id = t.fork_context_snapshot_id)));

      UPDATE ling_threads SET surface_kind = 'branch', relation_kind = 'branch'
      WHERE surface_kind = 'work' AND parent_turn_id IS NOT NULL AND id IN (
        SELECT root_thread_id FROM channel_branches WHERE deleted_at IS NULL
          AND id NOT IN (SELECT branch_id FROM channel_session_diagnostics)
      );

      UPDATE ling_threads SET surface_kind = 'channel_session', relation_kind = 'root'
      WHERE surface_kind = 'work' AND id IN (
        SELECT root_thread_id FROM channel_branches WHERE deleted_at IS NULL
          AND id NOT IN (SELECT branch_id FROM channel_session_diagnostics)
      );
      UPDATE ling_threads SET
        title = (SELECT name FROM channel_branches b WHERE b.root_thread_id = ling_threads.id AND b.deleted_at IS NULL),
        archived_at = (SELECT CASE WHEN b.status = 'archived' THEN COALESCE(b.archived_at, b.updated_at) END
          FROM channel_branches b WHERE b.root_thread_id = ling_threads.id AND b.deleted_at IS NULL),
        status = CASE WHEN status = 'archived' THEN 'open' ELSE status END
      WHERE id IN (SELECT root_thread_id FROM channel_branches WHERE deleted_at IS NULL
        AND id NOT IN (SELECT branch_id FROM channel_session_diagnostics));
      UPDATE channel_branches SET archived_at = COALESCE(archived_at, updated_at) WHERE status = 'archived';
      UPDATE channel_branches SET archived_at = NULL WHERE status = 'active';
      -- The compatibility root must remain reachable even if an old generic PATCH archived it.
      UPDATE ling_threads SET archived_at = NULL, archived_reason = NULL,
        status = CASE WHEN status = 'archived' THEN 'open' ELSE status END
      WHERE surface_kind = 'channel_root' AND id = (SELECT chosen.id FROM ling_threads chosen
        WHERE chosen.surface_kind = 'channel_root' AND chosen.channel_id = ling_threads.channel_id
        ORDER BY chosen.archived_at IS NOT NULL, chosen.created_at, chosen.id LIMIT 1);
      INSERT INTO ling_threads(id, workspace_id, kind, channel_id, title, objective, status,
        created_at, updated_at, surface_kind, relation_kind)
      SELECT 'thread_channel_default_' || c.id, c.workspace_id, 'channel_discussion', c.id,
        'Default conversation', 'Default conversation for ' || c.name, 'open',
        c.created_at, c.created_at, 'channel_root', 'root'
      FROM channels c WHERE NOT EXISTS (SELECT 1 FROM ling_threads t WHERE t.channel_id = c.id AND t.surface_kind = 'channel_root');
      UPDATE ling_threads SET session_activity_at = COALESCE(
        (SELECT MAX(i.updated_at) FROM conversation_items i WHERE i.thread_id = ling_threads.id
          AND i.visibility = 'channel' AND i.kind IN ('user_message', 'assistant_message', 'terminal_report')
          AND ${channelSessionNotificationEligibleSql("i")}),
        created_at);

      CREATE INDEX idx_channel_sessions_activity ON ling_threads(channel_id, session_activity_at DESC, id);
      CREATE TRIGGER trg_channel_session_directory_unique_insert BEFORE INSERT ON channel_branches
      WHEN NEW.root_thread_id IS NOT NULL AND NEW.deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM channel_branches b WHERE b.root_thread_id = NEW.root_thread_id AND b.deleted_at IS NULL)
      BEGIN SELECT RAISE(ABORT, 'channel_session_duplicate_directory'); END;
      CREATE TRIGGER trg_channel_session_directory_unique_update BEFORE UPDATE OF root_thread_id, deleted_at ON channel_branches
      WHEN NEW.root_thread_id IS NOT NULL AND NEW.deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM channel_branches b WHERE b.root_thread_id = NEW.root_thread_id AND b.id != NEW.id AND b.deleted_at IS NULL)
      BEGIN SELECT RAISE(ABORT, 'channel_session_duplicate_directory'); END;

      CREATE TRIGGER trg_channel_session_thread_mirror AFTER UPDATE OF title, archived_at ON ling_threads
      WHEN OLD.title IS NOT NEW.title OR OLD.archived_at IS NOT NEW.archived_at
      BEGIN
        UPDATE channel_branches SET name = NEW.title, archived_at = NEW.archived_at,
          status = CASE WHEN NEW.archived_at IS NULL THEN 'active' ELSE 'archived' END, updated_at = NEW.updated_at
        WHERE root_thread_id = NEW.id AND deleted_at IS NULL;
      END;
      CREATE TRIGGER trg_channel_session_directory_mirror AFTER UPDATE OF name, archived_at ON channel_branches
      WHEN NEW.deleted_at IS NULL AND (OLD.name IS NOT NEW.name OR OLD.archived_at IS NOT NEW.archived_at)
      BEGIN
        UPDATE ling_threads SET title = NEW.name, archived_at = NEW.archived_at,
          archived_reason = CASE WHEN NEW.archived_at IS NULL THEN NULL ELSE 'channel_branch_archived' END
        WHERE id = NEW.root_thread_id AND channel_id = NEW.channel_id;
      END;

    `);
    db.exec(channelSessionAdmissionTriggersSql());
    db.exec(channelSessionNotificationTriggersSql());
    input.recordMigration(CHANNEL_SESSION_MIGRATION_VERSION, "channel_independent_sessions");
    input.recordMigration(CHANNEL_SESSION_LINEAGE_MIGRATION_VERSION, "channel_session_topic_ownership");
    input.recordMigration(CHANNEL_SESSION_NOTIFICATION_MIGRATION_VERSION, "channel_session_topic_notifications");
    db.exec("RELEASE channel_session_migration");
  } catch (error) {
    db.exec("ROLLBACK TO channel_session_migration; RELEASE channel_session_migration");
    throw error;
  }
}

/** Refresh triggers only; existing history and read baselines are not replayed. */
function channelSessionNotificationTriggersSql(): string {
  const targets = `WITH RECURSIVE notification_lineage(id, workspace_id, channel_id, surface_kind, parent_thread_id) AS (
    SELECT id, workspace_id, channel_id, surface_kind, parent_thread_id FROM ling_threads
      WHERE id = NEW.thread_id AND workspace_id = NEW.workspace_id AND channel_id IS NEW.channel_id
    UNION
    SELECT parent.id, parent.workspace_id, parent.channel_id, parent.surface_kind, parent.parent_thread_id
      FROM notification_lineage child JOIN ling_threads parent ON parent.id = child.parent_thread_id
        AND parent.workspace_id = child.workspace_id AND parent.channel_id = child.channel_id
      WHERE child.surface_kind = 'topic'
  ) SELECT id FROM notification_lineage`;
  return `
    DROP TRIGGER IF EXISTS trg_channel_session_activity_insert;
    DROP TRIGGER IF EXISTS trg_channel_session_notification_update;
      CREATE TRIGGER trg_channel_session_activity_insert AFTER INSERT ON conversation_items
      WHEN NEW.visibility = 'channel' AND NEW.kind IN ('user_message','assistant_message','terminal_report')
        AND NEW.status IN ('committed','pending','failed') AND ${channelSessionNotificationEligibleSql("NEW")}
      BEGIN
        UPDATE ling_threads SET session_activity_at = MAX(COALESCE(session_activity_at, created_at), NEW.created_at),
          session_notification_revision = session_notification_revision + CASE WHEN NEW.kind IN ('assistant_message','terminal_report')
            AND (NEW.kind = 'terminal_report' OR length(json_extract(NEW.payload_json, '$.body')) > 0) THEN 1 ELSE 0 END
        WHERE id IN (${targets});
      END;
      CREATE TRIGGER trg_channel_session_notification_update AFTER UPDATE OF payload_json, status ON conversation_items
      WHEN CASE WHEN NEW.visibility != 'channel' OR NEW.kind != 'assistant_message' OR NEW.status NOT IN ('pending','committed','failed') THEN 0
        WHEN NOT json_valid(NEW.payload_json) OR NOT json_valid(OLD.payload_json) THEN 0
        ELSE ${channelSessionNotificationEligibleSql("NEW")} AND (
        (COALESCE(json_extract(OLD.payload_json, '$.body'), '') = '' AND length(json_extract(NEW.payload_json, '$.body')) > 0)
        OR (COALESCE(json_extract(OLD.payload_json, '$.streaming'), 0) = 1 AND json_extract(NEW.payload_json, '$.streaming') = 0)
        OR (json_extract(OLD.payload_json, '$.deliveryStatus') IS NOT json_extract(NEW.payload_json, '$.deliveryStatus')
          AND json_extract(NEW.payload_json, '$.deliveryStatus') IN ('ready','blocked','failed'))) END
      BEGIN
        UPDATE ling_threads SET session_notification_revision = session_notification_revision + 1,
          session_activity_at = MAX(COALESCE(session_activity_at, created_at), NEW.updated_at)
        WHERE id IN (${targets});
      END;
  `;
}

/** Refresh independently on 179 databases; never reruns directory classification or history backfill. */
function channelSessionAdmissionTriggersSql(): string {
  const archived = (source: string): string => `EXISTS (SELECT 1 FROM ling_threads t
    WHERE t.channel_id IS NOT NULL AND (t.archived_at IS NOT NULL OR t.status = 'archived') AND ${source})`;
  const trigger = (name: string, table: string, event: string, condition: string): string => `
    DROP TRIGGER IF EXISTS ${name};
    CREATE TRIGGER ${name} BEFORE ${event} ON ${table} WHEN ${condition}
    BEGIN SELECT RAISE(ABORT, 'channel_session_archived'); END;`;
  const threadArchived = archived(channelSessionThreadSourceSql("NEW.thread_id", "t.id"));
  const runArchived = archived(channelSessionRunSourceSql("NEW", "t.id"));
  const workArchived = archived(channelSessionWorkSourceSql("NEW", "t.id"));
  const approvalArchived = archived(channelSessionApprovalSourceSql("NEW", "t.id"));
  const workflowArchived = archived(channelSessionWorkflowSourceSql("NEW", "t.id"));
  const stepArchived = archived(`EXISTS (SELECT 1 FROM channel_workflows workflow
    WHERE workflow.id = NEW.workflow_id AND workflow.workspace_id = NEW.workspace_id
      AND workflow.channel_id = NEW.channel_id AND ${channelSessionWorkflowSourceSql("workflow", "t.id")})`);
  const waitArchived = archived(channelSessionInputWaitSourceSql("NEW", "t.id"));
  return `
    DROP TRIGGER IF EXISTS trg_channel_session_turn_lineage;
    CREATE TRIGGER trg_channel_session_turn_lineage BEFORE INSERT ON ling_turns
    WHEN EXISTS (SELECT 1 FROM ling_threads thread WHERE thread.id = NEW.thread_id AND thread.surface_kind = 'topic'
      AND NOT ${channelSessionTopicLineageValidSql("thread.id")})
    BEGIN SELECT RAISE(ABORT, 'channel_session_invalid_lineage'); END;
    ${trigger("trg_channel_session_turn_admission", "ling_turns", "INSERT", threadArchived)}
    ${trigger("trg_channel_session_run_admission", "run_sessions", "INSERT", runArchived)}
    ${trigger("trg_channel_session_run_retry_admission", "run_sessions",
      "UPDATE OF status, thread_id, workflow_step_id", `NEW.status IN ('queued','running','waiting_for_approval') AND ${runArchived}`)}
    ${trigger("trg_channel_session_work_admission", "work_units", "INSERT", workArchived)}
    ${trigger("trg_channel_session_work_retry_admission", "work_units",
      "UPDATE OF status, owner_type, owner_id, linked_run_id, linked_message_id", `NEW.status NOT IN ('succeeded','failed','cancelled','expired') AND ${workArchived}`)}
    ${trigger("trg_channel_session_approval_admission", "approval_requests", "INSERT", approvalArchived)}
    ${trigger("trg_channel_session_approval_retry_admission", "approval_requests",
      "UPDATE OF status, run_id, workflow_step_id, media_job_id", `NEW.status = 'pending' AND ${approvalArchived}`)}
    ${trigger("trg_channel_session_workflow_admission", "channel_workflows", "INSERT", workflowArchived)}
    ${trigger("trg_channel_session_workflow_retry_admission", "channel_workflows",
      "UPDATE OF status, metadata_json", `NEW.status NOT IN ('succeeded','failed','cancelled','expired') AND ${workflowArchived}`)}
    ${trigger("trg_channel_session_workflow_step_admission", "channel_workflow_steps", "INSERT", stepArchived)}
    ${trigger("trg_channel_session_workflow_step_retry_admission", "channel_workflow_steps",
      "UPDATE OF status, workflow_id", `NEW.status NOT IN ('succeeded','failed','cancelled','expired','skipped') AND ${stepArchived}`)}
    ${trigger("trg_channel_session_input_wait_admission", "user_input_requests", "INSERT", waitArchived)}
    ${trigger("trg_channel_session_input_wait_retry_admission", "user_input_requests",
      "UPDATE OF wait_status, thread_id, source_run_id", `NEW.wait_status IN ('waiting','resuming','blocked') AND ${waitArchived}`)}
  `;
}
