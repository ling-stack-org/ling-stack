import type { SkillRegistryEntry, SkillSourceSnapshot } from "./skill-types.js";
import { isSourceManagedSkill, parseSkillFrontMatter, refreshSourceManagedSkillDefinition } from "./skill-source-definition.js";
import { selectActiveSkillSourceSnapshots } from "./skill-source-selection.js";

export function resolveEffectiveSkillRegistryEntries(input: {
  readonly builtinEntries: readonly SkillRegistryEntry[];
  readonly persistedEntries: readonly SkillRegistryEntry[];
  readonly sourceSnapshots: readonly SkillSourceSnapshot[];
}): SkillRegistryEntry[] {
  const entries = new Map(input.builtinEntries.map((entry) => [entry.id, entry]));
  for (const entry of input.persistedEntries) {
    const builtin = entries.get(entry.id);
    if (builtin && (!isSourceManagedSkill(entry) || !isSourceManagedSkill(builtin))) {
      throw new Error(`skill_registry_identity_collision: ${entry.id}`);
    }
    if (builtin && entry.reviewStatus === "draft") continue;
    if (entry.reviewStatus === "archived" || entry.reviewStatus === "disabled") entries.delete(entry.id);
    else entries.set(entry.id, entry);
  }
  const snapshots = selectActiveSkillSourceSnapshots(input.sourceSnapshots);
  return [...entries.values()].map((entry) => {
    if (!isSourceManagedSkill(entry)) return entry;
    // Match the store's active snapshot selection, including an explicit rollback to an older version.
    const snapshot = snapshots.find((snapshot) => snapshot.skillId === entry.id && snapshot.workspaceId === entry.workspaceId);
    if (!snapshot || snapshot.sourceKind !== "gstack-skill-directory") return entry;
    return {
      ...entry,
      definition: refreshSourceManagedSkillDefinition(entry.definition, parseSkillFrontMatter(snapshot.rawSkillMarkdown).frontMatter, snapshot.agentMetadata),
      version: snapshot.upstreamVersion,
      checksum: snapshot.sourceChecksum,
    };
  });
}
