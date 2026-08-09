import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { importLegacyConversationContext } from "./continuity-v2-context-import.js";
import { importLegacyConversationItems } from "./continuity-v2-item-import.js";
import {
  CONTINUITY_V2_IMPORT_POLICY_VERSION,
  continuityV2ImportId,
  insertContinuitySyntheticTurn,
  legacyContinuityTitle,
  requiredContinuityMapValue,
  type ContinuityV2LegacyImportReport,
  type ContinuityV2ThreadTopology,
  type LegacyContinuityMessage,
} from "./continuity-v2-legacy-types.js";
import {
  parseJsonStringArray,
  readNullableString,
  readNumber,
  readString,
  stringifyJson,
} from "./helpers.js";

export type { ContinuityV2LegacyImportReport } from "./continuity-v2-legacy-types.js";

export function importLegacyConversationContinuity(
  database: DatabaseSync,
  migrationTimestamp: string,
): ContinuityV2LegacyImportReport {
  const messages = readLegacyMessages(database);
  const turnCountBefore = countRows(database, "ling_turns");
  const topology = materializeThreadTopology(database, messages);
  const replyToSource = readReplyToSourceMap(database);
  const turnByMessage = materializeTurns(database, messages, topology, replyToSource);
  const importedItemCount = importLegacyConversationItems(database, messages, topology, turnByMessage);
  materializeThreadLineage(database, messages, topology, turnByMessage);
  const { segmentCount, assignmentCount, summaryCount, invalidatedSummaryCount } =
    importLegacyConversationContext(database, topology, migrationTimestamp);

  return {
    legacyMessageCount: messages.length,
    importedItemCount,
    importedTurnCount: countRows(database, "ling_turns") - turnCountBefore,
    rootThreadCount: countThreads(database, "channel_root"),
    topicThreadCount: countThreads(database, "topic"),
    branchThreadCount: countThreads(database, "branch"),
    segmentCount,
    assignmentCount,
    summaryCount,
    invalidatedSummaryCount,
  };
}

