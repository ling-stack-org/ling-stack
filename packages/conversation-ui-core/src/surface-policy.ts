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
  | "edit_latest"
  | "reply_topic"
  | "fork"
  | "create_task"
  | "retry"
  | "open_reference"
  | "open_artifact"
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
  readonly allowThreadFork: boolean;
  readonly allowLatestUserMessageEdit: boolean;
  readonly allowCreateTask: boolean;
  readonly allowRetry: boolean;
  readonly allowToolExecution: boolean;
  readonly allowTeammateMentions: boolean;
  readonly allowMultiTeammateActivity: boolean;
  readonly showUserAvatar: boolean;
  readonly showAgentAvatar: boolean;
  readonly showChannelRoster: boolean;
  readonly showTerminalReportParticipants: boolean;
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
    allowThreadFork: true,
    allowLatestUserMessageEdit: true,
    allowCreateTask: false,
    allowRetry: false,
    allowToolExecution: true,
    allowTeammateMentions: false,
    allowMultiTeammateActivity: false,
    showUserAvatar: false,
    showAgentAvatar: false,
    showChannelRoster: false,
    showTerminalReportParticipants: false,
    evidenceMode: "compact",
    workCellMode: "compact",
    rawDetailMode: "developer",
  },
  channel_root: {
    surface: "channel_root",
    allowCopy: true,
    allowFeedback: true,
    allowTopicReply: true,
    allowThreadFork: true,
    allowLatestUserMessageEdit: true,
    allowCreateTask: true,
    allowRetry: false,
    allowToolExecution: true,
    allowTeammateMentions: true,
    allowMultiTeammateActivity: true,
    showUserAvatar: true,
    showAgentAvatar: true,
    showChannelRoster: true,
    showTerminalReportParticipants: true,
    evidenceMode: "compact",
    workCellMode: "compact",
    rawDetailMode: "developer",
  },
  channel_branch: {
    surface: "channel_branch",
    allowCopy: true,
    allowFeedback: true,
    allowTopicReply: true,
    allowThreadFork: true,
    allowLatestUserMessageEdit: true,
    allowCreateTask: true,
    allowRetry: false,
    allowToolExecution: true,
    allowTeammateMentions: true,
    allowMultiTeammateActivity: true,
    showUserAvatar: true,
    showAgentAvatar: true,
    showChannelRoster: true,
    showTerminalReportParticipants: true,
    evidenceMode: "compact",
    workCellMode: "compact",
    rawDetailMode: "developer",
  },
  topic_reply: {
    surface: "topic_reply",
    allowCopy: true,
    allowFeedback: false,
    allowTopicReply: false,
    allowThreadFork: false,
    allowLatestUserMessageEdit: true,
    allowCreateTask: false,
    allowRetry: false,
    allowToolExecution: false,
    allowTeammateMentions: false,
    allowMultiTeammateActivity: false,
    showUserAvatar: true,
    showAgentAvatar: true,
    showChannelRoster: false,
    showTerminalReportParticipants: false,
    evidenceMode: "compact",
    workCellMode: "none",
    rawDetailMode: "hidden",
  },
  teammate_direct: {
    surface: "teammate_direct",
    allowCopy: true,
    allowFeedback: true,
    allowTopicReply: false,
    allowThreadFork: false,
    allowLatestUserMessageEdit: true,
    allowCreateTask: true,
    allowRetry: false,
    allowToolExecution: true,
    allowTeammateMentions: false,
    allowMultiTeammateActivity: false,
    showUserAvatar: true,
    showAgentAvatar: true,
    showChannelRoster: false,
    showTerminalReportParticipants: false,
    evidenceMode: "compact",
    workCellMode: "compact",
    rawDetailMode: "developer",
  },
  run_thread: {
    surface: "run_thread",
    allowCopy: true,
    allowFeedback: false,
    allowTopicReply: false,
    allowThreadFork: false,
    allowLatestUserMessageEdit: false,
    allowCreateTask: false,
    allowRetry: true,
    allowToolExecution: true,
    allowTeammateMentions: false,
    allowMultiTeammateActivity: false,
    showUserAvatar: false,
    showAgentAvatar: true,
    showChannelRoster: false,
    showTerminalReportParticipants: false,
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
    case "edit_latest":
      return policy.allowLatestUserMessageEdit;
    case "reply_topic":
      return policy.allowTopicReply;
    case "fork":
      return policy.allowThreadFork;
    case "create_task":
      return policy.allowCreateTask;
    case "retry":
      return policy.allowRetry;
    case "open_reference":
    case "open_artifact":
    case "open":
    case "download":
    case "custom":
      return true;
  }
}
