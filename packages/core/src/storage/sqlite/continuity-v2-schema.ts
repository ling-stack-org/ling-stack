import type { DatabaseSync } from "node:sqlite";

const LEGACY_SUFFIX = "_legacy_continuity_v2";

export function createContinuityV2Tables(database: DatabaseSync): void {
  addColumnIfMissing(database, "ling_threads", "surface_kind", "TEXT NOT NULL DEFAULT 'work'");
  addColumnIfMissing(database, "ling_threads", "relation_kind", "TEXT NOT NULL DEFAULT 'root'");
  addColumnIfMissing(database, "ling_threads", "anchor_item_id", "TEXT");
  addColumnIfMissing(database, "ling_threads", "fork_context_snapshot_id", "TEXT");
  addColumnIfMissing(database, "ling_threads", "next_item_sequence", "INTEGER NOT NULL DEFAULT 1");

  database.exec(`
    CREATE TABLE conversation_items (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      workspace_id TEXT NOT NULL,
      channel_id TEXT,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      visibility TEXT NOT NULL,
      visibility_owner_id TEXT,
      payload_json TEXT NOT NULL,
      domain_refs_json TEXT NOT NULL,
      idempotency_key TEXT,
      revision INTEGER NOT NULL,
      supersedes_item_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      committed_at TEXT,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
      FOREIGN KEY(turn_id) REFERENCES ling_turns(id) ON DELETE SET NULL,
      FOREIGN KEY(supersedes_item_id) REFERENCES conversation_items(id) ON DELETE SET NULL,
      UNIQUE(thread_id, sequence),
      UNIQUE(supersedes_item_id)
    );

    CREATE UNIQUE INDEX idx_conversation_items_thread_idempotency
    ON conversation_items(thread_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

    CREATE INDEX idx_conversation_items_turn_sequence
    ON conversation_items(turn_id, sequence);

    CREATE INDEX idx_conversation_items_channel_created
    ON conversation_items(channel_id, created_at);

    CREATE TABLE context_segments (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      state TEXT NOT NULL,
      label TEXT,
      created_from_turn_id TEXT NOT NULL,
      last_active_turn_id TEXT NOT NULL,
      merged_into_segment_id TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
      FOREIGN KEY(created_from_turn_id) REFERENCES ling_turns(id) ON DELETE CASCADE,
      FOREIGN KEY(last_active_turn_id) REFERENCES ling_turns(id) ON DELETE CASCADE,
      FOREIGN KEY(merged_into_segment_id) REFERENCES context_segments(id) ON DELETE SET NULL
    );

    CREATE INDEX idx_context_segments_thread_state_active
    ON context_segments(thread_id, state, last_active_turn_id);

    CREATE TABLE turn_context_assignments (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      decision_source TEXT NOT NULL,
      confidence REAL,
      antecedent_turn_id TEXT,
      evidence_refs_json TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      supersedes_assignment_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(turn_id) REFERENCES ling_turns(id) ON DELETE CASCADE,
      FOREIGN KEY(segment_id) REFERENCES context_segments(id) ON DELETE CASCADE,
      FOREIGN KEY(antecedent_turn_id) REFERENCES ling_turns(id) ON DELETE SET NULL,
      FOREIGN KEY(supersedes_assignment_id) REFERENCES turn_context_assignments(id) ON DELETE SET NULL,
      UNIQUE(turn_id, revision),
      UNIQUE(supersedes_assignment_id)
    );

    CREATE INDEX idx_turn_context_assignments_segment_created
    ON turn_context_assignments(segment_id, created_at);

    CREATE TABLE conversation_context_summaries (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      segment_id TEXT,
      scope TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      covered_from_sequence INTEGER NOT NULL,
      covered_through_sequence INTEGER NOT NULL,
      objective TEXT,
      decisions_json TEXT NOT NULL,
      constraints_json TEXT NOT NULL,
      open_questions_json TEXT NOT NULL,
      active_work_refs_json TEXT NOT NULL,
      source_refs_json TEXT NOT NULL,
      supersedes_summary_id TEXT,
      policy_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
      FOREIGN KEY(segment_id) REFERENCES context_segments(id) ON DELETE SET NULL,
      FOREIGN KEY(supersedes_summary_id) REFERENCES conversation_context_summaries(id) ON DELETE SET NULL,
      UNIQUE(thread_id, segment_id, version),
      UNIQUE(supersedes_summary_id)
    );

    CREATE INDEX idx_conversation_context_summaries_coverage
    ON conversation_context_summaries(thread_id, segment_id, status, covered_through_sequence);

    CREATE TABLE conversation_context_snapshots (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      projection_version TEXT NOT NULL,
      through_item_sequence INTEGER NOT NULL,
      summary_ids_json TEXT NOT NULL,
      source_refs_json TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
      FOREIGN KEY(segment_id) REFERENCES context_segments(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_conversation_context_snapshots_thread_created
    ON conversation_context_snapshots(thread_id, created_at);
  `);
}

