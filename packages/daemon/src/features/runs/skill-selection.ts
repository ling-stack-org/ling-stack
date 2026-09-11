import { buildEffectiveTeammateSkills, getEffectiveTeammateSkill, type RunStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { listExecutableSkillDefinitions } from "../skills/registry.js";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import type { RunRequest } from "./schemas.js";

/** Current binding/executability only. Source text and compiled views are prepared separately. */
export function resolveCurrentRunSkill(store: RunStore, request: RunRequest): ReturnType<typeof getEffectiveTeammateSkill> {
  if (!request.requestedSkillId) return undefined;
  const teammate = request.teammateId ? resolveAiTeammateReference(store, request.teammateId) : undefined;
  if (!teammate) throw new HttpError(400, "skill_teammate_required", "requestedSkillId requires a resolved teammateId.");
  const channel = request.task.channelId ? store.getChannel(request.task.channelId) : undefined;
  const preset = request.providerPresetId ? store.getProviderPreset(request.providerPresetId) : undefined;
  const selected = getEffectiveTeammateSkill(buildEffectiveTeammateSkills({ teammate,
    bindings: store.listTeammateSkillBindings(teammate.id), skills: listExecutableSkillDefinitions(store),
    channelAllowedTools: channel?.allowedTools, providerCapabilities: preset?.capabilities }), request.requestedSkillId);
  if (!selected) throw new HttpError(400, "skill_not_bound", `Skill is not bound to teammate: ${request.requestedSkillId}`);
  if (!selected.executable) throw new HttpError(400, "skill_not_executable",
    `Skill is not executable: ${selected.blockedReasons.map((reason) => reason.code).join(", ")}`);
  return selected;
}
