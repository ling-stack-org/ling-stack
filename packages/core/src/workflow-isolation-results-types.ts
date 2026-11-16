import type { WorkflowIsolationMutationResult, WorkflowIsolationWriter } from "./workflow-isolation-types.js";
import type { ChannelWorkflowStep } from "./workspace-types.js";

export type WorkflowIsolationTerminalResultOutcome = "confirmed" | "blocked" | "effect_unknown";

/** A protected result ref, never the source worktree branch or an apply permit. */
export interface WorkflowIsolationTerminalResultEffectV1 {
  readonly kind: "branch_capture";
  readonly roundId: string;
  /** Step execution generation, not the Integration Round generation. */
  readonly generation: number;
  readonly commonDir: string;
  readonly ref: string;
  readonly beforeCommit: null;
  readonly afterCommit: string;
  readonly tree: string;
  readonly packetDigest: string;
  readonly packetJson: string;
}

export interface WorkflowIsolationTerminalResultReceiptEvidenceV1 {
  readonly schemaVersion: 1;
  readonly kind: "workflow_isolation_result_ref_receipt";
  readonly intentId: string;
  readonly effect: WorkflowIsolationTerminalResultEffectV1;
  readonly outcome: WorkflowIsolationTerminalResultOutcome;
  readonly observedCommit: string | null;
}

export interface WorkflowIsolationTerminalResultIntent {
  readonly intentId: string;
  readonly writer: WorkflowIsolationWriter;
  readonly bindingRevision: number;
  readonly proofDigest: string;
  readonly packetArtifactId: string;
  readonly packetContentSha256: string;
  readonly packetDigest: string;
  readonly commonDir: string;
  readonly ref: string;
  readonly commit: string;
  readonly tree: string;
  readonly revision: number;
  readonly status: "pending" | WorkflowIsolationTerminalResultOutcome;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowIsolationTerminalResultReceipt {
  readonly receiptId: string;
  readonly intentId: string;
  readonly writer: WorkflowIsolationWriter;
  /** Result-journal revision after this receipt, never the execution binding revision. */
  readonly revision: number;
  readonly outcome: WorkflowIsolationTerminalResultOutcome;
  readonly observedCommit: string | null;
  readonly artifactId: string;
  readonly artifactContentSha256: string;
  readonly createdAt: string;
}

export interface RecordWorkflowIsolationTerminalResultIntentInput {
  readonly intentId: string;
  readonly writer: WorkflowIsolationWriter;
  readonly expectedBindingRevision: number;
  readonly proofDigest: string;
  readonly packetArtifactId: string;
  readonly packetDigest: string;
  readonly ref: string;
  readonly commit: string;
  readonly tree: string;
  readonly now: string;
}

export interface RecordWorkflowIsolationTerminalResultReceiptInput {
  readonly receiptId: string;
  readonly intentId: string;
  readonly writer: WorkflowIsolationWriter;
  readonly expectedRevision: number;
  readonly outcome: WorkflowIsolationTerminalResultOutcome;
  readonly observedCommit: string | null;
  readonly artifactId: string;
  readonly now: string;
}

export interface ResumeWorkflowIsolationTerminalResultStepInput {
  readonly writer: WorkflowIsolationWriter;
  readonly expectedBindingRevision: number;
  readonly now: string;
}

export interface WorkflowIsolationTerminalResultsStore {
  /** Only created starts a new effect. Every duplicate must reconcile, never replay the Git write. */
  recordTerminalResultIntent(input: RecordWorkflowIsolationTerminalResultIntentInput): WorkflowIsolationMutationResult<WorkflowIsolationTerminalResultIntent>;
  getTerminalResultIntent(bindingId: string): WorkflowIsolationTerminalResultIntent | undefined;
  recordTerminalResultReceipt(input: RecordWorkflowIsolationTerminalResultReceiptInput): WorkflowIsolationMutationResult<WorkflowIsolationTerminalResultReceipt>;
  getTerminalResultReceipt(receiptId: string): WorkflowIsolationTerminalResultReceipt | undefined;
  /** Semantic recovery only: no new owner, execution, resource release, approval or merge authority. */
  resumeTerminalResultStep(input: ResumeWorkflowIsolationTerminalResultStepInput): WorkflowIsolationMutationResult<ChannelWorkflowStep>;
}
