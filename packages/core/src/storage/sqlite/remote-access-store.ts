import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import {
  REMOTE_CONVERSATION_AUTHORITY_CONTEXT,
  RemoteCommandIdempotencyConflictError,
  RemoteCommandRetryWindowExpiredError,
  RemoteConversationNotFoundError,
  type CommitRemoteConversationSendInput,
  type CommitRemoteConversationSendResult,
  type ConversationReadState,
  type ListRemoteDispatchIntentsOptions,
  type ListRemoteProjectionOutboxOptions,
  type MarkConversationReadInput,
  type RemoteCommandReceipt,
  type RemoteCommandTerminalOutcome,
  type RemoteConversationActivityInput,
  type RemoteConversationKind,
  type RemoteDispatchIntent,
  type RemoteProjectionEntityVersion,
  type RemoteProjectionEntityVersionInput,
  type RemoteProjectionOutboxRecord,
} from "../../remote-access-types.js";
import { redactSecrets } from "../../redaction.js";
import {
  parseJson,
  readBoolean,
  readNullableString,
  readNumber,
  readString,
  stringifyJson,
} from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

const REMOTE_COMMAND_TYPE = "conversation.send_text";
const MAX_REMOTE_TEXT_BYTES = 32 * 1024;
const MAX_RETRY_WINDOW_MS = 24 * 60 * 60_000;
const TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60_000;

export class SqliteRemoteAccessStore {
  constructor(private readonly context: SqliteStoreContext) {}

