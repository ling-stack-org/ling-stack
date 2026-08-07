import type { ChannelMessage, RunIntervention, RunSession, RunStore } from "@ling-stack/core";
import type { RunExecutionSink } from "../runs/orchestrator.js";
import { resolveChannelReplyExecutionTarget } from "./channel-reply-execution-target.js";
import {
  CHANNEL_PROMPT_LEAK_ERROR_MESSAGE,
  createChannelReplyRunProjection,
  isChannelReplyPromptLeak,
  visibleChannelReplyText,
} from "./channel-reply-run-projection.js";

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
  const sourceMessage = input.store.getChannelMessage(sourceMessageId);
  if (
    !sourceMessage ||
    sourceMessage.channelId !== channelId ||
    sourceMessage.authorType !== "local-user" ||
    sourceMessage.kind !== "message"
  ) {
    throw new Error(`Channel guidance source message is invalid: ${sourceMessageId}`);
  }

  const replyMessageId = channelContinuationReplyMessageId(input.intervention.id);
  const existingReply = input.store.getChannelMessage(replyMessageId);
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
    input.store.createChannelMessage({
      id: replyMessageId,
      channelId,
      threadId: sourceMessage.threadId ?? sourceMessage.id,
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "",
      status: "pending",
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
      const current = input.store.getChannelMessage(replyMessageId);
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
        return finishContinuationReply(input.store, replyMessageId, {
          body: "模型没有返回可显示内容，请重试或切换模型。",
          status: "failed",
          errorMessage: "Channel continuation completed without visible text.",
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
  return store.updateChannelMessageRuntime(messageId, input, new Date().toISOString())
    ?? store.getChannelMessage(messageId)!;
}
