import type { ApprovalDetailResponse } from "@ling-stack/contracts";

/** Observation of post-decision work, never permission to replay a decision or tool. */
export type ApprovalRecoveryState = "pending" | "completed" | "blocked" | "unknown";

export function approvalReceiptRecoveryState(receipt: ApprovalDetailResponse): ApprovalRecoveryState {
  const effects = receipt.postCommitEffects;
  if (!Array.isArray(effects)) return "unknown";
  const seen = new Set<string>();
  for (const effect of effects) {
    if (!effect || effect.approvalId !== receipt.approval.id
      || !["decision_event", "owner", "control_plane_event"].includes(effect.effectKind)
      || !["pending", "claimed", "completed", "blocked", "effect_unknown"].includes(effect.status)
      || seen.has(effect.effectKind)) return "unknown";
    seen.add(effect.effectKind);
  }
  if (effects.some(effect => effect.status === "effect_unknown")) return "unknown";
  if (effects.some(effect => effect.status === "blocked")) return "blocked";
  return effects.every(effect => effect.status === "completed") ? "completed" : "pending";
}

export function approvalRecoveryNotice(state: ApprovalRecoveryState) {
  if (state === "completed") return undefined;
  if (state === "pending") return {
    tone: "info" as const,
    message: "Approval recorded. Execution recovery is in progress.",
  };
  return {
    tone: "warning" as const,
    message: state === "blocked"
      ? "Approval recorded, but execution recovery is blocked. Check run status; do not approve again."
      : "Execution recovery could not be confirmed. Check run status; do not approve again.",
  };
}
