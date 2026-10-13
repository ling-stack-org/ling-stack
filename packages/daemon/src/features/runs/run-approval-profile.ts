import { mergeRunProgressApprovalProfiles as mergeApprovalProfiles,
  type RunSession, type RunStore, type RunTool, type SkillApprovalProfile } from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";
import { parseApprovalProfileObject } from "../../shared/approval-profile.js";
import { resolveCurrentRunSkill } from "./skill-selection.js";

export function mergeRunTools(base: readonly RunTool[], required: readonly RunTool[]): RunTool[] {
  return [...new Set([...base, ...required])];
}
/** One pure merge for admission, last-moment command authority and checkpoint validation. */
export { mergeApprovalProfiles };

/** Rebuild the selected skill's current DB profile; requestSnapshot alone did not persist this merge. */
export function readCurrentRunApprovalProfile(store: RunStore, run: RunSession): SkillApprovalProfile | undefined {
  const snapshot = isRecord(run.requestSnapshot) ? run.requestSnapshot : {};
  if (snapshot.approvalProfile !== undefined && !isRecord(snapshot.approvalProfile)) throw new Error("unified_exec_raw_profile_invalid");
  const base = isRecord(snapshot.approvalProfile) ? parseApprovalProfileObject(snapshot.approvalProfile, "approvalProfile") : undefined;
  const requested = snapshot.requestedSkillId, stored = snapshot.selectedSkillId;
  if ([requested, stored].some(id => id !== undefined && (typeof id !== "string" || !id.trim()))
    || stored !== undefined && stored !== run.selectedSkillId
    || requested !== undefined && run.selectedSkillId !== undefined && requested !== run.selectedSkillId) {
    throw new Error("unified_exec_raw_skill_source_invalid");
  }
  const requestedSkillId = run.selectedSkillId ?? requested;
  if (requestedSkillId === undefined) return base;
  const skill = resolveCurrentRunSkill(store, { requestedSkillId: requestedSkillId as string,
    teammateId: run.teammateId, providerPresetId: run.providerPresetId, task: { channelId: run.channelId } });
  if (!skill) throw new Error("unified_exec_raw_skill_source_invalid");
  return mergeApprovalProfiles(base, skill.skill.approvalProfile);
}
