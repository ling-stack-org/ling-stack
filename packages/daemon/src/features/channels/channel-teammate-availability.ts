import type { AiTeammate, Channel, ChannelExecutionProposalStepSource, RunStore } from "@ling-stack/core";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import { resolveEffectiveChannelCollaborationProtocol } from "./collaboration-protocol.js";
import { isLingAgentExecutorId } from "./ling-agent-executor.js";

export interface EffectiveChannelAiTeammateEntry {
  readonly teammate: AiTeammate;
  readonly sources: readonly ChannelExecutionProposalStepSource[];
  readonly isDefault: boolean;
}

export function listEffectiveChannelAiTeammateEntries(store: RunStore, channel: Channel): readonly EffectiveChannelAiTeammateEntry[] {
  const activeTeammates = store
    .readAiTeammates({ status: "active", includeHidden: false, limit: 100 })
    .filter((teammate) => !isLingAgentExecutorId(teammate.id));
  const activeById = new Map(activeTeammates.map((teammate) => [teammate.id, teammate]));
  const selected = new Map<string, { teammate: AiTeammate; sources: ChannelExecutionProposalStepSource[]; isDefault: boolean }>();
  const add = (teammate: AiTeammate | undefined, sources: readonly ChannelExecutionProposalStepSource[], isDefault = false): void => {
    if (!teammate || !activeById.has(teammate.id)) {
      return;
    }
    const existing = selected.get(teammate.id);
    if (existing) {
      existing.sources.push(...sources);
      existing.isDefault = existing.isDefault || isDefault;
      return;
    }
    selected.set(teammate.id, { teammate, sources: [...sources], isDefault });
  };

  for (const teammate of activeTeammates) {
    const directSource = directChannelSourceForTeammate(store, channel, teammate.id);
    if (directSource) {
      add(teammate, [directSource], directSource.isDefault === true);
    }
  }

  const effectiveCouncil = store.getEffectiveChannelCouncil(channel.id);
  for (const specialist of effectiveCouncil?.specialists ?? []) {
    const councilSources = specialist.sources.filter((source) => source.kind === "council");
    if (councilSources.length > 0) {
      add(activeById.get(specialist.teammateId) ?? specialist.teammate, councilSources, specialist.isDefault);
    }
  }

  return [...selected.values()].map((entry) => ({
    teammate: entry.teammate,
    sources: uniqueSources(entry.sources),
    isDefault: entry.isDefault,
  }));
}

export function listEffectiveChannelAiTeammates(store: RunStore, channel: Channel): readonly AiTeammate[] {
  return listEffectiveChannelAiTeammateEntries(store, channel).map((entry) => entry.teammate);
}

export function teammateCanWorkInEffectiveChannel(store: RunStore, channel: Channel, teammateId: string): boolean {
  if (isLingAgentExecutorId(teammateId)) {
    return true;
  }
  if (directChannelSourceForTeammate(store, channel, teammateId)) {
    return true;
  }
  return store.getEffectiveChannelCouncil(channel.id)?.specialists.some((specialist) => specialist.teammateId === teammateId) ?? false;
}

function directChannelSourceForTeammate(store: RunStore, channel: Channel, teammateId: string): ChannelExecutionProposalStepSource | undefined {
  const protocol = resolveEffectiveChannelCollaborationProtocol({ store, channel });
  const defaultTeammate = protocol.protocol.defaultTeammateId
    ? resolveAiTeammateReference(store, protocol.protocol.defaultTeammateId)
    : undefined;
  const isDefault = protocol.protocol.defaultTeammateId === teammateId || defaultTeammate?.id === teammateId;
  const directMembership = store.listTeammateChannelMemberships(teammateId).find((membership) => membership.channelId === channel.id);
  if (!directMembership && !isDefault) {
    return undefined;
  }
  return {
    kind: "direct",
    isDefault: isDefault || directMembership?.isDefault === true,
  };
}

function uniqueSources(sources: readonly ChannelExecutionProposalStepSource[]): readonly ChannelExecutionProposalStepSource[] {
  const selected: ChannelExecutionProposalStepSource[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const key = [
      source.kind,
      source.councilId ?? "",
      source.slotKey ?? "",
      source.label ?? "",
      source.isDefault === true ? "default" : "",
    ].join(":");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push(source);
  }
  return selected;
}
