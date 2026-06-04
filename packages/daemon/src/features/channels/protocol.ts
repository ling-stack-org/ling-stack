import type { Channel, ChannelBrief, ChannelContextSummaryTargetType, RunStore } from "@ling-stack/core";

export interface ChannelValidationError {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
}

export function validateChannelMessageOwner(
  store: RunStore,
  channelId: string,
  messageId: string,
): ChannelValidationError | undefined {
  const message = store.getChannelMessage(messageId);
  if (!message) {
    return {
      statusCode: 404,
      code: "message_not_found",
      message: `Channel message not found: ${messageId}`,
    };
  }
  if (message.channelId !== channelId) {
    return {
      statusCode: 400,
      code: "message_channel_mismatch",
      message: `Message does not belong to channel: ${messageId}`,
    };
  }
  return undefined;
}

export function validateProtocolSourceReferences(
  store: RunStore,
  channelId: string,
  input: { readonly sourceMessageId?: string; readonly sourceTaskId?: string; readonly sourceRunId?: string },
): ChannelValidationError | undefined {
  if (input.sourceMessageId) {
    const messageError = validateChannelMessageOwner(store, channelId, input.sourceMessageId);
    if (messageError) {
      return messageError.statusCode === 404 ? { ...messageError, statusCode: 400 } : messageError;
    }
  }
  if (input.sourceTaskId) {
    const task = store.getTask(input.sourceTaskId);
    if (!task) {
      return { statusCode: 400, code: "task_not_found", message: `Task not found: ${input.sourceTaskId}` };
    }
    if (task.channelId !== channelId) {
      return {
        statusCode: 400,
        code: "task_channel_mismatch",
        message: `Task does not belong to channel: ${input.sourceTaskId}`,
      };
    }
  }
  if (input.sourceRunId) {
    const run = store.getRun(input.sourceRunId);
    if (!run) {
      return { statusCode: 400, code: "run_not_found", message: `Run session not found: ${input.sourceRunId}` };
    }
    if (run.channelId !== channelId) {
      return {
        statusCode: 400,
        code: "run_channel_mismatch",
        message: `Run does not belong to channel: ${input.sourceRunId}`,
      };
    }
  }
  return undefined;
}

export function validateChannelDecisionOwner(
  store: RunStore,
  channelId: string,
  decisionId: string,
): ChannelValidationError | undefined {
  const decision = store.getChannelDecision(decisionId);
  if (!decision) {
    return { statusCode: 400, code: "decision_not_found", message: `Channel decision not found: ${decisionId}` };
  }
  if (decision.channelId !== channelId) {
    return {
      statusCode: 400,
      code: "decision_channel_mismatch",
      message: `Decision does not belong to channel: ${decisionId}`,
    };
  }
  return undefined;
}

export function validateChannelContextSummaryReferences(
  store: RunStore,
  channelId: string,
  input: {
    readonly targetType: ChannelContextSummaryTargetType;
    readonly targetId: string;
    readonly sourceMessageIds: readonly string[];
    readonly decisionIds: readonly string[];
  },
): ChannelValidationError | undefined {
  if (input.targetType === "task") {
    const target = store.getTask(input.targetId);
    if (!target) {
      return { statusCode: 400, code: "summary_target_not_found", message: `Task not found: ${input.targetId}` };
    }
    if (target.channelId !== channelId) {
      return {
        statusCode: 400,
        code: "summary_target_channel_mismatch",
        message: `Summary target does not belong to channel: ${input.targetId}`,
      };
    }
  } else if (!isThreadTargetInChannel(store, channelId, input.targetId)) {
    return { statusCode: 400, code: "summary_target_not_found", message: `Channel thread not found: ${input.targetId}` };
  }

  for (const messageId of input.sourceMessageIds) {
    const messageError = validateChannelMessageOwner(store, channelId, messageId);
    if (messageError) {
      return messageError.statusCode === 404 ? { ...messageError, statusCode: 400 } : messageError;
    }
  }
  for (const decisionId of input.decisionIds) {
    const decisionError = validateChannelDecisionOwner(store, channelId, decisionId);
    if (decisionError) {
      return decisionError;
    }
  }
  return undefined;
}

export function validateChannelMessageReferences(
  store: RunStore,
  channelId: string,
  attachmentIds: readonly string[],
  linkPreviewIds: readonly string[],
): ChannelValidationError | undefined {
  for (const attachmentId of attachmentIds) {
    const attachment = store.getChannelAttachment(attachmentId);
    if (!attachment) {
      return {
        statusCode: 404,
        code: "attachment_not_found",
        message: `Channel attachment not found: ${attachmentId}`,
      };
    }
    if (attachment.channelId !== channelId) {
      return {
        statusCode: 400,
        code: "attachment_channel_mismatch",
        message: `Attachment does not belong to channel: ${attachmentId}`,
      };
    }
  }

  for (const linkPreviewId of linkPreviewIds) {
    const linkPreview = store.getChannelLinkPreview(linkPreviewId);
    if (!linkPreview) {
      return {
        statusCode: 404,
        code: "link_preview_not_found",
        message: `Channel link preview not found: ${linkPreviewId}`,
      };
    }
    if (linkPreview.channelId !== channelId) {
      return {
        statusCode: 400,
        code: "link_preview_channel_mismatch",
        message: `Link preview does not belong to channel: ${linkPreviewId}`,
      };
    }
  }

  return undefined;
}

export function validateChannelBriefReferences(
  store: RunStore,
  channelId: string,
  input: {
    readonly decisionIds: readonly string[];
    readonly attachmentIds: readonly string[];
    readonly linkPreviewIds: readonly string[];
  },
): ChannelValidationError | undefined {
  for (const decisionId of input.decisionIds) {
    const error = validateChannelDecisionOwner(store, channelId, decisionId);
    if (error) {
      return error;
    }
  }
  const assetError = validateChannelMessageReferences(store, channelId, input.attachmentIds, input.linkPreviewIds);
  return assetError?.statusCode === 404 ? { ...assetError, statusCode: 400 } : assetError;
}

export function createEmptyChannelBrief(channel: Channel): ChannelBrief {
  return {
    id: `brief_${channel.id}`,
    workspaceId: channel.workspaceId,
    channelId: channel.id,
    objective: "",
    scope: "",
    acceptanceCriteria: [],
    openQuestions: [],
    risks: [],
    decisionIds: [],
    attachmentIds: [],
    linkPreviewIds: [],
    updatedBy: "system",
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

function isThreadTargetInChannel(store: RunStore, channelId: string, targetId: string): boolean {
  const directMessage = store.getChannelMessage(targetId);
  if (directMessage) {
    return directMessage.channelId === channelId;
  }
  return store.listChannelMessages({ channelId, threadId: targetId, limit: 1 }).length > 0;
}
