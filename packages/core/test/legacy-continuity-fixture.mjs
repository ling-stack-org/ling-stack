import { randomUUID } from "node:crypto";

/** Seeds the pre-v2 table directly for one-time migration and recovery tests only. */
export function appendLegacyChannelMessageFixture(store, input, now) {
  if (!store.getChannel(input.channelId)) throw new Error(`Channel not found: ${input.channelId}`);
  const message = {
    id: input.id ?? `message_${randomUUID()}`,
    workspaceId: "workspace_default",
    channelId: input.channelId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    kind: input.kind ?? "message",
    intent: input.intent ?? "discuss",
    authorType: input.authorType,
    ...(input.authorId ? { authorId: input.authorId } : {}),
    body: input.body,
    mentions: input.mentions ?? [],
    attachmentIds: input.attachmentIds ?? [],
    linkPreviewIds: input.linkPreviewIds ?? [],
    fileRefs: input.fileRefs ?? [],
    ...(input.linkedTaskId ? { linkedTaskId: input.linkedTaskId } : {}),
    ...(input.linkedRunId ? { linkedRunId: input.linkedRunId } : {}),
    status: input.status ?? "ready",
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    createdAt: now,
    updatedAt: now,
  };
  store.database.prepare(`
    INSERT INTO channel_messages (
      id, workspace_id, channel_id, thread_id, kind, intent, author_type, author_id,
      body, mentions_json, attachment_ids_json, link_preview_ids_json, file_refs_json,
      linked_task_id, linked_run_id, status, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    message.id,
    message.workspaceId,
    message.channelId,
    message.threadId ?? null,
    message.kind,
    message.intent,
    message.authorType,
    message.authorId ?? null,
    message.body,
    JSON.stringify(message.mentions),
    JSON.stringify(message.attachmentIds),
    JSON.stringify(message.linkPreviewIds),
    JSON.stringify(message.fileRefs),
    message.linkedTaskId ?? null,
    message.linkedRunId ?? null,
    message.status,
    message.errorMessage ?? null,
    now,
    now,
  );
  return message;
}

export function updateLegacyChannelMessageFixture(store, id, input, now) {
  store.database.prepare(`
    UPDATE channel_messages
    SET body = COALESCE(?, body),
        status = COALESCE(?, status),
        error_message = ?,
        linked_run_id = COALESCE(?, linked_run_id),
        updated_at = ?
    WHERE id = ?
  `).run(
    input.body ?? null,
    input.status ?? null,
    input.errorMessage ?? null,
    input.linkedRunId ?? null,
    now,
    id,
  );
}
