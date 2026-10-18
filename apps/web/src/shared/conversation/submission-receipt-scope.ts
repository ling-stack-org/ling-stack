import type { ConversationSubmissionQuery, ConversationSubmissionReceipt, TeammateDirectMessageSubmissionReceipt } from "@ling-stack/contracts";

export function validateConversationSubmissionReceipt(receipt: ConversationSubmissionReceipt, cwd: string,
  query: ConversationSubmissionQuery): ConversationSubmissionReceipt {
  const item = receipt.sourceItem;
  if (receipt.cwd !== cwd || receipt.idempotencyKey !== query.idempotencyKey
    || receipt.status === "accepted" && (!item || item.kind !== "user_message"
      || item.id !== receipt.sourceItemId || item.threadId !== receipt.threadId || item.turnId !== receipt.turnId
      || query.threadId && receipt.threadId !== query.threadId
      || (query.surface === "channel" ? item.channelId !== query.channelId : Boolean(item.channelId)))) {
    throw new Error("Conversation submission receipt scope mismatch");
  }
  return receipt;
}

export function validatePrivateSubmissionReceipt(receipt: TeammateDirectMessageSubmissionReceipt, cwd: string,
  teammateId: string, key: string): TeammateDirectMessageSubmissionReceipt {
  const { message, aiReply } = receipt;
  if (receipt.cwd !== cwd || receipt.idempotencyKey !== key || receipt.teammateId !== teammateId
    || receipt.status === "accepted" && (!message || message.teammateId !== teammateId
      || message.authorType !== "local-user" || message.authorId !== "local-user")
    || aiReply && (!message || aiReply.workspaceId !== message.workspaceId || aiReply.threadId !== message.threadId
      || aiReply.teammateId !== teammateId || aiReply.authorType !== "ai-teammate" || aiReply.authorId !== teammateId)) {
    throw new Error("Private submission receipt scope mismatch");
  }
  return receipt;
}
