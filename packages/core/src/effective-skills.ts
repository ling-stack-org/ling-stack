import type { RunTool } from "./approval-policy.js";
import type { ProviderCapability } from "./provider-types.js";
import type { SkillApprovalMode, SkillDefinition } from "./skill-types.js";
import type { AiTeammate, TeammateSkillBinding } from "./workspace-types.js";

export type EffectiveSkillBlockedReasonCode =
  | "disabled_binding"
  | "missing_tools"
  | "missing_provider_capability"
  | "channel_policy"
  | "approval_mismatch";

export interface EffectiveSkillBlockedReason {
  readonly code: EffectiveSkillBlockedReasonCode;
  readonly message: string;
  readonly missing?: readonly string[];
}

export interface EffectiveTeammateSkill {
  readonly teammateId: string;
  readonly skillId: string;
  readonly skill: SkillDefinition;
  readonly binding: TeammateSkillBinding;
  readonly executable: boolean;
  readonly blockedReasons: readonly EffectiveSkillBlockedReason[];
  readonly promptFragments: readonly string[];
  readonly requiredTools: readonly RunTool[];
  readonly requiredProviderCapabilities: readonly ProviderCapability[];
}

export interface BuildEffectiveTeammateSkillsInput {
  readonly teammate: AiTeammate;
  readonly bindings: readonly TeammateSkillBinding[];
  readonly skills: readonly SkillDefinition[];
  readonly channelAllowedTools?: readonly RunTool[];
  readonly providerCapabilities?: readonly ProviderCapability[];
}

export function buildEffectiveTeammateSkills(input: BuildEffectiveTeammateSkillsInput): EffectiveTeammateSkill[] {
  const skillsById = new Map(input.skills.map((skill) => [skill.id, skill]));
  return input.bindings.flatMap((binding): EffectiveTeammateSkill[] => {
    const skill = skillsById.get(binding.skillId);
    if (!skill) {
      return [];
    }
    const blockedReasons = effectiveSkillBlockedReasons(input, binding, skill);
    return [
      {
        teammateId: input.teammate.id,
        skillId: skill.id,
        skill,
        binding,
        executable: blockedReasons.length === 0,
        blockedReasons,
        promptFragments: skill.promptFragments,
        requiredTools: skill.requiredTools,
        requiredProviderCapabilities: skill.requiredProviderCapabilities,
      },
    ];
  });
}

export function getEffectiveTeammateSkill(
  skills: readonly EffectiveTeammateSkill[],
  skillId: string,
): EffectiveTeammateSkill | undefined {
  return skills.find((skill) => skill.skillId === skillId);
}

function effectiveSkillBlockedReasons(
  input: BuildEffectiveTeammateSkillsInput,
  binding: TeammateSkillBinding,
  skill: SkillDefinition,
): EffectiveSkillBlockedReason[] {
  const reasons: EffectiveSkillBlockedReason[] = [];
  if (!binding.enabled) {
    reasons.push({
      code: "disabled_binding",
      message: "Skill binding is disabled for this teammate.",
    });
  }

  const teammateMissingTools = missingValues(skill.requiredTools, input.teammate.allowedTools);
  if (teammateMissingTools.length > 0) {
    reasons.push({
      code: "missing_tools",
      message: "Teammate does not have the tools required by this skill.",
      missing: teammateMissingTools,
    });
  }

  if (input.channelAllowedTools) {
    const channelMissingTools = missingValues(skill.requiredTools, input.channelAllowedTools);
    if (channelMissingTools.length > 0) {
      reasons.push({
        code: "channel_policy",
        message: "Channel policy does not allow every tool required by this skill.",
        missing: channelMissingTools,
      });
    }
  }

  if (input.providerCapabilities) {
    const missingCapabilities = missingValues(skill.requiredProviderCapabilities, input.providerCapabilities);
    if (missingCapabilities.length > 0) {
      reasons.push({
        code: "missing_provider_capability",
        message: "Selected provider is missing capabilities required by this skill.",
        missing: missingCapabilities,
      });
    }
  }

  if (approvalModeRank(input.teammate.approvalProfile.mode) < approvalModeRank(skill.approvalProfile.mode)) {
    reasons.push({
      code: "approval_mismatch",
      message: "Teammate approval profile is weaker than the skill approval profile.",
    });
  }

  return reasons;
}

function missingValues<T extends string>(required: readonly T[], allowed: readonly T[]): T[] {
  const allowedSet = new Set(allowed);
  return required.filter((value) => !allowedSet.has(value));
}

function approvalModeRank(mode: SkillApprovalMode): number {
  if (mode === "strict") {
    return 2;
  }
  if (mode === "standard") {
    return 1;
  }
  return 0;
}
