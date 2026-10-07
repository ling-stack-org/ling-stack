import {
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type RunEventEnvelope,
  type RunSession,
  type RunStore,
  type WorkflowStepFailurePolicy,
  type WorkflowStepPolicy,
} from "@ling-stack/core";
import {
  delegatedStepFinalizationBasisFingerprintV1,
  delegatedStepRequirementFingerprintV1,
  isDelegatedStepRequirementV1,
  type DelegatedBlockCodeV1,
  type DelegatedEvidenceRefV1,
  type DelegatedLineageV1,
  type DelegatedOutcomeV1,
  type DelegatedTerminalCodeV1,
  type WorkflowPacketSourceRef,
  type WorkflowStepExecutionVerificationV1,
} from "@ling-stack/contracts";
import { isRecord } from "../../shared/validation.js";
import { listAllExecutionActionsForRun } from "../runs/execution-actions.js";
import { readRunNarrationSnapshot } from "../conversations/narration-segments.js";
import { preserveMarkdownLayout } from "./markdown-text.js";
import { verifyWorkflowStepExecutionOperations } from "./workflow-operation-evidence.js";
import {
  prepareDeterministicWorkflowStepOutputArtifact,
  readWorkflowStepOutputPacketArtifact,
} from "./workflow-step-packets.js";

export type WorkflowReconcileCause =
  | "run_terminal"
  | "approval_decision"
  | "run_start_preflight"
  | "startup"
  | "explicit_reconcile"
  | "duplicate_callback"
  | "pre_publication";

export type DelegatedStepFinalizationResult =
  | { readonly status: "not_found" }
  | { readonly status: "not_delegated"; readonly step: ChannelWorkflowStep }
  | { readonly status: "waiting"; readonly step: ChannelWorkflowStep; readonly reason: string }
  | { readonly status: "finalized" | "duplicate"; readonly step: ChannelWorkflowStep }
  | { readonly status: "stale"; readonly step: ChannelWorkflowStep };

type DelegatedOutcomeCandidate =
  | Omit<Extract<DelegatedOutcomeV1, { readonly kind: "completed" }>, "lineage">
  | Omit<Extract<DelegatedOutcomeV1, { readonly kind: "blocked" }>, "lineage">
  | Omit<Extract<DelegatedOutcomeV1, { readonly kind: "failed" | "cancelled" }>, "lineage">;

export interface DelegatedStepContextBlocker {
  readonly code: "agent_context_missing" | "agent_context_stale" | "agent_context_private_leak";
  readonly reason: string;
  readonly review: NonNullable<ChannelWorkflowStep["metadata"]>["resultContextReview"];
}

const DEFAULT_WORKFLOW_STEP_POLICY: WorkflowStepPolicy = {
  onRunFailed: "block_for_user",
  onRunCancelled: "block_for_user",
  onApprovalDenied: "block_for_user",
  retryable: true,
};

export function blockDelegatedWorkflowStepBeforeRun(input: {
  readonly store: RunStore;
  readonly workflowStepId: string;
  readonly code: DelegatedBlockCodeV1;
  readonly reason: string;
  readonly missingRequirements: readonly string[];
  readonly now?: string;
}): DelegatedStepFinalizationResult {
  const now = input.now ?? new Date().toISOString();
  const step = input.store.getChannelWorkflowStep(input.workflowStepId);
  if (!step) return { status: "not_found" };
  const workflow = input.store.getChannelWorkflow(step.workflowId);
  if (!workflow?.metadata?.requiredParticipantManifest) return { status: "not_delegated", step };
  if (isTerminalStep(step) && step.metadata?.delegatedOutcomeBasisFingerprint) {
    return { status: "duplicate", step };
  }
  if (step.status !== "running" && step.status !== "waiting_for_approval") {
    return { status: "waiting", step, reason: `step_${step.status}` };
  }
  if (step.runId) {
    return { status: "stale", step };
  }
  const requirement = step.metadata?.delegatedRequirement;
  const outcome = !isDelegatedStepRequirementV1(requirement)
    || requirement.workflowId !== workflow.id
    || requirement.workflowStepId !== step.id
    || requirement.participantId !== step.toParticipantId
    || requirement.participantManifestFingerprint !== workflow.metadata.requiredParticipantManifest.fingerprint
    ? blockedOutcome(step, "delegated_requirement_invalid", "Delegated step requirement is missing or inconsistent.", ["delegated_requirement"])
    : blockedOutcome(step, input.code, input.reason, input.missingRequirements);
  return commitCandidate(input.store, workflow, step, undefined, {
    finalStatus: "blocked",
    outcome,
    blocker: outcome.kind === "blocked" ? outcome.code : "delegated_requirement_invalid",
    resultSummary: undefined,
  }, "run_start_preflight", now);
}

