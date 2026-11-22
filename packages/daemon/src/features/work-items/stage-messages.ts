import { createHash } from "node:crypto";
import type { LingAppServerStageMessageSendParams, LingAppServerWorkItemWorkflowBinding } from "@ling-stack/contracts";
import { appendWorkItemCollaboration, readWorkItemCollaborationRecord, type ChannelWorkflowStep, type RunStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { isRecord } from "../../shared/validation.js";

export const WORKFLOW_STAGE_MESSAGE_ID_PREFIX = "work_item_stage_message_";
const stageMessageLimit = 16;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stagePrefix = (stepId: string) => `${WORKFLOW_STAGE_MESSAGE_ID_PREFIX}${digest(stepId)}_`;

export function sendWorkItemStageMessage(store: RunStore, input: LingAppServerStageMessageSendParams, now: string) {
  const { workItemId, planRevision, targetStepId, expectedTargetRevision, expectedWorkItemRevision, idempotencyKey } = input;
  const body = input.body.trim();
  if (!body || body.length > 1200 || !idempotencyKey.trim() || idempotencyKey.length > 200 || /[\r\n\0]/u.test(idempotencyKey)
    || !Number.isSafeInteger(expectedWorkItemRevision) || expectedWorkItemRevision < 1) {
    throw new HttpError(400, "invalid_params", "Supply the current Work Item and stage revisions, request key and a message of up to 1,200 characters.");
  }
  const item = store.getWorkItem(workItemId);
  if (!item) throw new HttpError(404, "workspace_binding_invalid", "The Work Item is unavailable.");
  const id = `${stagePrefix(targetStepId)}${digest([workItemId, idempotencyKey])}`;
  const fingerprint = digest([planRevision, targetStepId, expectedTargetRevision, expectedWorkItemRevision, body]);
  const prior = readWorkItemCollaborationRecord(store, workItemId, id);
  if (prior) {
    if (!isRecord(prior.payload) || prior.payload.fingerprint !== fingerprint) {
      throw new HttpError(409, "idempotency_conflict", "The stage message key belongs to a different request.");
    }
    return { status: "replayed" as const, record: { ...prior, workItemRevision: item.revision }, workItemRevision: item.revision };
  }
  const target = store.getChannelWorkflowStep(targetStepId);
  if (!item.workflowId || !target?.metadata?.planStageId || target.workflowId !== item.workflowId || item.planRevision !== planRevision
    || item.revision !== expectedWorkItemRevision || target.updatedAt !== expectedTargetRevision) {
    throw new HttpError(409, "stale_revision", "The Work Item, Plan or receiving stage changed.");
  }
  if (target.status !== "queued" || store.getBlockingResourceLease("workflow_step", target.id)
    || ["done", "archived", "cancelled", "superseded"].includes(item.status)) {
    throw new HttpError(409, "resume_blocked", "The receiving stage has already left the input queue.");
  }
  if (store.listWorkItemEvidence({ workItemId, recordIdPrefix: stagePrefix(targetStepId), limit: stageMessageLimit }).length === stageMessageLimit) {
    throw new HttpError(409, "resume_blocked", "The receiving stage has reached its coordination input limit.");
  }
  try {
    const result = appendWorkItemCollaboration(store, {
      id, workItemId, expectedWorkItemRevision, idempotencyKey, kind: "message", action: "created", actorId: "local-user",
      visibility: "participants",
      payload: { planRevision, targetStepId, participantId: target.toParticipantId, body, fingerprint },
      sourceRefs: [{ type: "workflow_step", id: target.id, revision: expectedTargetRevision }],
    }, now, store.paths.cwd);
    if (!result) throw new HttpError(409, "stale_revision", "The Work Item changed before recording the message.");
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "work_item_evidence_idempotency_conflict") {
      throw new HttpError(409, "idempotency_conflict", "The stage message key belongs to a different request.");
    }
    throw error;
  }
}

export function readWorkItemStageMessages(store: RunStore, step: ChannelWorkflowStep, participantId: string) {
  if (!step.metadata?.planStageId || step.toParticipantId !== participantId) return [];
  const link = store.getAppServerState("work_item_workflow", step.workflowId)?.payload as { binding: LingAppServerWorkItemWorkflowBinding } | undefined;
  const item = link && store.getWorkItem(link.binding.workItemId);
  if (!item || item.workflowId !== step.workflowId || !item.planRevision) return [];
  return store.listWorkItemEvidence({ workItemId: item.id, recordIdPrefix: stagePrefix(step.id), limit: stageMessageLimit }).flatMap(entry => {
    const message = readWorkItemCollaborationRecord(store, item.id, entry.id);
    const payload = message?.payload;
    return message?.kind === "message" && isRecord(payload) && payload.planRevision === item.planRevision
      && payload.targetStepId === step.id && payload.participantId === participantId && typeof payload.body === "string"
      ? [{ id: message.id, body: payload.body }] : [];
  });
}
