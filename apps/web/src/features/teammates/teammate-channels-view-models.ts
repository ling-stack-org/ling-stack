import type { Channel, TeammateChannelMembership } from "../../types.js";

export type TeammateChannelFilter = "all" | "active" | "paused" | "archived";
export type TeammateChannelAction = "join" | "leave" | "set-default";

export interface TeammateChannelRowActionViewModel {
  readonly id: TeammateChannelAction;
  readonly labelKey: "Join" | "Leave" | "Set default";
  readonly variant: "secondary" | "ghost";
  readonly disabled: boolean;
  readonly disabledReasonKey?: string;
}

export interface TeammateChannelRowViewModel {
  readonly channel: Channel;
  readonly joined: boolean;
  readonly isDefault: boolean;
  readonly lifecycleLabelKey: "active" | "paused" | "archived";
  readonly relationshipLabelKey: "Always joined" | "Default channel" | "Joined channel" | "Not joined";
  readonly relationshipTone: "neutral" | "info";
  readonly restrictionLabelKey?: string;
  readonly actions: readonly TeammateChannelRowActionViewModel[];
  readonly searchText: string;
}

export interface TeammateChannelStats {
  readonly total: number;
  readonly joined: number;
  readonly active: number;
  readonly paused: number;
  readonly archived: number;
}

export type TeammateChannelMembershipPayload = readonly {
  readonly channelId: string;
  readonly isDefault?: boolean;
}[];

export function mergeTeammateChannelCatalog(
  channels: readonly Channel[],
  archivedChannels: readonly Channel[],
): readonly Channel[] {
  const merged: Channel[] = [];
  const seen = new Set<string>();
  for (const channel of [...channels, ...archivedChannels]) {
    if (seen.has(channel.id)) continue;
    seen.add(channel.id);
    merged.push(channel);
  }
  return merged;
}

export function channelFilterLabelKey(filter: TeammateChannelFilter): string {
  if (filter === "active") return "Active channels";
  if (filter === "paused") return "Paused channels";
  if (filter === "archived") return "Archived channels";
  return "All channels";
}

export function buildTeammateChannelRows(input: {
  readonly channels: readonly Channel[];
  readonly memberships: readonly TeammateChannelMembership[];
  readonly protectedTeammate: boolean;
}): readonly TeammateChannelRowViewModel[] {
  const membershipByChannelId = new Map(input.memberships.map((membership) => [membership.channelId, membership]));
  return input.channels.map((channel) => {
    const membership = membershipByChannelId.get(channel.id);
    const joined = input.protectedTeammate || Boolean(membership);
    const isDefault = !input.protectedTeammate && Boolean(membership?.isDefault);
    return {
      channel,
      joined,
      isDefault,
      lifecycleLabelKey: channel.status,
      relationshipLabelKey: input.protectedTeammate
        ? "Always joined"
        : isDefault
          ? "Default channel"
          : joined
            ? "Joined channel"
            : "Not joined",
      relationshipTone: input.protectedTeammate || isDefault ? "info" : "neutral",
      restrictionLabelKey: restrictionLabelKey(channel.status, joined),
      actions: buildRowActions(channel.status, joined, isDefault, input.protectedTeammate),
      searchText: channel.name.toLocaleLowerCase(),
    };
  });
}

export function filterTeammateChannelRows(
  rows: readonly TeammateChannelRowViewModel[],
  query: string,
  filter: TeammateChannelFilter,
): readonly TeammateChannelRowViewModel[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (normalizedQuery && !row.searchText.includes(normalizedQuery)) return false;
    return filter === "all" || row.channel.status === filter;
  });
}

export function summarizeTeammateChannels(rows: readonly TeammateChannelRowViewModel[]): TeammateChannelStats {
  return rows.reduce<TeammateChannelStats>((stats, row) => ({
    total: stats.total + 1,
    joined: stats.joined + (row.joined ? 1 : 0),
    active: stats.active + (row.channel.status === "active" ? 1 : 0),
    paused: stats.paused + (row.channel.status === "paused" ? 1 : 0),
    archived: stats.archived + (row.channel.status === "archived" ? 1 : 0),
  }), { total: 0, joined: 0, active: 0, paused: 0, archived: 0 });
}

export function deriveTeammateChannelMutationPayload(input: {
  readonly action: TeammateChannelAction;
  readonly channelId: string;
  readonly channels: readonly Channel[];
  readonly memberships: readonly TeammateChannelMembership[];
  readonly protectedTeammate: boolean;
}): TeammateChannelMembershipPayload | undefined {
  if (input.protectedTeammate) return undefined;
  const channel = input.channels.find((candidate) => candidate.id === input.channelId);
  if (!channel) return undefined;

  const current = normalizeMembershipPayload(input.memberships);
  const existing = current.find((membership) => membership.channelId === channel.id);
  if (input.action === "join") {
    if (channel.status !== "active" || existing) return undefined;
    return [...current, { channelId: channel.id, isDefault: false }];
  }
  if (input.action === "leave") {
    if (!existing) return undefined;
    return current.filter((membership) => membership.channelId !== channel.id);
  }
  if (channel.status !== "active" || !existing || existing.isDefault) return undefined;
  return current.map((membership) => ({
    channelId: membership.channelId,
    isDefault: membership.channelId === channel.id,
  }));
}

function normalizeMembershipPayload(
  memberships: readonly TeammateChannelMembership[],
): TeammateChannelMembershipPayload {
  const seen = new Set<string>();
  let defaultAssigned = false;
  const result: { channelId: string; isDefault: boolean }[] = [];
  for (const membership of memberships) {
    if (seen.has(membership.channelId)) continue;
    seen.add(membership.channelId);
    const isDefault = Boolean(membership.isDefault && !defaultAssigned);
    if (isDefault) defaultAssigned = true;
    result.push({ channelId: membership.channelId, isDefault });
  }
  return result;
}

function buildRowActions(
  status: Channel["status"],
  joined: boolean,
  isDefault: boolean,
  protectedTeammate: boolean,
): readonly TeammateChannelRowActionViewModel[] {
  if (protectedTeammate) return [];
  if (status !== "active") {
    if (joined) return [{ id: "leave", labelKey: "Leave", variant: "ghost", disabled: false }];
    return [{
      id: "join",
      labelKey: "Join",
      variant: "secondary",
      disabled: true,
      disabledReasonKey: status === "paused"
        ? "Paused channels cannot be joined or set as default."
        : "Archived channels cannot be joined or set as default.",
    }];
  }
  if (!joined) return [{ id: "join", labelKey: "Join", variant: "secondary", disabled: false }];
  if (isDefault) return [{ id: "leave", labelKey: "Leave", variant: "ghost", disabled: false }];
  return [
    { id: "set-default", labelKey: "Set default", variant: "secondary", disabled: false },
    { id: "leave", labelKey: "Leave", variant: "ghost", disabled: false },
  ];
}

function restrictionLabelKey(status: Channel["status"], joined: boolean): string | undefined {
  if (status === "active") return undefined;
  if (status === "paused") {
    return joined
      ? "Paused channel relationships can only be removed."
      : "Paused channels cannot be joined or set as default.";
  }
  return joined
    ? "Archived channel relationships can only be removed."
    : "Archived channels cannot be joined or set as default.";
}