export function finalizeDelegatedWorkflowStepFromCanonicalState(input: {
  readonly store: RunStore;
  readonly workflowStepId: string;
  readonly cause: WorkflowReconcileCause;
  readonly now?: string;
  readonly contextBlocker?: DelegatedStepContextBlocker;
}): DelegatedStepFinalizationResult {
  const now = input.now ?? new Date().toISOString();
  const step = input.store.getChannelWorkflowStep(input.workflowStepId);
  if (!step) return { status: "not_found" };
  const workflow = input.store.getChannelWorkflow(step.workflowId);
  if (!workflow?.metadata?.requiredParticipantManifest) return { status: "not_delegated", step };
  if (isTerminalStep(step) && step.metadata?.delegatedOutcomeBasisFingerprint) {
    return { status: "duplicate", step };
  }
  if (step.status !== "running" && step.status !== "waiting_for_approval") {
    return { status: "waiting", step, reason: `step_${step.status}` };
  }
  const requirement = step.metadata?.delegatedRequirement;
  if (!isDelegatedStepRequirementV1(requirement)
    || requirement.workflowId !== workflow.id
    || requirement.workflowStepId !== step.id
    || requirement.participantId !== step.toParticipantId
    || requirement.participantManifestFingerprint !== workflow.metadata.requiredParticipantManifest.fingerprint) {
    return commitCandidate(input.store, workflow, step, undefined, {
      finalStatus: "blocked",
      outcome: blockedOutcome(step, "delegated_requirement_invalid", "Delegated step requirement is missing or inconsistent.", ["delegated_requirement"]),
      blocker: "delegated_requirement_invalid",
      resultSummary: undefined,
    }, input.cause, now);
  }
  const run = step.runId ? input.store.getRun(step.runId) : undefined;
  if (!run) {
    return commitCandidate(input.store, workflow, step, undefined, {
      finalStatus: "blocked",
      outcome: blockedOutcome(step, "delegated_run_missing", "The delegated step has no current linked Run.", ["linked_run"]),
      blocker: "delegated_run_missing",
      resultSummary: undefined,
    }, input.cause, now);
  }
  if (!isTerminalRun(run)) {
    return { status: "waiting", step, reason: `run_${run.status}` };
  }
  if (run.workflowStepId && run.workflowStepId !== step.id) {
    return commitCandidate(input.store, workflow, step, run, {
      finalStatus: "blocked",
      outcome: blockedOutcome(step, "delegated_run_owner_mismatch", "The linked Run belongs to a different workflow step.", ["run_owner"]),
      blocker: "delegated_run_owner_mismatch",
      resultSummary: undefined,
    }, input.cause, now);
  }
  if (input.contextBlocker) {
    const contextualStep = {
      ...step,
      metadata: { ...step.metadata, resultContextReview: input.contextBlocker.review },
    };
    return commitCandidate(input.store, workflow, contextualStep, run, {
      finalStatus: "blocked",
      outcome: blockedOutcome(
        step,
        input.contextBlocker.code,
        input.contextBlocker.reason,
        ["agent_context"],
      ),
      blocker: input.contextBlocker.reason,
      resultSummary: undefined,
    }, input.cause, now);
  }
  const approval = step.metadata?.postStepApprovalId
    ? input.store.getApprovalRequest(step.metadata.postStepApprovalId)
    : undefined;
  if (approval?.status === "pending") {
    return { status: "waiting", step, reason: "post_step_approval_pending" };
  }
  if (step.status === "waiting_for_approval" && !approval) {
    return { status: "waiting", step, reason: "post_step_approval_missing" };
  }
  if (step.status === "waiting_for_approval" && approval?.status === "approved") {
    const workflowApproval = workflow.status === "waiting_for_approval"
      ? input.store.transitionChannelWorkflowStatus({
          workflowId: workflow.id,
          expectedStatus: "waiting_for_approval",
          event: "approval_approved",
          actor: input.cause === "approval_decision" ? "local-user" : "system",
          reason: `${input.cause}:${approval.id}`,
          idempotencyKey: `delegated-post-approval:workflow:${approval.id}`,
          now,
        })
      : { ok: true as const, from: workflow.status, to: workflow.status };
    if (!workflowApproval.ok) return { status: "stale", step };
    const stepApproval = input.store.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "waiting_for_approval",
      event: "approval_approved",
      actor: input.cause === "approval_decision" ? "local-user" : "system",
      reason: `${input.cause}:${approval.id}`,
      idempotencyKey: `delegated-post-approval:step:${approval.id}`,
      now,
      blocker: null,
    });
    if (!stepApproval.ok) return { status: "stale", step: input.store.getChannelWorkflowStep(step.id) ?? step };
    const resumed = input.store.getChannelWorkflowStep(step.id);
    if (!resumed) return { status: "not_found" };
    const { activeGateStage: _activeGateStage, ...metadata } = resumed.metadata ?? {};
    input.store.updateChannelWorkflowStep(step.id, { metadata }, now);
    return finalizeDelegatedWorkflowStepFromCanonicalState(input);
  }
  if (approval && approval.status !== "approved") {
    const reason = approval.decisionReason ?? `Workflow post-step approval ${approval.status}.`;
    return commitCandidate(input.store, workflow, step, run, {
      finalStatus: failurePolicyStatus(resolveWorkflowStepPolicy(step).onApprovalDenied),
      outcome: failedOutcome(step, "failed", "post_step_approval_denied", reason),
      blocker: reason,
      resultSummary: undefined,
    }, input.cause, now, approval);
  }
  if (run.status === "failed" || run.status === "cancelled") {
    const loopDetection = run.status === "failed" ? latestExecutionLoopDetection(input.store, run.id) : undefined;
    if (loopDetection) {
      return commitCandidate(input.store, workflow, step, run, {
        finalStatus: "blocked",
        outcome: blockedOutcome(step, "execution_loop_detected", loopDetection.message, ["manual_intervention"]),
        blocker: loopDetection.message,
        resultSummary: undefined,
      }, input.cause, now, approval);
    }
    const policy = run.status === "cancelled"
      ? resolveWorkflowStepPolicy(step).onRunCancelled
      : resolveWorkflowStepPolicy(step).onRunFailed;
    const reason = run.errorMessage ?? `Run ${run.status}: ${run.id}`;
    const approvalResumeCode = approvalResumeBlockerCode(reason);
    if (approvalResumeCode) {
      return commitCandidate(input.store, workflow, step, run, {
        finalStatus: "blocked",
        outcome: blockedOutcome(step, approvalResumeCode, reason, ["approval_resume"]),
        blocker: reason,
        resultSummary: undefined,
      }, input.cause, now, approval);
    }
    return commitCandidate(input.store, workflow, step, run, {
      finalStatus: failurePolicyStatus(policy),
      outcome: failedOutcome(
        step,
        run.status,
        run.status === "failed" ? "delegated_run_failed" : "delegated_run_cancelled",
        reason,
      ),
      blocker: reason,
      resultSummary: undefined,
    }, input.cause, now, approval);
  }
  const resultSummary = workflowStepRunResultSummary(input.store, run);
  const verification = verifyWorkflowStepExecutionOperations({ store: input.store, step, now });
  if (verification && verification.status !== "verified") {
    const reason = executionVerificationFailureReason(verification);
    return commitCandidate(input.store, workflow, step, run, {
      finalStatus: verification.status === "failed"
        ? failurePolicyStatus(resolveWorkflowStepPolicy(step).onRunFailed)
        : "blocked",
      outcome: verification.status === "failed"
        ? failedOutcome(step, "failed", "required_operation_failed", reason)
        : blockedOutcome(step, "required_operation_evidence_missing", reason, missingOperationIds(verification)),
      executionVerification: verification,
      blocker: reason,
      resultSummary: undefined,
    }, input.cause, now, approval);
  }
  if (requirement.expectedOutcome === "synthesis" && !step.metadata?.outputArtifactId) {
    const artifact = prepareDeterministicWorkflowStepOutputArtifact({
      store: input.store,
      workflow,
      step: { ...step, status: "succeeded", resultSummary },
      run,
      requirement,
      now,
    });
    const refreshedStep = input.store.getChannelWorkflowStep(step.id);
    if (!refreshedStep || refreshedStep.runId !== run.id
      || refreshedStep.metadata?.outputArtifactId !== artifact.id) {
      return { status: "stale", step: refreshedStep ?? step };
    }
    return finalizeDelegatedWorkflowStepFromCanonicalState(input);
  }
  const evidenceRefs = evidenceRefsForSuccessfulStep(input.store, workflow, step, run, requirement, verification);
  if (evidenceRefs.length === 0) {
    const code = requirement.expectedOutcome === "synthesis"
      ? "required_participant_output_packet_missing"
      : "delegated_outcome_missing";
    const missing = requirement.expectedOutcome === "synthesis" ? ["workflow_output_packet"] : ["execution_action"];
    return commitCandidate(input.store, workflow, step, run, {
      finalStatus: "blocked",
      outcome: blockedOutcome(step, code, "Delegated Run ended without the required durable outcome evidence.", missing),
      executionVerification: verification,
      blocker: code,
      resultSummary: undefined,
    }, input.cause, now, approval);
  }
  return commitCandidate(input.store, workflow, step, run, {
    finalStatus: "succeeded",
    outcome: {
      kind: "completed",
      workflowId: step.workflowId,
      workflowStepId: step.id,
      participantId: step.toParticipantId,
      evidenceRefs,
    },
    executionVerification: verification,
    outputArtifactId: evidenceRefs.find((ref) => ref.kind === "workflow_output_packet")?.id,
    blocker: undefined,
    resultSummary,
  }, input.cause, now, approval);
}

