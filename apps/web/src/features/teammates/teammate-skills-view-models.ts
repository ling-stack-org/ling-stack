import type { SkillDefinition } from "@ling-stack/core/skill-types";
import type {
  EffectiveTeammateSkill,
  SkillImportDraft,
  SkillRegistryEntry,
  SkillSourceSnapshot,
  TeammateSkillBinding,
} from "../../types.js";

export type SkillBindingFilter = "all" | "bound" | "executable" | "blocked" | "available";
export type SkillPrimaryAction = "bind" | "disable" | "enable";
export type SkillStatusTone = "danger" | "info" | "neutral" | "success" | "warning";

type Translate = (key: string, values?: Readonly<Record<string, string | number>>) => string;

export interface TeammateSkillRowModel {
  readonly id: string;
  readonly skill: SkillDefinition | undefined;
  readonly binding: TeammateSkillBinding | undefined;
  readonly effectiveSkill: EffectiveTeammateSkill | undefined;
  readonly registryEntry: SkillRegistryEntry | undefined;
  readonly sourceSnapshot: SkillSourceSnapshot | undefined;
  readonly displayName: string;
  readonly summary: string;
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
  readonly primaryAction: SkillPrimaryAction;
  readonly canArchive: boolean;
  readonly canRemove: boolean;
  readonly blockedLabel: string;
  readonly toolCount: number;
}

export interface TeammateSkillStats {
  readonly attention: number;
  readonly bound: number;
  readonly executable: number;
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
    const sourceState = projectSkillSourceState(sourceSnapshot, t);
    const status = projectSkillStatus(skill, binding, effectiveSkill, t);
    return {
      id,
      skill,
      binding,
      effectiveSkill,
      registryEntry,
      sourceSnapshot,
      displayName: skill ? t(skill.name) : id,
      summary: skill ? t(skill.summary) : t("This binding points to a Skill that is no longer available."),
      sourceLabel: projectSkillSourceLabel(binding, registryEntry, t),
      sourceState,
      status,
      primaryAction: !binding ? "bind" : binding.enabled ? "disable" : "enable",
      canArchive: !binding && Boolean(registryEntry) && registryEntry?.source !== "builtin",
      canRemove: binding?.source === "user",
      blockedLabel: effectiveSkill?.blockedReasons.map((reason) => t(reason.code)).join(", ") ?? "",
      toolCount: skill?.requiredTools.length ?? 0,
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
      if (filter === "bound" && !row.binding?.enabled) return false;
      if (filter === "executable" && !row.effectiveSkill?.executable) return false;
      if (filter === "blocked" && (!row.binding?.enabled || row.effectiveSkill?.executable)) return false;
      if (filter === "available" && row.binding) return false;
      if (!normalizedQuery) return true;
      return skillSearchText(row).includes(normalizedQuery);
    })
    .sort((left, right) => {
      const leftRank = left.binding?.enabled ? 0 : left.binding ? 1 : 2;
      const rightRank = right.binding?.enabled ? 0 : right.binding ? 1 : 2;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.displayName.localeCompare(right.displayName);
    });
}

export function summarizeTeammateSkills(rows: readonly TeammateSkillRowModel[]): TeammateSkillStats {
  return {
    bound: rows.filter((row) => Boolean(row.binding)).length,
    executable: rows.filter((row) => row.effectiveSkill?.executable).length,
    attention: rows.filter((row) => row.status.tone === "danger" || row.status.tone === "warning" || row.sourceState.attention).length,
  };
}

export function teammateSkillFilterLabel(filter: SkillBindingFilter, t: Translate): string {
  if (filter === "bound") return t("Bound");
  if (filter === "executable") return t("Executable");
  if (filter === "blocked") return t("Blocked");
  if (filter === "available") return t("Bindable");
  return t("All");
}

export function teammateSkillActionLabel(action: SkillPrimaryAction, t: Translate): string {
  if (action === "disable") return t("Disable");
  if (action === "enable") return t("Enable");
  return t("Bind");
}

export function importDraftHasErrors(draft: SkillImportDraft): boolean {
  return draft.warnings.some((warning) => warning.severity === "error") ||
    draft.definitions.some((item) => item.warnings?.some((warning) => warning.severity === "error"));
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

function skillSearchText(row: TeammateSkillRowModel): string {
  return [
    row.id,
    row.displayName,
    row.summary,
    ...(row.skill?.requiredTools ?? []),
    ...(row.skill?.requiredProviderCapabilities ?? []),
    row.sourceSnapshot?.sourcePath ?? "",
    row.sourceSnapshot?.upstreamSkillPath ?? "",
    row.sourceSnapshot?.sourceChecksum ?? "",
    ...(row.sourceSnapshot?.warnings.map((warning) => `${warning.code} ${warning.message}`) ?? []),
    ...(row.effectiveSkill?.blockedReasons.map((reason) => `${reason.code} ${reason.message} ${(reason.missing ?? []).join(" ")}`) ?? []),
  ].join(" ").toLowerCase();
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
