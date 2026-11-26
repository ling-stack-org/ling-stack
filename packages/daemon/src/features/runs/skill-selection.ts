import { buildEffectiveTeammateSkills, getEffectiveTeammateSkill, type RunStore, type SkillSourceRuntimeContext } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { listEffectiveSkillRegistryEntries, listExecutableSkillDefinitions } from "../skills/registry.js";
import { assertOptionalSkillPackEnabledForRecovery, optionalPackForExecution, optionalPackForRegistryEntry } from "../skills/optional-pack-catalog.js";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import type { RunRequest } from "./schemas.js";

/** Current binding/executability only. Source text and compiled views are prepared separately. */
export function resolveCurrentRunSkill(store: RunStore, request: Pick<RunRequest, "requestedSkillId" | "teammateId" | "providerPresetId">
  & { readonly task: Pick<RunRequest["task"], "channelId"> }, frozenSource?: SkillSourceRuntimeContext): ReturnType<typeof getEffectiveTeammateSkill> {
  if (!request.requestedSkillId) return undefined;
  const teammate = request.teammateId ? resolveAiTeammateReference(store, request.teammateId) : undefined;
  if (!teammate) throw new HttpError(400, "skill_teammate_required", "requestedSkillId requires a resolved teammateId.");
  const channel = request.task.channelId ? store.getChannel(request.task.channelId) : undefined;
  const preset = request.providerPresetId ? store.getProviderPreset(request.providerPresetId) : undefined;
  assertOptionalSkillPackEnabledForRecovery(store, frozenSource);
  const pack = optionalPackForExecution(frozenSource);
  const skills = listExecutableSkillDefinitions(store);
  const recoveryEntry = (frozenSource?.resourceBinding || pack === "superpowers") && pack
    && frozenSource?.skillId === request.requestedSkillId && !skills.some(skill => skill.id === request.requestedSkillId)
    ? listEffectiveSkillRegistryEntries(store, true).find(entry => entry.id === request.requestedSkillId
      && optionalPackForRegistryEntry(entry) === pack && (entry.reviewStatus === "published" || entry.reviewStatus === "builtin")) : undefined;
  if (!recoveryEntry && !skills.some(skill => skill.id === request.requestedSkillId)) {
    const unavailable = store.getSkillRegistryEntry(request.requestedSkillId)
      ?? listEffectiveSkillRegistryEntries(store, true).find(entry => entry.id === request.requestedSkillId);
    const optional = unavailable && optionalPackForRegistryEntry(unavailable);
    if (optional) throw new HttpError(409, "skill_pack_unavailable", `Install and enable ${optional} in Settings → Plugins to use this skill.`);
  }
  const selected = getEffectiveTeammateSkill(buildEffectiveTeammateSkills({ teammate,
    bindings: store.listTeammateSkillBindings(teammate.id), skills: recoveryEntry ? [...skills, recoveryEntry.definition] : skills,
    channelAllowedTools: channel?.allowedTools, providerCapabilities: preset?.capabilities }), request.requestedSkillId);
  if (!selected) throw new HttpError(400, "skill_not_bound", `Skill is not bound to teammate: ${request.requestedSkillId}`);
  if (!selected.executable) throw new HttpError(400, "skill_not_executable",
    `Skill is not executable: ${selected.blockedReasons.map((reason) => reason.code).join(", ")}`);
  return selected;
}
