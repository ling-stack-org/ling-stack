import type {
  SkillRegistryEntry,
  SkillSourceSnapshot,
} from "../../types.js";

export type SkillLibrarySectionId = "mine" | "builtin" | "review" | "source";
export type SkillOwnership = "user" | "builtin";
export type UserSkillStatusFilter = "current" | "published" | "draft";
export type BuiltinSkillBindingFilter = "all" | "bound" | "unbound";
export type UserSkillSortMode = "updated" | "name";

export interface SkillOwnershipPartition {
  readonly user: readonly SkillRegistryEntry[];
  readonly builtin: readonly SkillRegistryEntry[];
}

interface SkillSearchInput {
  readonly query: string;
  readonly sourceSnapshotBySkillId: ReadonlyMap<string, SkillSourceSnapshot>;
}

export function skillOwnership(entry: SkillRegistryEntry): SkillOwnership {
  return entry.source === "builtin" || entry.reviewStatus === "builtin" ? "builtin" : "user";
}

export function partitionSkillRegistry(entries: readonly SkillRegistryEntry[]): SkillOwnershipPartition {
  const user: SkillRegistryEntry[] = [];
  const builtin: SkillRegistryEntry[] = [];
  for (const entry of entries) {
    if (skillOwnership(entry) === "builtin") {
      builtin.push(entry);
    } else {
      user.push(entry);
    }
  }
  return { user, builtin };
}

export function currentUserSkillCount(entries: readonly SkillRegistryEntry[]): number {
  return entries.filter((entry) => skillOwnership(entry) === "user" && entry.reviewStatus !== "archived").length;
}

export function filterUserSkillEntries(
  entries: readonly SkillRegistryEntry[],
  input: SkillSearchInput & {
    readonly status: UserSkillStatusFilter;
    readonly sortMode: UserSkillSortMode;
  },
): readonly SkillRegistryEntry[] {
  const rows = entries.filter((entry) => {
    if (skillOwnership(entry) !== "user" || !matchesUserStatus(entry, input.status)) {
      return false;
    }
    return matchesSkillSearch(entry, input);
  });
  return [...rows].sort(input.sortMode === "name" ? compareSkillName : compareSkillUpdated);
}

export function filterBuiltinSkillEntries(
  entries: readonly SkillRegistryEntry[],
  input: SkillSearchInput & {
    readonly binding: BuiltinSkillBindingFilter;
    readonly boundSkillIds: ReadonlySet<string>;
  },
): readonly SkillRegistryEntry[] {
  const rows = entries.filter((entry) => {
    if (skillOwnership(entry) !== "builtin") {
      return false;
    }
    const bound = input.boundSkillIds.has(entry.id);
    if (input.binding === "bound" && !bound) {
      return false;
    }
    if (input.binding === "unbound" && bound) {
      return false;
    }
    return matchesSkillSearch(entry, input);
  });
  return [...rows].sort(compareSkillName);
}

function matchesUserStatus(entry: SkillRegistryEntry, status: UserSkillStatusFilter): boolean {
  if (status === "current") {
    return entry.reviewStatus !== "archived";
  }
  return entry.reviewStatus === status;
}

function matchesSkillSearch(entry: SkillRegistryEntry, input: SkillSearchInput): boolean {
  const query = input.query.trim().toLowerCase();
  if (!query) {
    return true;
  }
  const snapshot = input.sourceSnapshotBySkillId.get(entry.id);
  const haystack = [
    entry.id,
    entry.definition.name,
    entry.definition.summary,
    entry.source,
    entry.sourcePath ?? "",
    snapshot?.sourcePath ?? "",
    snapshot?.upstreamSkillPath ?? "",
    snapshot?.sourceChecksum ?? "",
    entry.definition.workflowPhase,
    ...entry.definition.requiredTools,
    ...entry.definition.requiredProviderCapabilities,
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

function compareSkillName(left: SkillRegistryEntry, right: SkillRegistryEntry): number {
  return left.definition.name.localeCompare(right.definition.name) || left.id.localeCompare(right.id);
}

function compareSkillUpdated(left: SkillRegistryEntry, right: SkillRegistryEntry): number {
  return right.updatedAt.localeCompare(left.updatedAt) || compareSkillName(left, right);
}
