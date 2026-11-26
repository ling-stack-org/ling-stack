import {
  DEFAULT_WORKSPACE_ID,
  GSTACK_DEFAULT_SKILL_PACK_ID,
  GSTACK_DEFAULT_UPSTREAM_VERSION,
  listDefaultSkills,
  isLingNativeSkillId,
  resolveEffectiveSkillRegistryEntries,
  type ReplaceTeammateSkillBindingInput,
  type ManagedPluginStoreFacet,
  type SkillDefinition,
  type SkillRegistryEntry,
  type SkillRegistryStoreFacet,
  type TeammateStoreFacet,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { optionalPackForRegistryEntry, optionalSkillPackEnabled, optionalSkillPackPluginId } from "./optional-pack-catalog.js";

let skillRegistryGeneration = 0;

type EffectiveSkillRegistryStore = SkillRegistryStoreFacet & Pick<ManagedPluginStoreFacet, "getManagedPlugin" | "getManagedPluginPackage">;
type TeammateSkillValidationStore = EffectiveSkillRegistryStore & TeammateStoreFacet;

export function getSkillRegistryGeneration(): number {
  return skillRegistryGeneration;
}

export function listEffectiveSkillRegistryEntries(store: EffectiveSkillRegistryStore, includeInactivePacks = false): SkillRegistryEntry[] {
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
  const snapshots = store.listSkillSourceSnapshots({ reviewStatus: "published" });
  const entries = resolveEffectiveSkillRegistryEntries({
    builtinEntries: builtInEntries,
    persistedEntries: store.listSkillRegistryEntries({ includeArchived: true, includeDisabled: true }),
    sourceSnapshots: snapshots,
  });
  if (includeInactivePacks) return entries;
  const desktop = process.env.LING_STACK_PACKAGED_DESKTOP === "1";
  const gstack = optionalSkillPackEnabled(store, "gstack");
  const superpowers = store.getManagedPluginPackage(optionalSkillPackPluginId("superpowers"));
  const active = new Map(snapshots.map(snapshot => [snapshot.skillId, snapshot]));
  return entries.filter(entry => {
    const pack = optionalPackForRegistryEntry(entry);
    if (!pack || isLingNativeSkillId(entry.id)) return true;
    if (pack === "gstack") {
      if (gstack === false || desktop && gstack !== true) return false;
      return !desktop || active.get(entry.id)?.referencedFiles.some(file => file.path === "manifest.json") === true;
    }
    return optionalSkillPackEnabled(store, "superpowers") === true && superpowers?.status === "installed"
      && active.get(entry.id)?.referencedFiles.some(file => file.path === "skill-pack.json" && file.checksum === `sha256:${superpowers.packageHash}`);
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