function approvalResumeBlockerCode(reason: string): DelegatedBlockCodeV1 | undefined {
  const code = reason.split(":", 1)[0];
  return code === "approval_resume_unsupported"
    || code === "approval_resume_effect_unknown"
    || code === "approval_resume_lineage_invalid"
    || code === "approval_resume_mismatch"
    || code === "approval_resume_checkpoint_missing"
    || code === "approval_resume_owner_mismatch"
    || code === "approval_resume_tool_mismatch"
    || code === "approval_resume_requirement_mismatch"
    || code === "approval_resume_lineage_missing"
    || code === "approval_resume_state_mismatch"
    || code === "approval_resume_checkpoint_stale"
    || code === "approval_resume_state_stale"
    ? code
    : undefined;
}

function commitCandidate(
  store: RunStore,
  workflow: ChannelWorkflow,
  step: ChannelWorkflowStep,
  run: (RunSession & { readonly status: "succeeded" | "failed" | "cancelled" }) | undefined,
  candidate: {
    readonly finalStatus: "succeeded" | "blocked" | "failed" | "cancelled" | "skipped";
    readonly outcome: DelegatedOutcomeCandidate;
    readonly executionVerification?: WorkflowStepExecutionVerificationV1;
    readonly outputArtifactId?: string;
    readonly resultContextReview?: NonNullable<ChannelWorkflowStep["metadata"]>["resultContextReview"];
    readonly blocker?: string;
    readonly resultSummary?: string;
  },
  cause: WorkflowReconcileCause,
  now: string,
  approval = step.metadata?.postStepApprovalId ? store.getApprovalRequest(step.metadata.postStepApprovalId) : undefined,
): DelegatedStepFinalizationResult {
  const outcome = withDelegatedLineage(store, workflow, step, run, candidate.outcome);
  const runEventCount = run ? store.countEvents(run.id) : 0;
  const runLatestSeq = run ? readLatestRunEventSeq(store, run.id) : 0;
  const artifactIds = run ? store.listArtifacts(run.id).map((artifact) => artifact.id).sort() : [];
  const basisFingerprint = delegatedStepFinalizationBasisFingerprintV1({
    workflowId: workflow.id,
    workflowStepId: step.id,
    stepUpdatedAt: step.updatedAt,
    runId: run?.id,
    runStatus: run?.status,
    runUpdatedAt: run?.updatedAt,
    runEventCount,
    runLatestSeq,
    requirementFingerprint: step.metadata?.delegatedRequirement?.fingerprint,
    approval: approval ? { id: approval.id, status: approval.status, resolvedAt: approval.resolvedAt } : undefined,
    artifactIds,
    outcome,
    verification: candidate.executionVerification,
  });
  const transition = store.commitChannelWorkflowStepFinalization({
    workflowStepId: step.id,
    expectedStatus: step.status === "waiting_for_approval" ? "waiting_for_approval" : "running",
    expectedUpdatedAt: step.updatedAt,
    expectedRun: run ? {
      kind: "linked_run",
      id: run.id,
      status: run.status,
      updatedAt: run.updatedAt,
      eventWatermark: { count: runEventCount, latestSeq: runLatestSeq },
      artifactIds,
    } : { kind: "no_linked_run" },
    expectedApproval: approval ? { id: approval.id, status: approval.status, resolvedAt: approval.resolvedAt } : undefined,
    finalStatus: candidate.finalStatus,
    delegatedOutcome: outcome,
    delegatedOutcomeBasisFingerprint: basisFingerprint,
    executionVerification: candidate.executionVerification,
    outputArtifactId: candidate.outputArtifactId,
    resultContextReview: candidate.resultContextReview ?? step.metadata?.resultContextReview,
    resultSummary: candidate.resultSummary,
    blocker: candidate.blocker,
    actor: cause === "approval_decision" ? "local-user" : cause === "run_terminal" ? "runner" : "system",
    reason: `${cause}:${run?.id ?? "no-linked-run"}`,
    idempotencyKey: `delegated-step-finalization:${basisFingerprint}`,
    now,
  });
  const latest = store.getChannelWorkflowStep(step.id) ?? step;
  if (!transition.ok) return { status: "stale", step: latest };
  return { status: transition.duplicate ? "duplicate" : "finalized", step: latest };
}

