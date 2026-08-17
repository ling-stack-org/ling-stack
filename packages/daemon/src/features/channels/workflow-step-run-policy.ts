import type { SkillApprovalProfile } from "@ling-stack/core";

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
  if (!base) return override;
  if (!override) return base;
  return {
    mode: strictestApprovalMode(base.mode, override.mode),
    risk: override.risk ?? base.risk,
    requiredForTools: mergeStringLists(base.requiredForTools, override.requiredForTools),
    requiredForActions: mergeStringLists(base.requiredForActions, override.requiredForActions),
  };
}

function strictestApprovalMode(
  left: SkillApprovalProfile["mode"],
  right: SkillApprovalProfile["mode"],
): SkillApprovalProfile["mode"] {
  const rank = { none: 0, standard: 1, strict: 2 } as const;
  return rank[left] >= rank[right] ? left : right;
}

function mergeStringLists<T extends string>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): readonly T[] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}
