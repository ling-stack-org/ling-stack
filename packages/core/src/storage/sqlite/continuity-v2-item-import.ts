import type { DatabaseSync } from "node:sqlite";
import {
  isConversationItemV1,
  type ConversationDomainRef,
  type ConversationItemV1,
} from "@ling-stack/contracts";
import {
  isContinuityJsonRecord,
  requiredContinuityMapValue,
  type ContinuityV2ThreadTopology,
  type LegacyContinuityMessage,
} from "./continuity-v2-legacy-types.js";
import { parseJson, parseJsonStringArray, stringifyJson } from "./helpers.js";

export function importLegacyConversationItems(
  database: DatabaseSync,
  messages: readonly LegacyContinuityMessage[],
  topology: ContinuityV2ThreadTopology,
  turnByMessage: ReadonlyMap<string, string>,
): number {
  const nextSequenceByThread = new Map<string, number>();
  const ordered = [...messages].sort((left, right) =>
    requiredContinuityMapValue(topology.targetThreadByMessageId, left.id, "message thread")
      .localeCompare(requiredContinuityMapValue(topology.targetThreadByMessageId, right.id, "message thread"))
    || left.createdAt.localeCompare(right.createdAt)
    || left.rowid - right.rowid
    || left.id.localeCompare(right.id));
  const insert = database.prepare(`
    INSERT INTO conversation_items (
      id, schema_version, workspace_id, channel_id, thread_id, turn_id, sequence,
      kind, status, actor_type, actor_id, visibility, visibility_owner_id,
      payload_json, domain_refs_json, idempotency_key, revision,
      supersedes_item_id, created_at, updated_at, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const message of ordered) {
    const threadId = requiredContinuityMapValue(topology.targetThreadByMessageId, message.id, "message thread");
    const sequence = nextSequenceByThread.get(threadId) ?? 1;
    nextSequenceByThread.set(threadId, sequence + 1);
    const item = legacyMessageToItem(
      message,
      threadId,
      requiredContinuityMapValue(turnByMessage, message.id, "message turn"),
      sequence,
    );
    insert.run(
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
      stringifyJson(item.payload),
      stringifyJson(item.domainRefs),
      item.idempotencyKey ?? null,
      item.revision,
      item.supersedesItemId ?? null,
      item.createdAt,
      item.updatedAt,
      item.committedAt ?? null,
    );
  }
  return ordered.length;
}

function legacyMessageToItem(
  message: LegacyContinuityMessage,
  threadId: string,
  turnId: string,
  sequence: number,
): ConversationItemV1 {
  const domainRefs: ConversationDomainRef[] = [
    ...(message.linkedTaskId ? [{ type: "task" as const, id: message.linkedTaskId }] : []),
    ...(message.linkedRunId ? [{ type: "run" as const, id: message.linkedRunId }] : []),
  ];
  const base = {
    schemaVersion: 1 as const,
    id: message.id,
    workspaceId: message.workspaceId,
    channelId: message.channelId,
    threadId,
    turnId,
    sequence,
    actorId: message.authorId,
    visibility: "channel" as const,
    domainRefs,
    revision: 0,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
  let item: ConversationItemV1;
  if (message.authorType === "local-user") {
    item = {
      ...base,
      kind: "user_message",
      status: message.status === "failed" ? "failed" : "committed",
      actorType: "local_user",
      payload: {
        body: message.body,
        format: "plain_text",
        mentions: parseLegacyMentions(message.mentionsJson),
        attachmentIds: parseJsonStringArray(message.attachmentIdsJson),
        linkPreviewIds: parseJsonStringArray(message.linkPreviewIdsJson),
        fileRefs: parseLegacyFileRefs(message.fileRefsJson),
      },
      ...(message.status === "failed" ? {} : { committedAt: message.updatedAt }),
    };
  } else if (message.authorType === "ai-teammate" || message.kind === "ai_reply") {
    const deliveryStatus = legacyAssistantDeliveryStatus(message.status);
    const status = deliveryStatus === "pending" ? "pending" : deliveryStatus === "failed" ? "failed" : "committed";
    item = {
      ...base,
      kind: "assistant_message",
      status,
      actorType: message.authorId === "ling_agent" ? "ling_agent" : "teammate",
      payload: {
        body: message.body,
        format: "markdown",
        streaming: deliveryStatus === "pending",
        deliveryStatus,
        ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
      },
      ...(status === "committed" ? { committedAt: message.updatedAt } : {}),
    };
  } else {
    item = {
      ...base,
      kind: "system_event",
      status: message.status === "failed" ? "failed" : "committed",
      actorType: "system",
      payload: {
        eventType: `legacy_channel_${message.kind}`,
        summary: message.body || "Imported legacy channel event.",
      },
      ...(message.status === "failed" ? {} : { committedAt: message.updatedAt }),
    };
  }
  if (!isConversationItemV1(item)) {
    throw new Error(`Continuity v2 migration cannot represent legacy message without loss: ${message.id}`);
  }
  return item;
}

function parseLegacyMentions(value: string): readonly { readonly id: string; readonly label: string; readonly kind: "ai_teammate" | "local_user" | "channel" }[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) throw new Error("Continuity v2 migration expected legacy mentions array.");
  return parsed.map((entry) => {
    if (!isContinuityJsonRecord(entry) || typeof entry.id !== "string" || typeof entry.label !== "string") {
      throw new Error("Continuity v2 migration found an invalid legacy mention.");
    }
    const kind = entry.kind === "ai-teammate"
      ? "ai_teammate"
      : entry.kind === "local-user"
        ? "local_user"
        : entry.kind === "channel"
          ? "channel"
          : undefined;
    if (!kind) throw new Error("Continuity v2 migration found an invalid legacy mention kind.");
    return { id: entry.id, label: entry.label, kind };
  });
}

function parseLegacyFileRefs(value: string): readonly { readonly path: string; readonly label?: string; readonly source?: "composer" | "explicit_text" | "api"; readonly line?: number }[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) throw new Error("Continuity v2 migration expected legacy file refs array.");
  return parsed.map((entry) => {
    if (!isContinuityJsonRecord(entry) || typeof entry.path !== "string") {
      throw new Error("Continuity v2 migration found an invalid legacy file ref.");
    }
    const source = entry.source === "composer" || entry.source === "explicit_text" || entry.source === "api"
      ? entry.source
      : undefined;
    return {
      path: entry.path,
      ...(typeof entry.label === "string" ? { label: entry.label } : {}),
      ...(source ? { source } : {}),
      ...(typeof entry.line === "number" ? { line: entry.line } : {}),
    };
  });
}

function legacyAssistantDeliveryStatus(status: string): "pending" | "ready" | "blocked" | "failed" {
  if (status === "pending" || status === "ready" || status === "blocked" || status === "failed") return status;
  throw new Error(`Continuity v2 migration found an invalid assistant delivery status: ${status}`);
}
