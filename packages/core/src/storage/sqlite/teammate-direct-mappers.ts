import type { SQLOutputValue } from "node:sqlite";
import {
  type ChannelAttachmentKind,
  type ChannelLinkPreviewStatus,
  type TeammateDirectLinkPreview,
  type TeammateDirectMessage,
  type TeammateDirectMessageAuthorType,
  type TeammateDirectMessageStatus,
  type TeammateDirectThread,
  type TeammatePrivateAttachment,
  type TeammatePrivateAttachmentScope,
} from "../../workspace-types.js";
import {
  omitUndefined,
  parseJsonStringArray,
  readNullableString,
  readNumber,
  readString,
} from "./helpers.js";
import { parseChannelMessageFileRefs } from "./channel-message-parsers.js";
import { parseNullableDirectWorkspaceBinding } from "./workspace-binding-parsers.js";

export function mapTeammateDirectThread(row: Record<string, SQLOutputValue>): TeammateDirectThread {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    teammateId: readString(row, "teammate_id"),
    title: readString(row, "title"),
    workspaceBinding: parseNullableDirectWorkspaceBinding(readNullableString(row, "workspace_binding_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapTeammateDirectLinkPreview(row: Record<string, SQLOutputValue>): TeammateDirectLinkPreview {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    teammateId: readString(row, "teammate_id"),
    threadId: readString(row, "thread_id"),
    messageId: readNullableString(row, "message_id"),
    url: readString(row, "url"),
    normalizedUrl: readString(row, "normalized_url"),
    title: readNullableString(row, "title"),
    description: readNullableString(row, "description"),
    imageUrl: readNullableString(row, "image_url"),
    siteName: readNullableString(row, "site_name"),
    status: readString(row, "status") as ChannelLinkPreviewStatus,
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapTeammateDirectMessage(row: Record<string, SQLOutputValue>): TeammateDirectMessage {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    threadId: readString(row, "thread_id"),
    teammateId: readString(row, "teammate_id"),
    authorType: readString(row, "author_type") as TeammateDirectMessageAuthorType,
    authorId: readNullableString(row, "author_id"),
    body: readString(row, "body"),
    attachmentIds: parseJsonStringArray(readString(row, "attachment_ids_json")),
    linkPreviewIds: parseJsonStringArray(readString(row, "link_preview_ids_json")),
    fileRefs: parseChannelMessageFileRefs(readString(row, "file_refs_json")),
    status: readString(row, "status") as TeammateDirectMessageStatus,
    errorMessage: readNullableString(row, "error_message"),
    linkedTaskId: readNullableString(row, "linked_task_id"),
    linkedRunId: readNullableString(row, "linked_run_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapTeammatePrivateAttachment(row: Record<string, SQLOutputValue>): TeammatePrivateAttachment {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    teammateId: readString(row, "teammate_id"),
    threadId: readNullableString(row, "thread_id"),
    messageId: readNullableString(row, "message_id"),
    scope: readString(row, "scope") as TeammatePrivateAttachmentScope,
    kind: readString(row, "kind") as ChannelAttachmentKind,
    fileName: readString(row, "file_name"),
    contentType: readString(row, "content_type"),
    sizeBytes: readNumber(row, "size_bytes"),
    path: readString(row, "path"),
    createdAt: readString(row, "created_at"),
  });
}
