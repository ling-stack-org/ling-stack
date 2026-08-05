import {
  permissionModeForPreset,
  type AiTeammate,
  type Channel,
  type ChannelMessage,
  type LingThread,
  type RunStore,
} from "@ling-stack/core";
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
}): RunRequest {
  const thread = ensureChannelReplyThread(input.store, input.channel, input.sourceMessage);
  const permissionPreset = "read_only" as const;
  return {
    cwd: input.store.paths.cwd,
    workspaceCwd: input.store.paths.cwd,
    providerPresetId: input.providerPresetId,
    teammateId: input.teammateId,
    runnerId: input.teammate?.runnerId,
    threadId: thread.id,
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
    channelParallelLimit: input.channelParallelLimit,
    parentRunId: input.parentRunId,
    idempotencyKey: input.compactedRetry
      ? `channel_ai_reply:${input.sourceMessage.id}:${input.replyMessage.id}:compacted`
      : `channel_ai_reply:${input.sourceMessage.id}:${input.replyMessage.id}`,
    task: {
      id: input.sourceMessage.id,
      title: `Channel discussion in ${input.channel.name}`,
      prompt: input.prompt,
      channelId: input.channel.id,
    },
  };
}

export function ensureChannelReplyThread(
  store: RunStore,
  channel: Channel,
  sourceMessage: ChannelMessage,
): LingThread {
  if (sourceMessage.threadId) {
    const requested = store.getLingThread(sourceMessage.threadId);
    if (requested?.kind === "channel_discussion" && requested.channelId === channel.id && requested.status !== "archived") {
      return requested;
    }
  }

  const existing = store
    .listLingThreads({ kind: "channel_discussion", channelId: channel.id, archived: "exclude", limit: 100 })
    .find((thread) =>
      !thread.parentThreadId &&
      !thread.taskId &&
      !thread.teammateId &&
      !thread.workflowId &&
      !thread.workflowStepId &&
      !thread.externalWorkId
    );
  if (existing) {
    return existing;
  }

  return store.createLingThread({
    kind: "channel_discussion",
    channelId: channel.id,
    title: "Main branch",
    objective: `Main conversation branch for ${channel.name}.`,
    status: "open",
  }, new Date().toISOString());
}
