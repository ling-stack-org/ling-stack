import { createHash } from "node:crypto";
import type { RunStore, TeammateDirectMessage, TeammateDirectThread } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import type { TeammateDirectMessageRequest } from "./schemas.js";

export function directSubmissionReplyId(messageId: string): string {
  return `direct_submission_reply:${messageId}`;
}

export function acceptDirectSubmission(store: RunStore, thread: TeammateDirectThread,
  input: TeammateDirectMessageRequest, now: string): { readonly message: TeammateDirectMessage; readonly created: boolean } {
  const source = { threadId: thread.id, teammateId: thread.teammateId, authorType: "local-user" as const,
    authorId: "local-user", body: input.body, attachmentIds: input.attachmentIds,
    linkPreviewIds: input.linkPreviewIds, fileRefs: input.fileRefs };
  if (input.idempotencyKey === undefined) {
    return { message: store.createTeammateDirectMessage(source, now), created: true };
  }
  const requestFingerprint = createHash("sha256").update(JSON.stringify([1, thread.id, thread.teammateId,
    { ...input, idempotencyKey: undefined }])).digest("hex");
  try {
    return store.acceptTeammateDirectMessage({ ...source, idempotencyKey: input.idempotencyKey, requestFingerprint }, now);
  } catch (error) {
    if (error instanceof Error && error.message.includes("bound to another input")) {
      throw new HttpError(409, "private_submission_conflict", error.message);
    }
    throw error;
  }
}

export function readDirectSubmissionReply(store: RunStore, message: TeammateDirectMessage): TeammateDirectMessage | undefined {
  const reply = store.getTeammateDirectMessage(directSubmissionReplyId(message.id));
  return reply?.workspaceId === message.workspaceId && reply.teammateId === message.teammateId
    && reply.threadId === message.threadId && reply.authorType === "ai-teammate"
    && reply.authorId === message.teammateId ? reply : undefined;
}
