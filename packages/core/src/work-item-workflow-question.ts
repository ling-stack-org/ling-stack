import { createHash } from "node:crypto";
import type { RunStore } from "./run-types.js";
import { readWorkItemCollaborationRecord } from "./work-item-collaboration.js";

type QuestionStore = Pick<RunStore, "getWorkItemEvidence" | "listWorkItemEvidence">;

export const WORKFLOW_STAGE_QUESTION_ID_PREFIX = "work_item_stage_question_";
export const WORKFLOW_STAGE_QUESTION_ANSWER_ID_PREFIX = "work_item_stage_answer_";
export const WORKFLOW_STAGE_QUESTION_LIMIT = 64;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function questionPrefix(planRevision: string, waitingStepId?: string): string {
  const plan = WORKFLOW_STAGE_QUESTION_ID_PREFIX + digest(planRevision) + "_";
  return waitingStepId ? plan + digest(waitingStepId) + "_" : plan;
}

export function workItemStageQuestionId(planRevision: string, waitingStepId: string, requestKey: string): string {
  return questionPrefix(planRevision, waitingStepId) + digest(requestKey);
}

export function workItemStageQuestionAnswerId(questionId: string): string {
  return WORKFLOW_STAGE_QUESTION_ANSWER_ID_PREFIX + digest(questionId);
}

export interface WorkItemStageQuestionPayload {
  readonly planRevision: string;
  readonly waitingStepId: string;
  readonly respondentStepId: string;
  readonly question: string;
  readonly deadlineAt: string;
}

export function workItemStageQuestionExpired(question: WorkItemStageQuestionPayload, now: number): boolean {
  return Date.parse(question.deadlineAt) <= now;
}

export function readWorkItemStageQuestion(store: Pick<QuestionStore, "getWorkItemEvidence">, workItemId: string, questionId: string) {
  if (!questionId.startsWith(WORKFLOW_STAGE_QUESTION_ID_PREFIX)) return undefined;
  const record = readWorkItemCollaborationRecord(store, workItemId, questionId);
  const question = record?.payload as WorkItemStageQuestionPayload | undefined;
  if (record?.kind !== "question" || record.action !== "created" || !question
    || typeof question.planRevision !== "string" || typeof question.waitingStepId !== "string"
    || typeof question.respondentStepId !== "string" || typeof question.question !== "string"
    || typeof question.deadlineAt !== "string") return undefined;
  const answer = readWorkItemCollaborationRecord(store, workItemId, workItemStageQuestionAnswerId(questionId));
  const payload = answer?.payload as { readonly answer?: unknown; readonly historicalReason?: unknown } | undefined;
  const response = answer?.kind === "question" && answer.action === "replied" && answer.parentRecordId === record.id
    && typeof payload?.answer === "string" ? { record: answer, text: payload.answer } : undefined;
  return { record, question, reply: payload?.historicalReason === undefined ? response : undefined,
    historicalReply: payload?.historicalReason === undefined ? undefined : response };
}

export function listWorkItemStageQuestions(store: QuestionStore, workItemId: string, planRevision: string, waitingStepId?: string) {
  return store.listWorkItemEvidence({ workItemId, recordIdPrefix: questionPrefix(planRevision, waitingStepId), limit: WORKFLOW_STAGE_QUESTION_LIMIT })
    .flatMap(entry => {
      const result = readWorkItemStageQuestion(store, workItemId, entry.id);
      return result ? [result] : [];
    });
}