function materializeThreadTopology(
  database: DatabaseSync,
  messages: readonly LegacyContinuityMessage[],
): ContinuityV2ThreadTopology {
  database.exec(`
    UPDATE ling_threads
    SET surface_kind = CASE
          WHEN kind IN ('conversation', 'teammate_direct') THEN 'direct'
          ELSE 'work'
        END,
        relation_kind = 'root',
        anchor_item_id = NULL,
        fork_context_snapshot_id = NULL,
        next_item_sequence = 1;
  `);

  const branchRows = database.prepare(`
    SELECT channel_id, root_thread_id, created_at
    FROM channel_branches
    WHERE root_thread_id IS NOT NULL AND deleted_at IS NULL
    ORDER BY created_at ASC, id ASC
  `).all() as Record<string, SQLOutputValue>[];
  const branchThreadIds = new Set(branchRows.map((row) => readString(row, "root_thread_id")));
  const rootByChannel = new Map<string, string>();
  const channels = database.prepare(`
    SELECT id, workspace_id, name, status, created_at, updated_at
    FROM channels
    ORDER BY created_at ASC, id ASC
  `).all() as Record<string, SQLOutputValue>[];

  for (const channel of channels) {
    const channelId = readString(channel, "id");
    const candidates = (database.prepare(`
      SELECT id, created_at
      FROM ling_threads
      WHERE channel_id = ?
        AND kind = 'channel_discussion'
        AND status <> 'archived'
        AND archived_at IS NULL
        AND parent_thread_id IS NULL
        AND task_id IS NULL
        AND teammate_id IS NULL
        AND workflow_id IS NULL
        AND workflow_step_id IS NULL
        AND external_work_id IS NULL
      ORDER BY CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END, created_at ASC, id ASC
    `).all(channelId) as Record<string, SQLOutputValue>[])
      .filter((row) => !branchThreadIds.has(readString(row, "id")));
    const rootThreadId = candidates[0]
      ? readString(candidates[0], "id")
      : insertImportedThread(database, {
        id: continuityV2ImportId("thread_root", channelId),
        workspaceId: readString(channel, "workspace_id"),
        channelId,
        title: `${readString(channel, "name")} conversation`,
        objective: `Imported root conversation for ${readString(channel, "name")}.`,
        surfaceKind: "channel_root",
        relationKind: "root",
        createdAt: readString(channel, "created_at"),
        updatedAt: readString(channel, "updated_at"),
      });
    rootByChannel.set(channelId, rootThreadId);
    database.prepare(`
      UPDATE ling_threads
      SET surface_kind = 'channel_root', relation_kind = 'root',
          parent_thread_id = NULL, parent_turn_id = NULL,
          anchor_item_id = NULL, fork_context_snapshot_id = NULL
      WHERE id = ?
    `).run(rootThreadId);
  }

  for (const branch of branchRows) {
    const branchThreadId = readString(branch, "root_thread_id");
    const channelId = readString(branch, "channel_id");
    const rootThreadId = requiredContinuityMapValue(rootByChannel, channelId, "channel root");
    const updated = database.prepare(`
      UPDATE ling_threads
      SET surface_kind = 'branch', relation_kind = 'branch',
          parent_thread_id = COALESCE(parent_thread_id, ?),
          anchor_item_id = NULL
      WHERE id = ? AND channel_id = ?
    `).run(rootThreadId, branchThreadId, channelId);
    if (updated.changes !== 1) {
      throw new Error(`Continuity v2 migration found an invalid branch root thread: ${branchThreadId}`);
    }
  }

  const threadRows = database.prepare("SELECT id, channel_id FROM ling_threads").all() as Record<string, SQLOutputValue>[];
  const threadChannelById = new Map(threadRows.map((row) => [
    readString(row, "id"),
    readNullableString(row, "channel_id"),
  ]));
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const targetThreadByMessageId = new Map<string, string>();
  const topicThreadByAnchorItemId = new Map<string, string>();

  const resolveTarget = (messageId: string, visiting = new Set<string>()): string => {
    const cached = targetThreadByMessageId.get(messageId);
    if (cached) return cached;
    const message = messageById.get(messageId);
    if (!message) throw new Error(`Continuity v2 migration cannot resolve legacy message: ${messageId}`);
    if (visiting.has(messageId)) {
      throw new Error(`Continuity v2 migration found a cyclic message topic: ${messageId}`);
    }
    visiting.add(messageId);
    let targetThreadId: string;
    if (!message.legacyThreadId) {
      targetThreadId = requiredContinuityMapValue(rootByChannel, message.channelId, "channel root");
    } else if (threadChannelById.has(message.legacyThreadId)) {
      const threadChannelId = threadChannelById.get(message.legacyThreadId);
      if (threadChannelId !== message.channelId) {
        throw new Error(`Continuity v2 migration found a cross-channel thread reference: ${message.id}`);
      }
      targetThreadId = message.legacyThreadId;
    } else if (messageById.has(message.legacyThreadId)) {
      const anchorId = message.legacyThreadId;
      const anchor = messageById.get(anchorId)!;
      if (anchor.channelId !== message.channelId) {
        throw new Error(`Continuity v2 migration found a cross-channel topic anchor: ${message.id}`);
      }
      let topicThreadId = topicThreadByAnchorItemId.get(anchorId);
      if (!topicThreadId) {
        const parentThreadId = resolveTarget(anchorId, visiting);
        topicThreadId = continuityV2ImportId("thread_topic", anchorId);
        insertImportedThread(database, {
          id: topicThreadId,
          workspaceId: message.workspaceId,
          channelId: message.channelId,
          title: legacyContinuityTitle(anchor.body, "Imported topic"),
          objective: `Imported topic anchored at conversation item ${anchorId}.`,
          surfaceKind: "topic",
          relationKind: "topic",
          parentThreadId,
          anchorItemId: anchorId,
          createdAt: anchor.createdAt,
          updatedAt: anchor.updatedAt,
        });
        topicThreadByAnchorItemId.set(anchorId, topicThreadId);
        threadChannelById.set(topicThreadId, message.channelId);
      }
      targetThreadId = topicThreadId;
    } else {
      throw new Error(`Continuity v2 migration found an orphan legacy thread reference: ${message.legacyThreadId}`);
    }
    visiting.delete(messageId);
    targetThreadByMessageId.set(messageId, targetThreadId);
    return targetThreadId;
  };
  for (const message of messages) resolveTarget(message.id);

  database.exec(`
    CREATE UNIQUE INDEX idx_ling_threads_active_channel_root
    ON ling_threads(channel_id)
    WHERE surface_kind = 'channel_root' AND archived_at IS NULL;

    CREATE UNIQUE INDEX idx_ling_threads_active_topic_anchor
    ON ling_threads(anchor_item_id)
    WHERE surface_kind = 'topic' AND archived_at IS NULL;
  `);

  return {
    rootByChannel,
    threadChannelById,
    targetThreadByMessageId,
    topicThreadByAnchorItemId,
    branchThreadIds,
  };
}

