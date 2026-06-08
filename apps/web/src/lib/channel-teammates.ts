import type { AiTeammate, Channel, TeammateChannelMembership } from "../types.js";

export function deriveSelectedChannelTeammateMemberships(input: {
  readonly channel: Channel | undefined;
  readonly teammates: readonly AiTeammate[];
  readonly membershipsByTeammate: Readonly<Record<string, readonly TeammateChannelMembership[]>>;
}): readonly TeammateChannelMembership[] {
  const { channel, membershipsByTeammate, teammates } = input;
  if (!channel) {
    return [];
  }

  const memberships = Object.values(membershipsByTeammate)
    .flat()
    .filter((membership) => membership.channelId === channel.id);
  const byTeammateId = new Map(memberships.map((membership) => [membership.teammateId, membership]));
  if (
    channel.defaultTeammateId &&
    teammates.some((teammate) => teammate.id === channel.defaultTeammateId) &&
    !byTeammateId.has(channel.defaultTeammateId)
  ) {
    const membership: TeammateChannelMembership = {
      teammateId: channel.defaultTeammateId,
      channelId: channel.id,
      isDefault: true,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    };
    memberships.push(membership);
    byTeammateId.set(membership.teammateId, membership);
  }

  return memberships.sort((left, right) => {
    const leftDefault = left.teammateId === channel.defaultTeammateId;
    const rightDefault = right.teammateId === channel.defaultTeammateId;
    if (leftDefault !== rightDefault) {
      return leftDefault ? -1 : 1;
    }
    return left.teammateId.localeCompare(right.teammateId);
  });
}

export function deriveEffectiveTeammateChannelMemberships(input: {
  readonly teammate: AiTeammate;
  readonly channels: readonly Channel[];
  readonly memberships: readonly TeammateChannelMembership[];
}): readonly TeammateChannelMembership[] {
  const { channels, memberships, teammate } = input;
  const byChannelId = new Map(memberships.map((membership) => [membership.channelId, membership]));
  const effective = [...memberships];
  for (const channel of channels) {
    if (channel.defaultTeammateId !== teammate.id || byChannelId.has(channel.id)) {
      continue;
    }
    effective.push({
      teammateId: teammate.id,
      channelId: channel.id,
      isDefault: true,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    });
  }
  return effective.sort((left, right) => {
    if (left.isDefault !== right.isDefault) {
      return left.isDefault ? -1 : 1;
    }
    return left.channelId.localeCompare(right.channelId);
  });
}
