import type { AiTeammate, Channel, ChannelBranch, LingThread } from "../../types.js";

export type ArchivedCategoryId = "conversations" | "teammates" | "channels" | "branches";
export type ArchivedItemKind = "conversation" | "teammate" | "channel" | "branch";

export const archivedCategoryStorageKey = "ling-stack.settings.archived-category";
export const archivedCategoryIds: readonly ArchivedCategoryId[] = ["conversations", "teammates", "channels", "branches"];

export interface ArchivedCategoryDefinition {
  readonly id: ArchivedCategoryId;
  readonly labelKey: string;
  readonly emptyLabelKey: string;
}

export const archivedCategoryDefinitions: readonly ArchivedCategoryDefinition[] = [
  { id: "conversations", labelKey: "Conversations", emptyLabelKey: "No archived conversations" },
  { id: "teammates", labelKey: "AI Teammates", emptyLabelKey: "No archived teammates" },
  { id: "channels", labelKey: "Channels", emptyLabelKey: "No archived channels" },
  { id: "branches", labelKey: "Branches", emptyLabelKey: "No archived branches" },
];

export type ArchivedItemSource =
  | { readonly kind: "conversation"; readonly item: LingThread }
  | { readonly kind: "teammate"; readonly item: AiTeammate }
  | { readonly kind: "channel"; readonly item: Channel }
  | { readonly kind: "branch"; readonly item: ChannelBranch };

export interface ArchivedItemRowViewModel {
  readonly id: string;
  readonly key: string;
  readonly kind: ArchivedItemKind;
  readonly source: ArchivedItemSource;
  readonly displayName: string;
  readonly displayNameFallbackKey?: string;
  readonly searchValue: string;
  readonly archivedAt: string;
  readonly restoreActionId: string;
  readonly deleteActionId: string;
  readonly restoreLabelKey: "Restore" | "Restore both";
  readonly deleteLabelKey: "Delete conversation" | "Delete AI teammate" | "Delete channel" | "Delete branch";
}

export interface ArchivedDeleteTarget {
  readonly id: string;
  readonly kind: ArchivedItemKind;
  readonly source: ArchivedItemSource;
  readonly displayName: string;
  readonly displayNameFallbackKey?: string;
  readonly actionId: string;
}

export interface ArchivedItemsProjectionInput {
  readonly archivedChannels: readonly Channel[];
  readonly archiveParentChannelById: ReadonlyMap<string, Channel>;
  readonly archivedBranches: readonly ChannelBranch[];
  readonly archivedConversations: readonly LingThread[];
  readonly archivedTeammates: readonly AiTeammate[];
}

export function isArchivedCategoryId(value: string): value is ArchivedCategoryId {
  return archivedCategoryIds.includes(value as ArchivedCategoryId);
}

export function readArchivedCategoryPreference(): ArchivedCategoryId {
  try {
    const saved = globalThis.localStorage?.getItem(archivedCategoryStorageKey) ?? "";
    return isArchivedCategoryId(saved) ? saved : "conversations";
  } catch {
    return "conversations";
  }
}

export function writeArchivedCategoryPreference(categoryId: ArchivedCategoryId): void {
  try {
    globalThis.localStorage?.setItem(archivedCategoryStorageKey, categoryId);
  } catch {
    // Local presentation preferences are best-effort.
  }
}

export function archivedCategoryCount(
  categoryId: ArchivedCategoryId,
  input: ArchivedItemsProjectionInput,
): number {
  switch (categoryId) {
    case "conversations": return input.archivedConversations.length;
    case "teammates": return input.archivedTeammates.length;
    case "channels": return input.archivedChannels.length;
    case "branches": return input.archivedBranches.length;
  }
}

export function createArchivedRows(
  categoryId: ArchivedCategoryId,
  input: ArchivedItemsProjectionInput,
): readonly ArchivedItemRowViewModel[] {
  switch (categoryId) {
    case "conversations":
      return input.archivedConversations.map((thread) => ({
        id: thread.id,
        key: `conversation:${thread.id}`,
        kind: "conversation",
        source: { kind: "conversation", item: thread },
        displayName: thread.title.trim(),
        displayNameFallbackKey: "Conversation",
        searchValue: thread.title,
        archivedAt: thread.archivedAt ?? thread.updatedAt,
        restoreActionId: `conversation:${thread.id}:restore`,
        deleteActionId: `conversation:${thread.id}:delete`,
        restoreLabelKey: "Restore",
        deleteLabelKey: "Delete conversation",
      }));
    case "teammates":
      return input.archivedTeammates.map((teammate) => ({
        id: teammate.id,
        key: `teammate:${teammate.id}`,
        kind: "teammate",
        source: { kind: "teammate", item: teammate },
        displayName: teammate.displayName,
        searchValue: teammate.displayName,
        archivedAt: teammate.updatedAt,
        restoreActionId: `teammate:${teammate.id}:restore`,
        deleteActionId: `teammate:${teammate.id}:delete`,
        restoreLabelKey: "Restore",
        deleteLabelKey: "Delete AI teammate",
      }));
    case "channels":
      return input.archivedChannels.map((channel) => ({
        id: channel.id,
        key: `channel:${channel.id}`,
        kind: "channel",
        source: { kind: "channel", item: channel },
        displayName: channel.name,
        searchValue: channel.name,
        archivedAt: channel.updatedAt,
        restoreActionId: `channel:${channel.id}:restore`,
        deleteActionId: `channel:${channel.id}:delete`,
        restoreLabelKey: "Restore",
        deleteLabelKey: "Delete channel",
      }));
    case "branches":
      return input.archivedBranches.map((branch) => {
        const parent = input.archiveParentChannelById.get(branch.channelId);
        const displayName = parent ? `${parent.name} / ${branch.name}` : branch.name;
        return {
          id: branch.id,
          key: `branch:${branch.id}`,
          kind: "branch",
          source: { kind: "branch", item: branch },
          displayName,
          searchValue: parent ? `${parent.name} ${branch.name}` : branch.name,
          archivedAt: branch.archivedAt ?? branch.updatedAt,
          restoreActionId: `branch:${branch.id}:restore`,
          deleteActionId: `branch:${branch.id}:delete`,
          restoreLabelKey: parent?.status === "archived" ? "Restore both" : "Restore",
          deleteLabelKey: "Delete branch",
        };
      });
  }
}

export function filterArchivedRows(
  rows: readonly ArchivedItemRowViewModel[],
  query: string,
  resolveFallbackLabel: (key: string) => string,
): readonly ArchivedItemRowViewModel[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return rows;
  return rows.filter((row) => {
    const searchValue = row.searchValue || (row.displayNameFallbackKey ? resolveFallbackLabel(row.displayNameFallbackKey) : "");
    return searchValue.toLocaleLowerCase().includes(normalizedQuery);
  });
}

export function createArchivedDeleteTarget(row: ArchivedItemRowViewModel): ArchivedDeleteTarget {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    displayName: row.displayName,
    displayNameFallbackKey: row.displayNameFallbackKey,
    actionId: row.deleteActionId,
  };
}
