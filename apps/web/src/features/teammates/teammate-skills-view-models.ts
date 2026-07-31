import type { SkillDefinition } from "@ling-stack/core/skill-types";
import type {
  EffectiveTeammateSkill,
  SkillRegistryEntry,
  SkillSourceSnapshot,
  TeammateSkillBinding,
} from "../../types.js";

export type SkillBindingFilter = "all" | "using" | "unused" | "attention";
export type SkillStatusTone = "danger" | "info" | "neutral" | "success" | "warning";

type Translate = (key: string, values?: Readonly<Record<string, string | number>>) => string;

const visibleToolLabelKeys: Readonly<Record<string, string>> = {
  read: "Read files",
  grep: "Search file contents",
  find: "Find files",
  ls: "List folders",
  bash: "Run commands",
  edit: "Edit files",
  write: "Write files",
};

export interface TeammateSkillRowModel {
  readonly id: string;
  readonly skill: SkillDefinition | undefined;
  readonly binding: TeammateSkillBinding | undefined;
  readonly effectiveSkill: EffectiveTeammateSkill | undefined;
  readonly sourceSnapshot: SkillSourceSnapshot | undefined;
  readonly displayName: string;
  readonly summary: string;
  readonly searchableToolLabels: readonly string[];
  readonly sourceLabel: string;
  readonly sourceState: {
    readonly attention: boolean;
    readonly label: string;
    readonly tone: SkillStatusTone;
  };
  readonly status: {
    readonly label: string;
    readonly tone: SkillStatusTone;
  };
  readonly canRemove: boolean;
}

export function buildTeammateSkillRows({
  bindings,
  effectiveSkills,
  fallbackDefinitions,
  registryEntries,
  sourceSnapshots,
  t,
}: {
  readonly bindings: readonly TeammateSkillBinding[];
  readonly effectiveSkills: readonly EffectiveTeammateSkill[];
  readonly fallbackDefinitions: readonly SkillDefinition[];
  readonly registryEntries: readonly SkillRegistryEntry[];
  readonly sourceSnapshots: readonly SkillSourceSnapshot[];
  readonly t: Translate;
}): readonly TeammateSkillRowModel[] {
  const definitions = registryEntries.length > 0
    ? registryEntries.map((entry) => entry.definition)
    : fallbackDefinitions;
  const bindingById = new Map(bindings.map((binding) => [binding.skillId, binding]));
  const effectiveById = new Map(effectiveSkills.map((skill) => [skill.skillId, skill]));
  const registryById = new Map(registryEntries.map((entry) => [entry.id, entry]));
  const sourceById = selectAuthoritativeSourceSnapshots(sourceSnapshots);
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
  const ids = [
    ...definitions.map((definition) => definition.id),
    ...bindings.map((binding) => binding.skillId).filter((id) => !definitionById.has(id)),
  ];

  return ids.map((id) => {
    const skill = definitionById.get(id);
    const binding = bindingById.get(id);
    const effectiveSkill = effectiveById.get(id);
    const registryEntry = registryById.get(id);
    const sourceSnapshot = sourceById.get(id);
    return {
      id,
      skill,
      binding,
      effectiveSkill,
      sourceSnapshot,
      displayName: skill ? t(skill.name) : id,
      summary: skill ? t(skill.summary) : t("This binding points to a Skill that is no longer available."),
      searchableToolLabels: skill?.requiredTools.flatMap((tool) => {
        const labelKey = visibleToolLabelKeys[tool];
        return labelKey ? [t(labelKey)] : [];
      }) ?? [],
      sourceLabel: projectSkillSourceLabel(binding, registryEntry, t),
      sourceState: projectSkillSourceState(sourceSnapshot, t),
      status: projectSkillStatus(skill, binding, effectiveSkill, t),
      canRemove: binding?.source === "user",
    };
  });
}

