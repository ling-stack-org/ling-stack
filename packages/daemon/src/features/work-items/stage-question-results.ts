import { listWorkItemStageQuestions, WORKFLOW_STAGE_QUESTION_LIMIT, workItemStageQuestionAnswerId, type RunStore } from "@ling-stack/core";
import { workflowStepParticipantAvailable } from "../channels/workflow-participant-run-profile.js";
import { readWorkflowStepOutputPacketArtifact } from "../channels/workflow-step-packets.js";
import { trimOversizedEvent, type ControlPlaneEventHub } from "../control-plane/events.js";
import { isRecord } from "../../shared/validation.js";
import { readAdmittedStageQuestionIds, readStageAnswerBlocks, replyToWorkItemStageQuestion } from "./stage-questions.js";
import { readWorkItemWorkflowBinding } from "./workflow-stages.js";

export function reconcileWorkItemStageQuestionResults(store: RunStore, workflowId: string, events: ControlPlaneEventHub): void {
  const binding = readWorkItemWorkflowBinding(store, workflowId);
  const item = binding && store.getWorkItem(binding.workItemId);
  if (!item?.planRevision || item.workflowId !== workflowId || store.getWorkItemWorkflowAdmissionBlocker(workflowId)) return;
  const byRun = new Map<string, ReadonlyMap<string, string>>();
  for (const { record, question, reply, historicalReply } of listWorkItemStageQuestions(store, item.id, item.planRevision)) {
    if (!question.answerFromStageResult || reply || historicalReply
      || item.holds.some(hold => hold.blocksNewAdmission && hold.workflowStepIds?.some(stepId =>
        stepId === question.waitingStepId || stepId === question.respondentStepId))) continue;
    const stage = store.getChannelWorkflowStep(question.respondentStepId);
    if (stage?.workflowId !== workflowId || stage.status !== "succeeded" || !stage.runId
      || !workflowStepParticipantAvailable(store, stage)) continue;
    const run = store.getRun(stage.runId);
    if (run?.status !== "succeeded" || run.workflowStepId !== stage.id || run.teammateId !== stage.toParticipantId) continue;
    const artifactId = stage.metadata?.outputArtifactId;
    const packet = artifactId && readWorkflowStepOutputPacketArtifact({ store, artifactId });
    if (!packet || packet.workflowId !== workflowId || packet.workflowStepId !== stage.id || packet.runId !== run.id
      || !readAdmittedStageQuestionIds(run)?.includes(record.id)) continue;
    let answers = byRun.get(run.id);
    if (!answers) {
      answers = readStageAnswers(store, run.id);
      byRun.set(run.id, answers);
    }
    const answer = answers.get(record.id);
    const current = answer && store.getWorkItem(item.id);
    if (!answer || !current) continue;
    const result = replyToWorkItemStageQuestion(store, {
      workItemId: item.id, questionId: record.id, expectedQuestionRevision: record.collaborationRevision,
      expectedWorkItemRevision: current.revision, answer,
      idempotencyKey: `stage-result:${run.id}:${workItemStageQuestionAnswerId(record.id)}`,
    }, new Date().toISOString(), { participantId: stage.toParticipantId, runId: run.id });
    if (result.event) events.publish(trimOversizedEvent(result.event));
  }
}

function readStageAnswers(store: RunStore, runId: string): ReadonlyMap<string, string> {
  const answers = new Map<string, string>();
  const events = store.listEvents(runId, { limit: 1000 });
  if (events.length === 1000) return answers;
  const chunks: string[] = [];
  let length = 0;
  for (const event of events) {
    if (event.type !== "assistant_text_delta" || !isRecord(event.data) || typeof event.data.text !== "string") continue;
    length += event.data.text.length;
    if (length > 96_000) return answers;
    chunks.push(event.data.text);
  }
  const blocks = readStageAnswerBlocks(chunks.join(""));
  if (blocks.length !== 1) return answers;
  let value: unknown;
  try { value = JSON.parse(blocks[0]![1]!); } catch { return answers; }
  if (!Array.isArray(value) || value.length > WORKFLOW_STAGE_QUESTION_LIMIT) return answers;
  for (const entry of value) {
    if (!isRecord(entry) || Object.keys(entry).length !== 2 || typeof entry.questionId !== "string"
      || typeof entry.answer !== "string" || !entry.answer.trim() || entry.answer.length > 1200
      || answers.has(entry.questionId)) return new Map();
    answers.set(entry.questionId, entry.answer.trim());
  }
  return answers;
}
