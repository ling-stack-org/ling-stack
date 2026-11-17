import type { SQLOutputValue } from "node:sqlite";
import {
  isConversationContextProjectionMetadata,
  type ConversationContextProjectionMetadata,
} from "@ling-stack/contracts";
import {
  type ConversationContextViewLineage,
  type UpsertConversationContextViewLineageInput,
  type UpsertConversationContextViewLineageResult,
} from "../../conversation-context-store-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { parseJson, readNullableString, readNumber, readString, stringifyJson } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

/** Stores only rebuild metadata; source content remains in the durable domains. */
export class SqliteConversationContextViewLineageStore {
  constructor(private readonly context: SqliteStoreContext) {}

  getConversationContextViewLineage(lineageKey: string): ConversationContextViewLineage | undefined {
    const row = this.context.database.prepare(`${lineageSelectSql} WHERE lineage_key = ?`).get(lineageKey);
    return row ? mapLineage(row as Record<string, SQLOutputValue>) : undefined;
  }

  upsertConversationContextViewLineage(
    input: UpsertConversationContextViewLineageInput,
    now: string,
  ): UpsertConversationContextViewLineageResult {
    validateInput(input, now);
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getConversationContextViewLineage(input.lineageKey);
      if (input.expectedCurrentViewId !== undefined
        && current?.contextViewId !== input.expectedCurrentViewId) {
        this.context.database.exec("COMMIT");
        return { status: "rejected_stale", lineage: current, reason: "current_view_changed" };
      }

      const incomingThrough = input.projection?.throughItemSequence ?? -1;
      const currentThrough = current?.projection?.throughItemSequence ?? -1;
      if (current && incomingThrough < currentThrough) {
        this.context.database.exec("COMMIT");
        return { status: "rejected_stale", lineage: current, reason: "older_projection" };
      }

      if (current && current.contextViewId === input.contextViewId
        && current.viewFingerprint === input.viewFingerprint
        && current.projection?.projectionVersion === input.projection?.projectionVersion) {
        this.context.database.exec("COMMIT");
        return { status: "reused", lineage: current };
      }

      const revision = current ? current.revision + 1 : 1;
      this.context.database.prepare(`
        INSERT INTO conversation_context_view_lineage (
          lineage_key, workspace_id, channel_id, thread_id, source_item_id, kind,
          consumer_teammate_id, context_view_id, context_view_created_at, projection_json,
          view_fingerprint, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(lineage_key) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          channel_id = excluded.channel_id,
          thread_id = excluded.thread_id,
          source_item_id = excluded.source_item_id,
          kind = excluded.kind,
          consumer_teammate_id = excluded.consumer_teammate_id,
          context_view_id = excluded.context_view_id,
          context_view_created_at = excluded.context_view_created_at,
          projection_json = excluded.projection_json,
          view_fingerprint = excluded.view_fingerprint,
          revision = excluded.revision,
          updated_at = excluded.updated_at
      `).run(
        input.lineageKey,
        input.workspaceId,
        input.channelId ?? null,
        input.threadId ?? input.projection?.threadId ?? null,
        input.sourceItemId ?? input.projection?.turnId ?? null,
        input.kind,
        input.consumerTeammateId ?? null,
        input.contextViewId,
        input.contextViewCreatedAt,
        input.projection ? stringifyJson(input.projection) : null,
        input.viewFingerprint,
        revision,
        current?.createdAt ?? now,
        now,
      );
      const lineage = this.getConversationContextViewLineage(input.lineageKey);
      if (!lineage) throw new Error(`Context view lineage was not persisted: ${input.lineageKey}`);
      this.context.database.exec("COMMIT");
      return { status: current ? "updated" : "created", lineage };
    } catch (error) {
      try { this.context.database.exec("ROLLBACK"); } catch { /* preserve the original error */ }
      throw error;
    }
  }
}

const lineageSelectSql = `
  SELECT lineage_key, workspace_id, channel_id, thread_id, source_item_id, kind,
         consumer_teammate_id, context_view_id, context_view_created_at, projection_json,
         view_fingerprint, revision, created_at, updated_at
  FROM conversation_context_view_lineage
`;

function mapLineage(row: Record<string, SQLOutputValue>): ConversationContextViewLineage {
  const projectionJson = readNullableString(row, "projection_json");
  const projectionValue = projectionJson ? parseJson(projectionJson) : undefined;
  if (projectionValue !== undefined && !isConversationContextProjectionMetadata(projectionValue)) {
    throw new Error(`Invalid persisted conversation context projection: ${readString(row, "lineage_key")}`);
  }
  return {
    lineageKey: readString(row, "lineage_key"),
    workspaceId: readString(row, "workspace_id"),
    ...(readNullableString(row, "channel_id") ? { channelId: readNullableString(row, "channel_id") } : {}),
    ...(readNullableString(row, "thread_id") ? { threadId: readNullableString(row, "thread_id") } : {}),
    ...(readNullableString(row, "source_item_id") ? { sourceItemId: readNullableString(row, "source_item_id") } : {}),
    kind: readString(row, "kind"),
    ...(readNullableString(row, "consumer_teammate_id") ? { consumerTeammateId: readNullableString(row, "consumer_teammate_id") } : {}),
    contextViewId: readString(row, "context_view_id"),
    contextViewCreatedAt: readString(row, "context_view_created_at"),
    ...(projectionValue ? { projection: projectionValue as ConversationContextProjectionMetadata } : {}),
    viewFingerprint: readString(row, "view_fingerprint"),
    revision: readNumber(row, "revision"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function validateInput(input: UpsertConversationContextViewLineageInput, now: string): void {
  for (const [value, label] of [
    [input.lineageKey, "lineage key"],
    [input.workspaceId, "workspace id"],
    [input.kind, "view kind"],
    [input.contextViewId, "context view id"],
    [input.contextViewCreatedAt, "context view created at"],
    [input.viewFingerprint, "view fingerprint"],
    [now, "updated at"],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Context view ${label} must not be empty`);
  }
  if (input.projection && !isConversationContextProjectionMetadata(input.projection)) {
    throw new Error("Context view lineage projection is invalid");
  }
  if (!Number.isFinite(Date.parse(input.contextViewCreatedAt)) || !Number.isFinite(Date.parse(now))) {
    throw new Error("Context view lineage timestamps are invalid");
  }
  if (input.workspaceId !== DEFAULT_WORKSPACE_ID && input.workspaceId.trim().length === 0) {
    throw new Error("Context view lineage workspace is invalid");
  }
}
