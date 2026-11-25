import { createHash } from "node:crypto";
import type { LingAppServerStageBallotTally, LingAppServerStageHandoffProgress, LingAppServerWorkItemStageDecision, LingAppServerWorkItemWorkflowBinding,
  LingAppServerWorkItemWorkflowStages } from "@ling-stack/contracts";
import { readRetainedWorkflowStageExecution, readWorkItemCollaborationRecord, readWorkflowStageHandoff, stageHandoffAdmitsTarget,
  readWorkItemDeliberationWorkflowBinding, workItemWorkflowDecisionId } from "@ling-stack/core";
import type { ChannelWorkflowStep, RunStore, WorkItem } from "@ling-stack/core";
import { workflowStepParticipantAvailable } from "../channels/workflow-participant-run-profile.js";
import { appendControlPlaneEvent, type ControlPlaneEventHub } from "../control-plane/events.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import { continuationSourceReady } from "../../runtime/continuation-source-barrier.js";
import { isRecord } from "../../shared/validation.js";
import { readAppServerStageBallot } from "./stage-ballot.js";
import { readStageMessageReceiver } from "./stage-message-target.js";

export function readWorkItemWorkflowBinding(store: RunStore, workflowId: string): LingAppServerWorkItemWorkflowBinding | undefined {
  const link = store.getAppServerState("work_item_workflow", workflowId)?.payload as { binding: LingAppServerWorkItemWorkflowBinding } | undefined;
  return link?.binding;
}

export function readWorkItemRetainedStageInputs(store: RunStore, step: ChannelWorkflowStep) {
  if (!step.metadata?.planStageId) return [];
  const binding = readWorkItemWorkflowBinding(store, step.workflowId);
  const retained = readWorkItemRetainedStageResults(store, binding, step.id);
  return retained.map(result => {
    const packet = store.getArtifact(result.sourceArtifactId)?.sealedPayload;
    return {
      stageId: result.sourceStageId, resultArtifactId: result.sourceArtifactId,
      summary: isRecord(packet) && typeof packet.resultSummary === "string" ? packet.resultSummary.slice(0, 500) : undefined,
    };
  });
}

export function readWorkItemRetainedStageResults(store: RunStore, binding: LingAppServerWorkItemWorkflowBinding | undefined, targetStepId?: string) {
  const matches = (source: { readonly targetStepId: string }) => !targetStepId || source.targetStepId === targetStepId;
  const availableExecutions = (binding?.retainedStageExecutions ?? []).filter(matches).flatMap(execution => {
    const progress = readRetainedWorkflowStageExecution(store, execution);
    return progress.status === "available" ? [progress.result] : [];
  });
  return [...(binding?.retainedStageResults ?? []).filter(matches), ...availableExecutions];
}

export function workItemWorkflowSettled(store: RunStore, activeRuns: ActiveRunRegistry, workflowId: string,
  retainedRunIds: ReadonlySet<string>): boolean {
  return store.listChannelWorkflowSteps({ workflowId, complete: true }).every(step => {
    const retained = step.runId && retainedRunIds.has(step.runId);
    if (!retained && (["claimed", "running", "waiting_for_approval", "waiting_for_input"].includes(step.status)
      || store.getBlockingResourceLease("workflow_step", step.id))) return false;
    return store.listRuns({ workflowStepId: step.id, complete: true }).every(run => {
      if (retained && run.id === step.runId) return true;
      const unit = run.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
      return Boolean(unit?.linkedRunId === run.id
        && continuationSourceReady(store, unit, activeRuns, "work-item-replan", () => undefined));
    });
  });
}

