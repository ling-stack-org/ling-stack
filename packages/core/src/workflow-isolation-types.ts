import type { RuntimeAttemptFenceV1 } from "./runtime-supervisor-types.js";
import type { HostAttemptCompletionRecord } from "./host-attempt-completion-types.js";
import type { WorkflowStepAdmissionPlan } from "./workflow-step-admission.js";
import type { WorkflowStepStartOwnerV1 } from "./workflow-step-start-owner.js";
import type { WorkflowIsolationTerminalResultsStore } from "./workflow-isolation-results-types.js";

export interface WorkflowIsolationRepositoryIdentity {
  /** Host-realpathed Git common directory. Core performs no filesystem or Git I/O. */
  readonly commonDir: string;
  readonly objectFormat: "sha1" | "sha256";
}

export interface WorkflowIsolationLocation {
  readonly executionRoot: string;
  readonly worktreeId: string;
  readonly branchRef: string;
}

export interface WorkflowIsolationTarget extends WorkflowIsolationLocation {
  readonly expectedHead: string;
  readonly cleanStateDigest: string;
  readonly inputMode: "clean_checkout" | "committed_head_only";
}

export interface WorkflowIsolationTemplatePin {
  readonly templateId: string;
  readonly version: string;
  readonly digest: string;
}

export interface WorkflowIsolationSafetyPin {
  readonly workflowStepId: string;
  readonly fingerprint: string;
}

export interface WorkflowIntegrationRoundInputsV1 {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly canonicalWorkspaceId: string;
  readonly canonicalWorkspaceRoot: string;
  readonly repositoryIdentity: WorkflowIsolationRepositoryIdentity;
  readonly target: WorkflowIsolationTarget;
  readonly baseCommit: string;
  readonly integration: WorkflowIsolationLocation;
  readonly graphFingerprint: string;
  readonly safetyFingerprint: string;
  readonly safetyPins: readonly WorkflowIsolationSafetyPin[];
  readonly templatePins: readonly WorkflowIsolationTemplatePin[];
  readonly participants: readonly { readonly workflowStepId: string; readonly position: number; readonly required: boolean }[];
  readonly mergeOrder: readonly string[];
  readonly optionalFailurePolicy: "require_success" | "exclude_failed_with_evidence";
  readonly validationRequirements: readonly { readonly id: string; readonly fingerprint: string }[];
  readonly mode: "candidate_only" | "apply_to_target";
}

/** Frozen before a start owner exists. Runtime identities must never enter its digest. */
export interface WorkflowIsolationScopePlanV1 {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly planDigest: string;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly canonicalWorkspaceId: string;
  readonly canonicalWorkspaceRoot: string;
  readonly repositoryIdentity: WorkflowIsolationRepositoryIdentity;
  readonly target: WorkflowIsolationTarget;
  readonly integrationRoundId: string;
  readonly generation: number;
  readonly stepGeneration: number;
  readonly baseCommit: string;
  readonly executionRoot: string;
  readonly worktreeId: string;
  readonly branchRef: string;
  readonly graphFingerprint: string;
  readonly safetyFingerprint: string;
  readonly templatePins: readonly WorkflowIsolationTemplatePin[];
  readonly resourcePlan: WorkflowStepAdmissionPlan;
}