function materializeTurns(
  database: DatabaseSync,
  messages: readonly LegacyContinuityMessage[],
  topology: ContinuityV2ThreadTopology,
  replyToSource: ReadonlyMap<string, string>,
): Map<string, string> {
  const turnByMessage = new Map<string, string>();
  const existingTurns = database.prepare(`
    SELECT id, thread_id, source_message_id, created_at
    FROM ling_turns
    WHERE source_message_id IS NOT NULL
    ORDER BY created_at ASC, id ASC
  `).all() as Record<string, SQLOutputValue>[];
  const turnsBySource = new Map<string, Record<string, SQLOutputValue>[] >();
  for (const turn of existingTurns) {
    const sourceId = readString(turn, "source_message_id");
    const group = turnsBySource.get(sourceId) ?? [];
    group.push(turn);
    turnsBySource.set(sourceId, group);
  }

  for (const message of messages.filter((item) => item.authorType === "local-user")) {
    const targetThreadId = requiredContinuityMapValue(topology.targetThreadByMessageId, message.id, "message thread");
    const existing = turnsBySource.get(message.id)?.[0];
    const turnId = existing
      ? readString(existing, "id")
      : insertImportedTurn(database, message, targetThreadId, "local-user");
    if (existing && readString(existing, "thread_id") !== targetThreadId) {
      moveTurnToThread(database, turnId, targetThreadId, message.channelId);
    }
    turnByMessage.set(message.id, turnId);
  }

  for (const message of messages.filter((item) => item.authorType !== "local-user")) {
    const targetThreadId = requiredContinuityMapValue(topology.targetThreadByMessageId, message.id, "message thread");
    const sourceMessageId = replyToSource.get(message.id);
    const sourceTurnId = sourceMessageId ? turnByMessage.get(sourceMessageId) : undefined;
    const sourceTargetThreadId = sourceMessageId
      ? topology.targetThreadByMessageId.get(sourceMessageId)
      : undefined;
    const existing = turnsBySource.get(message.id)?.[0];
    const turnId = sourceTurnId && sourceTargetThreadId === targetThreadId
      ? sourceTurnId
      : existing
        ? readString(existing, "id")
        : insertImportedTurn(database, message, targetThreadId, "system");
    if (existing && readString(existing, "thread_id") !== targetThreadId) {
      moveTurnToThread(database, turnId, targetThreadId, message.channelId);
    }
    turnByMessage.set(message.id, turnId);
  }

  for (const message of messages) {
    if (message.linkedRunId) {
      moveRunToTurn(database, message.linkedRunId, requiredContinuityMapValue(turnByMessage, message.id, "message turn"));
    }
  }
  return turnByMessage;
}