export function filterTeammateSkillRows(
  rows: readonly TeammateSkillRowModel[],
  searchQuery: string,
  filter: SkillBindingFilter,
): readonly TeammateSkillRowModel[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  return rows
    .filter((row) => {
      const enabled = Boolean(row.binding?.enabled);
      if (filter === "using" && !enabled) return false;
      if (filter === "unused" && enabled) return false;
      if (filter === "attention" && !teammateSkillNeedsAttention(row)) return false;
      if (!normalizedQuery) return true;
      return [row.displayName, row.summary, ...row.searchableToolLabels]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .sort((left, right) => {
      const leftRank = left.binding?.enabled ? 0 : left.binding ? 1 : 2;
      const rightRank = right.binding?.enabled ? 0 : right.binding ? 1 : 2;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.displayName.localeCompare(right.displayName);
    });
}

export function teammateSkillNeedsAttention(row: TeammateSkillRowModel): boolean {
  return row.status.tone === "danger" || row.status.tone === "warning" || row.sourceState.attention;
}

export function teammateSkillFilterLabel(filter: SkillBindingFilter, t: Translate): string {
  if (filter === "using") return t("In use");
  if (filter === "unused") return t("Not in use");
  if (filter === "attention") return t("Needs attention");
  return t("All skills");
}

function projectSkillStatus(
  skill: SkillDefinition | undefined,
  binding: TeammateSkillBinding | undefined,
  effectiveSkill: EffectiveTeammateSkill | undefined,
  t: Translate,
): TeammateSkillRowModel["status"] {
  if (!skill) return { label: t("Skill unavailable"), tone: "danger" };
  if (binding?.enabled && !effectiveSkill?.executable) return { label: t("Blocked"), tone: "warning" };
  if (binding?.enabled && effectiveSkill?.executable === true) return { label: t("Executable"), tone: "success" };
  if (binding) return { label: t("Disabled"), tone: "neutral" };
  return { label: t("Bindable"), tone: "neutral" };
}

function projectSkillSourceLabel(
  binding: TeammateSkillBinding | undefined,
  entry: SkillRegistryEntry | undefined,
  t: Translate,
): string {
  if (binding?.source === "template") return t("Default skill");
  if (binding?.source === "user") return t("User skill");
  if (entry?.source === "builtin") return t("Available skill");
  return entry ? t("Registry skill") : t("Unknown source");
}

function projectSkillSourceState(
  snapshot: SkillSourceSnapshot | undefined,
  t: Translate,
): TeammateSkillRowModel["sourceState"] {
  if (!snapshot) return { attention: false, label: t("Metadata only"), tone: "neutral" };
  if (snapshot.warnings.length > 0) {
    return { attention: true, label: t("Source needs attention"), tone: "warning" };
  }
  return { attention: false, label: t("Source-backed"), tone: "success" };
}

function selectAuthoritativeSourceSnapshots(
  snapshots: readonly SkillSourceSnapshot[],
): ReadonlyMap<string, SkillSourceSnapshot> {
  const selected = new Map<string, SkillSourceSnapshot>();
  for (const snapshot of snapshots) {
    const current = selected.get(snapshot.skillId);
    if (!current || compareSourceSnapshotPriority(snapshot, current) > 0) {
      selected.set(snapshot.skillId, snapshot);
    }
  }
  return selected;
}

function compareSourceSnapshotPriority(left: SkillSourceSnapshot, right: SkillSourceSnapshot): number {
  const leftPublished = left.reviewStatus === "published" ? 1 : 0;
  const rightPublished = right.reviewStatus === "published" ? 1 : 0;
  if (leftPublished !== rightPublished) return leftPublished - rightPublished;
  const leftUpdatedAt = Date.parse(left.updatedAt);
  const rightUpdatedAt = Date.parse(right.updatedAt);
  return (Number.isFinite(leftUpdatedAt) ? leftUpdatedAt : 0) -
    (Number.isFinite(rightUpdatedAt) ? rightUpdatedAt : 0);
}