function withDelegatedLineage(
  store: RunStore,
  workflow: ChannelWorkflow,
  step: ChannelWorkflowStep,
  run: RunSession | undefined,
  outcome: DelegatedOutcomeCandidate,
): DelegatedOutcomeV1 {
  const runId = run?.id ?? null;
  const attemptId = run ? readRunAttemptId(store, run) : null;
  const sourceRefs = uniqueSourceRefs([
    { type: "workflow", id: workflow.id },
    { type: "workflow_step", id: step.id },
    ...(runId ? [{ type: "run", id: runId } satisfies WorkflowPacketSourceRef] : []),
    ...(attemptId ? [{ type: "attempt", id: attemptId } satisfies WorkflowPacketSourceRef] : []),
    ...outcome.evidenceRefs.map(evidenceRefToSourceRef),
  ]);
  const lineage: DelegatedLineageV1 = {
    workflowId: workflow.id,
    workflowStepId: step.id,
    participantId: step.toParticipantId,
    runId,
    attemptId,
    sourceRefs,
  };
  return { ...outcome, lineage } as DelegatedOutcomeV1;
}

function evidenceRefToSourceRef(ref: DelegatedEvidenceRefV1): WorkflowPacketSourceRef {
  return {
    type: ref.kind === "execution_action" || ref.kind === "conversation_item" ? ref.kind : "artifact",
    id: ref.id,
  };
}

