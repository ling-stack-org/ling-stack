import type {
  ConversationItemV1,
  ConversationMessageMentionV1,
} from "./conversation-continuity.js";
import type {
  ChannelMention,
  ChannelMessage,
  ChannelMessageFileRef,
} from "./channels.js";

/**
 * Projects a canonical conversation item into the message-shaped presentation view used
 * by the current Channel UI. The item remains the authority; this helper is pure and
 * browser-safe so daemon, API consumers, and Web cannot drift on projection semantics.
 */
export function projectConversationItemToChannelMessage(
  item: ConversationItemV1,
  options: { readonly linkedRunId?: string } = {},
): ChannelMessage {
  if (!item.channelId) {
    throw new Error(`Conversation item is not attached to a channel: ${item.id}`);
  }
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    channelId: item.channelId,
    threadId: item.threadId,
    ...(item.turnId ? { turnId: item.turnId } : {}),
    kind: item.kind === "user_message" ? "message" : item.kind === "assistant_message" ? "ai_reply" : "system",
    intent: item.domainRefs.some((ref) => ref.type === "task") ? "task" : "discuss",
    authorType: item.actorType === "local_user"
      ? "local-user"
      : item.actorType === "ling_agent" || item.actorType === "teammate"
        ? "ai-teammate"
        : "system",
    ...(item.actorId ? { authorId: item.actorId } : {}),
    body: projectBody(item),
    mentions: item.kind === "user_message" ? item.payload.mentions.map(projectMention) : [],
    attachmentIds: item.kind === "user_message" ? item.payload.attachmentIds : [],
    linkPreviewIds: item.kind === "user_message" ? item.payload.linkPreviewIds : [],
    fileRefs: item.kind === "user_message" ? item.payload.fileRefs.map(projectFileRef) : [],
    ...(item.kind === "user_message" && item.payload.replyToItemId
      ? { replyToItemId: item.payload.replyToItemId }
      : {}),
    linkedTaskId: item.domainRefs.find((ref) => ref.type === "task")?.id,
    linkedRunId: options.linkedRunId ?? item.domainRefs.find((ref) => ref.type === "run")?.id,
    status: projectStatus(item),
    errorMessage: item.kind === "assistant_message" ? item.payload.errorMessage : undefined,
    revision: item.revision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function isChannelMessageConversationItem(item: ConversationItemV1): boolean {
  return item.kind === "user_message" || item.kind === "assistant_message" || item.kind === "system_event";
}

function projectBody(item: ConversationItemV1): string {
  switch (item.kind) {
    case "user_message":
    case "assistant_message":
      return item.payload.body;
    case "tool_call":
      return item.payload.title ?? item.payload.inputSummary ?? item.payload.toolName;
    case "tool_result":
      return item.payload.outputSummary ?? item.payload.errorCode ?? item.payload.status;
    case "approval_request":
      return item.payload.summary ?? item.payload.title;
    case "approval_decision":
      return item.payload.reason ?? item.payload.decision;
    case "handoff":
      return item.payload.summary;
    case "operation_state":
      return item.payload.summary ?? item.payload.title;
    case "artifact_ref":
      return item.payload.title ?? item.payload.artifactId;
    case "system_event":
      return item.payload.summary;
  }
}

function projectStatus(item: ConversationItemV1): ChannelMessage["status"] {
  if (item.status === "pending") return "pending";
  if (item.status === "failed") return "failed";
  if (item.kind === "assistant_message") {
    if (item.payload.deliveryStatus === "blocked") return "blocked";
    if (item.payload.deliveryStatus === "failed") return "failed";
    if (item.payload.deliveryStatus === "pending") return "pending";
  }
  return "ready";
}

function projectMention(mention: ConversationMessageMentionV1): ChannelMention {
  return {
    id: mention.id,
    label: mention.label,
    kind: mention.kind === "ai_teammate"
      ? "ai-teammate"
      : mention.kind === "local_user"
        ? "local-user"
        : "channel",
  };
}

function projectFileRef(ref: {
  readonly path: string;
  readonly label?: string;
  readonly source?: "composer" | "explicit_text" | "api";
  readonly line?: number;
}): ChannelMessageFileRef {
  return {
    path: ref.path,
    ...(ref.label ? { label: ref.label } : {}),
    ...(ref.source ? { source: ref.source } : {}),
    ...(ref.line !== undefined ? { line: ref.line } : {}),
  };
}
