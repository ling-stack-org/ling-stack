import {
  resolveEffectiveTeammateProviderPresetId,
  type AiTeammate,
  type Channel,
  type RunStore,
} from "@ling-stack/core";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import { createLingAgentExecutor, isLingAgentExecutorId, LING_AGENT_EXECUTOR_ID } from "./ling-agent-executor.js";

export interface ChannelReplyExecutionTarget {
  readonly teammate?: AiTeammate;
  readonly teammateId: string;
  readonly providerPresetId?: string;
}

export function resolveChannelReplyExecutionTarget(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly requestedTeammateId?: string;
  readonly requestedProviderPresetId?: string;
  readonly now?: string;
}): ChannelReplyExecutionTarget {
  const requestedTeammateId = input.requestedTeammateId ?? LING_AGENT_EXECUTOR_ID;
  const teammate = isLingAgentExecutorId(requestedTeammateId)
    ? input.store.getAiTeammate(requestedTeammateId) ?? createLingAgentExecutor(input.now)
    : resolveAiTeammateReference(input.store, requestedTeammateId);
  const teammateId = teammate?.id ?? requestedTeammateId;
  const providerPresetId = teammate
    ? resolveEffectiveTeammateProviderPresetId({
        teammate,
        surface: "channel",
        requestedProviderPresetId: input.requestedProviderPresetId,
        workspaceDefaultProviderPresetId: input.store.getWorkspaceSettings().defaultProviderPresetId,
        channelDefaultProviderPresetId: input.channel.defaultProviderPresetId,
      })
    : input.requestedProviderPresetId ?? input.channel.defaultProviderPresetId;
  return {
    teammate,
    teammateId,
    providerPresetId,
  };
}
