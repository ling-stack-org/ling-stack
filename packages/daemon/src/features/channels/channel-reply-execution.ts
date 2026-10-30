import {
  permissionModeForPreset,
  type AiTeammate,
  type Channel,
  type ChannelMessage,
  type LingThread,
  type RunStore,
} from "@ling-stack/core";
import { resolveChannelConversationThread } from "./conversation-thread-resolution.js";
import { HttpError } from "../../errors.js";
import type { ConversationContextProjectionMetadata } from "@ling-stack/contracts";
import type { RunRequest } from "../runs/schemas.js";

export function buildChannelReplyRunRequest(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly replyMessage: ChannelMessage;
  readonly teammate: AiTeammate | undefined;
  readonly teammateId: string;
  readonly providerPresetId: string;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly channelParallelLimit?: number;
  readonly parentRunId?: string;
  readonly compactedRetry?: boolean;
  readonly recoveryAttempt?: number;
  readonly contextProjection: ConversationContextProjectionMetadata;
}): RunRequest {
  const thread = ensureChannelReplyThread(input.store, input.channel, input.sourceMessage);
  const sourceItem = input.store.getConversationItem(input.sourceMessage.id);
  if (!sourceItem?.turnId || sourceItem.threadId !== thread.id) {
    throw new Error(`Channel reply source item has no owning turn: ${input.sourceMessage.id}`);
  }
  const permissionPreset = "read_only" as const;
  return {
    cwd: input.store.paths.cwd,
    workspaceCwd: input.store.paths.cwd,
    providerPresetId: input.providerPresetId,
    teammateId: input.teammateId,
    runnerId: input.teammate?.runnerId,
    threadId: thread.id,
    turnId: sourceItem.turnId,
    sourceMessageId: input.sourceMessage.id,
    linkedMessageId: input.replyMessage.id,
    createdByActor: input.sourceMessage.authorType === "local-user" ? "local-user" : "system",
    tools: [],
    authorizationMode: "always",
    workspaceAccessMode: "read_only",
    permissionPreset,
    permissionMode: permissionModeForPreset(permissionPreset),
    thinkingLevel: "medium",
    systemPrompt: input.systemPrompt,
    skipMemoryRecall: true,
    contextProjection: input.contextProjection,
    channelParallelLimit: input.channelParallelLimit,
    parentRunId: input.parentRunId,
    idempotencyKey: channelReplyIdempotencyKey(input),
    task: {
      id: input.sourceMessage.id,
      title: `Channel discussion in ${input.channel.name}`,
      prompt: input.prompt,
      channelId: input.channel.id,
    },
  };
}

function channelReplyIdempotencyKey(input: {
  readonly sourceMessage: ChannelMessage;
  readonly replyMessage: ChannelMessage;
  readonly compactedRetry?: boolean;
  readonly recoveryAttempt?: number;
}): string {
  const base = `channel_ai_reply:${input.sourceMessage.id}:${input.replyMessage.id}`;
  const recovery = input.recoveryAttempt && input.recoveryAttempt > 0
    ? `${base}:recovery:${input.recoveryAttempt}`
    : base;
  return input.compactedRetry ? `${recovery}:compacted` : recovery;
}

export function ensureChannelReplyThread(
  store: RunStore,
  channel: Channel,
  sourceMessage: ChannelMessage,
): LingThread {
  if (sourceMessage.threadId) {
    const requested = store.getLingThread(sourceMessage.threadId);
    if (requested?.kind === "channel_discussion" && requested.channelId === channel.id && requested.status !== "archived" && !requested.archivedAt) {
      return requested;
    }
    throw new HttpError(409, "conversation_thread_unavailable", `Reply source thread is unavailable: ${sourceMessage.threadId}`);
  }

  return resolveChannelConversationThread({ store, channel, now: new Date().toISOString() });
}
