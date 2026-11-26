import { createHash } from "node:crypto";
import type { LingAppServerStageMessageSendParams, LingAppServerWorkItemWorkflowBinding } from "@ling-stack/contracts";
import { appendWorkItemCollaboration, readWorkItemCollaborationRecord, type ChannelWorkflowStep, type RunStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { isRecord } from "../../shared/validation.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import { workflowStepParticipantAvailable } from "../channels/workflow-participant-run-profile.js";
import {
  matchesStageCoordinationExecution, stageCoordinationDenied, stageCoordinationExecution, stageCoordinationRequestKey,
  stageCoordinationSourceRefs, type StageCoordinationActor,
} from "./stage-coordination-authority.js";
import { readStageMessageReceiver } from "./stage-message-target.js";

export const WORKFLOW_STAGE_MESSAGE_ID_PREFIX = "work_item_stage_message_";
export const WORKFLOW_STAGE_MESSAGE_LIMIT = 16;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const workflowStageMessagePrefix = (stepId: string) => `${WORKFLOW_STAGE_MESSAGE_ID_PREFIX}${digest(stepId)}_`;

export function sendWorkItemStageMessage(store: RunStore, input: LingAppServerStageMessageSendParams, now: string,
  activeRuns: ActiveRunRegistry, actor?: StageCoordinationActor) {
  const { workItemId, planRevision, targetStepId, expectedTargetRevision, expectedWorkItemRevision, expectedExecution } = input;
  const source = actor?.binding;
  const body = input.body.trim();
  if (!body || body.length > 1200 || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200 || /[\r\n\0]/u.test(input.idempotencyKey)
    || !Number.isSafeInteger(expectedWorkItemRevision) || expectedWorkItemRevision < 1) {
    throw new HttpError(400, "invalid_params", "Supply the current Work Item and stage revisions, request key and a message of up to 1,200 characters.");
  }
  if (source && (source.workItemId !== workItemId || source.planRevision !== planRevision || targetStepId === source.stepId)) {
    throw stageCoordinationDenied();
  }
  actor?.assertCurrent();
  const item = store.getWorkItem(workItemId);
  if (!item) throw new HttpError(404, "workspace_binding_invalid", "The Work Item is unavailable.");
  const idempotencyKey = source ? stageCoordinationRequestKey(source, input.idempotencyKey) : input.idempotencyKey;
  const id = `${workflowStageMessagePrefix(targetStepId)}${digest([workItemId, idempotencyKey])}`;
  const fingerprint = digest([planRevision, targetStepId, expectedTargetRevision, expectedWorkItemRevision, body,
    ...(expectedExecution ? [expectedExecution.runId, expectedExecution.attemptId] : [])]);
  const prior = readWorkItemCollaborationRecord(store, workItemId, id);
  if (prior) {
    if (source && (!isRecord(prior.payload) || !matchesStageCoordinationExecution(prior.payload.sendingExecution, source))) {
      throw stageCoordinationDenied();
    }
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
  if (item.control.state !== "active" || (expectedExecution || source) && item.holds.some(hold => hold.blocksNewAdmission
    && (!hold.workflowStepIds || hold.workflowStepIds.includes(target.id)))) {
    throw new HttpError(409, "resume_blocked", "New stage messages require an active Work Item.");
  }
  if (["done", "archived", "cancelled", "superseded"].includes(item.status) || !workflowStepParticipantAvailable(store, target)
    || source && target.metadata.planBallotKey) {
    throw new HttpError(409, "resume_blocked", "The receiving stage or assigned participant is unavailable.");
  }
  const assertTargetCurrent = () => {
    const current = store.getChannelWorkflowStep(targetStepId);
    if (!current || current.updatedAt !== expectedTargetRevision || current.toParticipantId !== target.toParticipantId
      || !workflowStepParticipantAvailable(store, current)) {
      throw new HttpError(409, "stale_revision", "The receiving stage changed.");
    }
    if (expectedExecution) {
      const receiver = readStageMessageReceiver(store, current, activeRuns);
      if (!receiver || receiver.runId !== expectedExecution.runId || receiver.attemptId !== expectedExecution.attemptId) {
        throw new HttpError(409, "stale_revision", "Read the current execution for the receiving stage.");
      }
    } else if (current.status !== "queued" || store.getBlockingResourceLease("workflow_step", current.id)) {
      throw new HttpError(409, "resume_blocked", "A running stage requires its current Run and Attempt.");
    }
  };
  if (store.listWorkItemEvidence({ workItemId, recordIdPrefix: workflowStageMessagePrefix(targetStepId), limit: WORKFLOW_STAGE_MESSAGE_LIMIT }).length === WORKFLOW_STAGE_MESSAGE_LIMIT) {
    throw new HttpError(409, "resume_blocked", "The receiving stage has reached its coordination input limit.");
  }
  try {
    const result = appendWorkItemCollaboration(store, {
      id, workItemId, expectedWorkItemRevision, idempotencyKey, kind: "message", action: "created", actorId: source?.participantId ?? "local-user",
      visibility: "participants",
      payload: { planRevision, targetStepId, participantId: target.toParticipantId, body, fingerprint,
        ...(source ? { sendingStepId: source.stepId, sendingExecution: stageCoordinationExecution(source) } : {}),
        ...(expectedExecution ? { receivingExecution: expectedExecution } : {}) },
      sourceRefs: [{ type: "workflow_step", id: target.id, revision: expectedTargetRevision }, ...(source ? stageCoordinationSourceRefs(source) : [])],
      assertCurrent: () => { actor?.assertCurrent(); assertTargetCurrent(); },
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
  return store.listWorkItemEvidence({ workItemId: item.id, recordIdPrefix: workflowStageMessagePrefix(step.id), limit: WORKFLOW_STAGE_MESSAGE_LIMIT }).flatMap(entry => {
    const message = readWorkItemCollaborationRecord(store, item.id, entry.id);
    const payload = message?.payload;
    return message?.kind === "message" && isRecord(payload) && payload.planRevision === item.planRevision
      && payload.targetStepId === step.id && payload.participantId === participantId && payload.receivingExecution === undefined
      && typeof payload.body === "string"
      ? [{ id: message.id, body: payload.body }] : [];
  });
}