export function renameLingTurnSourceMessageColumn(database: DatabaseSync): void {
  if (hasColumn(database, "ling_turns", "source_item_id")) return;
  if (!hasColumn(database, "ling_turns", "source_message_id")) {
    throw new Error("Continuity v2 migration requires ling_turns.source_message_id.");
  }
  database.exec("ALTER TABLE ling_turns RENAME COLUMN source_message_id TO source_item_id;");
}

export function rebuildContinuityV2ReferenceTables(database: DatabaseSync): void {
  dropLegacyReferenceIndexes(database);
  for (const table of legacyReferenceTables) {
    database.exec(`ALTER TABLE ${table} RENAME TO ${table}${LEGACY_SUFFIX};`);
  }
  createReferenceTables(database);
  copyReferenceRows(database);
  for (const table of [...legacyReferenceTables].reverse()) {
    database.exec(`DROP TABLE ${table}${LEGACY_SUFFIX};`);
  }
  createReferenceIndexes(database);
}

export function installConversationItemOutboxTriggers(database: DatabaseSync): void {
  database.exec(`
    CREATE TRIGGER trg_remote_outbox_conversation_item_insert
    AFTER INSERT ON conversation_items
    WHEN NEW.channel_id IS NOT NULL
    BEGIN
      INSERT INTO remote_projection_outbox (
        workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
        operation, affects_unread, occurred_at
      ) VALUES (
        NEW.workspace_id, 'channel', NEW.channel_id, 'conversation_item', NEW.id,
        'insert', CASE WHEN NEW.actor_type = 'local_user' THEN 0 ELSE 1 END, NEW.updated_at
      );
    END;

    CREATE TRIGGER trg_remote_outbox_conversation_item_update
    AFTER UPDATE ON conversation_items
    WHEN NEW.channel_id IS NOT NULL
    BEGIN
      INSERT INTO remote_projection_outbox (
        workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
        operation, affects_unread, occurred_at
      ) VALUES (
        NEW.workspace_id, 'channel', NEW.channel_id, 'conversation_item', NEW.id,
        'update', CASE WHEN NEW.actor_type = 'local_user' THEN 0 ELSE 1 END, NEW.updated_at
      );
    END;

    CREATE TRIGGER trg_remote_outbox_conversation_item_delete
    AFTER DELETE ON conversation_items
    WHEN OLD.channel_id IS NOT NULL
    BEGIN
      INSERT INTO remote_projection_outbox (
        workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
        operation, affects_unread, occurred_at
      ) VALUES (
        OLD.workspace_id, 'channel', OLD.channel_id, 'conversation_item', OLD.id,
        'delete', CASE WHEN OLD.actor_type = 'local_user' THEN 0 ELSE 1 END, OLD.updated_at
      );
    END;
  `);
}