function uniqueSourceRefs(refs: readonly WorkflowPacketSourceRef[]): readonly WorkflowPacketSourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readRunAttemptId(store: RunStore, run: RunSession): string | null {
  if (run.workUnitId) {
    const workUnit = store.getWorkUnit(run.workUnitId);
    const activeAttemptId = workUnit?.activeAttemptId;
    if (activeAttemptId) {
      const activeAttempt = store.getWorkUnitAttempt(activeAttemptId);
      if (activeAttempt?.workUnitId === workUnit?.id) {
        return activeAttempt.id;
      }
    }
  }
  const created = listAllRunEvents(store, run.id)
    .filter((event) => event.type === "run_created" && isRecord(event.data))
    .sort((left, right) => right.seq - left.seq)[0];
  const createdAttemptId = created && isRecord(created.data) && typeof created.data.attemptId === "string"
    ? created.data.attemptId.trim()
    : "";
  if (!createdAttemptId) return null;
  if (!run.workUnitId) return createdAttemptId;
  const createdAttempt = store.getWorkUnitAttempt(createdAttemptId);
  return createdAttempt?.workUnitId === run.workUnitId ? createdAttempt.id : null;
}

function readLatestRunEventSeq(store: RunStore, runId: string): number {
  return listAllRunEvents(store, runId).at(-1)?.seq ?? 0;
}

