export type ApprovalPostCommitEffectKind = "decision_event" | "owner" | "control_plane_event";
export type ApprovalPostCommitOwnerKind = "run" | "workflow_step" | "media_job" | "external_work_action";
export type ApprovalPostCommitEffectStatus = "pending" | "claimed" | "completed" | "blocked" | "effect_unknown";

/** A decision is durable before any of these independently recoverable effects run. */
export interface ApprovalPostCommitEffect {
  readonly approvalId: string;
  readonly effectKind: ApprovalPostCommitEffectKind;
  readonly ownerKind?: ApprovalPostCommitOwnerKind;
  readonly ownerId?: string;
  readonly status: ApprovalPostCommitEffectStatus;
  readonly revision: number;
  readonly claimToken?: string;
  readonly claimExpiresAt?: string;
  readonly attempts: number;
  readonly lastErrorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
