/**
 * Product surface controls the shell around a transcript. It deliberately
 * does not select a renderer, change row geometry, hide facts, or decide
 * completion. Those concerns belong to the canonical projector and the
 * exhaustive ConversationTimeline registry.
 */
export type ConversationInteractionSurfaceKind =
  | "normal_conversation"
  | "channel_root"
  | "channel_branch"
  | "topic_reply"
  | "teammate_direct"
  | "run_thread";

export type ConversationTimelineScopeKind =
  | "normal"
  | "private"
  | "channel_root"
  | "topic"
  | "branch"
  | "run_detail"
  | "child";

export interface ConversationTimelineScope {
  readonly kind: ConversationTimelineScopeKind;
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly anchorItemId: string | null;
  readonly depth: 0 | 1;
}

export interface ConversationInteractionPolicy {
  readonly surface: ConversationInteractionSurfaceKind;
  readonly allowCopy: boolean;
  readonly allowFeedback: boolean;
  readonly allowTopicReply: boolean;
  readonly allowThreadFork: boolean;
  readonly allowLatestUserMessageEdit: boolean;
  readonly allowCreateTask: boolean;
  readonly allowRetry: boolean;
  readonly allowToolExecution: boolean;
  readonly showUserAvatar: boolean;
  readonly showAgentAvatar: boolean;
  readonly showRoster: boolean;
  readonly allowMentions: boolean;
  readonly allowMultiAgent: boolean;
  readonly showTerminalReportParticipants: boolean;
  readonly modelControl: "picker" | "readonly" | "hidden";
  readonly permissionControl: "editable" | "readonly" | "hidden";
  readonly allowedDetailTargets: readonly (
    "open_file" | "open_diff" | "open_artifact" | "open_run"
  )[];
}

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

const allDetailTargets: ConversationInteractionPolicy["allowedDetailTargets"] = [
  "open_file",
  "open_diff",
  "open_artifact",
  "open_run",
];

const conversationInteractionPolicies: Record<
  ConversationInteractionSurfaceKind,
  ConversationInteractionPolicy
> = {
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
    showUserAvatar: false,
    showAgentAvatar: false,
    showRoster: false,
    allowMentions: false,
    allowMultiAgent: false,
    showTerminalReportParticipants: false,
    modelControl: "picker",
    permissionControl: "editable",
    allowedDetailTargets: allDetailTargets,
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
    showUserAvatar: true,
    showAgentAvatar: true,
    showRoster: true,
    allowMentions: true,
    allowMultiAgent: true,
    showTerminalReportParticipants: true,
    modelControl: "picker",
    permissionControl: "editable",
    allowedDetailTargets: allDetailTargets,
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
    showUserAvatar: true,
    showAgentAvatar: true,
    showRoster: true,
    allowMentions: true,
    allowMultiAgent: true,
    showTerminalReportParticipants: true,
    modelControl: "picker",
    permissionControl: "editable",
    allowedDetailTargets: allDetailTargets,
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
    showUserAvatar: true,
    showAgentAvatar: true,
    showRoster: false,
    allowMentions: false,
    allowMultiAgent: false,
    showTerminalReportParticipants: false,
    modelControl: "readonly",
    permissionControl: "readonly",
    allowedDetailTargets: allDetailTargets,
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
    showUserAvatar: true,
    showAgentAvatar: true,
    showRoster: false,
    allowMentions: false,
    allowMultiAgent: false,
    showTerminalReportParticipants: false,
    modelControl: "readonly",
    permissionControl: "editable",
    allowedDetailTargets: allDetailTargets,
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
    showUserAvatar: false,
    showAgentAvatar: true,
    showRoster: false,
    allowMentions: false,
    allowMultiAgent: false,
    showTerminalReportParticipants: false,
    modelControl: "readonly",
    permissionControl: "readonly",
    allowedDetailTargets: allDetailTargets,
  },
};

export function getConversationInteractionPolicy(
  surface: ConversationInteractionSurfaceKind,
): ConversationInteractionPolicy {
  return conversationInteractionPolicies[surface];
}

export function mergeConversationInteractionPolicy(
  surface: ConversationInteractionSurfaceKind,
  override: Partial<ConversationInteractionPolicy> | undefined,
): ConversationInteractionPolicy {
  return {
    ...getConversationInteractionPolicy(surface),
    ...override,
    surface,
  };
}

/**
 * Pure surface-to-scope mapping. Topology validation happens in the adapter;
 * this function never invents ids or inspects display text.
 */
export function resolveTimelineScope(input: {
  readonly surface: ConversationInteractionSurfaceKind;
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly anchorItemId: string | null;
  readonly childParticipantId?: string;
}): ConversationTimelineScope {
  if (input.childParticipantId) {
    return {
      kind: "child",
      threadId: input.threadId,
      parentThreadId: input.parentThreadId,
      anchorItemId: input.anchorItemId,
      depth: 1,
    };
  }
  const kindBySurface: Record<
    ConversationInteractionSurfaceKind,
    Exclude<ConversationTimelineScopeKind, "child">
  > = {
    normal_conversation: "normal",
    teammate_direct: "private",
    channel_root: "channel_root",
    topic_reply: "topic",
    channel_branch: "branch",
    run_thread: "run_detail",
  };
  return {
    kind: kindBySurface[input.surface],
    threadId: input.threadId,
    parentThreadId: input.parentThreadId,
    anchorItemId: input.anchorItemId,
    depth: 0,
  };
}

export function conversationActionAllowedByPolicy(
  kind: MessageActionKind,
  policy: ConversationInteractionPolicy,
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
