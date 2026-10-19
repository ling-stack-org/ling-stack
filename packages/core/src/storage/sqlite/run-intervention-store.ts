import type { SQLOutputValue } from "node:sqlite";
import {
  projectConversationItemToChannelMessage,
  type ConversationAttachment,
  type ConversationItemV1,
  type LingThread,
} from "@ling-stack/contracts";
import type { ChannelMessage } from "../../workspace-types.js";
import {
  createRunInterventionId,
  type ClaimNextRunInterventionInput,
  type CreateRunInterventionInput,
  type ListPriorRunInterventionReplyMessagesInput,
  type ListRunInterventionsOptions,
  type RunIntervention,
  type RunSession,
  type UpdateRunInterventionStatusInput,
} from "../../run-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { readString, stringifyJson } from "./helpers.js";
import {
  mapRunIntervention,
  normalizeRunInterventionMessagePayload,
} from "./intervention-mappers.js";
import { runInterventionSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteRunInterventionStorePorts {
  readonly getRun: (runId: string) => RunSession | undefined;
  readonly getConversationItem: (itemId: string) => ConversationItemV1 | undefined;
  readonly getLingThread: (threadId: string) => LingThread | undefined;
  readonly getConversationAttachment: (attachmentId: string) => ConversationAttachment | undefined;
  readonly assertAttachmentInChannel: (channelId: string, attachmentId: string) => void;
  readonly assertLinkPreviewInChannel: (channelId: string, linkPreviewId: string) => void;
}

export class SqliteRunInterventionStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteRunInterventionStorePorts,
  ) {}

  createRunIntervention(input: CreateRunInterventionInput, now: string): RunIntervention {
    const existing = this.context.database
      .prepare(runInterventionSelectSql("WHERE source_run_id = ? AND idempotency_key = ?"))
      .get(input.sourceRunId, input.idempotencyKey);
    if (existing) {
      return mapRunIntervention(existing as Record<string, SQLOutputValue>);
    }
    const sourceRun = this.ports.getRun(input.sourceRunId);
    if (!sourceRun) {
      throw new Error(`Source run not found: ${input.sourceRunId}`);
    }
    const messagePayload = input.messagePayload ? normalizeRunInterventionMessagePayload(input.messagePayload) : undefined;
    if (messagePayload && (messagePayload.attachmentIds.length > 0 || messagePayload.linkPreviewIds.length > 0)) {
      if (messagePayload.attachmentIds.length > 10) {
        throw new Error("A run intervention can reference at most 10 attachments");
      }
      if (messagePayload.linkPreviewIds.length > 10) {
        throw new Error("A run intervention can reference at most 10 link previews");
      }
      if (sourceRun.channelId) {
        for (const attachmentId of messagePayload.attachmentIds) {
          this.ports.assertAttachmentInChannel(sourceRun.channelId, attachmentId);
        }
        for (const linkPreviewId of messagePayload.linkPreviewIds) {
          this.ports.assertLinkPreviewInChannel(sourceRun.channelId, linkPreviewId);
        }
      } else {
        const thread = sourceRun.threadId ? this.ports.getLingThread(sourceRun.threadId) : undefined;
        if (!thread || thread.kind !== "conversation" || thread.channelId || messagePayload.linkPreviewIds.length) {
          throw new Error(`Run intervention payload requires a channel run or a normal conversation without link previews: ${input.sourceRunId}`);
        }
        for (const attachmentId of messagePayload.attachmentIds) {
          const attachment = this.ports.getConversationAttachment(attachmentId);
          if (!attachment || attachment.workspaceId !== thread.workspaceId) {
            throw new Error(`Conversation attachment not found: ${attachmentId}`);
          }
          if (attachment.threadId && attachment.threadId !== thread.id) {
            throw new Error(`Conversation attachment belongs to a different thread: ${attachmentId}`);
          }
          if (attachment.turnId) {
            throw new Error(`Conversation attachment was already used: ${attachmentId}`);
          }
        }
      }
    }
    const id = input.id ?? createRunInterventionId();
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
    this.context.database
      .prepare(`
        INSERT INTO run_interventions (
          id,
          workspace_id,
          source_run_id,
          source_work_unit_id,
          source_attempt_id,
          continuation_run_id,
          continuation_work_unit_id,
          mode,
          status,
          instruction,
          message_payload_json,
          requested_by,
          idempotency_key,
          created_at,
          updated_at,
          started_at,
          completed_at,
          failure_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        workspaceId,
        input.sourceRunId,
        input.sourceWorkUnitId ?? null,
        input.sourceAttemptId ?? null,
        null,
        null,
        input.mode,
        "queued",
        input.instruction,
        messagePayload ? stringifyJson(messagePayload) : null,
        input.requestedBy ?? "local-user",
        input.idempotencyKey,
        now,
        now,
        null,
        null,
        null,
      );
    const created = this.getRunIntervention(id);
    if (!created) {
      throw new Error(`Failed to create run intervention: ${id}`);
    }
    return created;
  }

  getRunIntervention(interventionId: string): RunIntervention | undefined {
    const row = this.context.database.prepare(runInterventionSelectSql("WHERE id = ?")).get(interventionId);
    return row ? mapRunIntervention(row as Record<string, SQLOutputValue>) : undefined;
  }

  listRunInterventions(options: ListRunInterventionsOptions = {}): RunIntervention[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.sourceRunId) {
      clauses.push("source_run_id = ?");
      params.push(options.sourceRunId);
    }
    if (options.idempotencyKey !== undefined) {
      clauses.push("idempotency_key = ?");
      params.push(options.idempotencyKey);
    }
    const sourceMessageIds = [...new Set(options.sourceMessageIds?.filter(Boolean) ?? [])];
    if (sourceMessageIds.length > 0) {
      clauses.push(`json_extract(message_payload_json, '$.sourceMessageId') IN (${sourceMessageIds.map(() => "?").join(", ")})`);
      params.push(...sourceMessageIds);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.mode) {
      clauses.push("mode = ?");
      params.push(options.mode);
    }
    if (options.hasContinuation) clauses.push("continuation_run_id IS NOT NULL");
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    return this.context.database
      .prepare(`${runInterventionSelectSql(whereClause)} ORDER BY ${options.newestFirst ? "started_at DESC, rowid DESC" : "created_at ASC, rowid ASC"} LIMIT ?`)
      .all(...params)
      .map((row) => mapRunIntervention(row as Record<string, SQLOutputValue>));
  }

  claimNextRunIntervention(input: ClaimNextRunInterventionInput): RunIntervention | undefined {
    const expectedStatuses = [...new Set(input.expectedStatuses)];
    if (expectedStatuses.length === 0) {
      return undefined;
    }
    const placeholders = expectedStatuses.map(() => "?").join(", ");
    const row = this.context.database
      .prepare(`
        UPDATE run_interventions
        SET status = ?,
            updated_at = ?,
            started_at = ?
        WHERE id = (
          SELECT id
          FROM run_interventions
          WHERE source_run_id = ?
            AND status IN (${placeholders})
          ORDER BY created_at ASC, rowid ASC
          LIMIT 1
        )
          AND status IN (${placeholders})
          AND NOT EXISTS (SELECT 1 FROM run_interventions AS active
            WHERE active.source_run_id=run_interventions.source_run_id
              AND (active.status='starting_continuation' OR active.status='started' AND active.completed_at IS NULL))
        RETURNING
          id,
          workspace_id,
          source_run_id,
          source_work_unit_id,
          source_attempt_id,
          continuation_run_id,
          continuation_work_unit_id,
          mode,
          status,
          instruction,
          message_payload_json,
          requested_by,
          idempotency_key,
          created_at,
          updated_at,
          started_at,
          completed_at,
          failure_reason
      `)
      .get(
        input.status,
        input.now,
        input.startedAt ?? null,
        input.sourceRunId,
        ...expectedStatuses,
        ...expectedStatuses,
      );
    return row ? mapRunIntervention(row as Record<string, SQLOutputValue>) : undefined;
  }

  listPriorRunInterventionReplyMessages(input: ListPriorRunInterventionReplyMessagesInput): ChannelMessage[] {
    const limit = input.limit === undefined
      ? undefined
      : Math.min(Math.max(input.limit, 1), 100);
    const statement = this.context.database.prepare(`
        SELECT items.id AS item_id
        FROM run_interventions AS earlier
        JOIN run_interventions AS current
          ON current.id = ?
         AND current.source_run_id = ?
        JOIN work_units
          ON work_units.id = earlier.continuation_work_unit_id
        JOIN conversation_items AS items
          ON items.id = work_units.linked_message_id
        WHERE earlier.source_run_id = ?
          AND earlier.completed_at IS NOT NULL
          AND items.channel_id = ?
          AND items.status = 'committed'
          AND items.kind IN ('assistant_message', 'system_event')
          AND (
            earlier.created_at < current.created_at
            OR (earlier.created_at = current.created_at AND earlier.rowid < current.rowid)
          )
        ORDER BY earlier.created_at DESC, earlier.rowid DESC
        ${limit === undefined ? "" : "LIMIT ?"}
      `);
    const parameters: readonly (string | number)[] = [
      input.beforeInterventionId,
      input.sourceRunId,
      input.sourceRunId,
      input.channelId,
      ...(limit === undefined ? [] : [limit]),
    ];
    return statement
      .all(...parameters)
      .map((row) => this.ports.getConversationItem(readString(row as Record<string, SQLOutputValue>, "item_id")))
      .filter((item): item is ConversationItemV1 => Boolean(item))
      .map((item) => projectConversationItemToChannelMessage(item))
      .reverse();
  }

  updateRunInterventionStatus(input: UpdateRunInterventionStatusInput): RunIntervention | undefined {
    const existing = this.getRunIntervention(input.interventionId);
    if (!existing) {
      return undefined;
    }
    const continuationRunId = input.continuationRunId === undefined ? existing.continuationRunId ?? null : input.continuationRunId;
    const continuationWorkUnitId = input.continuationWorkUnitId === undefined ? existing.continuationWorkUnitId ?? null : input.continuationWorkUnitId;
    const startedAt = input.startedAt === undefined ? existing.startedAt ?? null : input.startedAt;
    const completedAt = input.completedAt === undefined ? existing.completedAt ?? null : input.completedAt;
    const failureReason = input.failureReason === undefined ? existing.failureReason ?? null : input.failureReason;
    const expectedStatuses = input.expectedStatuses ? [...new Set(input.expectedStatuses)] : [];
    const expectedClause = expectedStatuses.length > 0
      ? ` AND status IN (${expectedStatuses.map(() => "?").join(", ")})`
      : "";
    const result = this.context.database
      .prepare(`
        UPDATE run_interventions
        SET status = ?,
            continuation_run_id = ?,
            continuation_work_unit_id = ?,
            updated_at = ?,
            started_at = ?,
            completed_at = ?,
            failure_reason = ?
        WHERE id = ?${expectedClause}
      `)
      .run(
        input.status,
        continuationRunId,
        continuationWorkUnitId,
        input.now,
        startedAt,
        completedAt,
        failureReason,
        input.interventionId,
        ...expectedStatuses,
      );
    if (result.changes === 0) {
      return undefined;
    }
    return this.getRunIntervention(input.interventionId);
  }

  cancelRunIntervention(interventionId: string, now: string, reason?: string): RunIntervention | undefined {
    const existing = this.getRunIntervention(interventionId);
    if (!existing) {
      return undefined;
    }
    if (existing.status === "started" || existing.status === "cancelled" || existing.status === "failed") {
      return existing;
    }
    return this.updateRunInterventionStatus({
      interventionId,
      expectedStatuses: [existing.status],
      status: "cancelled",
      completedAt: now,
      failureReason: reason ?? "cancelled",
      now,
    });
  }
}
