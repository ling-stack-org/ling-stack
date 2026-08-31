import type { ChannelMessage, RunIntervention, RunSession, RunStore } from "@ling-stack/core";
import { formatServerCatalogMessage } from "@ling-stack/localization";
import type { RunExecutionSink } from "../runs/orchestrator.js";
import { resolveChannelReplyExecutionTarget } from "./channel-reply-execution-target.js";
import {
  CHANNEL_PROMPT_LEAK_ERROR_MESSAGE,
  createChannelReplyRunProjection,
  isChannelReplyPromptLeak,
  visibleChannelReplyText,
} from "./channel-reply-run-projection.js";
import {
  getChannelMessageView,
  updatePendingAssistantMessage,
} from "./conversation-item-messages.js";
import { runHasConversationGeneratedMedia } from "../media/conversation-projection.js";
import { resolveChannelResponseLanguage } from "./response-language.js";

export interface ChannelReplyContinuationProjection {
  readonly sourceMessageId: string;
  readonly replyMessageId: string;
  readonly sink: RunExecutionSink;
  finalize(run: RunSession | undefined, fallbackError?: string): ChannelMessage;
}

export function createChannelReplyContinuationProjection(input: {
  readonly store: RunStore;
  readonly sourceRun: RunSession;
  readonly intervention: RunIntervention;
}): ChannelReplyContinuationProjection | undefined {
  const channelId = input.sourceRun.channelId;
  const sourceMessageId = input.intervention.messagePayload?.sourceMessageId;
  if (!channelId || !sourceMessageId) {
    return undefined;
  }
  const sourceMessage = getChannelMessageView(input.store, sourceMessageId);
  if (
    !sourceMessage ||
    sourceMessage.channelId !== channelId ||
    sourceMessage.authorType !== "local-user" ||
    sourceMessage.kind !== "message"
  ) {
    throw new Error(`Channel guidance source message is invalid: ${sourceMessageId}`);
  }

  const replyMessageId = channelContinuationReplyMessageId(input.intervention.id);
  const existingReply = getChannelMessageView(input.store, replyMessageId);
  const channel = input.store.getChannel(channelId);
  if (!channel) {
    throw new Error(`Channel continuation channel was not found: ${channelId}`);
  }
  const teammateId = resolveChannelReplyExecutionTarget({
    store: input.store,
    channel,
    requestedTeammateId: input.intervention.messagePayload?.targetTeammateId ?? input.sourceRun.teammateId,
    now: input.intervention.createdAt,
  }).teammateId;
  if (!existingReply) {
    const sourceItem = input.store.getConversationItem(sourceMessageId);
    if (!sourceItem?.turnId) {
      throw new Error(`Channel guidance source item has no owning turn: ${sourceMessageId}`);
    }
    input.store.appendConversationItem({
      id: replyMessageId,
      channelId,
      threadId: sourceItem.threadId,
      turnId: sourceItem.turnId,
      kind: "assistant_message",
      status: "pending",
      actorType: teammateId === "ling_agent" ? "ling_agent" : "teammate",
      actorId: teammateId,
      visibility: "channel",
      payload: {
        body: "",
        format: "markdown",
        streaming: true,
        deliveryStatus: "pending",
      },
      domainRefs: [{ type: "conversation_item", id: sourceItem.id }],
      idempotencyKey: `assistant-reply:${replyMessageId}`,
    }, new Date().toISOString());
  }

  const projection = createChannelReplyRunProjection({
    store: input.store,
    pendingMessageId: replyMessageId,
  });
  return {
    sourceMessageId,
    replyMessageId,
    sink: projection.sink,
    finalize(run, fallbackError) {
      const current = getChannelMessageView(input.store, replyMessageId);
      if (!run) {
        return finishContinuationReply(input.store, replyMessageId, {
          body: "Agent 回复未能启动，请重试。",
          status: "failed",
          errorMessage: fallbackError ?? projection.error() ?? "Channel continuation failed to start.",
        });
      }
      if (run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval") {
        return current!;
      }
      if (run.status === "cancelled") {
        return finishContinuationReply(input.store, replyMessageId, {
          body: "回复已停止。",
          status: "blocked",
          errorMessage: run.errorMessage ?? "Channel continuation was cancelled.",
        });
      }
      if (run.status === "failed") {
        return finishContinuationReply(input.store, replyMessageId, {
          body: "Agent 回复失败，请重试。",
          status: "failed",
          errorMessage: run.errorMessage ?? projection.error() ?? fallbackError ?? "Channel continuation failed.",
        });
      }

      const rawText = projection.rawText().trim() || readPersistedAssistantText(input.store, run.id);
      if (projection.promptLeakDetected() || isChannelReplyPromptLeak(rawText)) {
        return finishContinuationReply(input.store, replyMessageId, {
          body: "Agent 回复因包含内部上下文而被阻止。",
          status: "blocked",
          errorMessage: CHANNEL_PROMPT_LEAK_ERROR_MESSAGE,
        });
      }
      const body = visibleChannelReplyText(rawText);
      if (!body) {
        if (runHasConversationGeneratedMedia(input.store, run.id)) {
          return finishContinuationReply(input.store, replyMessageId, {
            body: "",
            status: "ready",
            errorMessage: null,
          });
        }
        const emptyResponseLanguage = resolveChannelResponseLanguage({
          store: input.store,
          channel,
          sourceText: sourceMessage.body,
        }).language;
        const emptyResponseMessage = formatServerCatalogMessage(
          emptyResponseLanguage,
          "daemon.conversation.empty_result",
        );
        return finishContinuationReply(input.store, replyMessageId, {
          body: emptyResponseMessage,
          status: "failed",
          errorMessage: emptyResponseMessage,
        });
      }
      return finishContinuationReply(input.store, replyMessageId, {
        body,
        status: "ready",
        errorMessage: null,
      });
    },
  };
}

function readPersistedAssistantText(store: RunStore, runId: string): string {
  let text = "";
  for (const event of store.listEvents(runId)) {
    if (event.type === "assistant_text_delta") {
      text += readEventText(event.data);
      continue;
    }
    if (event.type === "message_end" && !text.trim()) {
      text = readEventText(event.data);
    }
  }
  return text.trim();
}

function readEventText(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "";
  }
  const text = (value as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
}

function channelContinuationReplyMessageId(interventionId: string): string {
  return `msg_channel_continuation_${interventionId}`;
}

function finishContinuationReply(
  store: RunStore,
  messageId: string,
  input: {
    readonly body: string;
    readonly status: ChannelMessage["status"];
    readonly errorMessage: string | null;
  },
): ChannelMessage {
  return updatePendingAssistantMessage({
    store,
    itemId: messageId,
    body: input.body,
    status: input.status,
    errorMessage: input.errorMessage,
    now: new Date().toISOString(),
  });
}
