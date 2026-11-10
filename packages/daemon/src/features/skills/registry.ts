import {
  DEFAULT_WORKSPACE_ID,
  GSTACK_DEFAULT_SKILL_PACK_ID,
  GSTACK_DEFAULT_UPSTREAM_VERSION,
  listDefaultSkills,
  resolveEffectiveSkillRegistryEntries,
  type ReplaceTeammateSkillBindingInput,
  type SkillDefinition,
  type SkillRegistryEntry,
  type SkillRegistryStoreFacet,
  type TeammateStoreFacet,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";

let skillRegistryGeneration = 0;

type EffectiveSkillRegistryStore = SkillRegistryStoreFacet;
type TeammateSkillValidationStore = EffectiveSkillRegistryStore & TeammateStoreFacet;

export function getSkillRegistryGeneration(): number {
  return skillRegistryGeneration;
}

export function listEffectiveSkillRegistryEntries(store: EffectiveSkillRegistryStore): SkillRegistryEntry[] {
  const builtInTimestamp = new Date(0).toISOString();
  const builtInEntries = listDefaultSkills(GSTACK_DEFAULT_SKILL_PACK_ID).map((definition): SkillRegistryEntry => ({
    id: definition.id,
    workspaceId: DEFAULT_WORKSPACE_ID,
    packId: GSTACK_DEFAULT_SKILL_PACK_ID,
    source: "builtin",
    version: GSTACK_DEFAULT_UPSTREAM_VERSION,
    definition,
    visibility: {
      workspaceVisible: true,
      promotableToWorkspace: false,
    },
    reviewStatus: "builtin",
    createdAt: builtInTimestamp,
    updatedAt: builtInTimestamp,
  }));
  return resolveEffectiveSkillRegistryEntries({
    builtinEntries: builtInEntries,
    persistedEntries: store.listSkillRegistryEntries({ includeArchived: true, includeDisabled: true }),
    sourceSnapshots: store.listSkillSourceSnapshots({ reviewStatus: "published" }),
  });
}

export function refreshEffectiveSkillRegistryEntries(store: EffectiveSkillRegistryStore): {
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

export function listExecutableSkillDefinitions(store: EffectiveSkillRegistryStore): readonly SkillDefinition[] {
  return listEffectiveSkillRegistryEntries(store)
    .filter((entry) => entry.reviewStatus === "builtin" || entry.reviewStatus === "published")
    .map((entry) => entry.definition);
}

export function validateTeammateSkillBindings(
  store: TeammateSkillValidationStore,
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