function listAllRunEvents(store: RunStore, runId: string): readonly RunEventEnvelope[] {
  const events: RunEventEnvelope[] = [];
  let afterSeq = 0;
  while (true) {
    const page = store.listEvents(runId, { afterSeq, limit: 1000 });
    events.push(...page);
    const latestSeq = page.at(-1)?.seq;
    if (page.length < 1000 || latestSeq === undefined || latestSeq <= afterSeq) {
      return events;
    }
    afterSeq = latestSeq;
  }
}

function latestExecutionLoopDetection(
  store: RunStore,
  runId: string,
): RunEventEnvelope["data"] & { readonly message: string } | undefined {
  const event = listAllRunEvents(store, runId).filter((candidate) => candidate.type === "loop_detected").at(-1);
  return event && isRecord(event.data) && event.data.code === "execution_loop_detected"
    && typeof event.data.message === "string"
    ? event.data as RunEventEnvelope["data"] & { readonly message: string }
    : undefined;
}

function evidenceRefsForSuccessfulStep(
  store: RunStore,
  workflow: ChannelWorkflow,
  step: ChannelWorkflowStep,
  run: RunSession,
  requirement: NonNullable<ChannelWorkflowStep["metadata"]>["delegatedRequirement"],
  verification: WorkflowStepExecutionVerificationV1 | undefined,
): readonly DelegatedEvidenceRefV1[] {
  if (!requirement) return [];
  if (requirement.expectedOutcome === "synthesis") {
    const artifactId = step.metadata?.outputArtifactId;
    if (!artifactId) return [];
    const packet = readWorkflowStepOutputPacketArtifact({ store, artifactId });
    if (!packet || packet.workflowId !== workflow.id || packet.workflowStepId !== step.id
      || packet.runId !== run.id || packet.teammateId !== step.toParticipantId || packet.status !== "succeeded") return [];
    const dependencyRefs = new Set((packet.sourceRefs ?? [])
      .filter((ref) => ref.type === "workflow_step")
      .map((ref) => ref.id));
    if (requirement.requiredDependencyStepIds.some((id) => !dependencyRefs.has(id))) return [];
    return [{ kind: "workflow_output_packet", id: artifactId }];
  }
  const evidenceIds = verification
    ? verification.operationResults.flatMap((result) => result.evidenceActionIds)
    : listAllExecutionActionsForRun(store, run.id)
      .filter((action) => action.status === "succeeded")
      .map((action) => action.id);
  return [...new Set(evidenceIds)].map((id) => ({ kind: "execution_action", id }));
}