/** Work Board and App Server project the actual Workflow owner and its retained evidence. */
export function readWorkItemWorkflowStages(store: RunStore, item: WorkItem, includeEvidence: boolean, offset = 0,
  liveReceivers?: ActiveRunRegistry): LingAppServerWorkItemWorkflowStages | undefined {
  if (!item.workflowId || !item.planRevision) return undefined;
  const binding = readWorkItemWorkflowBinding(store, item.workflowId);
  if (!binding) return undefined;
  const workflow = store.getChannelWorkflow(item.workflowId);
  if (!workflow) return undefined;
  const limit = 20;
  const steps = store.listChannelWorkflowSteps({ workflowId: workflow.id, offset, limit: limit + 1 });
  const admissionBlocker = store.getWorkItemWorkflowAdmissionBlocker(workflow.id);
  const usage = includeEvidence ? store.getWorkItemWorkflowUsage(item, new Date().toISOString()) : undefined;
  return {
    workflowId: workflow.id,
    planRevision: item.planRevision,
    workItemRevision: item.revision,
    status: workflow.status,
    admissionBlocker,
    ...(usage ? { usage: usage.total, goalBudget: usage.goalBudget } : {}),
    ...(steps.length > limit ? { nextOffset: offset + limit } : {}),
    steps: steps.slice(0, limit).map(step => {
      const canStart = !admissionBlocker && (step.status === "queued" || step.status === "blocked");
      const retryBudget = includeEvidence || canStart ? store.getWorkItemStageRetryBudget(step) : undefined;
      return {
        stepId: step.id, stageId: step.metadata?.planStageId,
        title: step.title.slice(0, 250), status: step.status, participantLabel: step.toParticipantLabel.slice(0, 160),
        dependencyIds: step.metadata?.dependsOnStepIds?.slice(0, 20) ?? [], updatedAt: step.updatedAt,
        ...(canStart ? { admissionBlocker: readStageAdmissionBlocker(store, step, retryBudget?.exhausted) } : {}),
        ...(includeEvidence || liveReceivers ? { messageReceiver: readStageMessageReceiver(store, step, liveReceivers) } : {}),
        ...(includeEvidence ? {
          runId: step.runId, outputArtifactId: step.metadata?.outputArtifactId, brief: (step.resultSummary ?? step.blocker)?.slice(0, 500),
          usage: step.metadata?.planStageId ? usage?.byStage.get(step.metadata.planStageId) : usage?.byStep.get(step.id),
          progress: store.getWorkItemStageProgress(item, step),
          ...(step.metadata?.recoveryVerification ? { recoveryVerification: step.metadata.recoveryVerification } : {}),
          ...(step.metadata?.recoveryReview ? { recoveryReview: step.metadata.recoveryReview } : {}),
          briefBasis: readStageBriefBasis(store, step),
          ...(retryBudget ? { retryBudget } : {}),
          decision: readStageDecision(store, item.id, item.planRevision!, binding.planId, step),
          handoffs: readStageHandoffs(store, item.id, item.planRevision!, step),
          ...(binding.retainedStageResults?.length || binding.retainedStageExecutions?.length ? {
            retainedStageResults: readWorkItemRetainedStageResults(store, binding, step.id),
          } : {}),
          ...(binding.retainedStageExecutions?.length ? {
            retainedStageExecutions: binding.retainedStageExecutions.filter(execution => execution.targetStepId === step.id)
              .map(execution => ({ ...execution, status: readRetainedWorkflowStageExecution(store, execution).status })),
          } : {}),
        } : {}),
      };
    }),
  };
}

function readStageAdmissionBlocker(store: RunStore, step: ChannelWorkflowStep, retryBudgetExhausted?: boolean): string | undefined {
  const blocker = store.getWorkItemWorkflowAdmissionBlocker(step.workflowId, step);
  if ((!blocker || blocker === "work_item_handoff_pending") && step.metadata?.requiredPlanHandoffStepIds?.length
    && !workflowStepParticipantAvailable(store, step)) return "work_item_handoff_recipient_unavailable";
  return blocker ?? (retryBudgetExhausted ? "work_item_stage_retry_budget_exhausted" : undefined);
}

function readStageHandoffs(
  store: RunStore, workItemId: string, planRevision: string, step: ChannelWorkflowStep,
): readonly LingAppServerStageHandoffProgress[] | undefined {
  return step.metadata?.requiredPlanHandoffStepIds?.flatMap((sourceStepId): LingAppServerStageHandoffProgress[] => {
    const source = store.getChannelWorkflowStep(sourceStepId);
    if (!source || source.workflowId !== step.workflowId) return [];
    const basis = { sourceStepId, sourceRevision: source.updatedAt, sourceStageId: source.metadata?.planStageId };
    const subject = { workItemId, planRevision, ...basis, targetStepId: step.id };
    const handoff = readWorkflowStageHandoff(store, subject);
    if (handoff?.record.action === "returned") return [{
      ...basis, status: "returned", receiptId: handoff.record.id, reason: handoff.decision.reason, candidateDigest: handoff.decision.candidateDigest,
    }];
    if (handoff && stageHandoffAdmitsTarget(store, subject, source, step)) return [{
      ...basis, status: "accepted", receiptId: handoff.record.id, candidateDigest: handoff.decision.candidateDigest,
    }];
    return [{ ...basis, status: source.status === "succeeded" ? "awaiting_acceptance" : "awaiting_source" }];
  });
}

