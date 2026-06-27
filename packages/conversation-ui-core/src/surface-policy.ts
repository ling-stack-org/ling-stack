export type ConversationSurfaceKind =
  | "normal_conversation"
  | "channel_root"
  | "channel_branch"
  | "topic_reply"
  | "teammate_direct"
  | "run_thread";

export type ConversationEvidenceMode = "none" | "compact" | "rich";
export type ConversationWorkCellMode = "none" | "compact" | "rich";
export type ConversationRawDetailMode = "hidden" | "developer" | "rich";

export type MessageActionKind =
  | "copy"
  | "like"
  | "dislike"
  | "reply_topic"
  | "create_task"
  | "retry"
  | "open"
  | "download"
  | "custom";

export type SourceIconKind =
  | "web"
  | "open_url"
  | "memory"
  | "file"
  | "tool"
  | "artifact"
  | "app"
  | "policy";

export interface ConversationSurfacePolicy {
  readonly surface: ConversationSurfaceKind;
  readonly allowCopy: boolean;
  readonly allowFeedback: boolean;
  readonly allowTopicReply: boolean;
  readonly allowCreateTask: boolean;
  readonly allowRetry: boolean;
  readonly allowTeammateMentions: boolean;
  readonly allowMultiTeammateActivity: boolean;
  readonly showChannelRoster: boolean;
  readonly evidenceMode: ConversationEvidenceMode;
  readonly workCellMode: ConversationWorkCellMode;
  readonly rawDetailMode: ConversationRawDetailMode;
}

const conversationSurfacePolicies: Record<ConversationSurfaceKind, ConversationSurfacePolicy> = {
  normal_conversation: {
    surface: "normal_conversation",
    allowCopy: true,
    allowFeedback: true,
    allowTopicReply: false,
    allowCreateTask: false,
    allowRetry: false,
    allowTeammateMentions: false,
    allowMultiTeammateActivity: false,
    showChannelRoster: false,
    evidenceMode: "compact",
    workCellMode: "compact",
    rawDetailMode: "developer",
  },
  channel_root: {
    surface: "channel_root",
    allowCopy: true,
    allowFeedback: true,
    allowTopicReply: true,
    allowCreateTask: true,
    allowRetry: false,
    allowTeammateMentions: true,
    allowMultiTeammateActivity: true,
    showChannelRoster: true,
    evidenceMode: "compact",
    workCellMode: "compact",
    rawDetailMode: "developer",
  },
  channel_branch: {
    surface: "channel_branch",
    allowCopy: true,
    allowFeedback: true,
    allowTopicReply: true,
    allowCreateTask: true,
    allowRetry: false,
    allowTeammateMentions: true,
    allowMultiTeammateActivity: true,
    showChannelRoster: true,
    evidenceMode: "compact",
    workCellMode: "compact",
    rawDetailMode: "developer",
  },
  topic_reply: {
    surface: "topic_reply",
    allowCopy: true,
    allowFeedback: false,
    allowTopicReply: false,
    allowCreateTask: false,
    allowRetry: false,
    allowTeammateMentions: false,
    allowMultiTeammateActivity: false,
    showChannelRoster: false,
    evidenceMode: "compact",
    workCellMode: "none",
    rawDetailMode: "hidden",
  },
  teammate_direct: {
    surface: "teammate_direct",
    allowCopy: true,
    allowFeedback: false,
    allowTopicReply: false,
    allowCreateTask: true,
    allowRetry: false,
    allowTeammateMentions: false,
    allowMultiTeammateActivity: false,
    showChannelRoster: false,
    evidenceMode: "compact",
    workCellMode: "compact",
    rawDetailMode: "developer",
  },
  run_thread: {
    surface: "run_thread",
    allowCopy: true,
    allowFeedback: false,
    allowTopicReply: false,
    allowCreateTask: false,
    allowRetry: true,
    allowTeammateMentions: false,
    allowMultiTeammateActivity: false,
    showChannelRoster: false,
    evidenceMode: "rich",
    workCellMode: "rich",
    rawDetailMode: "rich",
  },
};

export function getConversationSurfacePolicy(surface: ConversationSurfaceKind): ConversationSurfacePolicy {
  return conversationSurfacePolicies[surface];
}

export function mergeConversationSurfacePolicy(
  surface: ConversationSurfaceKind,
  override: Partial<ConversationSurfacePolicy> | undefined,
): ConversationSurfacePolicy {
  return {
    ...getConversationSurfacePolicy(surface),
    ...override,
    surface,
  };
}

export function conversationActionAllowedByPolicy(
  kind: MessageActionKind,
  policy: ConversationSurfacePolicy,
): boolean {
  switch (kind) {
    case "copy":
      return policy.allowCopy;
    case "like":
    case "dislike":
      return policy.allowFeedback;
    case "reply_topic":
      return policy.allowTopicReply;
    case "create_task":
      return policy.allowCreateTask;
    case "retry":
      return policy.allowRetry;
    case "open":
    case "download":
    case "custom":
      return true;
  }
}