export function dropLegacyContinuityTables(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE channel_context_summaries;
    DROP TABLE channel_messages;
  `);
}

function createReferenceTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE channel_attachments (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      item_id TEXT,
      kind TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES conversation_items(id) ON DELETE SET NULL
    );

    CREATE TABLE channel_link_previews (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      item_id TEXT,
      url TEXT NOT NULL,
      normalized_url TEXT NOT NULL,
      title TEXT,
      description TEXT,
      image_url TEXT,
      site_name TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES conversation_items(id) ON DELETE SET NULL
    );

    CREATE TABLE channel_decisions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      source_item_id TEXT,
      source_task_id TEXT,
      source_run_id TEXT,
      title TEXT NOT NULL,
      decision TEXT NOT NULL,
      rationale TEXT NOT NULL,
      alternatives_json TEXT NOT NULL,
      status TEXT NOT NULL,
      supersedes_decision_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY(source_item_id) REFERENCES conversation_items(id) ON DELETE SET NULL,
      FOREIGN KEY(source_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
      FOREIGN KEY(source_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL,
      FOREIGN KEY(supersedes_decision_id) REFERENCES channel_decisions(id) ON DELETE SET NULL
    );

    CREATE TABLE channel_handoffs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      source_item_id TEXT,
      source_task_id TEXT,
      source_run_id TEXT,
      from_participant_id TEXT NOT NULL,
      from_participant_label TEXT NOT NULL,
      to_participant_id TEXT NOT NULL,
      to_participant_label TEXT NOT NULL,
      reason TEXT NOT NULL,
      required_input TEXT NOT NULL,
      expected_output TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY(source_item_id) REFERENCES conversation_items(id) ON DELETE SET NULL,
      FOREIGN KEY(source_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
      FOREIGN KEY(source_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
    );

    CREATE TABLE channel_execution_proposals (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      proposed_by_teammate_id TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      assignee_teammate_id TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL,
      collaboration_steps_json TEXT NOT NULL,
      required_tools_json TEXT NOT NULL,
      risk_summary TEXT,
      response_language TEXT,
      shaping_json TEXT,
      status TEXT NOT NULL,
      linked_task_id TEXT,
      linked_run_id TEXT,
      linked_workflow_id TEXT,
      error_message TEXT,
      blocker_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY(source_item_id) REFERENCES conversation_items(id) ON DELETE CASCADE,
      FOREIGN KEY(linked_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
      FOREIGN KEY(linked_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
    );

    CREATE TABLE channel_intent_decisions (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      action TEXT NOT NULL,
      selected_teammate_id TEXT,
      selected_teammate_ids_json TEXT,
      proposal_id TEXT,
      reply_item_id TEXT,
      reply_item_ids_json TEXT,
      workflow_id TEXT,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY(source_item_id) REFERENCES conversation_items(id) ON DELETE CASCADE,
      FOREIGN KEY(proposal_id) REFERENCES channel_execution_proposals(id) ON DELETE SET NULL,
      FOREIGN KEY(reply_item_id) REFERENCES conversation_items(id) ON DELETE SET NULL,
      FOREIGN KEY(workflow_id) REFERENCES channel_workflows(id) ON DELETE SET NULL
    );

    CREATE TABLE channel_message_route_decisions (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      reply_item_id TEXT,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      selected_teammate_id TEXT,
      selected_provider_preset_id TEXT,
      confidence REAL,
      reason TEXT NOT NULL,
      alternatives_json TEXT NOT NULL,
      context_pack_json TEXT,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY(source_item_id) REFERENCES conversation_items(id) ON DELETE CASCADE,
      FOREIGN KEY(reply_item_id) REFERENCES conversation_items(id) ON DELETE SET NULL
    );

    CREATE TABLE channel_workflow_steps (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      source_handoff_id TEXT,
      context_summary_id TEXT,
      task_id TEXT,
      run_id TEXT,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      to_participant_id TEXT NOT NULL,
      to_participant_label TEXT NOT NULL,
      status TEXT NOT NULL,
      blocker TEXT,
      result_summary TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY(workflow_id) REFERENCES channel_workflows(id) ON DELETE CASCADE,
      FOREIGN KEY(source_handoff_id) REFERENCES channel_handoffs(id) ON DELETE SET NULL,
      FOREIGN KEY(context_summary_id) REFERENCES conversation_context_summaries(id) ON DELETE SET NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL,
      FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
    );
  `);
}