export interface WorkflowIsolationExecutionBinding {
  readonly bindingId: string;
  readonly revision: number;
  readonly planId: string;
  readonly planDigest: string;
  readonly startOwner: WorkflowStepStartOwnerV1;
  readonly runId: string;
  readonly fence: RuntimeAttemptFenceV1;
  readonly location: WorkflowIsolationLocation;
  readonly status: "planned" | "ready" | "blocked";
  readonly creationReceiptId?: string;
  readonly openIntentId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WorkflowIntegrationRoundPhase = "preparing" | "collecting" | "integrating" | "verifying"
  | "awaiting_approval" | "applying" | "applied" | "conflicted" | "failed" | "blocked";

export interface WorkflowIntegrationCandidate {
  readonly commit: string;
  readonly tree: string;
  readonly packetDigest: string;
  readonly branchResultDigests: readonly string[];
  readonly validationDigest: string;
}

export interface WorkflowIntegrationRound {
  readonly roundId: string;
  readonly generation: number;
  readonly revision: number;
  readonly inputs: WorkflowIntegrationRoundInputsV1;
  readonly inputsDigest: string;
  readonly phase: WorkflowIntegrationRoundPhase;
  readonly lastConfirmedPhase: WorkflowIntegrationRoundPhase;
  readonly writerBindingId?: string;
  readonly openIntentId?: string;
  readonly candidate?: WorkflowIntegrationCandidate;
  readonly outstandingApprovalId?: string;
  readonly reason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Not a caller-supplied authority claim: every write rechecks the actual persisted lineage. */
export interface WorkflowIsolationWriter extends RuntimeAttemptFenceV1 {
  readonly bindingId: string;
}

export type WorkflowIsolationJournalScope = { readonly type: "binding"; readonly bindingId: string }
  | { readonly type: "round"; readonly roundId: string; readonly generation: number };

export interface WorkflowIsolationGitIdentity extends WorkflowIsolationLocation {
  readonly commonDir: string;
  readonly exists: boolean;
  readonly headCommit: string | null;
  readonly tree?: string;
  readonly cleanStateDigest?: string;
}

export type WorkflowIsolationIntentKind = "worktree_create" | "branch_capture" | "integration_create"
  | "integrate_branch" | "candidate_verify" | "target_apply";

export interface WorkflowIsolationIntent {
  readonly intentId: string;
  readonly commandId: string;
  readonly digest: string;
  readonly scope: WorkflowIsolationJournalScope;
  readonly scopeRevision: number;
  readonly writer: WorkflowIsolationWriter;
  readonly kind: WorkflowIsolationIntentKind;
  readonly before: WorkflowIsolationGitIdentity;
  readonly after: WorkflowIsolationGitIdentity;
  readonly status: "pending" | "confirmed" | "blocked" | "effect_unknown";
  readonly createdAt: string;
}

export interface WorkflowIsolationReceipt {
  readonly receiptId: string;
  readonly intentId: string;
  readonly digest: string;
  readonly outcome: "confirmed" | "blocked" | "effect_unknown";
  readonly observed: WorkflowIsolationGitIdentity;
  readonly artifactId: string;
  readonly createdAt: string;
}

export type WorkflowIsolationMutationResult<T> = { readonly status: "created" | "updated" | "duplicate"; readonly value: T }
  | { readonly status: "invalid" | "stale" | "conflict"; readonly code: string };

export interface BindWorkflowIsolationExecutionInput {
  readonly bindingId: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly startOwner: WorkflowStepStartOwnerV1;
  readonly runId: string;
  readonly fence: RuntimeAttemptFenceV1;
  readonly now: string;
}

export interface AdvanceWorkflowIntegrationRoundInput {
  readonly commandId: string;
  readonly roundId: string;
  readonly generation: number;
  readonly expectedRevision: number;
  readonly from: WorkflowIntegrationRoundPhase;
  readonly to: WorkflowIntegrationRoundPhase;
  readonly writer: WorkflowIsolationWriter;
  readonly receiptIds?: readonly string[];
  readonly candidate?: WorkflowIntegrationCandidate;
  readonly approvalId?: string;
  readonly reason?: string;
  readonly now: string;
}

export interface RecordWorkflowIsolationIntentInput {
  readonly intentId: string;
  readonly commandId: string;
  readonly scope: WorkflowIsolationJournalScope;
  readonly expectedRevision: number;
  readonly writer: WorkflowIsolationWriter;
  readonly kind: WorkflowIsolationIntentKind;
  readonly before: WorkflowIsolationGitIdentity;
  readonly after: WorkflowIsolationGitIdentity;
  readonly now: string;
}

export interface RecordWorkflowIsolationReceiptInput {
  readonly receiptId: string;
  readonly intentId: string;
  readonly expectedRevision: number;
  readonly writer: WorkflowIsolationWriter;
  readonly outcome: WorkflowIsolationReceipt["outcome"];
  readonly observed: WorkflowIsolationGitIdentity;
  readonly artifactId: string;
  readonly now: string;
}

export interface SealWorkflowIsolationPreparedExecutionInput {
  readonly writer: WorkflowIsolationWriter;
  readonly expectedRevision: number;
  readonly runnerExecutionInput: Readonly<Record<string, unknown>>;
  readonly now: string;
}

export interface AssertWorkflowIsolationTerminalCaptureInput {
  readonly writer: WorkflowIsolationWriter;
  readonly expectedRevision: number;
  readonly now: string;
}

/** Read-side evidence only, never a live writer, merge permit, or cleanup capability. */
export type WorkflowIsolationTerminalCaptureResult = {
  readonly status: "authorized";
  readonly binding: WorkflowIsolationExecutionBinding;
  readonly plan: WorkflowIsolationScopePlanV1;
  readonly terminal: {
    readonly outcome: "succeeded" | "failed";
    readonly endedAt: string;
    readonly audit: { readonly seq: number; readonly digest: string };
    readonly completion: HostAttemptCompletionRecord;
    readonly effectDigest: string;
    readonly descendantEvidenceFingerprint: string;
  };
  /** Recheck before each physical capture effect; this snapshot grants no future authority. */
  readonly proofDigest: string;
} | { readonly status: "invalid" | "stale" | "blocked"; readonly code: string };

/** Host-internal persistence only. No route, approval grant, Git executor or write-concurrency opt-in. */
export interface WorkflowIsolationStore extends WorkflowIsolationTerminalResultsStore {
  createIntegrationRound(input: { readonly roundId: string; readonly inputs: WorkflowIntegrationRoundInputsV1; readonly now: string }): WorkflowIsolationMutationResult<WorkflowIntegrationRound>;
  getIntegrationRound(roundId: string, generation?: number): WorkflowIntegrationRound | undefined;
  beginIntegrationRoundGeneration(input: { readonly commandId: string; readonly roundId: string; readonly expectedGeneration: number;
    readonly expectedRevision: number; readonly inputs: WorkflowIntegrationRoundInputsV1; readonly writer: WorkflowIsolationWriter;
    readonly now: string }): WorkflowIsolationMutationResult<WorkflowIntegrationRound>;
  createScopePlan(input: { readonly plan: WorkflowIsolationScopePlanV1; readonly now: string }): WorkflowIsolationMutationResult<WorkflowIsolationScopePlanV1>;
  getScopePlan(planId: string): WorkflowIsolationScopePlanV1 | undefined;
  bindExecution(input: BindWorkflowIsolationExecutionInput): WorkflowIsolationMutationResult<WorkflowIsolationExecutionBinding>;
  getExecutionBinding(bindingId: string): WorkflowIsolationExecutionBinding | undefined;
  assertExecutionBinding(input: { readonly writer: WorkflowIsolationWriter; readonly now: string; readonly requireReady?: boolean }):
    { readonly status: "current"; readonly binding: WorkflowIsolationExecutionBinding; readonly plan: WorkflowIsolationScopePlanV1 }
    | { readonly status: "stale" | "invalid"; readonly code: string };
  /** Original terminal lineage may be read after resource release; live execution checks remain unchanged. */
  assertTerminalCapture(input: AssertWorkflowIsolationTerminalCaptureInput): WorkflowIsolationTerminalCaptureResult;
  markExecutionReady(input: { readonly commandId: string; readonly writer: WorkflowIsolationWriter; readonly expectedRevision: number;
    readonly creationReceiptId: string; readonly now: string }): WorkflowIsolationMutationResult<WorkflowIsolationExecutionBinding>;
  /** Physical-ready, before dispatch; may precede admission transfer. Only appends matching Pi evidence to both requests. */
  sealPreparedExecution(input: SealWorkflowIsolationPreparedExecutionInput): WorkflowIsolationMutationResult<WorkflowIsolationExecutionBinding>;
  advanceIntegrationRound(input: AdvanceWorkflowIntegrationRoundInput): WorkflowIsolationMutationResult<WorkflowIntegrationRound>;
  recordIntent(input: RecordWorkflowIsolationIntentInput): WorkflowIsolationMutationResult<WorkflowIsolationIntent>;
  getIntent(intentId: string): WorkflowIsolationIntent | undefined;
  recordReceipt(input: RecordWorkflowIsolationReceiptInput): WorkflowIsolationMutationResult<WorkflowIsolationReceipt>;
  getReceipt(receiptId: string): WorkflowIsolationReceipt | undefined;
  listPendingIntents(input?: { readonly roundId?: string; readonly bindingId?: string; readonly limit?: number }): readonly WorkflowIsolationIntent[];
}
