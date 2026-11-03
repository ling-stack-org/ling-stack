import { mergeWorkflowPreApprovalProfiles, type SkillApprovalProfile } from "@ling-stack/core";

/**
 * Merge two approval profiles conservatively. Every non-empty requirement from either
 * profile is retained and the stricter mode wins. This helper is shared by direct,
 * orchestrated, retry, and approval-resume workflow starts so no route can bypass a
 * workflow-step gate.
 */
export function mergeWorkflowApprovalProfiles(
  base: SkillApprovalProfile | undefined,
  override: SkillApprovalProfile | undefined,
): SkillApprovalProfile | undefined {
  return mergeWorkflowPreApprovalProfiles(base, override);
}
