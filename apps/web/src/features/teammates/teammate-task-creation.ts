import type { Channel, TeammateChannelMembership } from "../../types.js";

export function deriveActiveTeammateTaskChannels(
  channels: readonly Channel[],
  memberships: readonly TeammateChannelMembership[],
): readonly Channel[] {
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const seen = new Set<string>();
  const result: Channel[] = [];
  for (const membership of memberships) {
    const channel = channelById.get(membership.channelId);
    if (!channel || channel.status !== "active" || seen.has(channel.id)) continue;
    seen.add(channel.id);
    result.push(channel);
  }
  return result;
}

export function resolveTeammateTaskChannelId(
  requestedChannelId: string,
  channels: readonly Channel[],
  memberships: readonly TeammateChannelMembership[],
): string {
  if (requestedChannelId && channels.some((channel) => channel.id === requestedChannelId)) {
    return requestedChannelId;
  }
  const preferredMembership = memberships.find((membership) => membership.isDefault);
  if (preferredMembership && channels.some((channel) => channel.id === preferredMembership.channelId)) {
    return preferredMembership.channelId;
  }
  return channels[0]?.id ?? "";
}
