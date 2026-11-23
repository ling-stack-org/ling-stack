import type { LingAppServerStageQuestionAskParams, LingAppServerStageQuestionReplyParams } from "@ling-stack/contracts";
import {
  appendWorkItemCollaboration, listWorkItemStageQuestions, readWorkItemStageQuestion, WORKFLOW_STAGE_QUESTION_LIMIT,
  workItemStageQuestionAnswerId, workItemStageQuestionExpired, workItemStageQuestionId, type RunSession, type RunStore,
  type AppendWorkItemCollaborationInput, type AppendWorkItemCollaborationResult, type ChannelWorkflowStep, type WorkItemCollaborationRecord,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { isRecord } from "../../shared/validation.js";
import { workflowStepParticipantAvailable } from "../channels/workflow-participant-run-profile.js";
import { readWorkItemWorkflowBinding } from "./workflow-stages.js";

export function askWorkItemStageQuestion(store: RunStore, input: LingAppServerStageQuestionAskParams, now: string) {
  const { workItemId, planRevision, waitingStepId, respondentStepId, deadlineAt, expectedWorkItemRevision,
    idempotencyKey, answerFromStageResult, predecessorQuestion } = input;
  const question = readQuestionText(input.question, idempotencyKey, expectedWorkItemRevision);
  const item = store.getWorkItem(workItemId);
  if (!item) throw new HttpError(404, "workspace_binding_invalid", "The Work Item is unavailable.");
  const id = workItemStageQuestionId(planRevision, waitingStepId, predecessorQuestion ? `predecessor:${predecessorQuestion.id}` : idempotencyKey);
  const payload = { planRevision, waitingStepId, respondentStepId, question, deadlineAt, requestRevision: expectedWorkItemRevision,
    ...(answerFromStageResult ? { answerFromStageResult: true } : {}), ...(predecessorQuestion ? { predecessorQuestion } : {}) };
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
  const transferring = predecessorQuestion !== undefined;
  if (item.control.state !== (transferring ? "paused" : "active") || ["done", "archived", "cancelled", "superseded"].includes(item.status)
    || [waiting, respondent].some(step => step.status !== "queued" || store.getBlockingResourceLease("workflow_step", step.id))) {
    throw new HttpError(409, "resume_blocked", "Both stages must be waiting for their initial Workflow admission.");
  }
  if (predecessorQuestion) {
    const current = readWorkItemWorkflowBinding(store, item.workflowId);
    const previous = current?.previousWorkflowId && readWorkItemWorkflowBinding(store, current.previousWorkflowId);
    const source = readWorkItemStageQuestion(store, workItemId, predecessorQuestion.id);
    const predecessorWaiting = source && store.getChannelWorkflowStep(source.question.waitingStepId);
    if (!previous || !source || source.reply || source.historicalReply
      || source.question.planRevision !== `${previous.planId}:${previous.planRevision}`
      || source.record.collaborationRevision !== predecessorQuestion.revision || source.question.question !== question
      || workItemStageQuestionExpired(source.question, Date.parse(now))
      || predecessorWaiting?.workflowId !== previous.workflowId || predecessorWaiting.metadata?.planStageId !== waiting.metadata.planStageId) {
      throw new HttpError(409, "stale_revision", "The source question is no longer pending for this successor stage.");
    }
    if (!workflowStepParticipantAvailable(store, respondent)) {
      throw new HttpError(409, "resume_blocked", "The assigned participant cannot receive the question.");
    }
  }
  if (answerFromStageResult && respondent.metadata?.planBallotKey) {
    throw new HttpError(409, "resume_blocked", "A ballot stage can only return its ballot.");
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
    ...(predecessorQuestion ? { parentRecordId: predecessorQuestion.id } : {}),
    sourceRefs: [{ type: "workflow_step", id: waitingStepId }, { type: "workflow_step", id: respondentStepId }],
  }, now);
}

