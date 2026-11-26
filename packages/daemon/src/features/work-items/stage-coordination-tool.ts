import { isDeepStrictEqual } from "node:util";
import {
  digestHarnessToolValue, readWorkItemCollaborationRecord, readWorkItemStageQuestion, redactSecrets,
  stageCoordinationToolKey, stageCoordinationToolReceiptId,
  type AppendWorkItemCollaborationResult, type RunSession, type RunStore, type WorkItemCollaborationRecord,
  type WorkItemStageToolReceipt,
} from "@ling-stack/core";
import type { PiRunnerRunOptions, PiRunnerToolHandledResult } from "@ling-stack/runner-pi";
import { HttpError } from "../../errors.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import { isRecord } from "../../shared/validation.js";
import { trimOversizedEvent, type ControlPlaneEventHub } from "../control-plane/events.js";
import {
  readStageCoordinationBinding, stageCoordinationDenied, stageCoordinationExecution, stageCoordinationRequestKey,
  type StageCoordinationActor,
} from "./stage-coordination-authority.js";
import { listStageDevelopmentEvidence, readStageDependencyOutput, readStageDevelopmentEvidence } from "./stage-evidence.js";
import { readStageMessageReceiver } from "./stage-message-target.js";
import { sendWorkItemStageMessage } from "./stage-messages.js";
import { askWorkItemStageQuestion, readWorkItemStageQuestionInputs, replyToWorkItemStageQuestion } from "./stage-questions.js";
import { readWorkItemWorkflowBinding, readWorkItemWorkflowStages } from "./workflow-stages.js";

type ReadRequest = { readonly action: "read"; readonly stageOffset: number; readonly afterEvidenceSequence: number }
  | { readonly action: "read_evidence"; readonly evidenceId: string; readonly sourceId: string }
  | { readonly action: "read_output"; readonly artifactId: string };
type WriteRequest =
  | { readonly action: "send" | "ask"; readonly targetStepId: string; readonly text: string }
  | { readonly action: "reply"; readonly questionId: string; readonly text: string };

export function createWorkItemCoordinationToolHandler(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly attemptId: string;
  readonly activeRuns: ActiveRunRegistry;
  readonly assertCurrent: () => void;
  readonly extraSecrets: readonly (string | undefined)[];
  readonly events?: ControlPlaneEventHub;
}): NonNullable<PiRunnerRunOptions["onWorkItemCoordinationCall"]> {
  const { store, run, attemptId, activeRuns } = input;
  const step = run.workflowStepId ? store.getChannelWorkflowStep(run.workflowStepId) : undefined;
  const itemId = step && readWorkItemWorkflowBinding(store, step.workflowId)?.workItemId;
  return ({ toolCallId, input: raw }): PiRunnerToolHandledResult => {
    input.assertCurrent();
    const item = itemId ? store.getWorkItem(itemId) : undefined;
    const binding = item && readStageCoordinationBinding(store, activeRuns, item.id, { runId: run.id, attemptId });
    if (!binding || !item || !step) throw stageCoordinationDenied();
    const actor: StageCoordinationActor = {
      binding,
      assertCurrent() {
        input.assertCurrent();
        const current = readStageCoordinationBinding(store, activeRuns, item.id, stageCoordinationExecution(binding));
        if (!isDeepStrictEqual(current, binding)) throw stageCoordinationDenied();
      },
    };
    const idempotencyKey = stageCoordinationToolKey(toolCallId);
    const recordId = stageCoordinationToolReceiptId(run.id, attemptId, toolCallId);
    const safeInput = redactSecrets(raw ?? null, input.extraSecrets);
    const requestDigest = digestHarnessToolValue(safeInput);
    const prior = store.getAppServerState("work_item_stage_tool_receipt", recordId);
    const retained = prior?.payload as WorkItemStageToolReceipt | undefined;
    if (retained && retained.requestDigest !== requestDigest) {
      return toolResult({ status: "rejected", code: "idempotency_conflict" });
    }
    const now = new Date().toISOString();
    const save = (outcome: WorkItemStageToolReceipt["outcome"]) => {
      if (retained) return;
      const receipt: WorkItemStageToolReceipt = {
        source: { runId: run.id, ...binding.fence }, workItemId: item.id, stepId: step.id, toolCallId, requestDigest, outcome,
      };
      if (!store.putAppServerState({ kind: "work_item_stage_tool_receipt", recordId, expectedRevision: 0, payload: receipt }, now)) {
        throw new Error("Coordination tool receipt could not be committed.");
      }
    };
    if (retained?.outcome.status === "rejected") return toolResult(retained.outcome);
    if (retained?.outcome.status === "recorded") return toolResult({ status: "replayed", recordId: retained.outcome.recordId });

    let committed: AppendWorkItemCollaborationResult;
    try {
      const request = parseRequest(safeInput);
      if (request.action === "read" || request.action === "read_evidence" || request.action === "read_output") {
        const response = store.readSnapshot(() => {
          actor.assertCurrent();
          if (request.action === "read_evidence") return readStageDevelopmentEvidence(store, binding, request.evidenceId, request.sourceId);
          if (request.action === "read_output") return readStageDependencyOutput(store, step, request.artifactId);
          const readItem = store.getWorkItem(item.id)!;
          const workflow = readWorkItemWorkflowStages(store, readItem, false, request.stageOffset);
          const questions = readWorkItemStageQuestionInputs(store, step, binding.participantId);
          const evidence = listStageDevelopmentEvidence(store, binding, request.afterEvidenceSequence);
          return { workflow, questions: questions.slice(0, 16), evidence };
        });
        save({ status: "read" });
        return toolResult(redactSecrets(response, input.extraSecrets));
      }
      const existing = store.findWorkItemEvidenceByKey(item.id, stageCoordinationRequestKey(binding, idempotencyKey));
      if (existing) {
        const record = readWorkItemCollaborationRecord(store, item.id, existing.id);
        if (!record || !sameRequest(record, request)) throw new HttpError(409, "idempotency_conflict", "The tool call key belongs to a different coordination request.");
        save({ status: "recorded", recordId: existing.id });
        return toolResult({ status: "replayed", recordId: existing.id });
      }
      const basis = { workItemId: item.id, expectedWorkItemRevision: item.revision, idempotencyKey };
      if (request.action === "reply") {
        const question = readWorkItemStageQuestion(store, item.id, request.questionId);
        if (!question) throw stageCoordinationDenied();
        committed = replyToWorkItemStageQuestion(store, {
          ...basis, questionId: request.questionId, answer: request.text,
          expectedQuestionRevision: question.record.collaborationRevision,
        }, now, undefined, actor);
      } else if (request.action === "ask") {
        const target = store.getChannelWorkflowStep(request.targetStepId);
        const running = target && readStageMessageReceiver(store, target, activeRuns);
        committed = askWorkItemStageQuestion(store, {
          ...basis, planRevision: binding.planRevision, waitingStepId: step.id,
          respondentStepId: request.targetStepId, question: request.text,
          deadlineAt: new Date(Date.parse(now) + 60 * 60_000).toISOString(),
          ...(running ? {} : { answerFromStageResult: true }),
        }, now, activeRuns, actor);
      } else {
        const target = store.getChannelWorkflowStep(request.targetStepId);
        if (target?.workflowId !== step.workflowId) throw stageCoordinationDenied();
        const receiver = readStageMessageReceiver(store, target, activeRuns);
        committed = sendWorkItemStageMessage(store, {
          ...basis, planRevision: binding.planRevision, targetStepId: target.id, expectedTargetRevision: target.updatedAt,
          body: request.text, expectedExecution: receiver,
        }, now, activeRuns, actor);
      }
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      const outcome = { status: "rejected", code: error.code } as const;
      save(outcome);
      return toolResult({ ...outcome, message: error.message });
    }
    save({ status: "recorded", recordId: committed.record.id });
    if (committed.event) input.events?.publish(trimOversizedEvent(committed.event));
    return toolResult({ status: committed.status === "appended" ? "recorded" : "replayed", recordId: committed.record.id });
  };
}

