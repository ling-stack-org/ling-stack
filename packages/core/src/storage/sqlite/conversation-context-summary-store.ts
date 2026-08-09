import type { SQLOutputValue } from "node:sqlite";
import type { ConversationDomainRef, ConversationItemV1 } from "@ling-stack/contracts";
import {
  DEFAULT_WORKSPACE_ID,
  createChannelContextSummaryId,
  type ChannelContextSummary,
  type ChannelContextSummaryAuthorType,
  type ChannelContextSummaryTargetType,
  type CreateChannelContextSummaryInput,
  type ListChannelContextSummariesOptions,
  type UpdateChannelContextSummaryInput,
} from "../../workspace-types.js";
import type { LingThread } from "../../run-types.js";
import {
  parseJson,
  parseJsonStringArray,
  readNullableString,
  readNumber,
  readString,
  stringifyJson,
} from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

const LEGACY_PROJECTION_POLICY_VERSION = "legacy-channel-summary-projection-v1";

export interface SqliteConversationContextSummaryStorePorts {
  readonly assertChannelExists: (channelId: string) => void;
  readonly assertItemInChannel: (channelId: string, itemId: string) => void;
  readonly assertTaskInChannel: (channelId: string, taskId: string) => void;
  readonly getConversationItem: (itemId: string) => ConversationItemV1 | undefined;
  readonly getLingThread: (threadId: string) => LingThread | undefined;
  readonly resolveChannelRootThread: (channelId: string, now: string) => LingThread;
  readonly assertDecisionInChannel: (channelId: string, decisionId: string) => void;
}

export class SqliteConversationContextSummaryStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteConversationContextSummaryStorePorts,
  ) {}

  createChannelContextSummary(input: CreateChannelContextSummaryInput, now: string): ChannelContextSummary {
    this.ports.assertChannelExists(input.channelId);
    const thread = this.resolveTargetThread(input.channelId, input.targetType, input.targetId, now);
    for (const itemId of input.sourceMessageIds ?? []) this.ports.assertItemInChannel(input.channelId, itemId);
    for (const decisionId of input.decisionIds ?? []) this.ports.assertDecisionInChannel(input.channelId, decisionId);
    return this.insertSummary(input, thread, now);
  }

  getChannelContextSummary(id: string): ChannelContextSummary | undefined {
    let row = this.getSummaryRow(id);
    const visited = new Set<string>();
    while (row) {
      const currentId = readString(row, "id");
      if (visited.has(currentId)) throw new Error(`Conversation context summary supersession cycle: ${currentId}`);
      visited.add(currentId);
      const replacement = this.context.database.prepare(`
        ${summarySelectSql}
        WHERE supersedes_summary_id = ?
        ORDER BY version DESC, created_at DESC
        LIMIT 1
      `).get(currentId) as Record<string, SQLOutputValue> | undefined;
      if (!replacement) return mapChannelContextSummary(row);
      row = replacement;
    }
    return undefined;
  }

  listChannelContextSummaries(options: ListChannelContextSummariesOptions): ChannelContextSummary[] {
    const rows = this.context.database.prepare(`
      ${summarySelectSql}
      WHERE status = 'active'
        AND EXISTS (
          SELECT 1 FROM json_each(source_refs_json)
          WHERE json_extract(value, '$.type') = 'channel'
            AND json_extract(value, '$.id') = ?
        )
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(options.channelId, Math.min(Math.max(options.limit ?? 100, 1), 500));
    return rows
      .map((row) => mapChannelContextSummary(row as Record<string, SQLOutputValue>))
      .filter((summary) => !options.targetType || summary.targetType === options.targetType)
      .filter((summary) => !options.targetId || summary.targetId === options.targetId);
  }

  updateChannelContextSummary(
    id: string,
    input: UpdateChannelContextSummaryInput,
    now: string,
  ): ChannelContextSummary | undefined {
    const existing = this.getChannelContextSummary(id);
    if (!existing) return undefined;
    const targetType = input.targetType ?? existing.targetType;
    const targetId = input.targetId ?? existing.targetId;
    const thread = this.resolveTargetThread(existing.channelId, targetType, targetId, now);
    const nextInput: CreateChannelContextSummaryInput = {
      channelId: existing.channelId,
      targetType,
      targetId,
      sourceMessageIds: input.sourceMessageIds ?? existing.sourceMessageIds,
      decisionIds: input.decisionIds ?? existing.decisionIds,
      summary: input.summary ?? existing.summary,
      acceptanceCriteria: input.acceptanceCriteria ?? existing.acceptanceCriteria,
      openQuestions: input.openQuestions ?? existing.openQuestions,
      authorType: input.authorType ?? existing.authorType,
      ...(input.authorId === null
        ? {}
        : input.authorId !== undefined
          ? { authorId: input.authorId }
          : existing.authorId
            ? { authorId: existing.authorId }
            : {}),
    };
    for (const itemId of nextInput.sourceMessageIds ?? []) this.ports.assertItemInChannel(existing.channelId, itemId);
    for (const decisionId of nextInput.decisionIds ?? []) this.ports.assertDecisionInChannel(existing.channelId, decisionId);

    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const effectiveRow = this.getSummaryRow(existing.id);
      if (!effectiveRow || readString(effectiveRow, "status") !== "active") {
        throw new Error(`Conversation context summary is not active: ${existing.id}`);
      }
      this.context.database.prepare(`
        UPDATE conversation_context_summaries SET status = 'superseded' WHERE id = ? AND status = 'active'
      `).run(existing.id);
      const replacement = this.insertSummary(nextInput, thread, now, existing.id);
      this.context.database.exec("COMMIT");
      return replacement;
    } catch (error) {
      if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  private insertSummary(
    input: CreateChannelContextSummaryInput,
    thread: LingThread,
    now: string,
    supersedesSummaryId?: string,
  ): ChannelContextSummary {
    const sourceItems = (input.sourceMessageIds ?? [])
      .map((id) => this.ports.getConversationItem(id))
      .filter((item): item is ConversationItemV1 => Boolean(item));
    const sequences = sourceItems.map((item) => item.sequence);
    const sourceRefs: ConversationDomainRef[] = [
      { type: "channel", id: input.channelId },
      { type: "thread", id: thread.id, label: "summary_thread" },
      targetRef(input.targetType, input.targetId),
      ...sourceItems.map((item) => ({ type: "conversation_item" as const, id: item.id, label: "source_message" })),
      ...(input.decisionIds ?? []).map((id) => ({ type: "operation" as const, id, label: "decision" })),
      { type: "operation", id: input.authorId ?? input.authorType, label: `author:${input.authorType}` },
    ];
    const versionRow = this.context.database.prepare(`
      SELECT COALESCE(MAX(version), 0) + 1 AS version
      FROM conversation_context_summaries
      WHERE workspace_id = ? AND thread_id = ? AND segment_id IS NULL
    `).get(DEFAULT_WORKSPACE_ID, thread.id) as Record<string, SQLOutputValue>;
    const id = createChannelContextSummaryId();
    this.context.database.prepare(`
      INSERT INTO conversation_context_summaries (
        id, workspace_id, thread_id, segment_id, scope, status, version,
        covered_from_sequence, covered_through_sequence, objective,
        decisions_json, constraints_json, open_questions_json, active_work_refs_json,
        source_refs_json, supersedes_summary_id, policy_version, created_at
      ) VALUES (?, ?, ?, NULL, ?, 'active', ?, ?, ?, ?, '[]', ?, ?, '[]', ?, ?, ?, ?)
    `).run(
      id,
      DEFAULT_WORKSPACE_ID,
      thread.id,
      input.targetType === "task" ? "work" : "thread_core",
      readNumber(versionRow, "version"),
      sequences.length > 0 ? Math.min(...sequences) : 0,
      sequences.length > 0 ? Math.max(...sequences) : 0,
      input.summary,
      stringifyJson(input.acceptanceCriteria ?? []),
      stringifyJson(input.openQuestions ?? []),
      stringifyJson(sourceRefs),
      supersedesSummaryId ?? null,
      LEGACY_PROJECTION_POLICY_VERSION,
      now,
    );
    const created = this.getChannelContextSummary(id);
    if (!created) throw new Error(`Failed to create conversation context summary: ${id}`);
    return created;
  }

  private resolveTargetThread(
    channelId: string,
    targetType: ChannelContextSummaryTargetType,
    targetId: string,
    now: string,
  ): LingThread {
    if (targetType === "task") {
      this.ports.assertTaskInChannel(channelId, targetId);
      const row = this.context.database.prepare(`
        SELECT id FROM ling_threads
        WHERE workspace_id = ? AND channel_id = ? AND task_id = ?
        ORDER BY updated_at DESC LIMIT 1
      `).get(DEFAULT_WORKSPACE_ID, channelId, targetId) as Record<string, SQLOutputValue> | undefined;
      const owned = row ? this.ports.getLingThread(readString(row, "id")) : undefined;
      return owned ?? this.ports.resolveChannelRootThread(channelId, now);
    }
    const item = this.ports.getConversationItem(targetId);
    const thread = item ? this.ports.getLingThread(item.threadId) : this.ports.getLingThread(targetId);
    if (!thread || thread.channelId !== channelId) throw new Error(`Channel thread not found: ${targetId}`);
    return thread;
  }

  private getSummaryRow(id: string): Record<string, SQLOutputValue> | undefined {
    return this.context.database.prepare(`${summarySelectSql} WHERE id = ?`).get(id) as
      | Record<string, SQLOutputValue>
      | undefined;
  }
}

const summarySelectSql = `
  SELECT id, workspace_id, thread_id, segment_id, scope, status, version,
         covered_from_sequence, covered_through_sequence, objective,
         decisions_json, constraints_json, open_questions_json, active_work_refs_json,
         source_refs_json, supersedes_summary_id, policy_version, created_at
  FROM conversation_context_summaries
`;

function mapChannelContextSummary(row: Record<string, SQLOutputValue>): ChannelContextSummary {
  const refs = parseDomainRefs(readString(row, "source_refs_json"));
  const channel = refs.find((ref) => ref.type === "channel");
  const target = refs.find((ref) => ref.label === "legacy_target");
  const author = refs.find((ref) => ref.type === "operation" && ref.label?.startsWith("author:"));
  if (!channel || !target) throw new Error(`Conversation context summary is missing projection refs: ${readString(row, "id")}`);
  const authorType = author?.label?.slice("author:".length) as ChannelContextSummaryAuthorType | undefined;
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: channel.id,
    targetType: target.type === "task" ? "task" : "thread",
    targetId: target.id,
    sourceMessageIds: refs.filter((ref) => ref.type === "conversation_item" && ref.label === "source_message").map((ref) => ref.id),
    decisionIds: refs.filter((ref) => ref.type === "operation" && ref.label === "decision").map((ref) => ref.id),
    summary: readNullableString(row, "objective") ?? "",
    acceptanceCriteria: parseJsonStringArray(readString(row, "constraints_json")),
    openQuestions: parseJsonStringArray(readString(row, "open_questions_json")),
    authorType: authorType === "local-user" || authorType === "ai-teammate" ? authorType : "system",
    ...(author && author.id !== authorType ? { authorId: author.id } : {}),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "created_at"),
  };
}

function targetRef(targetType: ChannelContextSummaryTargetType, targetId: string): ConversationDomainRef {
  return { type: targetType === "task" ? "task" : "thread", id: targetId, label: "legacy_target" };
}

function parseDomainRefs(value: string): ConversationDomainRef[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) throw new Error("Expected conversation context summary source refs array");
  return parsed as ConversationDomainRef[];
}