function copyReferenceRows(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO channel_attachments
    SELECT id, workspace_id, channel_id, message_id, kind, file_name, content_type,
           size_bytes, path, created_at
    FROM channel_attachments${LEGACY_SUFFIX};

    INSERT INTO channel_link_previews
    SELECT id, workspace_id, channel_id, message_id, url, normalized_url, title,
           description, image_url, site_name, status, error_message, created_at, updated_at
    FROM channel_link_previews${LEGACY_SUFFIX};

    INSERT INTO channel_decisions
    SELECT id, workspace_id, channel_id, source_message_id, source_task_id, source_run_id,
           title, decision, rationale, alternatives_json, status, supersedes_decision_id,
           created_by, created_at, updated_at
    FROM channel_decisions${LEGACY_SUFFIX};

    INSERT INTO channel_handoffs
    SELECT id, workspace_id, channel_id, source_message_id, source_task_id, source_run_id,
           from_participant_id, from_participant_label, to_participant_id,
           to_participant_label, reason, required_input, expected_output, status,
           created_by, created_at, updated_at
    FROM channel_handoffs${LEGACY_SUFFIX};

    INSERT INTO channel_execution_proposals
    SELECT id, workspace_id, channel_id, source_message_id, proposed_by_teammate_id,
           title, prompt, assignee_teammate_id, acceptance_criteria_json,
           collaboration_steps_json, required_tools_json, risk_summary, response_language,
           shaping_json, status, linked_task_id, linked_run_id, linked_workflow_id,
           error_message, NULL AS blocker_json, created_at, updated_at
    FROM channel_execution_proposals${LEGACY_SUFFIX};

    INSERT INTO channel_intent_decisions
    SELECT id, schema_version, workspace_id, channel_id, source_message_id, action,
           selected_teammate_id, selected_teammate_ids_json, proposal_id, reply_message_id,
           reply_message_ids_json, workflow_id, reason, status, created_by, error_message,
           created_at, updated_at
    FROM channel_intent_decisions${LEGACY_SUFFIX};

    INSERT INTO channel_message_route_decisions
    SELECT id, schema_version, workspace_id, channel_id, source_message_id,
           reply_message_id, mode, action, selected_teammate_id,
           selected_provider_preset_id, confidence, reason, alternatives_json,
           context_pack_json, status, created_by, error_message, created_at, updated_at
    FROM channel_message_route_decisions${LEGACY_SUFFIX};

    INSERT INTO channel_workflow_steps
    SELECT id, workspace_id, channel_id, workflow_id, source_handoff_id,
           CASE WHEN context_summary_id IN (SELECT id FROM conversation_context_summaries)
             THEN context_summary_id ELSE NULL END,
           task_id, run_id, position, title, prompt, to_participant_id,
           to_participant_label, status, blocker, result_summary, metadata_json,
           created_at, updated_at
    FROM channel_workflow_steps${LEGACY_SUFFIX};
  `);
}

function dropLegacyReferenceIndexes(database: DatabaseSync): void {
  for (const index of legacyReferenceIndexes) {
    database.exec(`DROP INDEX IF EXISTS ${index};`);
  }
}

function createReferenceIndexes(database: DatabaseSync): void {
  database.exec(`
    CREATE INDEX idx_channel_attachments_channel_created
    ON channel_attachments(channel_id, created_at);
    CREATE INDEX idx_channel_link_previews_channel_created
    ON channel_link_previews(channel_id, created_at);
    CREATE UNIQUE INDEX idx_channel_link_previews_channel_url
    ON channel_link_previews(channel_id, normalized_url);
    CREATE INDEX idx_channel_decisions_channel_created
    ON channel_decisions(channel_id, created_at);
    CREATE INDEX idx_channel_decisions_channel_status_created
    ON channel_decisions(channel_id, status, created_at);
    CREATE UNIQUE INDEX idx_channel_decisions_supersedes_unique
    ON channel_decisions(supersedes_decision_id)
    WHERE supersedes_decision_id IS NOT NULL;
    CREATE INDEX idx_channel_handoffs_channel_status_created
    ON channel_handoffs(channel_id, status, created_at);
    CREATE INDEX idx_channel_execution_proposals_channel_created
    ON channel_execution_proposals(channel_id, created_at);
    CREATE INDEX idx_channel_execution_proposals_source
    ON channel_execution_proposals(source_item_id);
    CREATE INDEX idx_channel_execution_proposals_status
    ON channel_execution_proposals(channel_id, status, updated_at);
    CREATE INDEX idx_channel_intent_decisions_channel_created
    ON channel_intent_decisions(workspace_id, channel_id, created_at);
    CREATE INDEX idx_channel_intent_decisions_source
    ON channel_intent_decisions(workspace_id, source_item_id);
    CREATE INDEX idx_channel_intent_decisions_status
    ON channel_intent_decisions(workspace_id, channel_id, status, updated_at);
    CREATE INDEX idx_channel_message_route_decisions_source
    ON channel_message_route_decisions(source_item_id, created_at);
    CREATE INDEX idx_channel_message_route_decisions_channel
    ON channel_message_route_decisions(channel_id, created_at);
    CREATE INDEX idx_channel_message_route_decisions_status
    ON channel_message_route_decisions(channel_id, status, updated_at);
    CREATE INDEX idx_channel_workflow_steps_workflow_position
    ON channel_workflow_steps(workflow_id, position);
    CREATE INDEX idx_channel_workflow_steps_channel_status
    ON channel_workflow_steps(channel_id, status, updated_at);
    CREATE INDEX idx_channel_workflow_steps_task
    ON channel_workflow_steps(task_id);
    CREATE INDEX idx_channel_workflow_steps_run
    ON channel_workflow_steps(run_id);
  `);
}

function addColumnIfMissing(database: DatabaseSync, table: string, column: string, definition: string): void {
  if (!hasColumn(database, table, column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return database.prepare(`PRAGMA table_info(${table})`).all().some((row) => {
    return typeof row === "object" && row !== null && "name" in row && row.name === column;
  });
}

const legacyReferenceTables = [
  "channel_attachments",
  "channel_link_previews",
  "channel_decisions",
  "channel_handoffs",
  "channel_execution_proposals",
  "channel_intent_decisions",
  "channel_message_route_decisions",
  "channel_workflow_steps",
] as const;

const legacyReferenceIndexes = [
  "idx_channel_attachments_channel_created",
  "idx_channel_link_previews_channel_created",
  "idx_channel_link_previews_channel_url",
  "idx_channel_decisions_channel_created",
  "idx_channel_decisions_channel_status_created",
  "idx_channel_decisions_supersedes_unique",
  "idx_channel_handoffs_channel_status_created",
  "idx_channel_execution_proposals_channel_created",
  "idx_channel_execution_proposals_source",
  "idx_channel_execution_proposals_status",
  "idx_channel_intent_decisions_channel_created",
  "idx_channel_intent_decisions_source",
  "idx_channel_intent_decisions_status",
  "idx_channel_message_route_decisions_source",
  "idx_channel_message_route_decisions_channel",
  "idx_channel_message_route_decisions_status",
  "idx_channel_workflow_steps_workflow_position",
  "idx_channel_workflow_steps_channel_status",
  "idx_channel_workflow_steps_task",
  "idx_channel_workflow_steps_run",
] as const;
