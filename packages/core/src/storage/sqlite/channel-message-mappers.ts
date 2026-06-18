import type { SQLOutputValue } from "node:sqlite";
import {
  type ChannelMessage,
  type ChannelMessageAuthorType,
  type ChannelMessageIntent,
  type ChannelMessageKind,
} from "../../workspace-types.js";
import {
  isJsonRecord,
  omitUndefined,
  parseJson,
  parseJsonStringArray,
  readNullableString,
  readString,
} from "./helpers.js";
import { parseChannelMessageFileRefs } from "./channel-message-parsers.js";

export function mapChannelMessage(row: Record<string, SQLOutputValue>): ChannelMessage {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    threadId: readNullableString(row, "thread_id"),
    kind: readString(row, "kind") as ChannelMessageKind,
    intent: readString(row, "intent") as ChannelMessageIntent,
    authorType: readString(row, "author_type") as ChannelMessageAuthorType,
    authorId: readNullableString(row, "author_id"),
    body: readString(row, "body"),
    mentions: parseChannelMentions(readString(row, "mentions_json")),
    attachmentIds: parseJsonStringArray(readString(row, "attachment_ids_json")),
    linkPreviewIds: parseJsonStringArray(readString(row, "link_preview_ids_json")),
    fileRefs: parseChannelMessageFileRefs(readString(row, "file_refs_json")),
    linkedTaskId: readNullableString(row, "linked_task_id"),
    linkedRunId: readNullableString(row, "linked_run_id"),
    status: readString(row, "status") as ChannelMessage["status"],
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function parseChannelMentions(value: string): ChannelMessage["mentions"] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected channel mentions array from SQLite");
  }
  return parsed.map((item) => {
    if (!isJsonRecord(item) || typeof item.id !== "string" || typeof item.label !== "string") {
      throw new Error("Expected channel mention from SQLite");
    }
    if (item.kind !== "ai-teammate" && item.kind !== "local-user" && item.kind !== "channel") {
      throw new Error("Expected channel mention kind from SQLite");
    }
    return {
      id: item.id,
      label: item.label,
      kind: item.kind,
    };
  });
}