function materializeThreadLineage(
  database: DatabaseSync,
  messages: readonly LegacyContinuityMessage[],
  topology: ContinuityV2ThreadTopology,
  turnByMessage: ReadonlyMap<string, string>,
): void {
  for (const [anchorItemId, topicThreadId] of topology.topicThreadByAnchorItemId) {
    const parentTurnId = requiredContinuityMapValue(turnByMessage, anchorItemId, "topic parent turn");
    database.prepare("UPDATE ling_threads SET parent_turn_id = ? WHERE id = ?").run(parentTurnId, topicThreadId);
  }

  for (const branchThreadId of topology.branchThreadIds) {
    const thread = database.prepare("SELECT channel_id, parent_thread_id, created_at FROM ling_threads WHERE id = ?")
      .get(branchThreadId) as Record<string, SQLOutputValue> | undefined;
    if (!thread) continue;
    const parentThreadId = readNullableString(thread, "parent_thread_id")
      ?? requiredContinuityMapValue(topology.rootByChannel, readString(thread, "channel_id"), "branch parent thread");
    const parentTurn = database.prepare(`
      SELECT id
      FROM ling_turns
      WHERE thread_id = ? AND created_at <= ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(parentThreadId, readString(thread, "created_at")) as Record<string, SQLOutputValue> | undefined;
    const parentTurnId = parentTurn
      ? readString(parentTurn, "id")
      : insertContinuitySyntheticTurn(
        database,
        parentThreadId,
        readString(thread, "channel_id"),
        `branch_parent:${branchThreadId}`,
        readString(thread, "created_at"),
      );
    database.prepare(`
      UPDATE ling_threads
      SET parent_thread_id = ?, parent_turn_id = ?
      WHERE id = ?
    `).run(parentThreadId, parentTurnId, branchThreadId);
  }

  void messages;
}

function readLegacyMessages(database: DatabaseSync): LegacyContinuityMessage[] {
  return (database.prepare(`
    SELECT rowid AS legacy_rowid, *
    FROM channel_messages
    ORDER BY created_at ASC, rowid ASC
  `).all() as Record<string, SQLOutputValue>[]).map((row) => ({
    rowid: readNumber(row, "legacy_rowid"),
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    legacyThreadId: readNullableString(row, "thread_id"),
    kind: readString(row, "kind"),
    authorType: readString(row, "author_type"),
    authorId: readNullableString(row, "author_id"),
    body: readString(row, "body"),
    mentionsJson: readString(row, "mentions_json"),
    attachmentIdsJson: readString(row, "attachment_ids_json"),
    linkPreviewIdsJson: readString(row, "link_preview_ids_json"),
    fileRefsJson: readString(row, "file_refs_json"),
    linkedTaskId: readNullableString(row, "linked_task_id"),
    linkedRunId: readNullableString(row, "linked_run_id"),
    status: readString(row, "status"),
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  }));
}

function readReplyToSourceMap(database: DatabaseSync): Map<string, string> {
  const result = new Map<string, string>();
  const rows = database.prepare(`
    SELECT source_message_id, reply_message_id, reply_message_ids_json, created_at
    FROM channel_intent_decisions
    UNION ALL
    SELECT source_message_id, reply_message_id, NULL AS reply_message_ids_json, created_at
    FROM channel_message_route_decisions
    ORDER BY created_at ASC
  `).all() as Record<string, SQLOutputValue>[];
  for (const row of rows) {
    const sourceMessageId = readString(row, "source_message_id");
    const replyMessageId = readNullableString(row, "reply_message_id");
    if (replyMessageId) result.set(replyMessageId, sourceMessageId);
    const replyIdsJson = readNullableString(row, "reply_message_ids_json");
    for (const replyId of replyIdsJson ? parseJsonStringArray(replyIdsJson) : []) {
      result.set(replyId, sourceMessageId);
    }
  }
  return result;
}

function insertImportedThread(database: DatabaseSync, input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly title: string;
  readonly objective: string;
  readonly surfaceKind: "channel_root" | "topic";
  readonly relationKind: "root" | "topic";
  readonly parentThreadId?: string;
  readonly anchorItemId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}): string {
  database.prepare(`
    INSERT INTO ling_threads (
      id, workspace_id, kind, channel_id, task_id, teammate_id, workflow_id,
      workflow_step_id, external_work_id, title, objective, status, active_run_id,
      last_run_id, parent_thread_id, parent_turn_id, forked_from_run_id, metadata_json,
      conversation_mode, conversation_mode_updated_at, created_at, updated_at,
      pinned_at, archived_at, archived_reason, surface_kind, relation_kind,
      anchor_item_id, fork_context_snapshot_id, next_item_sequence
    ) VALUES (?, ?, 'channel_discussion', ?, NULL, NULL, NULL, NULL, NULL, ?, ?, 'open',
      NULL, NULL, ?, NULL, NULL, ?, 'default', NULL, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, 1)
  `).run(
    input.id,
    input.workspaceId,
    input.channelId,
    input.title,
    input.objective,
    input.parentThreadId ?? null,
    stringifyJson({ importedBy: CONTINUITY_V2_IMPORT_POLICY_VERSION }),
    input.createdAt,
    input.updatedAt,
    input.surfaceKind,
    input.relationKind,
    input.anchorItemId ?? null,
  );
  return input.id;
}

function insertImportedTurn(
  database: DatabaseSync,
  message: LegacyContinuityMessage,
  threadId: string,
  createdByActor: "local-user" | "system",
): string {
  const turnId = continuityV2ImportId("turn", `${threadId}:${message.id}`);
  database.prepare(`
    INSERT INTO ling_turns (
      id, workspace_id, thread_id, kind, status, title, user_instruction, channel_id,
      task_id, teammate_id, workflow_step_id, external_work_id, automation_id,
      source_message_id, source_turn_id, intervention_id, active_run_id, last_run_id,
      created_by_actor, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, 'initial_request', ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, NULL,
      NULL, NULL, ?, ?, ?, ?, ?)
  `).run(
    turnId,
    message.workspaceId,
    threadId,
    message.status === "pending" ? "open" : message.status === "failed" ? "failed" : "succeeded",
    legacyContinuityTitle(message.body, createdByActor === "local-user" ? "Imported request" : "Imported response"),
    message.body || "Imported legacy channel event.",
    message.channelId,
    message.authorType === "ai-teammate" ? message.authorId ?? null : null,
    message.id,
    message.linkedRunId ?? null,
    createdByActor,
    message.createdAt,
    message.updatedAt,
    message.status === "pending" ? null : message.updatedAt,
  );
  return turnId;
}

function moveTurnToThread(database: DatabaseSync, turnId: string, threadId: string, channelId: string): void {
  database.prepare(`
    UPDATE ling_turns
    SET thread_id = ?, channel_id = ?, source_turn_id = NULL
    WHERE id = ?
  `).run(threadId, channelId, turnId);
  database.prepare(`
    UPDATE run_sessions
    SET thread_id = ?
    WHERE id IN (SELECT run_id FROM ling_turn_runs WHERE turn_id = ?)
  `).run(threadId, turnId);
}

function moveRunToTurn(database: DatabaseSync, runId: string, targetTurnId: string): void {
  const link = database.prepare(`
    SELECT turn_id, attempt_number, role, created_at
    FROM ling_turn_runs
    WHERE run_id = ?
  `).get(runId) as Record<string, SQLOutputValue> | undefined;
  if (!link) return;
  const sourceTurnId = readString(link, "turn_id");
  if (sourceTurnId === targetTurnId) return;
  const target = database.prepare("SELECT thread_id FROM ling_turns WHERE id = ?").get(targetTurnId) as
    | Record<string, SQLOutputValue>
    | undefined;
  if (!target) throw new Error(`Continuity v2 migration cannot move run to missing turn: ${targetTurnId}`);
  const nextAttempt = database.prepare("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt FROM ling_turn_runs WHERE turn_id = ?")
    .get(targetTurnId) as Record<string, SQLOutputValue>;
  database.prepare("DELETE FROM ling_turn_runs WHERE run_id = ?").run(runId);
  database.prepare(`
    INSERT INTO ling_turn_runs (turn_id, run_id, attempt_number, role, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    targetTurnId,
    runId,
    readNumber(nextAttempt, "attempt"),
    readString(link, "role"),
    readString(link, "created_at"),
  );
  database.prepare("UPDATE run_sessions SET thread_id = ? WHERE id = ?")
    .run(readString(target, "thread_id"), runId);
  database.prepare(`
    UPDATE ling_turns
    SET active_run_id = CASE WHEN active_run_id = ? THEN NULL ELSE active_run_id END,
        last_run_id = CASE WHEN last_run_id = ? THEN NULL ELSE last_run_id END,
        status = CASE
          WHEN NOT EXISTS (SELECT 1 FROM ling_turn_runs WHERE turn_id = ling_turns.id)
            AND status IN ('running', 'waiting_for_approval') THEN 'succeeded'
          ELSE status
        END,
        completed_at = CASE
          WHEN NOT EXISTS (SELECT 1 FROM ling_turn_runs WHERE turn_id = ling_turns.id)
            AND status IN ('running', 'waiting_for_approval')
            THEN COALESCE(completed_at, (SELECT updated_at FROM run_sessions WHERE id = ?))
          ELSE completed_at
        END
    WHERE id = ?
  `).run(runId, runId, runId, sourceTurnId);
  const run = database.prepare("SELECT status FROM run_sessions WHERE id = ?").get(runId) as
    | Record<string, SQLOutputValue>
    | undefined;
  const runStatus = run ? readString(run, "status") : undefined;
  database.prepare(`
    UPDATE ling_turns
    SET last_run_id = ?,
        active_run_id = CASE WHEN ? IN ('queued', 'running', 'waiting_for_approval') THEN ? ELSE NULL END,
        status = CASE
          WHEN ? = 'waiting_for_approval' THEN 'waiting_for_approval'
          WHEN ? IN ('queued', 'running') THEN 'running'
          WHEN ? = 'succeeded' THEN 'succeeded'
          WHEN ? = 'failed' THEN 'failed'
          WHEN ? = 'cancelled' THEN 'cancelled'
          ELSE status
        END,
        completed_at = CASE
          WHEN ? IN ('queued', 'running', 'waiting_for_approval') THEN NULL
          WHEN ? IN ('succeeded', 'failed', 'cancelled')
            THEN COALESCE(completed_at, (SELECT updated_at FROM run_sessions WHERE id = ?))
          ELSE completed_at
        END
    WHERE id = ?
  `).run(
    runId,
    runStatus ?? null,
    runId,
    runStatus ?? null,
    runStatus ?? null,
    runStatus ?? null,
    runStatus ?? null,
    runStatus ?? null,
    runStatus ?? null,
    runStatus ?? null,
    runId,
    targetTurnId,
  );
}

function countRows(database: DatabaseSync, table: string): number {
  return readNumber(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, SQLOutputValue>, "count");
}

function countThreads(database: DatabaseSync, surfaceKind: string): number {
  return readNumber(database.prepare("SELECT COUNT(*) AS count FROM ling_threads WHERE surface_kind = ?").get(surfaceKind) as Record<string, SQLOutputValue>, "count");
}
