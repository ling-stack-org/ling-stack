import { inspectWorkflowPreApproval, type ApprovalPostCommitEffectKind, type ApprovalRequest, type RunStore } from "@ling-stack/core";
import { terminalReportsEnabledForStore } from "../channels/terminal-report-coordinator.js";
import { approvalDecisionEventType, resolveApprovalDecisionRunId } from "./approval-decision-projection.js";

export type ApprovalPostCommitEvidenceStatus = "applied" | "pending" | "blocked" | "effect_unknown";

export interface ApprovalPostCommitEvidence {
  readonly status: ApprovalPostCommitEvidenceStatus;
  readonly code: string;
}

/** Re-read durable facts after a callback; callback success is never completion evidence. */
export function verifyApprovalPostCommitEvidence(
  store: RunStore,
  approval: ApprovalRequest,
  effectKind: ApprovalPostCommitEffectKind,
): ApprovalPostCommitEvidence {
  if (effectKind === "decision_event") {
    if (!resolveApprovalDecisionRunId(store, approval)) {
      return blocked("approval_decision_event_lineage_invalid");
    }
    return hasApprovalDecisionEvent(store, approval)
      ? applied("approval_decision_event_committed")
      : pending("approval_decision_event_missing");
  }
  if (effectKind === "control_plane_event") {
    return pending("approval_control_plane_event_requires_projection");
  }
  return verifyApprovalOwnerEvidence(store, approval);
}

/** A crash after append but before settlement must not append the decision again. */
export function hasApprovalDecisionEvent(store: RunStore, approval: ApprovalRequest): boolean {
  const runId = resolveApprovalDecisionRunId(store, approval);
  if (!runId) return false;
  const decisionType = approvalDecisionEventType(approval);
  let afterSeq = 0;
  for (;;) {
    const page = store.listEvents(runId, { afterSeq, limit: 1000 });
    if (page.some((event) => event.type === decisionType
      && typeof event.data === "object" && event.data !== null
      && "approvalId" in event.data && event.data.approvalId === approval.id)) return true;
    const lastSeq = page.at(-1)?.seq;
    if (page.length < 1000 || lastSeq === undefined || lastSeq <= afterSeq) return false;
    afterSeq = lastSeq;
  }
}

function verifyApprovalOwnerEvidence(store: RunStore, approval: ApprovalRequest): ApprovalPostCommitEvidence {
  if (approval.externalWorkActionId) return verifyExternalWorkEvidence(store, approval);
  if (approval.mediaJobId) return verifyMediaEvidence(store, approval);

  if (approval.runId) {
    const runEvidence = verifyRunEvidence(store, approval);
    if (runEvidence.status !== "applied") return runEvidence;
  }

  // A workflowStepId on an ordinary Run tool approval is lineage only. Only
  // a real workflow_step payload owns Workflow/Turn/TerminalReport projection.
  if (approval.payload.type === "workflow_step") {
    return verifyWorkflowEvidence(store, approval);
  }

  return applied("approval_owner_applied");
}

function verifyRunEvidence(store: RunStore, approval: ApprovalRequest): ApprovalPostCommitEvidence {
  const run = approval.runId ? store.getRun(approval.runId) : undefined;
  const checkpoint = store.getApprovalCheckpointForApproval(approval.id);
  if (!run || !checkpoint || checkpoint.runId !== approval.runId) {
    return blocked("approval_run_evidence_missing");
  }
  if (run.status === "waiting_for_approval") return pending("approval_run_still_waiting");
  if (checkpoint.status === "pending") return pending("approval_checkpoint_still_pending");

  if (approval.status === "approved") {
    return checkpoint.status === "approved" || checkpoint.status === "resume_pending"
      || checkpoint.status === "resumed" || checkpoint.status === "resume_failed"
      ? applied("approval_run_resumed") : pending("approval_checkpoint_not_applied");
  }
  if (approval.status === "denied") {
    return checkpoint.status === "denied" || checkpoint.status === "resume_failed"
      ? applied("approval_run_denied") : pending("approval_checkpoint_not_denied");
  }
  if (approval.status === "expired") {
    return checkpoint.status === "expired" || checkpoint.status === "resume_failed"
      ? applied("approval_run_expired") : pending("approval_checkpoint_not_expired");
  }
  if (approval.status === "cancelled") {
    return checkpoint.status === "cancelled" || checkpoint.status === "resume_failed"
      ? applied("approval_run_cancelled") : pending("approval_checkpoint_not_cancelled");
  }
  return pending("approval_decision_pending");
}

