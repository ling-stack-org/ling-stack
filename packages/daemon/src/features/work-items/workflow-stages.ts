import { createHash } from "node:crypto";
import type { LingAppServerWorkItemWorkflowStages } from "@ling-stack/contracts";
import type { ChannelWorkflowStep, RunStore, WorkItem } from "@ling-stack/core";
import { appendControlPlaneEvent, type ControlPlaneEventHub } from "../control-plane/events.js";

/** Work Board and App Server project the actual Workflow owner and its retained evidence. */
export function readWorkItemWorkflowStages(store: RunStore, item: WorkItem, includeEvidence: boolean, offset = 0): LingAppServerWorkItemWorkflowStages | undefined {
  if (!item.workflowId || !item.planRevision || !store.getAppServerState("work_item_workflow", item.workflowId)) return undefined;
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
      ...(!admissionBlocker && step.metadata?.requiredPlanDecision && step.status === "queued"
        ? { admissionBlocker: store.getWorkItemWorkflowAdmissionBlocker(workflow.id, step) } : {}),
      ...(includeEvidence ? {
        runId: step.runId, outputArtifactId: step.metadata?.outputArtifactId, brief: (step.resultSummary ?? step.blocker)?.slice(0, 500),
        briefBasis: readStageBriefBasis(store, step),
      } : {}),
    })),
  };
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
  const { workItemId, threadId } = link.binding;
  const revision = createHash("sha256").update(JSON.stringify([step.id, step.updatedAt, step.status, step.runId])).digest("hex");
  const idempotencyKey = `work-item-stage:${revision}`;
  if (store.getControlPlaneEventByIdempotency(step.workspaceId, idempotencyKey)) return;
  appendControlPlaneEvent(store, events, {
    workspaceId: step.workspaceId, cwd: store.paths.cwd, domain: "work_items",
    entityType: "work_item", entityId: workItemId, action: "work_item.stage.updated",
    data: { workItemId, threadId, stepId, status: step.status, revision }, idempotencyKey,
  });
}
