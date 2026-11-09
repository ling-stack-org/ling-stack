/** Public observations only. None of these identities grants execution or merge authority. */
export interface WorkflowIntegrationRoundEvidenceV1 {
  readonly roundId: string;
  readonly generation: number;
  readonly revision: number;
  readonly phase: "preparing" | "collecting" | "integrating" | "verifying" | "awaiting_approval"
    | "applying" | "applied" | "conflicted" | "failed" | "blocked";
  readonly lastConfirmedPhase: WorkflowIntegrationRoundEvidenceV1["phase"];
  readonly mode: "candidate_only" | "apply_to_target";
  readonly maxConcurrentSteps: number;
  readonly participants: readonly { readonly workflowStepId: string; readonly required: boolean }[];
  readonly candidate?: { readonly commit: string; readonly tree: string };
  readonly approval?: {
    readonly approvalId: string;
    readonly status: "pending" | "approved" | "denied" | "expired" | "cancelled" | "blocked";
    readonly reasonCode?: string;
  };
  readonly application: {
    readonly status: "not_started" | "pending" | "applied" | "not_applied" | "effect_unknown" | "blocked" | "invalid";
    readonly reasonCode?: string;
  };
  readonly effects: readonly {
    readonly id: string;
    readonly kind: "worktree_create" | "branch_capture" | "integration_create" | "integrate_branch" | "candidate_verify" | "target_apply";
    readonly status: "pending" | "confirmed" | "blocked" | "effect_unknown";
    readonly artifactIds: readonly string[];
  }[];
  readonly reasonCode?: string;
  readonly updatedAt: string;
}

export interface WorkflowIsolationEvidenceV1 {
  readonly schemaVersion: 1;
  readonly status: "available" | "unavailable";
  readonly rounds: readonly WorkflowIntegrationRoundEvidenceV1[];
  /** Journal confirmation is not proof that an Attempt or its descendants have stopped. */
  readonly gitEffects: "confirmed" | "unconfirmed";
  readonly hostOperationPending: boolean;
  readonly completion: "ready" | "blocked";
  readonly publicationBlockerCode?: string;
  readonly completionBlockerCode?: string;
  readonly reasonCode?: string;
}
