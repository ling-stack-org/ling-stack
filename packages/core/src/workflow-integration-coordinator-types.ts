import type { WorkflowIntegrationRound, WorkflowIntegrationRoundPhase, WorkflowIntegrationCandidate,
  WorkflowIsolationExecutionBinding, WorkflowIsolationScopePlanV1, WorkflowIsolationWriter, WorkflowIsolationIntent,
  WorkflowIsolationReceipt, WorkflowIsolationGitIdentity, WorkflowIsolationMutationResult } from "./workflow-isolation-types.js";
import type { WorkflowIsolationTerminalResultIntent } from "./workflow-isolation-results-types.js";

export interface WorkflowIntegrationCoordinatorParticipant {
  readonly binding: WorkflowIsolationExecutionBinding;
  readonly plan: WorkflowIsolationScopePlanV1;
  readonly proofDigest: string;
  readonly resultIntent: WorkflowIsolationTerminalResultIntent;
}

export type WorkflowIntegrationCoordinatorAuthority = {
  readonly status: "authorized";
  readonly round: WorkflowIntegrationRound;
  readonly writer: WorkflowIsolationWriter;
  /** Stable across this round's own phase/revision and effect journal changes. */
  readonly authorityDigest: string;
  readonly participants: readonly WorkflowIntegrationCoordinatorParticipant[];
} | { readonly status: "invalid" | "stale" | "blocked"; readonly code: string };

export type WorkflowIntegrationCoordinatorEffectKind = "integration_create" | "integrate_branch" | "candidate_verify";

/** Generic intent plus an immutable link to the retained Host effect payload. */
export interface WorkflowIntegrationCoordinatorEffect extends WorkflowIsolationIntent {
  readonly effectKey: string;
  readonly payloadArtifactId: string;
  readonly payloadContentSha256: string;
  readonly authorityDigest: string;
}

export interface WorkflowIntegrationCoordinatorEffectEvidenceV1 {
  readonly schemaVersion: 1;
  readonly kind: "workflow_integration_coordinator_effect";
  readonly roundId: string;
  readonly generation: number;
  readonly authorityDigest: string;
  readonly effectKey: string;
  readonly effectKind: WorkflowIntegrationCoordinatorEffectKind;
  readonly before: WorkflowIsolationGitIdentity;
  readonly after: WorkflowIsolationGitIdentity;
  readonly effect: Readonly<Record<string, unknown>>;
}

export interface WorkflowIntegrationCoordinatorReceiptEvidenceV1 {
  readonly schemaVersion: 1;
  readonly kind: "workflow_integration_coordinator_receipt";
  readonly intentId: string;
  readonly effectKey: string;
  readonly outcome: WorkflowIsolationReceipt["outcome"];
  readonly observed: WorkflowIsolationGitIdentity;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface RecordWorkflowIntegrationCoordinatorIntentInput {
  readonly roundId: string;
  readonly generation: number;
  readonly expectedRevision: number;
  readonly authorityDigest: string;
  readonly effectKey: string;
  readonly kind: WorkflowIntegrationCoordinatorEffectKind;
  readonly before: WorkflowIsolationGitIdentity;
  readonly after: WorkflowIsolationGitIdentity;
  readonly payloadArtifactId: string;
  readonly now: string;
}

export interface RecordWorkflowIntegrationCoordinatorReceiptInput {
  readonly intentId: string;
  readonly expectedRevision: number;
  readonly authorityDigest: string;
  readonly outcome: WorkflowIsolationReceipt["outcome"];
  readonly observed: WorkflowIsolationGitIdentity;
  readonly artifactId: string;
  readonly now: string;
}

export interface AdvanceWorkflowIntegrationCoordinatorRoundInput {
  readonly roundId: string;
  readonly generation: number;
  readonly expectedRevision: number;
  readonly authorityDigest: string;
  readonly from: WorkflowIntegrationRoundPhase;
  readonly to: WorkflowIntegrationRoundPhase;
  readonly receiptIds?: readonly string[];
  readonly candidate?: WorkflowIntegrationCandidate;
  readonly candidateArtifactId?: string;
  readonly reason?: string;
  readonly now: string;
}

/** Host-only terminal round authority, never a live writer or target-apply permit. */
export interface WorkflowIntegrationCoordinatorStore {
  assertAuthority(input: { readonly roundId: string; readonly generation: number; readonly now: string }): WorkflowIntegrationCoordinatorAuthority;
  recordIntent(input: RecordWorkflowIntegrationCoordinatorIntentInput): WorkflowIsolationMutationResult<WorkflowIntegrationCoordinatorEffect>;
  recordReceipt(input: RecordWorkflowIntegrationCoordinatorReceiptInput): WorkflowIsolationMutationResult<WorkflowIsolationReceipt>;
  advanceRound(input: AdvanceWorkflowIntegrationCoordinatorRoundInput): WorkflowIsolationMutationResult<WorkflowIntegrationRound>;
  listEffects(input: { readonly roundId: string; readonly generation: number }): readonly WorkflowIntegrationCoordinatorEffect[];
  listReceipts(input: { readonly roundId: string; readonly generation: number }): readonly WorkflowIsolationReceipt[];
  listRounds(workflowId?: string): readonly WorkflowIntegrationRound[];
  /** Observation only, including cancelled/older generations. Never grants a stopped or apply capability. */
  readPublicationBlocker(workflowId: string): string | undefined;
  readCompletionBlocker(workflowId: string): string | undefined;
}