function verifyWorkflowEvidence(store: RunStore, approval: ApprovalRequest): ApprovalPostCommitEvidence {
  const payload = approval.payload;
  if (payload.type !== "workflow_step") return applied("approval_not_workflow_owned");
  const step = store.getChannelWorkflowStep(payload.workflowStepId);
  const workflow = store.getChannelWorkflow(payload.workflowId);
  const checkpoint = store.getApprovalCheckpointForApproval(approval.id);
  if (!step || !workflow || step.workflowId !== workflow.id
    || approval.workflowStepId !== step.id || approval.channelId !== step.channelId
    || workflow.channelId !== step.channelId
    || !checkpoint || checkpoint.runId !== undefined
    || checkpoint.workflowStepId !== step.id || checkpoint.channelId !== step.channelId
    || checkpoint.sideEffect.type !== "workflow_step"
    || checkpoint.sideEffect.workflowId !== workflow.id
    || checkpoint.sideEffect.workflowStepId !== step.id
    || checkpoint.sideEffect.gateStage !== payload.gateStage
    || checkpoint.sideEffect.runId !== payload.runId) {
    return blocked("approval_workflow_owner_missing");
  }
  if (checkpoint.status === "pending") return pending("approval_workflow_checkpoint_pending");
  if (checkpoint.status !== approval.status) return pending("approval_workflow_checkpoint_incomplete");
  if (payload.gateStage === "post" && !resolveApprovalDecisionRunId(store, approval)) {
    return blocked("approval_workflow_run_lineage_invalid");
  }

  const gateApprovalId = payload.gateStage === "post"
    ? step.metadata?.postStepApprovalId : step.metadata?.preStepApprovalId;
  if (gateApprovalId && gateApprovalId !== approval.id) {
    return blocked("approval_workflow_gate_lineage_mismatch");
  }
  if (payload.gateStage === "pre"
    && step.metadata?.activeGateStage === "pre"
    && step.status === "waiting_for_approval"
    && !step.taskId && !step.runId && !step.metadata.startOwner
    && inspectWorkflowPreApproval(store, step, approval.resolvedAt ?? approval.createdAt).status === "stale") {
    // A changed/corrupt/missing frozen basis is a permanent rejection of this
    // resolved decision. The owner effect is complete precisely because no
    // Task, Run or execution owner was created; explicit admission owns later
    // retirement of the stale wait.
    return applied("approval_workflow_stale_decision_rejected");
  }
  // The resolved gate id remains in metadata as canonical lineage. Only the
  // active stage or a waiting Step proves that the gate is still unresolved.
  if (step.metadata?.activeGateStage === payload.gateStage || step.status === "waiting_for_approval") {
    return pending("approval_workflow_gate_still_waiting");
  }

  if (payload.gateStage === "pre" && step.status === "skipped"
    && !step.taskId && !step.runId && !step.metadata?.startOwner) {
    const inspection = inspectWorkflowPreApproval(store, step, approval.resolvedAt ?? approval.createdAt);
    if (inspection.status === "blocked" && inspection.approval.id === approval.id
      && inspection.approval.status !== "pending" && inspection.approval.status !== "approved") {
      // skip_if_optional intentionally leaves the aggregate Workflow running
      // for the canonical completion gate. The owner effect is already applied
      // once the exact rejected pre-admission is durably projected to skipped.
      return applied("approval_workflow_pre_skip_applied");
    }
  }

  const steps = store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true });
  const allStepsTerminal = steps.length > 0 && steps.every((candidate) => isTerminalWorkflowStep(candidate.status));
  const anyStepWaitingForApproval = steps.some((candidate) => candidate.status === "waiting_for_approval");
  const workflowTerminal = isTerminalWorkflow(workflow.status);
  if (allStepsTerminal && !workflowTerminal) return pending("approval_workflow_aggregate_incomplete");
  if (!allStepsTerminal && workflowTerminal) return pending("approval_workflow_terminal_with_open_steps");

  const sourceTurnId = workflow.metadata?.sourceTurnId;
  const sourceTurn = sourceTurnId ? store.getLingTurn(sourceTurnId) : undefined;
  if (sourceTurnId && !sourceTurn) return blocked("approval_workflow_source_turn_missing");
  if (!workflowTerminal && !anyStepWaitingForApproval && sourceTurn?.status === "waiting_for_approval") {
    return pending("approval_workflow_source_turn_still_waiting");
  }
  if (!workflowTerminal) return applied("approval_workflow_continued");
  if (sourceTurn && !isTerminalTurn(sourceTurn.status)) {
    return pending("approval_workflow_source_turn_incomplete");
  }

  if (terminalReportsEnabledForStore(store)) {
    const report = store.listTerminalReports({ sourceKind: "workflow", sourceId: workflow.id, effectiveOnly: true, limit: 100 })
      .filter((candidate) => candidate.status === "committed" || candidate.status === "fallback")
      .sort((left, right) => right.generation - left.generation)[0];
    if (!report?.resultItemId || !store.getConversationItem(report.resultItemId)) {
      return pending("approval_workflow_terminal_report_unpublished");
    }
  }

  return applied("approval_workflow_projection_applied");
}