function readStageDecision(
  store: RunStore, workItemId: string, planRevision: string, planId: string, step: ChannelWorkflowStep,
): LingAppServerWorkItemStageDecision | undefined {
  const decision = step.metadata?.requiredPlanDecision;
  if (!decision) return undefined;
  const { question } = decision;
  if (decision.receiptSource === "checkpoint") {
    const selected = store.getWorkItemWorkflowStepDecision(step);
    return selected ? { question, status: "decided", selectedOption: selected.option } : { question, status: "not_open" };
  }
  const subject = { workItemId, planRevision, workflowStepId: step.id };
  const round = readWorkItemCollaborationRecord(store, workItemId, workItemWorkflowDecisionId(subject, "round"));
  if (!round) return { question, status: "not_open" };
  const resolution = readWorkItemCollaborationRecord(store, workItemId, workItemWorkflowDecisionId(subject, "resolution"));
  if (resolution && isRecord(resolution.payload)) {
    const { reason, disposition, option, ballot } = resolution.payload;
    return {
      question,
      status: resolution.action === "cancelled" ? "cancelled" : "decided",
      ...(typeof reason === "string" ? { reason } : {}),
      ...(disposition === "selected" && typeof option === "string" ? { selectedOption: option } : {}),
      ...(isRecord(ballot) ? { ballot: ballot as unknown as LingAppServerStageBallotTally } : {}),
    };
  }
  if (!decision.ballot) return { question, status: "ready" };
  const frozen = isRecord(round.payload) && isRecord(round.payload.ballot) ? round.payload.ballot : undefined;
  const result = readAppServerStageBallot(store, step, planId, decision, frozen?.ballotKey);
  return { question, status: result.status, ...("summary" in result ? { ballot: result.summary } : {}) };
}

function readStageBriefBasis(store: RunStore, step: ChannelWorkflowStep) {
  if (!["succeeded", "failed", "cancelled", "skipped", "blocked"].includes(step.status)) return undefined;
  const [transition] = store.listStateTransitionEvents({ entityType: "workflow_step", entityId: step.id, limit: 1 });
  if (transition?.toStatus === step.status) return { transitionId: transition.id, committedAt: transition.createdAt };
  return undefined;
}

export function publishWorkItemWorkflowStep(store: RunStore, events: ControlPlaneEventHub | undefined, stepId: string): void {
  if (!events) return;
  const step = store.getChannelWorkflowStep(stepId);
  if (!step) return;
  const binding = readWorkItemWorkflowBinding(store, step.workflowId);
  const deliberation = readWorkItemDeliberationWorkflowBinding(store, step.workflowId);
  const target = binding ? { workItemId: binding.workItemId, threadId: binding.threadId,
    planRevision: `${binding.planId}:${binding.planRevision}` }
    : deliberation ? { workItemId: deliberation.workItemId, roundId: deliberation.roundId } : undefined;
  if (!target) return;
  const revision = createHash("sha256").update(JSON.stringify([step.id, step.updatedAt, step.status, step.runId])).digest("hex");
  const idempotencyKey = `work-item-stage:${revision}`;
  if (store.getControlPlaneEventByIdempotency(step.workspaceId, idempotencyKey)) return;
  appendControlPlaneEvent(store, events, {
    workspaceId: step.workspaceId, cwd: store.paths.cwd, domain: "work_items",
    entityType: "work_item", entityId: target.workItemId,
    action: deliberation ? "work_item.deliberation.workflow_progress" : "work_item.stage.updated",
    data: { ...target, workflowId: step.workflowId, stepId, status: step.status, revision }, idempotencyKey,
  });
}
