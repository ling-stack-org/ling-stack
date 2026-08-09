import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import {
  isConversationItemV1,
  type ConversationItemKindV1,
  type ConversationItemPayloadByKindV1,
  type ConversationItemV1,
} from "@ling-stack/contracts";
import {
  ConversationItemStoreError,
  type AppendConversationItem,
  type ConversationItemChannelListPage,
  type ConversationItemListPage,
  type FindConversationItemByDomainRefInput,
  type ListConversationItemsByChannelOptions,
  type ListConversationItemsForSegmentOptions,
  type ListConversationItemsForTurnOptions,
  type ListConversationItemsOptions,
  type UpdatePendingConversationItemInput,
} from "../../conversation-item-store-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteConversationItemStore {
  constructor(private readonly context: SqliteStoreContext) {}

  appendConversationItem(input: AppendConversationItem, now: string): ConversationItemV1 {
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const item = this.appendConversationItemWithinTransaction(input, now);
      this.context.database.exec("COMMIT");
      return item;
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  appendConversationItemWithinTransaction(input: AppendConversationItem, now: string): ConversationItemV1 {
    if (input.idempotencyKey) {
      const existing = this.getConversationItemByIdempotencyKey(input.threadId, input.idempotencyKey);
      if (existing) return existing;
    }
    const thread = this.context.database
      .prepare("SELECT id, channel_id, status FROM ling_threads WHERE workspace_id = ? AND id = ?")
      .get(DEFAULT_WORKSPACE_ID, input.threadId) as Record<string, SQLOutputValue> | undefined;
    if (!thread) {
      throw new ConversationItemStoreError("thread_not_found", `Ling thread not found: ${input.threadId}`);
    }
    if (thread.status === "archived") {
      throw new ConversationItemStoreError("thread_archived", `Ling thread is archived: ${input.threadId}`);
    }
    const threadChannelId = readNullableString(thread.channel_id);
    if (input.channelId !== undefined && input.channelId !== threadChannelId) {
      throw new ConversationItemStoreError(
        "channel_thread_mismatch",
        `Conversation item channel does not match Ling thread: ${input.channelId}`,
      );
    }
    if (input.turnId) {
      const turn = this.context.database
        .prepare("SELECT thread_id FROM ling_turns WHERE workspace_id = ? AND id = ?")
        .get(DEFAULT_WORKSPACE_ID, input.turnId) as Record<string, SQLOutputValue> | undefined;
      if (!turn) {
        throw new ConversationItemStoreError("turn_not_found", `Ling turn not found: ${input.turnId}`);
      }
      if (turn.thread_id !== input.threadId) {
        throw new ConversationItemStoreError(
          "turn_thread_mismatch",
          `Ling turn does not belong to conversation item thread: ${input.turnId}`,
        );
      }
    }
    if (input.supersedesItemId) {
      this.assertValidSupersession(input.threadId, input.supersedesItemId);
    }

    const sequenceRow = this.context.database
      .prepare(`
        UPDATE ling_threads
        SET next_item_sequence = next_item_sequence + 1,
            updated_at = ?
        WHERE workspace_id = ? AND id = ?
        RETURNING next_item_sequence - 1 AS sequence
      `)
      .get(now, DEFAULT_WORKSPACE_ID, input.threadId) as Record<string, SQLOutputValue> | undefined;
    const sequence = readSafeInteger(sequenceRow?.sequence, "sequence");
    const status = input.status ?? "committed";
    const item = {
      schemaVersion: 1,
      id: input.id ?? `item_${randomUUID()}`,
      workspaceId: DEFAULT_WORKSPACE_ID,
      ...(input.channelId ?? threadChannelId ? { channelId: input.channelId ?? threadChannelId ?? undefined } : {}),
      threadId: input.threadId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      sequence,
      kind: input.kind,
      status,
      actorType: input.actorType,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      visibility: input.visibility,
      ...(input.visibilityOwnerId ? { visibilityOwnerId: input.visibilityOwnerId } : {}),
      payload: input.payload,
      domainRefs: input.domainRefs ?? [],
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      revision: 0,
      ...(input.supersedesItemId ? { supersedesItemId: input.supersedesItemId } : {}),
      createdAt: now,
      updatedAt: now,
      ...(status === "committed" ? { committedAt: now } : {}),
    } as ConversationItemV1;
    assertValidConversationItem(item);

    try {
      this.context.database
        .prepare(`
          INSERT INTO conversation_items (
            id, schema_version, workspace_id, channel_id, thread_id, turn_id, sequence,
            kind, status, actor_type, actor_id, visibility, visibility_owner_id,
            payload_json, domain_refs_json, idempotency_key, revision,
            supersedes_item_id, created_at, updated_at, committed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          item.id,
          item.schemaVersion,
          item.workspaceId,
          item.channelId ?? null,
          item.threadId,
          item.turnId ?? null,
          item.sequence,
          item.kind,
          item.status,
          item.actorType,
          item.actorId ?? null,
          item.visibility,
          item.visibilityOwnerId ?? null,
          JSON.stringify(item.payload),
          JSON.stringify(item.domainRefs),
          item.idempotencyKey ?? null,
          item.revision,
          item.supersedesItemId ?? null,
          item.createdAt,
          item.updatedAt,
          item.committedAt ?? null,
        );
    } catch (error) {
      if (isSqliteConstraintOn(error, ["conversation_items.supersedes_item_id"])) {
        throw new ConversationItemStoreError(
          "supersession_conflict",
          `Conversation item already has an effective supersession: ${input.supersedesItemId}`,
          { cause: error },
        );
      }
      if (isSqliteConstraintOn(error, ["conversation_items.id"])) {
        throw new ConversationItemStoreError(
          "item_id_conflict",
          `Conversation item id already exists: ${item.id}`,
          { cause: error },
        );
      }
      if (isSqliteConstraintOn(error, [
        "conversation_items.thread_id",
        "conversation_items.idempotency_key",
      ])) {
        throw new ConversationItemStoreError(
          "idempotency_conflict",
          `Conversation item idempotency key already exists: ${input.idempotencyKey}`,
          { cause: error },
        );
      }
      if (isSqliteConstraintOn(error, [
        "conversation_items.thread_id",
        "conversation_items.sequence",
      ])) {
        throw new ConversationItemStoreError(
          "item_sequence_conflict",
          `Conversation item sequence already exists in thread: ${input.threadId}/${sequence}`,
          { cause: error },
        );
      }
      throw error;
    }
    return this.getRequiredConversationItem(item.id);
  }

  getConversationItem(itemId: string): ConversationItemV1 | undefined {
    const row = this.context.database.prepare(`${conversationItemSelectSql} WHERE id = ?`).get(itemId);
    return row ? mapConversationItem(row as Record<string, SQLOutputValue>) : undefined;
  }

  getEffectiveConversationItem(itemId: string): ConversationItemV1 | undefined {
    let current = this.getConversationItem(itemId);
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current.id)) {
        throw new ConversationItemStoreError(
          "supersession_conflict",
          `Conversation item supersession cycle detected: ${current.id}`,
        );
      }
      visited.add(current.id);
      const row = this.context.database
        .prepare(`${conversationItemSelectSql} WHERE supersedes_item_id = ?`)
        .get(current.id);
      if (!row) return current;
      current = mapConversationItem(row as Record<string, SQLOutputValue>);
    }
    return undefined;
  }

  getConversationItemByIdempotencyKey(threadId: string, idempotencyKey: string): ConversationItemV1 | undefined {
    const row = this.context.database
      .prepare(`${conversationItemSelectSql} WHERE workspace_id = ? AND thread_id = ? AND idempotency_key = ?`)
      .get(DEFAULT_WORKSPACE_ID, threadId, idempotencyKey);
    return row ? mapConversationItem(row as Record<string, SQLOutputValue>) : undefined;
  }

  findConversationItemByDomainRef(
    input: FindConversationItemByDomainRefInput,
  ): ConversationItemV1 | undefined {
    const beforeSequence = input.beforeSequence ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1) {
      throw new RangeError(`Invalid conversation domain-ref watermark: ${beforeSequence}`);
    }
    const row = this.context.database.prepare(`
      ${conversationItemSelectSql}
      WHERE workspace_id = ?
        AND thread_id = ?
        AND sequence < ?
        AND status = 'committed'
        AND EXISTS (
          SELECT 1 FROM json_each(domain_refs_json)
          WHERE json_extract(value, '$.type') = ?
            AND json_extract(value, '$.id') = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM conversation_items AS replacement
          WHERE replacement.supersedes_item_id = conversation_items.id
        )
      ORDER BY sequence DESC
      LIMIT 1
    `).get(
      DEFAULT_WORKSPACE_ID,
      input.threadId,
      beforeSequence,
      input.ref.type,
      input.ref.id,
    );
    return row ? mapConversationItem(row as Record<string, SQLOutputValue>) : undefined;
  }

  listConversationItemsForTurn(
    options: ListConversationItemsForTurnOptions,
  ): readonly ConversationItemV1[] {
    if (!options.turnId.trim()) {
      throw new RangeError("Conversation turn id must not be empty");
    }
    return this.context.database.prepare(`
      ${conversationItemSelectSql}
      WHERE workspace_id = ?
        AND turn_id = ?
        AND status = 'committed'
        AND NOT EXISTS (
          SELECT 1 FROM conversation_items AS replacement
          WHERE replacement.supersedes_item_id = conversation_items.id
        )
      ORDER BY sequence ASC
    `).all(DEFAULT_WORKSPACE_ID, options.turnId)
      .map((row) => mapConversationItem(row as Record<string, SQLOutputValue>));
  }

  listConversationItemsPage(options: ListConversationItemsOptions): ConversationItemListPage {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const beforeSequence = options.beforeSequence ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1) {
      throw new RangeError(`Invalid conversation item cursor: ${beforeSequence}`);
    }
    const effectiveClause = options.effectiveOnly
      ? "AND NOT EXISTS (SELECT 1 FROM conversation_items AS replacement WHERE replacement.supersedes_item_id = conversation_items.id)"
      : "";
    const rows = this.context.database
      .prepare(`
        ${conversationItemSelectSql}
        WHERE workspace_id = ? AND thread_id = ? AND sequence < ?
        ${effectiveClause}
        ORDER BY sequence DESC
        LIMIT ?
      `)
      .all(DEFAULT_WORKSPACE_ID, options.threadId, beforeSequence, limit + 1);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit).map((row) => mapConversationItem(row as Record<string, SQLOutputValue>));
    const items = selected.reverse();
    return {
      items,
      ...(hasMore && items.length > 0 ? { nextBeforeSequence: items[0]?.sequence } : {}),
    };
  }

  listConversationItemsByChannelPage(
    options: ListConversationItemsByChannelOptions,
  ): ConversationItemChannelListPage {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    const excludedThreadIds = [...new Set(options.excludeThreadIds ?? [])]
      .filter((threadId) => threadId.trim().length > 0);
    if (options.threadId) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    } else if (excludedThreadIds.length > 0) {
      clauses.push(`thread_id NOT IN (${excludedThreadIds.map(() => "?").join(", ")})`);
      params.push(...excludedThreadIds);
    }
    const kinds = [...new Set(options.kinds ?? [])];
    if (kinds.length > 0) {
      clauses.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
      params.push(...kinds);
    }
    if (options.effectiveOnly) {
      clauses.push("NOT EXISTS (SELECT 1 FROM conversation_items AS replacement WHERE replacement.supersedes_item_id = conversation_items.id)");
    }
    if (options.beforeItemId) {
      const cursor = this.context.database
        .prepare(`
          SELECT channel_id, thread_id, created_at, rowid
          FROM conversation_items
          WHERE workspace_id = ? AND id = ?
        `)
        .get(DEFAULT_WORKSPACE_ID, options.beforeItemId) as Record<string, SQLOutputValue> | undefined;
      if (!cursor || readNullableString(cursor.channel_id) !== options.channelId) {
        throw new Error(`Invalid conversation item cursor: ${options.beforeItemId}`);
      }
      const cursorThreadId = readNullableString(cursor.thread_id);
      if (options.threadId !== undefined && options.threadId !== cursorThreadId) {
        throw new Error(`Invalid conversation item cursor: ${options.beforeItemId}`);
      }
      if (options.threadId === undefined && cursorThreadId && excludedThreadIds.includes(cursorThreadId)) {
        throw new Error(`Invalid conversation item cursor: ${options.beforeItemId}`);
      }
      clauses.push("(created_at < ? OR (created_at = ? AND rowid < ?))");
      const cursorCreatedAt = readString(cursor.created_at, "created_at");
      params.push(cursorCreatedAt, cursorCreatedAt, readSafeInteger(cursor.rowid, "rowid"));
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    params.push(limit + 1);
    const rows = this.context.database
      .prepare(`
        ${conversationItemSelectSql}
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      `)
      .all(...params)
      .map((row) => mapConversationItem(row as Record<string, SQLOutputValue>));
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).reverse();
    return {
      items,
      hasMore,
      ...(hasMore && items[0] ? { nextBeforeItemId: items[0].id } : {}),
    };
  }

  listConversationItemsForSegment(
    options: ListConversationItemsForSegmentOptions,
  ): readonly ConversationItemV1[] {
    if (!Number.isSafeInteger(options.throughSequence) || options.throughSequence < 1) {
      throw new RangeError(`Invalid conversation projection watermark: ${options.throughSequence}`);
    }
    const afterSequence = options.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > options.throughSequence) {
      throw new RangeError(`Invalid conversation projection lower watermark: ${afterSequence}`);
    }
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 500);
    const rows = this.context.database.prepare(`
      SELECT items.*
      FROM conversation_items AS items
      INNER JOIN turn_context_assignments AS assignments
        ON assignments.turn_id = items.turn_id
       AND assignments.revision = (
         SELECT MAX(candidate.revision)
         FROM turn_context_assignments AS candidate
         WHERE candidate.turn_id = items.turn_id
       )
      WHERE items.workspace_id = ?
        AND items.thread_id = ?
        AND assignments.segment_id = ?
        AND items.sequence > ?
        AND items.sequence <= ?
        AND items.status = 'committed'
        AND NOT EXISTS (
          SELECT 1 FROM conversation_items AS replacement
          WHERE replacement.supersedes_item_id = items.id
        )
      ORDER BY items.sequence DESC
      LIMIT ?
    `).all(
      DEFAULT_WORKSPACE_ID,
      options.threadId,
      options.segmentId,
      afterSequence,
      options.throughSequence,
      limit,
    );
    return rows
      .map((row) => mapConversationItem(row as Record<string, SQLOutputValue>))
      .reverse();
  }

  updatePendingConversationItem<K extends ConversationItemKindV1>(
    itemId: string,
    input: UpdatePendingConversationItemInput<K>,
    now: string,
  ): ConversationItemV1 {
    const existing = this.getConversationItem(itemId);
    if (!existing) {
      throw new ConversationItemStoreError("item_not_found", `Conversation item not found: ${itemId}`);
    }
    if (existing.status !== "pending") {
      throw new ConversationItemStoreError("item_not_pending", `Conversation item is immutable: ${itemId}`);
    }
    if (existing.revision !== input.expectedRevision) {
      throw new ConversationItemStoreError(
        "item_revision_conflict",
        `Conversation item revision changed: ${itemId}`,
      );
    }
    const status = input.status ?? "pending";
    const candidate = {
      ...existing,
      payload: input.payload as ConversationItemPayloadByKindV1[typeof existing.kind],
      status,
      revision: existing.revision + 1,
      updatedAt: now,
      ...(status === "committed" ? { committedAt: now } : { committedAt: undefined }),
    } as ConversationItemV1;
    assertValidConversationItem(candidate);
    const result = this.context.database
      .prepare(`
        UPDATE conversation_items
        SET payload_json = ?, status = ?, revision = revision + 1, updated_at = ?, committed_at = ?
        WHERE id = ? AND status = 'pending' AND revision = ?
      `)
      .run(
        JSON.stringify(candidate.payload),
        candidate.status,
        candidate.updatedAt,
        candidate.committedAt ?? null,
        itemId,
        input.expectedRevision,
      );
    if (result.changes !== 1) {
      throw new ConversationItemStoreError(
        "item_revision_conflict",
        `Conversation item changed during update: ${itemId}`,
      );
    }
    return this.getRequiredConversationItem(itemId);
  }

  private assertValidSupersession(threadId: string, sourceItemId: string): void {
    const source = this.getConversationItem(sourceItemId);
    if (!source || source.threadId !== threadId || source.status !== "committed") {
      throw new ConversationItemStoreError(
        "supersession_invalid",
        `Conversation item supersession source must be committed in the same thread: ${sourceItemId}`,
      );
    }
    const existing = this.context.database
      .prepare("SELECT id FROM conversation_items WHERE workspace_id = ? AND supersedes_item_id = ?")
      .get(DEFAULT_WORKSPACE_ID, sourceItemId);
    if (existing) {
      throw new ConversationItemStoreError(
        "supersession_conflict",
        `Conversation item already has an effective supersession: ${sourceItemId}`,
      );
    }
  }

  private getRequiredConversationItem(itemId: string): ConversationItemV1 {
    const item = this.getConversationItem(itemId);
    if (!item) {
      throw new ConversationItemStoreError("item_not_found", `Conversation item not found after write: ${itemId}`);
    }
    return item;
  }
}

const conversationItemSelectSql = `
  SELECT id, schema_version, workspace_id, channel_id, thread_id, turn_id, sequence,
         kind, status, actor_type, actor_id, visibility, visibility_owner_id,
         payload_json, domain_refs_json, idempotency_key, revision,
         supersedes_item_id, created_at, updated_at, committed_at
  FROM conversation_items
`;

function mapConversationItem(row: Record<string, SQLOutputValue>): ConversationItemV1 {
  const item = {
    schemaVersion: readSafeInteger(row.schema_version, "schema_version"),
    id: readString(row.id, "id"),
    workspaceId: readString(row.workspace_id, "workspace_id"),
    ...(readNullableString(row.channel_id) ? { channelId: readNullableString(row.channel_id) } : {}),
    threadId: readString(row.thread_id, "thread_id"),
    ...(readNullableString(row.turn_id) ? { turnId: readNullableString(row.turn_id) } : {}),
    sequence: readSafeInteger(row.sequence, "sequence"),
    kind: readString(row.kind, "kind"),
    status: readString(row.status, "status"),
    actorType: readString(row.actor_type, "actor_type"),
    ...(readNullableString(row.actor_id) ? { actorId: readNullableString(row.actor_id) } : {}),
    visibility: readString(row.visibility, "visibility"),
    ...(readNullableString(row.visibility_owner_id)
      ? { visibilityOwnerId: readNullableString(row.visibility_owner_id) }
      : {}),
    payload: parseJson(row.payload_json, "payload_json"),
    domainRefs: parseJson(row.domain_refs_json, "domain_refs_json"),
    ...(readNullableString(row.idempotency_key) ? { idempotencyKey: readNullableString(row.idempotency_key) } : {}),
    revision: readSafeInteger(row.revision, "revision"),
    ...(readNullableString(row.supersedes_item_id)
      ? { supersedesItemId: readNullableString(row.supersedes_item_id) }
      : {}),
    createdAt: readString(row.created_at, "created_at"),
    updatedAt: readString(row.updated_at, "updated_at"),
    ...(readNullableString(row.committed_at) ? { committedAt: readNullableString(row.committed_at) } : {}),
  } as unknown;
  assertValidConversationItem(item);
  return item;
}

function assertValidConversationItem(value: unknown): asserts value is ConversationItemV1 {
  if (!isConversationItemV1(value)) {
    throw new ConversationItemStoreError("item_invalid", "Conversation item failed schema validation.");
  }
}

function parseJson(value: SQLOutputValue | undefined, column: string): unknown {
  const text = readString(value, column);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConversationItemStoreError("item_invalid", `Conversation item ${column} is not valid JSON.`, { cause: error });
  }
}

function readString(value: SQLOutputValue | undefined, column: string): string {
  if (typeof value !== "string") {
    throw new ConversationItemStoreError("item_invalid", `Conversation item ${column} must be text.`);
  }
  return value;
}

function readNullableString(value: SQLOutputValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readSafeInteger(value: SQLOutputValue | undefined, column: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ConversationItemStoreError("item_invalid", `Conversation item ${column} must be a safe integer.`);
  }
  return value;
}

function isSqliteConstraintOn(error: unknown, columns: readonly string[]): boolean {
  if (!(error instanceof Error)
    || !("errcode" in error)
    || typeof error.errcode !== "number"
    || (error.errcode & 0xff) !== 19) {
    return false;
  }
  const actualColumns = error.message.match(/constraint failed: (.+)$/u)?.[1]?.split(", ");
  return actualColumns?.length === columns.length
    && columns.every((column, index) => actualColumns[index] === column);
}
