import type { SkillRegistryEntry } from "../../types.js";

export type SkillLibrarySectionId = "mine" | "evolution" | "builtin";
export type SkillOwnership = "user" | "evolved" | "builtin";
export type SkillEvolutionViewId = "pending" | "generated" | "ignored";
export type BuiltinSkillBindingFilter = "all" | "bound" | "unbound";
export type UserSkillSortMode = "updated" | "name";

export interface SkillOwnershipPartition {
  readonly user: readonly SkillRegistryEntry[];
  readonly evolved: readonly SkillRegistryEntry[];
  readonly builtin: readonly SkillRegistryEntry[];
}

interface SkillSearchInput {
  readonly query: string;
}

export function skillOwnership(entry: SkillRegistryEntry): SkillOwnership {
  if (entry.source === "builtin" || entry.source === "gstack" || entry.reviewStatus === "builtin") {
    return "builtin";
  }
  if (entry.packId === "ling-generated" || entry.sourcePath?.startsWith("skill-candidates/")) {
    return "evolved";
  }
  return "user";
}

export function isSkillLibraryVisibleEntry(entry: SkillRegistryEntry): boolean {
  return !(entry.id === "gstack" && entry.source === "gstack" && entry.packId === "gstack-source-sync");
}

export function partitionSkillRegistry(entries: readonly SkillRegistryEntry[]): SkillOwnershipPartition {
  const user: SkillRegistryEntry[] = [];
  const evolved: SkillRegistryEntry[] = [];
  const builtin: SkillRegistryEntry[] = [];
  for (const entry of entries) {
    if (!isSkillLibraryVisibleEntry(entry)) {
      continue;
    }
    const ownership = skillOwnership(entry);
    if (ownership === "builtin") {
      builtin.push(entry);
    } else if (ownership === "evolved") {
      evolved.push(entry);
    } else {
      user.push(entry);
    }
  }
  return { user, evolved, builtin };
}

export function currentUserSkillCount(entries: readonly SkillRegistryEntry[]): number {
  return entries.filter((entry) => isSkillLibraryVisibleEntry(entry) && skillOwnership(entry) === "user" && entry.reviewStatus !== "archived").length;
}

export function filterUserSkillEntries(
  entries: readonly SkillRegistryEntry[],
  input: SkillSearchInput & {
    readonly sortMode: UserSkillSortMode;
  },
): readonly SkillRegistryEntry[] {
  const rows = entries.filter((entry) => {
    if (!isSkillLibraryVisibleEntry(entry) || skillOwnership(entry) !== "user" || entry.reviewStatus === "archived") {
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
    if (!isSkillLibraryVisibleEntry(entry) || skillOwnership(entry) !== "builtin") {
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

export function filterEvolvedSkillEntries(
  entries: readonly SkillRegistryEntry[],
  input: SkillSearchInput & {
    readonly sortMode: UserSkillSortMode;
  },
): readonly SkillRegistryEntry[] {
  const rows = entries.filter((entry) => {
    if (!isSkillLibraryVisibleEntry(entry) || skillOwnership(entry) !== "evolved" || entry.reviewStatus === "archived") {
      return false;
    }
    return matchesSkillSearch(entry, input);
  });
  return [...rows].sort(input.sortMode === "name" ? compareSkillName : compareSkillUpdated);
}

function matchesSkillSearch(entry: SkillRegistryEntry, input: SkillSearchInput): boolean {
  const query = input.query.trim().toLowerCase();
  if (!query) {
    return true;
  }
  const haystack = [
    entry.definition.name,
    entry.definition.summary,
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
