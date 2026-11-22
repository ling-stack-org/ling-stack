import type { LingAppServerStageQuestionAskParams, LingAppServerStageQuestionReplyParams } from "@ling-stack/contracts";
import {
  appendWorkItemCollaboration, listWorkItemStageQuestions, readWorkItemStageQuestion, WORKFLOW_STAGE_QUESTION_LIMIT,
  workItemStageQuestionAnswerId, workItemStageQuestionId, type RunStore,
  type AppendWorkItemCollaborationInput, type AppendWorkItemCollaborationResult, type ChannelWorkflowStep, type WorkItemCollaborationRecord,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { readWorkItemWorkflowBinding } from "./workflow-stages.js";

export function askWorkItemStageQuestion(store: RunStore, input: LingAppServerStageQuestionAskParams, now: string) {
  const { workItemId, planRevision, waitingStepId, respondentStepId, deadlineAt, expectedWorkItemRevision, idempotencyKey } = input;
  const question = readQuestionText(input.question, idempotencyKey, expectedWorkItemRevision);
  const item = store.getWorkItem(workItemId);
  if (!item) throw new HttpError(404, "workspace_binding_invalid", "The Work Item is unavailable.");
  const id = workItemStageQuestionId(planRevision, waitingStepId, idempotencyKey);
  const payload = { planRevision, waitingStepId, respondentStepId, question, deadlineAt, requestRevision: expectedWorkItemRevision };
  const prior = readWorkItemStageQuestion(store, workItemId, id);
  if (prior) return replay(prior.record, idempotencyKey, payload, item.revision);

  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline) || deadline <= Date.parse(now) || deadline - Date.parse(now) > 86_400_000) {
    throw new HttpError(400, "invalid_params", "Choose a question deadline within the next 24 hours.");
  }
  const waiting = store.getChannelWorkflowStep(waitingStepId);
  const respondent = store.getChannelWorkflowStep(respondentStepId);
  if (!item.workflowId || item.revision !== expectedWorkItemRevision || item.planRevision !== planRevision
    || !waiting?.metadata?.planStageId || !respondent?.metadata?.planStageId
    || waiting.workflowId !== item.workflowId || respondent.workflowId !== item.workflowId) {
    throw new HttpError(409, "stale_revision", "Choose stages from the current accepted Plan.");
  }
  if (item.control.state !== "active" || ["done", "archived", "cancelled", "superseded"].includes(item.status)
    || [waiting, respondent].some(step => step.status !== "queued" || store.getBlockingResourceLease("workflow_step", step.id))) {
    throw new HttpError(409, "resume_blocked", "Both stages must be waiting for their initial Workflow admission.");
  }
  const existing = listWorkItemStageQuestions(store, workItemId, planRevision);
  if (existing.length >= WORKFLOW_STAGE_QUESTION_LIMIT) throw new HttpError(409, "resume_blocked", "The Plan's question limit has been reached.");
  const graph = new Map(store.listChannelWorkflowSteps({ workflowId: item.workflowId, complete: true })
    .map(step => [step.id, [...(step.metadata?.dependsOnStepIds ?? [])]]));
  for (const { question: outstanding, reply } of existing) {
    if (!reply) graph.get(outstanding.waitingStepId)?.push(outstanding.respondentStepId);
  }
  const reachable = new Set([respondentStepId]);
  for (const stepId of reachable) {
    if (stepId === waitingStepId) throw new HttpError(409, "work_item_question_cycle", "These stages would be waiting for each other.");
    for (const dependency of graph.get(stepId) ?? []) reachable.add(dependency);
  }
  return appendQuestion(store, { id, workItemId, expectedWorkItemRevision, idempotencyKey, kind: "question", action: "created",
    actorId: "local-user", payload, visibility: "participants",
    sourceRefs: [{ type: "workflow_step", id: waitingStepId }, { type: "workflow_step", id: respondentStepId }],
  }, now);
}

export function replyToWorkItemStageQuestion(store: RunStore, input: LingAppServerStageQuestionReplyParams, now: string) {
  const { workItemId, questionId, expectedQuestionRevision, expectedWorkItemRevision, idempotencyKey } = input;
  const answer = readQuestionText(input.answer, idempotencyKey, expectedWorkItemRevision);
  const item = store.getWorkItem(workItemId);
  const question = readWorkItemStageQuestion(store, workItemId, questionId);
  if (!item || !question) throw new HttpError(404, "workspace_binding_invalid", "The stage question is unavailable.");
  const payload = { answer, questionRevision: expectedQuestionRevision, requestRevision: expectedWorkItemRevision };
  if (question.reply) return replay(question.reply.record, idempotencyKey, payload, item.revision);

  if (item.planRevision !== question.question.planRevision || item.revision !== expectedWorkItemRevision
    || question.record.collaborationRevision !== expectedQuestionRevision) {
    throw new HttpError(409, "stale_revision", "The Plan, Work Item or question revision changed.");
  }
  return appendQuestion(store, {
    id: workItemStageQuestionAnswerId(questionId), workItemId, expectedWorkItemRevision, idempotencyKey, kind: "question",
    action: "replied", actorId: "local-user", parentRecordId: questionId, payload, visibility: "participants",
  }, now);
}

interface StageQuestionInput {
  readonly questionId: string;
  readonly question: string;
  readonly answer?: string;
  readonly answerReceiptId?: string;
}

export function readWorkItemStageQuestionInputs(store: RunStore, step: ChannelWorkflowStep, participantId: string): readonly StageQuestionInput[] {
  if (!step.metadata?.planStageId || step.toParticipantId !== participantId) return [];
  const binding = readWorkItemWorkflowBinding(store, step.workflowId);
  const item = binding && store.getWorkItem(binding.workItemId);
  if (!item || item.workflowId !== step.workflowId || !item.planRevision) return [];
  return listWorkItemStageQuestions(store, item.id, item.planRevision).flatMap<StageQuestionInput>(({ record, question, reply }) => {
    if (question.waitingStepId === step.id && reply) {
      return [{ questionId: record.id, question: question.question, answer: reply.text, answerReceiptId: reply.record.id }];
    }
    if (question.respondentStepId === step.id && !reply) {
      return [{ questionId: record.id, question: question.question }];
    }
    return [];
  });
}

function readQuestionText(value: string, key: string, revision: number): string {
  const text = value.trim();
  if (!text || text.length > 1200 || !key.trim() || key.length > 200 || /[\r\n\0]/u.test(key)
    || !Number.isSafeInteger(revision) || revision < 1) {
    throw new HttpError(400, "invalid_params", "Supply a current revision, bounded request key and text of up to 1,200 characters.");
  }
  return text;
}

function replay(record: WorkItemCollaborationRecord, key: string, payload: unknown, workItemRevision: number): AppendWorkItemCollaborationResult {
  if (record.idempotencyKey !== key) throw new HttpError(409, "stale_revision", "The question already has a reply.");
  if (JSON.stringify(record.payload) !== JSON.stringify(payload)) throw new HttpError(409, "idempotency_conflict", "The request key belongs to different input.");
  return { status: "replayed" as const, record: { ...record, workItemRevision }, workItemRevision };
}

function appendQuestion(store: RunStore, input: AppendWorkItemCollaborationInput, now: string) {
  try {
    const result = appendWorkItemCollaboration(store, input, now, store.paths.cwd);
    if (!result) throw new HttpError(409, "stale_revision", "The Work Item changed before recording the question.");
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "work_item_evidence_idempotency_conflict") {
      throw new HttpError(409, "idempotency_conflict", "The request key belongs to different input.");
    }
    throw error;
  }
}
