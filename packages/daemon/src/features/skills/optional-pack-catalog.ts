import type { OptionalSkillPackId } from "@ling-stack/contracts";
import type { ManagedPluginDescriptor, ManagedPluginStoreFacet, SkillRegistryEntry, SkillSourceRuntimeContext } from "@ling-stack/core";
import { isLingNativeSkillId } from "@ling-stack/core";
import { HttpError } from "../../errors.js";

export const optionalSkillPacks = {
  gstack: { name: "gstack", upstreamUrl: "https://github.com/garrytan/gstack", packId: "gstack-default" },
  superpowers: { name: "Superpowers", upstreamUrl: "https://github.com/obra/superpowers", packId: "superpowers" },
} as const satisfies Record<OptionalSkillPackId, { name: string; upstreamUrl: string; packId: string }>;

export function optionalSkillPackPluginId(id: OptionalSkillPackId): string { return `skill-pack:${id}`; }

export function optionalSkillPackDescriptor(id: OptionalSkillPackId, version: string): ManagedPluginDescriptor {
  const pack = optionalSkillPacks[id];
  return { id: optionalSkillPackPluginId(id), version, displayName: pack.name, sourceKind: "built-in",
    homepageUrl: pack.upstreamUrl, trustSummary: "Skill tools use the workspace's Ling execution policy.",
    contributions: [{ kind: "skill-pack", id: pack.packId, label: pack.name, capabilities: ["skills"] }] };
}

export function optionalPackForRegistryEntry(entry: SkillRegistryEntry): OptionalSkillPackId | undefined {
  if (isLingNativeSkillId(entry.id)) return undefined;
  // The built-in gstack-inspired templates are Ling-owned defaults. Only
  // source-managed entries are optional external packs.
  if (entry.source === "gstack") return "gstack";
  if (entry.source === "skill-directory" && entry.packId === optionalSkillPacks.superpowers.packId) return "superpowers";
}

export function optionalPackForExecution(context: SkillSourceRuntimeContext | undefined): OptionalSkillPackId | undefined {
  if (context?.sourceKind === "gstack-skill-directory") return "gstack";
  if (context?.sourceKind === "workspace-skill-directory" && context.upstreamName === "obra/superpowers"
    && context.skillId.startsWith("superpowers-")) return "superpowers";
}

export function optionalSkillPackEnabled(store: Pick<ManagedPluginStoreFacet, "getManagedPlugin">,
  id: OptionalSkillPackId): boolean | undefined {
  return store.getManagedPlugin(optionalSkillPackPluginId(id))?.enabled;
}

export function assertOptionalSkillPackEnabledForRecovery(store: Pick<ManagedPluginStoreFacet, "getManagedPlugin">,
  context: SkillSourceRuntimeContext | undefined): void {
  const pack = optionalPackForExecution(context);
  if (pack && optionalSkillPackEnabled(store, pack) === false) {
    throw new HttpError(409, "skill_pack_disabled", `Enable ${optionalSkillPacks[pack].name} in this workspace to continue.`);
  }
}