function blockedOutcome(
  step: ChannelWorkflowStep,
  code: DelegatedBlockCodeV1,
  reason: string,
  missingRequirements: readonly string[],
): Omit<Extract<DelegatedOutcomeV1, { readonly kind: "blocked" }>, "lineage"> {
  return {
    kind: "blocked",
    workflowId: step.workflowId,
    workflowStepId: step.id,
    participantId: step.toParticipantId,
    code,
    reason,
    missingRequirements,
    evidenceRefs: [],
  };
}

function failedOutcome(
  step: ChannelWorkflowStep,
  kind: "failed" | "cancelled",
  code: DelegatedTerminalCodeV1,
  reason: string,
): Omit<Extract<DelegatedOutcomeV1, { readonly kind: "failed" | "cancelled" }>, "lineage"> {
  return {
    kind,
    workflowId: step.workflowId,
    workflowStepId: step.id,
    participantId: step.toParticipantId,
    code,
    reason,
    evidenceRefs: [],
  };
}

function resolveWorkflowStepPolicy(step: ChannelWorkflowStep): WorkflowStepPolicy {
  return step.metadata?.policy ?? DEFAULT_WORKFLOW_STEP_POLICY;
}

function failurePolicyStatus(policy: WorkflowStepFailurePolicy): "blocked" | "failed" | "cancelled" | "skipped" {
  return policy === "fail_workflow"
    ? "failed"
    : policy === "cancel_workflow"
      ? "cancelled"
      : policy === "skip_if_optional"
        ? "skipped"
        : "blocked";
}

function workflowStepRunResultSummary(store: RunStore, run: RunSession): string {
  const normalizedText = preserveMarkdownLayout(readRunNarrationSnapshot(store, run.id).content);
  if (normalizedText) return normalizedText;
  const labels = store.listArtifacts(run.id)
    .filter((artifact) => artifact.type === "file" || artifact.type === "diff")
    .map((artifact) => artifact.title?.trim() || artifact.path)
    .filter(Boolean)
    .slice(0, 3);
  return labels.length > 0 ? `Run succeeded. Artifacts: ${labels.join(", ")}.` : "Run succeeded.";
}

function executionVerificationFailureReason(verification: WorkflowStepExecutionVerificationV1): string {
  return verification.operationResults
    .filter((result) => result.status !== "succeeded")
    .map((result) => `${result.operationId}:${result.reasonCode ?? result.status}`)
    .join(", ") || "Required operation evidence was not verified.";
}

function missingOperationIds(verification: WorkflowStepExecutionVerificationV1): readonly string[] {
  return verification.operationResults
    .filter((result) => result.status !== "succeeded")
    .map((result) => result.operationId);
}

function isTerminalRun(run: RunSession): run is RunSession & { status: "succeeded" | "failed" | "cancelled" } {
  return run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
}

function isTerminalStep(step: ChannelWorkflowStep): boolean {
  return step.status === "succeeded" || step.status === "blocked" || step.status === "failed"
    || step.status === "cancelled" || step.status === "skipped";
}