function verifyExternalWorkEvidence(store: RunStore, approval: ApprovalRequest): ApprovalPostCommitEvidence {
  const action = approval.externalWorkActionId ? store.getExternalWorkAction(approval.externalWorkActionId) : undefined;
  if (!action || action.approvalId !== approval.id) return blocked("approval_external_action_missing");
  const appliedStatuses = approval.status === "approved"
    ? ["approved", "executing", "succeeded", "failed", "cancelled", "stale_target"]
    : approval.status === "denied" ? ["denied"]
      : approval.status === "expired" ? ["expired"]
        : approval.status === "cancelled" ? ["cancelled"] : [];
  return appliedStatuses.includes(action.status)
    ? applied("approval_external_action_applied")
    : pending("approval_external_action_incomplete");
}

function verifyMediaEvidence(store: RunStore, approval: ApprovalRequest): ApprovalPostCommitEvidence {
  const job = approval.mediaJobId ? store.getMediaJob(approval.mediaJobId) : undefined;
  if (!job) return blocked("approval_media_job_missing");
  if (job.status === "waiting_for_approval") return pending("approval_media_job_still_waiting");
  if (approval.status !== "approved") {
    return job.status === "failed" || job.status === "cancelled" || job.status === "succeeded"
      ? applied("approval_media_job_terminal") : pending("approval_media_job_incomplete");
  }
  if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
    return applied("approval_media_job_terminal");
  }
  const handle = store.getMediaJobExecutionHandle(job.id);
  if (!handle || handle.externalOperationId.startsWith("ling-pending:")
    || handle.recovery.phase === "nonrecoverable_execution") {
    return unknown("approval_media_execution_handle_missing");
  }
  return applied("approval_media_execution_handle_committed");
}

function isTerminalWorkflow(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "blocked" || status === "cancelled";
}

function isTerminalWorkflowStep(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "blocked"
    || status === "skipped" || status === "cancelled";
}

function isTerminalTurn(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "superseded";
}

function applied(code: string): ApprovalPostCommitEvidence { return { status: "applied", code }; }
function pending(code: string): ApprovalPostCommitEvidence { return { status: "pending", code }; }
function blocked(code: string): ApprovalPostCommitEvidence { return { status: "blocked", code }; }
function unknown(code: string): ApprovalPostCommitEvidence { return { status: "effect_unknown", code }; }
