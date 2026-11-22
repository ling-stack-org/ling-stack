import type { LingAppServerStageHandoffParams } from "@ling-stack/contracts";
import {
  appendWorkItemCollaboration, readWorkflowStageHandoff, workflowStageHandoffId,
  type RunStore, type WorkflowStageHandoffDecision,
} from "@ling-stack/core";
import { HttpError } from "../errors.js";
import { readWorkflowStepOutputPacketArtifact } from "../features/channels/workflow-step-packets.js";
import { AppServerCollaborationError } from "./app-server-collaboration.js";

export function settleAppServerStageHandoff(
  store: RunStore, input: LingAppServerStageHandoffParams, action: "accepted" | "returned", now: string,
) {
  const { workItemId, planRevision, sourceStepId, targetStepId, expectedSourceRevision, expectedTargetRevision, idempotencyKey } = input;
  const item = store.getWorkItem(workItemId);
  if (!item) throw new AppServerCollaborationError("work_item_not_found", "The Work Item is unavailable.");
  const subject = { workItemId, planRevision, sourceStepId, sourceRevision: expectedSourceRevision, targetStepId };
  const existing = readWorkflowStageHandoff(store, subject);
  if (existing) {
    const { record, decision } = existing;
    if (record.idempotencyKey !== idempotencyKey) throw new AppServerCollaborationError("stale_revision", "This source revision already has a handoff decision.");
    if (record.action !== action || decision.targetRevision !== expectedTargetRevision
      || decision.reason !== input.reason || decision.detail !== input.detail) {
      throw new AppServerCollaborationError("idempotency_conflict", "The handoff key was used with a different decision.");
    }
    return { status: "replayed" as const, record: { ...record, workItemRevision: item.revision }, workItemRevision: item.revision };
  }

  const source = store.getChannelWorkflowStep(sourceStepId);
  const target = store.getChannelWorkflowStep(targetStepId);
  if (item.revision !== input.expectedWorkItemRevision || item.planRevision !== planRevision
    || !item.workflowId || !source || !target || source.workflowId !== item.workflowId || target.workflowId !== item.workflowId
    || !target.metadata?.requiredPlanHandoffStepIds?.includes(sourceStepId)
    || source.updatedAt !== expectedSourceRevision || target.updatedAt !== expectedTargetRevision || target.status !== "queued") {
    throw new AppServerCollaborationError("stale_revision", "The accepted Plan, supplying stage or receiving stage changed.");
  }
  if (store.getWorkItemWorkflowAdmissionBlocker(item.workflowId)) {
    throw new HttpError(409, "resume_blocked", "The Work Item is not ready to settle this handoff.");
  }
  if (source.status !== "succeeded") throw new HttpError(409, "resume_blocked", "The supplying stage needs an accepted result.");
  const artifactId = source.metadata?.outputArtifactId;
  const sourceRun = source.runId ? store.getRun(source.runId) : undefined;
  const packet = artifactId ? readWorkflowStepOutputPacketArtifact({ store, artifactId }) : undefined;
  if (action === "accepted" && (sourceRun?.status !== "succeeded" || sourceRun.workflowStepId !== source.id
    || packet?.workflowId !== source.workflowId || packet.workflowStepId !== source.id || packet.runId !== sourceRun.id)) {
    throw new HttpError(409, "resume_blocked", "The supplying stage needs a current result packet from its original Run.");
  }
  const payload: WorkflowStageHandoffDecision = {
    recipientId: target.toParticipantId, targetRevision: target.updatedAt, sourceArtifactId: artifactId, sourceRunId: sourceRun?.id,
    reason: input.reason, detail: input.detail,
  };
  const result = appendWorkItemCollaboration(store, {
    id: workflowStageHandoffId(subject), workItemId, expectedWorkItemRevision: input.expectedWorkItemRevision,
    kind: "handoff", action, actorId: "local-user", idempotencyKey, payload,
    sourceRefs: [
      { type: "workflow_step", id: source.id, revision: source.updatedAt },
      { type: "workflow_step", id: target.id, revision: target.updatedAt },
      ...(artifactId ? [{ type: "artifact", id: artifactId }] : []),
    ],
  }, now, store.paths.cwd);
  if (!result) throw new AppServerCollaborationError("stale_revision", "The Work Item changed before recording the handoff.");
  return result;
}
