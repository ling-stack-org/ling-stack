import type { AiCouncil, Channel, ChannelCouncilPolicy } from "../../types.js";

export type CouncilChannelMutationAction = "attach" | "detach" | "prefer";

export interface CouncilChannelPolicyMutationPayload {
  readonly attachedCouncilIds: readonly string[];
  readonly preferredCouncilId: string | null;
}

export interface CouncilChannelRelationshipRow {
  readonly council?: AiCouncil;
  readonly councilId: string;
  readonly preferred: boolean;
  readonly relationshipLabelKey: "Attached councils" | "Preferred";
  readonly relationshipTone: "info" | "neutral";
  readonly canDetach: boolean;
  readonly canPrefer: boolean;
  readonly restrictionLabelKey?: string;
}

export function mergeCouncilChannelCatalog(
  currentChannels: readonly Channel[],
  archivedChannels: readonly Channel[],
): readonly Channel[] {
  const result: Channel[] = [];
  const seen = new Set<string>();
  for (const channel of [...currentChannels, ...archivedChannels]) {
    if (seen.has(channel.id)) continue;
    seen.add(channel.id);
    result.push(channel);
  }
  return result;
}

export function buildCouncilChannelRelationshipRows(input: {
  readonly councils: readonly AiCouncil[];
  readonly policy?: ChannelCouncilPolicy;
  readonly selectedChannel?: Channel;
}): readonly CouncilChannelRelationshipRow[] {
  const councilById = new Map(input.councils.map((council) => [council.id, council]));
  const attachedCouncilIds = normalizeIds(input.policy?.attachedCouncilIds ?? []);
  return attachedCouncilIds.map((councilId) => {
    const council = councilById.get(councilId);
    const preferred = input.policy?.preferredCouncilId === councilId;
    const mutableChannel = input.selectedChannel?.status === "active";
    return {
      council,
      councilId,
      preferred,
      relationshipLabelKey: preferred ? "Preferred" : "Attached councils",
      relationshipTone: preferred ? "info" : "neutral",
      canDetach: Boolean(input.selectedChannel),
      canPrefer: Boolean(council && mutableChannel && !preferred),
      restrictionLabelKey: channelRestrictionLabelKey(input.selectedChannel?.status),
    };
  });
}

export function deriveCouncilChannelPolicyMutation(input: {
  readonly action: CouncilChannelMutationAction;
  readonly councilId: string;
  readonly policy?: ChannelCouncilPolicy;
  readonly selectedChannel?: Channel;
}): CouncilChannelPolicyMutationPayload | undefined {
  if (!input.policy || !input.selectedChannel || !input.councilId) return undefined;
  const attachedCouncilIds = normalizeIds(input.policy.attachedCouncilIds);
  const preferredCouncilId = input.policy.preferredCouncilId;
  const attached = attachedCouncilIds.includes(input.councilId);

  if (input.action === "attach") {
    if (input.selectedChannel.status !== "active" || attached) return undefined;
    return {
      attachedCouncilIds: [...attachedCouncilIds, input.councilId],
      preferredCouncilId: preferredCouncilId ?? input.councilId,
    };
  }

  if (input.action === "prefer") {
    if (input.selectedChannel.status !== "active" || preferredCouncilId === input.councilId) return undefined;
    return {
      attachedCouncilIds: attached ? attachedCouncilIds : [...attachedCouncilIds, input.councilId],
      preferredCouncilId: input.councilId,
    };
  }

  if (!attached) return undefined;
  const nextIds = attachedCouncilIds.filter((councilId) => councilId !== input.councilId);
  return {
    attachedCouncilIds: nextIds,
    preferredCouncilId: preferredCouncilId === input.councilId
      ? (nextIds[0] ?? null)
      : (preferredCouncilId ?? null),
  };
}

export function channelRestrictionLabelKey(status: Channel["status"] | undefined): string | undefined {
  if (status === "paused") return "Paused channel relationships can only be removed.";
  if (status === "archived") return "Archived channel relationships can only be removed.";
  return undefined;
}

function normalizeIds(ids: readonly string[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}