function sameRequest(record: WorkItemCollaborationRecord, request: WriteRequest): boolean {
  if (!isRecord(record.payload)) return false;
  const payload = record.payload;
  switch (request.action) {
    case "send": return record.kind === "message" && payload.targetStepId === request.targetStepId && payload.body === request.text;
    case "ask": return record.kind === "question" && record.action === "created"
      && payload.respondentStepId === request.targetStepId && payload.question === request.text;
    case "reply": return record.kind === "question" && record.action === "replied"
      && record.parentRecordId === request.questionId && payload.answer === request.text;
  }
}

function parseRequest(value: unknown): ReadRequest | WriteRequest {
  if (!isRecord(value)) throw invalidRequest();
  if (value.action === "read") {
    const stageOffset = value.stageOffset ?? 0;
    const afterEvidenceSequence = value.afterEvidenceSequence ?? 0;
    if (typeof stageOffset !== "number" || !Number.isSafeInteger(stageOffset) || stageOffset < 0
      || typeof afterEvidenceSequence !== "number" || !Number.isSafeInteger(afterEvidenceSequence) || afterEvidenceSequence < 0
      || Object.keys(value).some(key => !["action", "stageOffset", "afterEvidenceSequence"].includes(key))) throw invalidRequest();
    return { action: "read", stageOffset, afterEvidenceSequence };
  }
  if (value.action === "read_evidence") {
    if (!validId(value.evidenceId) || !validId(value.sourceId)
      || Object.keys(value).some(key => !["action", "evidenceId", "sourceId"].includes(key))) throw invalidRequest();
    return { action: "read_evidence", evidenceId: value.evidenceId, sourceId: value.sourceId };
  }
  if (value.action === "read_output") {
    if (!validId(value.artifactId) || Object.keys(value).some(key => key !== "action" && key !== "artifactId")) throw invalidRequest();
    return { action: "read_output", artifactId: value.artifactId };
  }
  const text = value.text;
  if (typeof text !== "string" || !text.trim() || text.length > 1200) throw invalidRequest();
  const { action } = value;
  const field = action === "reply" ? "questionId" : "targetStepId";
  const id = value[field];
  if (!validId(id)
    || Object.keys(value).some(key => key !== "action" && key !== field && key !== "text")) throw invalidRequest();
  if (action === "send" || action === "ask") return { action, targetStepId: id, text: text.trim() };
  if (action === "reply") return { action, questionId: id, text: text.trim() };
  throw invalidRequest();
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function invalidRequest(): HttpError {
  return new HttpError(400, "invalid_params", "Supply a supported action and its required references or bounded text.");
}

function toolResult(value: unknown): PiRunnerToolHandledResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