export function replyToWorkItemStageQuestion(store: RunStore, input: LingAppServerStageQuestionReplyParams, now: string,
  stageResult?: { readonly participantId: string; readonly runId: string }) {
  const { workItemId, questionId, expectedQuestionRevision, expectedWorkItemRevision, idempotencyKey } = input;
  const answer = readQuestionText(input.answer, idempotencyKey, expectedWorkItemRevision);
  const item = store.getWorkItem(workItemId);
  const question = readWorkItemStageQuestion(store, workItemId, questionId);
  if (!item || !question) throw new HttpError(404, "workspace_binding_invalid", "The stage question is unavailable.");
  const payload = { answer, questionRevision: expectedQuestionRevision, requestRevision: expectedWorkItemRevision };
  const previous = question.reply ?? question.historicalReply;
  if (previous) {
    const { historicalReason, ...inputBasis } = previous.record.payload as typeof payload & { historicalReason?: string };
    return replay(previous.record, idempotencyKey, payload, item.revision, inputBasis);
  }

  if (item.revision !== expectedWorkItemRevision || question.record.collaborationRevision !== expectedQuestionRevision) {
    throw new HttpError(409, "stale_revision", "The Work Item or question revision changed.");
  }
  const historicalReason = item.planRevision !== question.question.planRevision ? "plan_superseded"
    : workItemStageQuestionExpired(question.question, Date.parse(now)) ? "deadline_expired" : undefined;
  return appendQuestion(store, {
    id: workItemStageQuestionAnswerId(questionId), workItemId, expectedWorkItemRevision, idempotencyKey, kind: "question",
    action: "replied", actorId: stageResult?.participantId ?? "local-user", parentRecordId: questionId,
    payload: { ...payload, ...(historicalReason ? { historicalReason } : {}) }, visibility: "participants",
    ...(stageResult ? { sourceRefs: [{ type: "run", id: stageResult.runId }] } : {}),
  }, now);
}

interface StageQuestionInput {
  readonly questionId: string;
  readonly question: string;
  readonly answer?: string;
  readonly answerReceiptId?: string;
  readonly answerFromStageResult?: true;
}

export const WORK_ITEM_STAGE_ANSWER_FORMAT = "ling-stage-answers";
const answerFenceStart = "^```" + WORK_ITEM_STAGE_ANSWER_FORMAT + "\\r?\\n";
const answerFenceEnd = "^```[ \\t]*(?:\\r?$)";
const answerFence = new RegExp(answerFenceStart + "([\\s\\S]*?)" + answerFenceEnd, "gmu");
const answerFenceIncludingUnclosed = new RegExp(answerFenceStart + "[\\s\\S]*?(?:" + answerFenceEnd + "|(?![\\s\\S]))", "gmu");

export function readAdmittedStageQuestionIds(run: RunSession): readonly unknown[] | undefined {
  const snapshot = isRecord(run.requestSnapshot) ? run.requestSnapshot.contextPack : undefined;
  return isRecord(snapshot) && Array.isArray(snapshot.stageQuestionIds) ? snapshot.stageQuestionIds : undefined;
}

export function readStageAnswerBlocks(text: string): readonly RegExpMatchArray[] {
  return [...text.matchAll(answerFence)];
}

export function stripStageAnswerBlocks(text: string): string {
  return text.replace(answerFenceIncludingUnclosed, "");
}

export function readWorkItemStageQuestionInputs(store: RunStore, step: ChannelWorkflowStep, participantId: string): readonly StageQuestionInput[] {
  if (!step.metadata?.planStageId || step.toParticipantId !== participantId) return [];
  const binding = readWorkItemWorkflowBinding(store, step.workflowId);
  const item = binding && store.getWorkItem(binding.workItemId);
  if (!item || item.workflowId !== step.workflowId || !item.planRevision) return [];
  const now = Date.now();
  return listWorkItemStageQuestions(store, item.id, item.planRevision).flatMap<StageQuestionInput>(({ record, question, reply }) => {
    if (question.waitingStepId === step.id && reply) {
      return [{ questionId: record.id, question: question.question, answer: reply.text, answerReceiptId: reply.record.id }];
    }
    if (question.respondentStepId === step.id && !reply && !workItemStageQuestionExpired(question, now)) {
      return [{ questionId: record.id, question: question.question,
        ...(question.answerFromStageResult ? { answerFromStageResult: true } : {}) }];
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

function replay(record: WorkItemCollaborationRecord, key: string, payload: unknown, workItemRevision: number,
  originalPayload: unknown = record.payload): AppendWorkItemCollaborationResult {
  if (record.idempotencyKey !== key) throw new HttpError(409, "stale_revision", "This question operation has already been accepted.");
  if (JSON.stringify(originalPayload) !== JSON.stringify(payload)) throw new HttpError(409, "idempotency_conflict", "The request key belongs to different input.");
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
