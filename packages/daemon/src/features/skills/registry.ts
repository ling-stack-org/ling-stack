import {
  DEFAULT_WORKSPACE_ID,
  GSTACK_DEFAULT_SKILL_PACK_ID,
  listDefaultSkills,
  type ReplaceTeammateSkillBindingInput,
  type RunStore,
  type SkillDefinition,
  type SkillRegistryEntry,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";

let skillRegistryGeneration = 0;

export function listEffectiveSkillRegistryEntries(store: RunStore): SkillRegistryEntry[] {
  const builtInTimestamp = new Date(0).toISOString();
  const builtInEntries = listDefaultSkills(GSTACK_DEFAULT_SKILL_PACK_ID).map((definition): SkillRegistryEntry => ({
    id: definition.id,
    workspaceId: DEFAULT_WORKSPACE_ID,
    packId: GSTACK_DEFAULT_SKILL_PACK_ID,
    source: "builtin",
    version: "builtin",
    definition,
    visibility: {
      workspaceVisible: true,
      promotableToWorkspace: false,
    },
    reviewStatus: "builtin",
    createdAt: builtInTimestamp,
    updatedAt: builtInTimestamp,
  }));
  const customEntries = store.listSkillRegistryEntries();
  const seen = new Set<string>();
  return [...builtInEntries, ...customEntries].filter((entry) => {
    if (seen.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
}

export function refreshEffectiveSkillRegistryEntries(store: RunStore): {
  readonly refreshedAt: string;
  readonly registryGeneration: number;
  readonly skills: readonly SkillRegistryEntry[];
} {
  skillRegistryGeneration += 1;
  return {
    refreshedAt: new Date().toISOString(),
    registryGeneration: skillRegistryGeneration,
    skills: listEffectiveSkillRegistryEntries(store),
  };
}

export function listExecutableSkillDefinitions(store: RunStore): readonly SkillDefinition[] {
  return listEffectiveSkillRegistryEntries(store)
    .filter((entry) => entry.reviewStatus === "builtin" || entry.reviewStatus === "published")
    .map((entry) => entry.definition);
}

export function validateTeammateSkillBindings(
  store: RunStore,
  teammateId: string,
  bindings: readonly ReplaceTeammateSkillBindingInput[],
): void {
  const knownSkillIds = new Set(listExecutableSkillDefinitions(store).map((skill) => skill.id));
  const existingSkillIds = new Set(store.listTeammateSkillBindings(teammateId).map((binding) => binding.skillId));
  for (const binding of bindings) {
    if (!knownSkillIds.has(binding.skillId) && !existingSkillIds.has(binding.skillId)) {
      throw new HttpError(400, "skill_not_found", `Skill definition not found: ${binding.skillId}`);
    }
  }
}