  commitRemoteConversationSend(input: CommitRemoteConversationSendInput, now: string): CommitRemoteConversationSendResult {
    this.assertSendInput(input, now);
    const existing = this.getRemoteCommandReceipt(input.commandId);
    if (existing) {
      return this.replaySend(existing, input);
    }

    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const concurrent = this.getRemoteCommandReceipt(input.commandId);
      if (concurrent) {
        const replay = this.replaySend(concurrent, input);
        this.context.database.exec("COMMIT");
        return replay;
      }

      this.assertConversationExists(input.workspaceId, input.conversationKind, input.conversationId);
      const identityDigest = createHash("sha256").update(input.commandId).digest("hex").slice(0, 32);
      const messageId = `remote_msg_${identityDigest}`;
      const dispatchIntentId = `remote_dispatch_${identityDigest}`;

      this.context.database.prepare(`
        INSERT INTO remote_command_receipts (
          command_id, workspace_id, device_id, command_type, body_hash, receipt_state,
          status, issued_at, retry_until, terminal_json, message_id, dispatch_intent_id,
          created_at, updated_at, compacted_at
        ) VALUES (?, ?, ?, ?, ?, 'full', 'pending', ?, ?, NULL, NULL, NULL, ?, ?, NULL)
      `).run(
        input.commandId,
        input.workspaceId,
        input.deviceId,
        REMOTE_COMMAND_TYPE,
        input.bodyHash,
        input.issuedAt,
        input.retryUntil,
        now,
        now,
      );

      this.insertConversationMessage(input, messageId, now);
      this.insertDispatchIntent(input, dispatchIntentId, messageId, now);
      const terminalOutcome: RemoteCommandTerminalOutcome = {
        kind: "completed",
        result: {
          kind: "message_created",
          conversationId: input.conversationId,
          messageId,
        },
      };
      this.context.database.prepare(`
        UPDATE remote_command_receipts
        SET status = 'completed', terminal_json = ?, message_id = ?, dispatch_intent_id = ?, updated_at = ?
        WHERE command_id = ?
      `).run(stringifyJson(terminalOutcome), messageId, dispatchIntentId, now, input.commandId);

      const receipt = this.getRemoteCommandReceipt(input.commandId);
      const dispatchIntent = this.getDispatchIntent(dispatchIntentId);
      if (!receipt || !dispatchIntent) {
        throw new Error(`Failed to commit remote command: ${input.commandId}`);
      }
      this.context.database.exec("COMMIT");
      return { receipt, dispatchIntent, messageId, idempotentReplay: false };
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  getRemoteCommandReceipt(commandId: string): RemoteCommandReceipt | undefined {
    const row = this.context.database.prepare(`
      SELECT * FROM remote_command_receipts WHERE command_id = ?
    `).get(commandId);
    return row ? mapRemoteCommandReceipt(row as Record<string, SQLOutputValue>) : undefined;
  }

  compactRemoteCommandReceipts(now: string): { readonly compacted: number; readonly purged: number } {
    const nowMs = parseTimestamp(now, "now");
    const tombstoneCutoff = new Date(nowMs - TOMBSTONE_RETENTION_MS).toISOString();
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const compacted = this.context.database.prepare(`
        UPDATE remote_command_receipts
        SET receipt_state = 'tombstone', compacted_at = ?, updated_at = ?
        WHERE receipt_state = 'full'
          AND status IN ('completed', 'failed')
          AND retry_until < ?
      `).run(now, now, now);
      const purged = this.context.database.prepare(`
        DELETE FROM remote_command_receipts
        WHERE receipt_state = 'tombstone'
          AND compacted_at <= ?
          AND retry_until <= ?
      `).run(tombstoneCutoff, tombstoneCutoff);
      this.context.database.exec("COMMIT");
      return { compacted: Number(compacted.changes), purged: Number(purged.changes) };
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  listRemoteDispatchIntents(options: ListRemoteDispatchIntentsOptions = {}): RemoteDispatchIntent[] {
    const clauses = ["1 = 1"];
    const params: (string | number)[] = [];
    if (options.workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(options.workspaceId);
    }
    if (options.conversationKind) {
      clauses.push("conversation_kind = ?");
      params.push(options.conversationKind);
    }
    if (options.conversationId) {
      clauses.push("conversation_id = ?");
      params.push(options.conversationId);
    }
    if (options.statuses && options.statuses.length > 0) {
      const statuses = [...new Set(options.statuses)];
      clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    params.push(Math.min(Math.max(options.limit ?? 200, 1), 500));
    return this.context.database.prepare(`
      SELECT * FROM remote_dispatch_intents
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(...params).map((row) => mapRemoteDispatchIntent(row as Record<string, SQLOutputValue>));
  }

  claimRemoteDispatchIntent(
    intentId: string,
    input: { readonly workerId: string; readonly claimExpiresAt: string },
    now: string,
  ): RemoteDispatchIntent | undefined {
    requireNonEmpty(input.workerId, "workerId");
    if (parseTimestamp(input.claimExpiresAt, "claimExpiresAt") <= parseTimestamp(now, "now")) {
      throw new Error("claimExpiresAt must be later than now");
    }
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.context.database.prepare(`
        UPDATE remote_dispatch_intents
        SET status = 'claimed', claimed_by = ?, claim_expires_at = ?, attempt_count = attempt_count + 1,
            last_error = NULL, updated_at = ?
        WHERE id = ?
          AND available_at <= ?
          AND (
            status IN ('pending', 'failed')
            OR (status = 'claimed' AND claim_expires_at <= ?)
          )
      `).run(input.workerId, input.claimExpiresAt, now, intentId, now, now);
      const intent = Number(result.changes) === 1 ? this.getDispatchIntent(intentId) : undefined;
      this.context.database.exec("COMMIT");
      return intent;
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  completeRemoteDispatchIntent(intentId: string, now: string): RemoteDispatchIntent | undefined {
    const result = this.context.database.prepare(`
      UPDATE remote_dispatch_intents
      SET status = 'dispatched', claimed_by = NULL, claim_expires_at = NULL,
          last_error = NULL, dispatched_at = ?, updated_at = ?
      WHERE id = ? AND status = 'claimed'
    `).run(now, now, intentId);
    return Number(result.changes) === 1 ? this.getDispatchIntent(intentId) : undefined;
  }

  failRemoteDispatchIntent(intentId: string, errorMessage: string, retryAt: string, now: string): RemoteDispatchIntent | undefined {
    parseTimestamp(retryAt, "retryAt");
    const redactedError = String(redactSecrets(errorMessage)).slice(0, 2_000);
    const result = this.context.database.prepare(`
      UPDATE remote_dispatch_intents
      SET status = 'failed', available_at = ?, claimed_by = NULL, claim_expires_at = NULL,
          last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'claimed'
    `).run(retryAt, redactedError, now, intentId);
    return Number(result.changes) === 1 ? this.getDispatchIntent(intentId) : undefined;
  }

  listRemoteProjectionOutbox(options: ListRemoteProjectionOutboxOptions = {}): RemoteProjectionOutboxRecord[] {
    const clauses = ["activity_seq > ?"];
    const params: (string | number)[] = [Math.max(0, options.afterActivitySeq ?? 0)];
    if (options.workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(options.workspaceId);
    }
    if (options.conversationKind) {
      clauses.push("conversation_kind = ?");
      params.push(options.conversationKind);
    }
    if (options.conversationId) {
      clauses.push("conversation_id = ?");
      params.push(options.conversationId);
    }
    if (options.unprocessedOnly) {
      clauses.push("processed_at IS NULL");
    }
    params.push(Math.min(Math.max(options.limit ?? 200, 1), 1_000));
    return this.context.database.prepare(`
      SELECT * FROM remote_projection_outbox
      WHERE ${clauses.join(" AND ")}
      ORDER BY activity_seq ASC
      LIMIT ?
    `).all(...params).map((row) => mapRemoteProjectionOutbox(row as Record<string, SQLOutputValue>));
  }

  getRemoteProjectionEntityVersion(input: RemoteProjectionEntityVersionInput): RemoteProjectionEntityVersion {
    const clauses = ["workspace_id = ?", "entity_type = ?", "entity_id = ?"];
    const params: string[] = [input.workspaceId, input.entityType, input.entityId];
    if (input.conversationKind !== undefined || input.conversationId !== undefined) {
      if (!input.conversationKind || !input.conversationId) {
        throw new Error("Remote projection entity conversation scope must include both kind and id.");
      }
      clauses.push("conversation_kind = ?", "conversation_id = ?");
      params.push(input.conversationKind, input.conversationId);
    }
    const row = this.context.database.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN operation <> 'delete' THEN 1 ELSE 0 END), 0) AS revision,
        COALESCE(MAX(activity_seq), 0) AS activity_seq
      FROM remote_projection_outbox
      WHERE ${clauses.join(" AND ")}
    `).get(...params) as Record<string, SQLOutputValue>;
    return {
      revision: Math.max(1, readNumber(row, "revision")),
      activitySeq: readNumber(row, "activity_seq"),
    };
  }

  getLatestConversationActivitySeq(input: RemoteConversationActivityInput): number {
    const row = this.context.database.prepare(`
      SELECT COALESCE(MAX(activity_seq), 0) AS activity_seq
      FROM remote_projection_outbox
      WHERE workspace_id = ? AND conversation_kind = ? AND conversation_id = ?
    `).get(input.workspaceId, input.conversationKind, input.conversationId);
    return readNumber(row as Record<string, SQLOutputValue>, "activity_seq");
  }

  markRemoteProjectionOutboxProcessed(activitySeqs: readonly number[], now: string): number {
    const normalized = [...new Set(activitySeqs)]
      .filter((seq) => Number.isSafeInteger(seq) && seq > 0)
      .slice(0, 1_000);
    if (normalized.length === 0) {
      return 0;
    }
    const result = this.context.database.prepare(`
      UPDATE remote_projection_outbox
      SET processed_at = COALESCE(processed_at, ?)
      WHERE activity_seq IN (${normalized.map(() => "?").join(", ")})
        AND processed_at IS NULL
    `).run(now, ...normalized);
    return Number(result.changes);
  }

  getConversationReadState(
    input: Omit<MarkConversationReadInput, "throughActivitySeq">,
    now: string,
  ): ConversationReadState {
    this.assertConversationExists(input.workspaceId, input.conversationKind, input.conversationId, true);
    const row = this.context.database.prepare(`
      SELECT read_through_activity_seq, updated_at
      FROM conversation_read_states
      WHERE workspace_id = ? AND user_id = ? AND conversation_kind = ? AND conversation_id = ?
    `).get(input.workspaceId, input.userId, input.conversationKind, input.conversationId);
    const cursor = row
      ? readNumber(row as Record<string, SQLOutputValue>, "read_through_activity_seq")
      : 0;
    const updatedAt = row
      ? readString(row as Record<string, SQLOutputValue>, "updated_at")
      : now;
    return this.buildConversationReadState(input, cursor, updatedAt);
  }

  markConversationRead(input: MarkConversationReadInput, now: string): ConversationReadState {
    if (!Number.isSafeInteger(input.throughActivitySeq) || input.throughActivitySeq < 0) {
      throw new Error("throughActivitySeq must be a non-negative safe integer");
    }
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      this.assertConversationExists(input.workspaceId, input.conversationKind, input.conversationId, true);
      const latestActivitySeq = this.getLatestConversationActivitySeq(input);
      const requestedCursor = Math.min(input.throughActivitySeq, latestActivitySeq);
      this.context.database.prepare(`
        INSERT INTO conversation_read_states (
          workspace_id, user_id, conversation_kind, conversation_id,
          read_through_activity_seq, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, user_id, conversation_kind, conversation_id) DO UPDATE SET
          read_through_activity_seq = excluded.read_through_activity_seq,
          updated_at = excluded.updated_at
        WHERE excluded.read_through_activity_seq > conversation_read_states.read_through_activity_seq
      `).run(
        input.workspaceId,
        input.userId,
        input.conversationKind,
        input.conversationId,
        requestedCursor,
        now,
        now,
      );
      this.context.database.exec("COMMIT");
      return this.getConversationReadState(input, now);
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  private replaySend(
    receipt: RemoteCommandReceipt,
    input: CommitRemoteConversationSendInput,
  ): CommitRemoteConversationSendResult {
    if (
      receipt.bodyHash !== input.bodyHash ||
      receipt.workspaceId !== input.workspaceId ||
      receipt.deviceId !== input.deviceId ||
      receipt.commandType !== REMOTE_COMMAND_TYPE
    ) {
      throw new RemoteCommandIdempotencyConflictError(input.commandId);
    }
    if (!receipt.messageId || !receipt.dispatchIntentId || receipt.status !== "completed") {
      throw new Error(`Remote send receipt is not replayable: ${input.commandId}`);
    }
    const dispatchIntent = this.getDispatchIntent(receipt.dispatchIntentId);
    if (!dispatchIntent) {
      throw new Error(`Remote dispatch intent not found: ${receipt.dispatchIntentId}`);
    }
    return {
      receipt,
      dispatchIntent,
      messageId: receipt.messageId,
      idempotentReplay: true,
    };
  }

  private assertSendInput(input: CommitRemoteConversationSendInput, now: string): void {
    requireNonEmpty(input.workspaceId, "workspaceId");
    requireNonEmpty(input.deviceId, "deviceId");
    requireNonEmpty(input.commandId, "commandId");
    requireNonEmpty(input.bodyHash, "bodyHash");
    requireNonEmpty(input.conversationId, "conversationId");
    const body = input.body.trim();
    if (!body) {
      throw new Error("Remote message body is required");
    }
    if (Buffer.byteLength(input.body, "utf8") > MAX_REMOTE_TEXT_BYTES) {
      throw new Error("Remote message body exceeds the 32 KiB limit");
    }
    const issuedAtMs = parseTimestamp(input.issuedAt, "issuedAt");
    const retryUntilMs = parseTimestamp(input.retryUntil, "retryUntil");
    const nowMs = parseTimestamp(now, "now");
    if (retryUntilMs < issuedAtMs || retryUntilMs - issuedAtMs > MAX_RETRY_WINDOW_MS) {
      throw new Error("Remote command retry window is invalid");
    }
    if (nowMs > retryUntilMs) {
      throw new RemoteCommandRetryWindowExpiredError(input.commandId);
    }
  }

  private assertConversationExists(
    workspaceId: string,
    conversationKind: RemoteConversationKind,
    conversationId: string,
    allowInactive = false,
  ): void {
    let row: unknown;
    if (conversationKind === "channel") {
      row = this.context.database.prepare(`
        SELECT 1 AS found FROM channels
        WHERE workspace_id = ? AND id = ? ${allowInactive ? "" : "AND status <> 'archived'"}
      `).get(workspaceId, conversationId);
    } else if (conversationKind === "teammate_direct") {
      row = this.context.database.prepare(
        "SELECT 1 AS found FROM teammate_direct_threads WHERE workspace_id = ? AND id = ?",
      ).get(workspaceId, conversationId);
    } else {
      row = this.context.database.prepare(`
        SELECT 1 AS found FROM ling_threads
        WHERE workspace_id = ? AND id = ? AND kind = 'conversation'
          ${allowInactive ? "" : "AND archived_at IS NULL AND status <> 'archived'"}
      `).get(workspaceId, conversationId);
    }
    if (!row) {
      throw new RemoteConversationNotFoundError(conversationKind, conversationId);
    }
  }

  private insertConversationMessage(input: CommitRemoteConversationSendInput, messageId: string, now: string): void {
    const body = String(redactSecrets(input.body));
    if (input.conversationKind === "channel") {
      this.context.database.prepare(`
        INSERT INTO channel_messages (
          id, workspace_id, channel_id, thread_id, kind, intent, author_type, author_id,
          body, mentions_json, attachment_ids_json, link_preview_ids_json, file_refs_json,
          linked_task_id, linked_run_id, status, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, 'message', 'discuss', 'local-user', 'local-user', ?, '[]', '[]', '[]', '[]', NULL, NULL, 'ready', NULL, ?, ?)
      `).run(messageId, input.workspaceId, input.conversationId, body, now, now);
      return;
    }

    if (input.conversationKind === "teammate_direct") {
      const thread = this.context.database.prepare(`
        SELECT teammate_id FROM teammate_direct_threads WHERE workspace_id = ? AND id = ?
      `).get(input.workspaceId, input.conversationId) as Record<string, SQLOutputValue> | undefined;
      if (!thread) {
        throw new RemoteConversationNotFoundError(input.conversationKind, input.conversationId);
      }
      this.context.database.prepare(`
        INSERT INTO teammate_direct_messages (
          id, workspace_id, thread_id, teammate_id, author_type, author_id, body,
          attachment_ids_json, link_preview_ids_json, file_refs_json, status, error_message,
          linked_task_id, linked_run_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'local-user', 'local-user', ?, '[]', '[]', '[]', 'ready', NULL, NULL, NULL, ?, ?)
      `).run(
        messageId,
        input.workspaceId,
        input.conversationId,
        readString(thread, "teammate_id"),
        body,
        now,
        now,
      );
      this.context.database.prepare(`
        UPDATE teammate_direct_threads SET updated_at = ? WHERE workspace_id = ? AND id = ?
      `).run(now, input.workspaceId, input.conversationId);
      return;
    }

    const title = body.split(/\r?\n/u, 1)[0]!.trim().slice(0, 120) || "Mobile message";
    this.context.database.prepare(`
      INSERT INTO ling_turns (
        id, workspace_id, thread_id, kind, status, title, user_instruction, channel_id,
        task_id, teammate_id, workflow_step_id, external_work_id, automation_id,
        source_message_id, source_turn_id, intervention_id, active_run_id, last_run_id,
        created_by_actor, created_at, updated_at, completed_at
      )
      SELECT ?, ?, id, 'manual_followup', 'open', ?, ?, channel_id, task_id, teammate_id,
             workflow_step_id, external_work_id, NULL, NULL, NULL, NULL, NULL, NULL,
             'local-user', ?, ?, NULL
      FROM ling_threads
      WHERE workspace_id = ? AND id = ? AND kind = 'conversation' AND archived_at IS NULL
    `).run(messageId, input.workspaceId, title, body, now, now, input.workspaceId, input.conversationId);
    this.context.database.prepare(`
      UPDATE ling_threads SET status = 'open', updated_at = ?
      WHERE workspace_id = ? AND id = ? AND kind = 'conversation' AND archived_at IS NULL
    `).run(now, input.workspaceId, input.conversationId);
  }

  private insertDispatchIntent(
    input: CommitRemoteConversationSendInput,
    intentId: string,
    messageId: string,
    now: string,
  ): void {
    const authority = REMOTE_CONVERSATION_AUTHORITY_CONTEXT;
    this.context.database.prepare(`
      INSERT INTO remote_dispatch_intents (
        id, command_id, workspace_id, conversation_kind, conversation_id, message_id,
        source_surface, authority_ceiling, allow_ai_reply, allow_tool_calls,
        allow_workflow_auto_start, allow_execution_proposal, status, attempt_count,
        available_at, claimed_by, claim_expires_at, last_error, created_at, updated_at, dispatched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 'pending', 0, ?, NULL, NULL, NULL, ?, ?, NULL)
    `).run(
      intentId,
      input.commandId,
      input.workspaceId,
      input.conversationKind,
      input.conversationId,
      messageId,
      authority.sourceSurface,
      authority.authorityCeiling,
      now,
      now,
      now,
    );
  }

  private getDispatchIntent(intentId: string): RemoteDispatchIntent | undefined {
    const row = this.context.database.prepare(`
      SELECT * FROM remote_dispatch_intents WHERE id = ?
    `).get(intentId);
    return row ? mapRemoteDispatchIntent(row as Record<string, SQLOutputValue>) : undefined;
  }

  private buildConversationReadState(
    input: {
      readonly workspaceId: string;
      readonly userId: string;
      readonly conversationKind: RemoteConversationKind;
      readonly conversationId: string;
    },
    cursor: number,
    updatedAt: string,
  ): ConversationReadState {
    const activitySeq = this.getLatestConversationActivitySeq(input);
    const unreadRow = this.context.database.prepare(`
      SELECT COUNT(DISTINCT entity_type || ':' || entity_id) AS unread_count
      FROM remote_projection_outbox
      WHERE workspace_id = ? AND conversation_kind = ? AND conversation_id = ?
        AND activity_seq > ? AND affects_unread = 1 AND operation <> 'delete'
    `).get(input.workspaceId, input.conversationKind, input.conversationId, cursor);
    let mentioned = false;
    if (input.conversationKind === "channel") {
      mentioned = Boolean(this.context.database.prepare(`
        SELECT 1 AS found
        FROM remote_projection_outbox AS outbox
        INNER JOIN channel_messages AS messages
          ON messages.workspace_id = outbox.workspace_id
          AND messages.channel_id = outbox.conversation_id
          AND messages.id = outbox.entity_id
        WHERE outbox.workspace_id = ?
          AND outbox.conversation_kind = 'channel'
          AND outbox.conversation_id = ?
          AND outbox.activity_seq > ?
          AND outbox.affects_unread = 1
          AND outbox.operation <> 'delete'
          AND messages.mentions_json LIKE '%"kind":"local-user"%'
        LIMIT 1
      `).get(input.workspaceId, input.conversationId, cursor));
    }
    return {
      workspaceId: input.workspaceId,
      userId: input.userId,
      conversationKind: input.conversationKind,
      conversationId: input.conversationId,
      readThroughActivitySeq: cursor,
      activitySeq,
      unreadCount: readNumber(unreadRow as Record<string, SQLOutputValue>, "unread_count"),
      mentioned,
      updatedAt,
    };
  }
}

function mapRemoteCommandReceipt(row: Record<string, SQLOutputValue>): RemoteCommandReceipt {
  const terminalJson = readNullableString(row, "terminal_json");
  return {
    commandId: readString(row, "command_id"),
    workspaceId: readString(row, "workspace_id"),
    deviceId: readString(row, "device_id"),
    commandType: readString(row, "command_type"),
    bodyHash: readString(row, "body_hash"),
    receiptState: readString(row, "receipt_state") as RemoteCommandReceipt["receiptState"],
    status: readString(row, "status") as RemoteCommandReceipt["status"],
    issuedAt: readString(row, "issued_at"),
    retryUntil: readString(row, "retry_until"),
    ...(terminalJson ? { terminalOutcome: parseJson(terminalJson) as RemoteCommandTerminalOutcome } : {}),
    ...(readNullableString(row, "message_id") ? { messageId: readNullableString(row, "message_id") } : {}),
    ...(readNullableString(row, "dispatch_intent_id") ? { dispatchIntentId: readNullableString(row, "dispatch_intent_id") } : {}),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    ...(readNullableString(row, "compacted_at") ? { compactedAt: readNullableString(row, "compacted_at") } : {}),
  };
}

function mapRemoteDispatchIntent(row: Record<string, SQLOutputValue>): RemoteDispatchIntent {
  return {
    id: readString(row, "id"),
    commandId: readString(row, "command_id"),
    workspaceId: readString(row, "workspace_id"),
    conversationKind: readString(row, "conversation_kind") as RemoteConversationKind,
    conversationId: readString(row, "conversation_id"),
    messageId: readString(row, "message_id"),
    authority: {
      sourceSurface: readString(row, "source_surface") as "mobile",
      authorityCeiling: readString(row, "authority_ceiling") as "conversation_comment",
      allowAiReply: readBoolean(row, "allow_ai_reply") as true,
      allowToolCalls: readBoolean(row, "allow_tool_calls") as false,
      allowWorkflowAutoStart: readBoolean(row, "allow_workflow_auto_start") as false,
      allowExecutionProposal: readBoolean(row, "allow_execution_proposal") as false,
    },
    status: readString(row, "status") as RemoteDispatchIntent["status"],
    attemptCount: readNumber(row, "attempt_count"),
    availableAt: readString(row, "available_at"),
    ...(readNullableString(row, "claimed_by") ? { claimedBy: readNullableString(row, "claimed_by") } : {}),
    ...(readNullableString(row, "claim_expires_at") ? { claimExpiresAt: readNullableString(row, "claim_expires_at") } : {}),
    ...(readNullableString(row, "last_error") ? { lastError: readNullableString(row, "last_error") } : {}),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    ...(readNullableString(row, "dispatched_at") ? { dispatchedAt: readNullableString(row, "dispatched_at") } : {}),
  };
}

function mapRemoteProjectionOutbox(row: Record<string, SQLOutputValue>): RemoteProjectionOutboxRecord {
  return {
    activitySeq: readNumber(row, "activity_seq"),
    workspaceId: readString(row, "workspace_id"),
    ...(readNullableString(row, "conversation_kind")
      ? { conversationKind: readNullableString(row, "conversation_kind") as RemoteConversationKind }
      : {}),
    ...(readNullableString(row, "conversation_id") ? { conversationId: readNullableString(row, "conversation_id") } : {}),
    entityType: readString(row, "entity_type"),
    entityId: readString(row, "entity_id"),
    operation: readString(row, "operation") as RemoteProjectionOutboxRecord["operation"],
    affectsUnread: readBoolean(row, "affects_unread"),
    occurredAt: readString(row, "occurred_at"),
    ...(readNullableString(row, "processed_at") ? { processedAt: readNullableString(row, "processed_at") } : {}),
  };
}

function parseTimestamp(value: string, fieldName: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be an ISO timestamp`);
  }
  return parsed;
}

function requireNonEmpty(value: string, fieldName: string): void {
  if (!value.trim()) {
    throw new Error(`${fieldName} is required`);
  }
}
