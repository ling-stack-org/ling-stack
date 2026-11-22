import { createHash } from "node:crypto";
import type { LingAppServerStageBallotTally, LingAppServerWorkItemStageDecision, LingAppServerWorkItemWorkflowBinding,
  LingAppServerWorkItemWorkflowStages } from "@ling-stack/contracts";
import { readWorkItemCollaborationRecord, workItemWorkflowDecisionId } from "@ling-stack/core";
import type { ChannelWorkflowStep, RunStore, WorkItem } from "@ling-stack/core";
import { appendControlPlaneEvent, type ControlPlaneEventHub } from "../control-plane/events.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import { continuationSourceReady } from "../../runtime/continuation-source-barrier.js";
import { isRecord } from "../../shared/validation.js";
import { readAppServerStageBallot } from "./stage-ballot.js";

export function workItemWorkflowSettled(store: RunStore, activeRuns: ActiveRunRegistry, workflowId: string): boolean {
  return store.listChannelWorkflowSteps({ workflowId, complete: true }).every(step => {
    if (["claimed", "running", "waiting_for_approval", "waiting_for_input"].includes(step.status)
      || store.getBlockingResourceLease("workflow_step", step.id)) return false;
    return store.listRuns({ workflowStepId: step.id, complete: true }).every(run => {
      const unit = run.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
      return Boolean(unit?.linkedRunId === run.id
        && continuationSourceReady(store, unit, activeRuns, "work-item-replan", () => undefined));
    });
  });
}

/** Work Board and App Server project the actual Workflow owner and its retained evidence. */
export function readWorkItemWorkflowStages(store: RunStore, item: WorkItem, includeEvidence: boolean, offset = 0): LingAppServerWorkItemWorkflowStages | undefined {
  if (!item.workflowId || !item.planRevision) return undefined;
  const link = store.getAppServerState("work_item_workflow", item.workflowId)?.payload as {
    readonly binding: LingAppServerWorkItemWorkflowBinding;
  } | undefined;
  if (!link) return undefined;
  const workflow = store.getChannelWorkflow(item.workflowId);
  if (!workflow) return undefined;
  const limit = 20;
  const steps = store.listChannelWorkflowSteps({ workflowId: workflow.id, offset, limit: limit + 1 });
  const admissionBlocker = store.getWorkItemWorkflowAdmissionBlocker(workflow.id);
  return {
    workflowId: workflow.id,
    planRevision: item.planRevision,
    status: workflow.status,
    admissionBlocker,
    ...(steps.length > limit ? { nextOffset: offset + limit } : {}),
    steps: steps.slice(0, limit).map(step => ({
      stepId: step.id, stageId: step.metadata?.planStageId,
      title: step.title.slice(0, 250), status: step.status, participantLabel: step.toParticipantLabel.slice(0, 160),
      dependencyIds: step.metadata?.dependsOnStepIds?.slice(0, 20) ?? [], updatedAt: step.updatedAt,
      ...(!admissionBlocker && (step.metadata?.requiredPlanDecision || step.metadata?.planBallotKey) && step.status === "queued"
        ? { admissionBlocker: store.getWorkItemWorkflowAdmissionBlocker(workflow.id, step) } : {}),
      ...(includeEvidence ? {
        runId: step.runId, outputArtifactId: step.metadata?.outputArtifactId, brief: (step.resultSummary ?? step.blocker)?.slice(0, 500),
        briefBasis: readStageBriefBasis(store, step),
        decision: readStageDecision(store, item.id, item.planRevision!, link.binding.planId, step),
      } : {}),
    })),
  };
}

function readStageDecision(
  store: RunStore, workItemId: string, planRevision: string, planId: string, step: ChannelWorkflowStep,
): LingAppServerWorkItemStageDecision | undefined {
  const decision = step.metadata?.requiredPlanDecision;
  if (!decision) return undefined;
  const { question } = decision;
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
  const link = store.getAppServerState("work_item_workflow", step.workflowId)?.payload as {
    binding: import("@ling-stack/contracts").LingAppServerWorkItemWorkflowBinding;
  } | undefined;
  if (!link) return;
  const { workItemId, threadId, planId, planRevision } = link.binding;
  const revision = createHash("sha256").update(JSON.stringify([step.id, step.updatedAt, step.status, step.runId])).digest("hex");
  const idempotencyKey = `work-item-stage:${revision}`;
  if (store.getControlPlaneEventByIdempotency(step.workspaceId, idempotencyKey)) return;
  appendControlPlaneEvent(store, events, {
    workspaceId: step.workspaceId, cwd: store.paths.cwd, domain: "work_items",
    entityType: "work_item", entityId: workItemId, action: "work_item.stage.updated",
    data: { workItemId, threadId, workflowId: step.workflowId, planRevision: `${planId}:${planRevision}`,
      stepId, status: step.status, revision }, idempotencyKey,
  });
}
