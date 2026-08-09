import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type {
  AppendConversationUserTurnInput,
  AppendConversationUserTurnResult,
} from "../../conversation-turn-ingest-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { readNullableString, readString, stringifyJson } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";
import { SqliteConversationItemStore } from "./conversation-item-store.js";

const BOOTSTRAP_SEGMENT_POLICY_VERSION = "continuity-v2-bootstrap-v1";

export class SqliteConversationTurnIngestStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly items: SqliteConversationItemStore,
  ) {}

  appendUserTurn(input: AppendConversationUserTurnInput, now: string): AppendConversationUserTurnResult {
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.appendUserTurnWithinTransaction(input, now);
      this.context.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  appendUserTurnWithinTransaction(
    input: AppendConversationUserTurnInput,
    now: string,
  ): AppendConversationUserTurnResult {
    const replay = this.items.getConversationItemByIdempotencyKey(input.threadId, input.idempotencyKey);
      if (replay) {
        if (replay.kind !== "user_message" || !replay.turnId || replay.channelId !== input.channelId) {
          throw new Error(`Conversation turn idempotency key belongs to another input: ${input.idempotencyKey}`);
        }
        const assignment = this.context.database.prepare(`
          SELECT segment_id
          FROM turn_context_assignments
          WHERE turn_id = ? AND status = 'committed'
          ORDER BY revision DESC
          LIMIT 1
        `).get(replay.turnId) as Record<string, SQLOutputValue> | undefined;
        if (!assignment) {
          throw new Error(`Conversation turn replay is missing its context assignment: ${replay.turnId}`);
        }
        return {
          turnId: replay.turnId,
          item: replay,
          contextSegmentId: readString(assignment, "segment_id"),
          idempotentReplay: true,
        };
      }

      const thread = this.context.database.prepare(`
        SELECT channel_id, status
        FROM ling_threads
        WHERE workspace_id = ? AND id = ?
      `).get(DEFAULT_WORKSPACE_ID, input.threadId) as Record<string, SQLOutputValue> | undefined;
      if (!thread) throw new Error(`Ling thread not found: ${input.threadId}`);
      if (readString(thread, "status") === "archived") {
        throw new Error(`Ling thread is archived: ${input.threadId}`);
      }
      if (readNullableString(thread, "channel_id") !== input.channelId) {
        throw new Error(`Ling thread does not belong to channel: ${input.threadId}`);
      }
      if (input.sourceTurnId) {
        const source = this.context.database.prepare(`
          SELECT thread_id FROM ling_turns WHERE workspace_id = ? AND id = ?
        `).get(DEFAULT_WORKSPACE_ID, input.sourceTurnId) as Record<string, SQLOutputValue> | undefined;
        if (!source || readString(source, "thread_id") !== input.threadId) {
          throw new Error(`Source Ling turn does not belong to thread: ${input.sourceTurnId}`);
        }
      }

      const turnId = input.turnId ?? `turn_${randomUUID()}`;
      const itemId = input.itemId ?? `item_${randomUUID()}`;
      this.context.database.prepare(`
        INSERT INTO ling_turns (
          id, workspace_id, thread_id, kind, status, title, user_instruction,
          channel_id, task_id, teammate_id, workflow_step_id, external_work_id,
          automation_id, source_item_id, source_turn_id, intervention_id,
          active_run_id, last_run_id, created_by_actor, created_at, updated_at,
          completed_at
        ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?,
          NULL, NULL, NULL, 'local-user', ?, ?, NULL)
      `).run(
        turnId,
        DEFAULT_WORKSPACE_ID,
        input.threadId,
        input.turnKind ?? "initial_request",
        input.title,
        input.userInstruction,
        input.channelId,
        itemId,
        input.sourceTurnId ?? null,
        now,
        now,
      );
      const item = this.items.appendConversationItemWithinTransaction({
        id: itemId,
        channelId: input.channelId,
        threadId: input.threadId,
        turnId,
        kind: "user_message",
        status: "committed",
        actorType: "local_user",
        ...(input.actorId ? { actorId: input.actorId } : {}),
        visibility: "channel",
        payload: input.payload,
        domainRefs: input.domainRefs ?? [],
        idempotencyKey: input.idempotencyKey,
        ...(input.supersedesItemId ? { supersedesItemId: input.supersedesItemId } : {}),
      }, now);
      const segmentId = this.resolveOrCreateSegment(turnId, input.threadId, now);
      this.context.database.prepare(`
        INSERT INTO turn_context_assignments (
          id, workspace_id, turn_id, segment_id, status, revision,
          decision_source, confidence, antecedent_turn_id, evidence_refs_json,
          policy_version, supersedes_assignment_id, created_at
        ) VALUES (?, ?, ?, ?, 'committed', 1, 'structural', 1, ?, ?, ?, NULL, ?)
      `).run(
        `assignment_${turnId}`,
        DEFAULT_WORKSPACE_ID,
        turnId,
        segmentId,
        input.sourceTurnId ?? null,
        stringifyJson([
          ...(input.payload.replyToItemId
            ? [{ type: "conversation_item", id: input.payload.replyToItemId }]
            : []),
          ...(input.payload.quotedItemIds ?? []).map((id) => ({ type: "conversation_item", id })),
        ]),
        BOOTSTRAP_SEGMENT_POLICY_VERSION,
        now,
      );
      return { turnId, item, contextSegmentId: segmentId, idempotentReplay: false };
  }

  private resolveOrCreateSegment(turnId: string, threadId: string, now: string): string {
    const existing = this.context.database.prepare(`
      SELECT id
      FROM context_segments
      WHERE thread_id = ? AND state = 'active'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(threadId) as Record<string, SQLOutputValue> | undefined;
    if (existing) {
      const segmentId = readString(existing, "id");
      this.context.database.prepare(`
        UPDATE context_segments
        SET last_active_turn_id = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(turnId, now, segmentId);
      return segmentId;
    }
    const segmentId = `segment_${randomUUID()}`;
    this.context.database.prepare(`
      INSERT INTO context_segments (
        id, workspace_id, thread_id, state, label, created_from_turn_id,
        last_active_turn_id, merged_into_segment_id, revision, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', NULL, ?, ?, NULL, 1, ?, ?)
    `).run(segmentId, DEFAULT_WORKSPACE_ID, threadId, turnId, turnId, now, now);
    return segmentId;
  }
}
