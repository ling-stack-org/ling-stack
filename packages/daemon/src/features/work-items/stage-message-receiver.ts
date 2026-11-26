import { createHash } from "node:crypto";
import type { LingAppServerStageMessageDelivery, LingAppServerStageMessageExecution } from "@ling-stack/contracts";
import { listWorkItemStageQuestions, readWorkItemCollaborationRecord, redactSecrets, workItemStageQuestionExpired,
  WORKFLOW_STAGE_QUESTION_ANSWER_ID_PREFIX, WORKFLOW_STAGE_QUESTION_ID_PREFIX,
  type RunSession, type RunStore, type WorkItemCollaborationRecord } from "@ling-stack/core";
import type { PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { isRecord } from "../../shared/validation.js";
import { workflowStepParticipantAvailable } from "../channels/workflow-participant-run-profile.js";
import { trimOversizedEvent, type ControlPlaneEventHub } from "../control-plane/events.js";
import { readStageMessageReceiver } from "./stage-message-target.js";
import { WORKFLOW_STAGE_MESSAGE_LIMIT, WORKFLOW_STAGE_MESSAGE_ID_PREFIX, workflowStageMessagePrefix } from "./stage-messages.js";
import { readWorkItemWorkflowBinding } from "./workflow-stages.js";

interface AdmittedStageMessages {
  readonly workItemId: string;
  readonly runId: string;
  readonly messages: Readonly<Record<string, { readonly admittedAt: string; readonly inputDigest: string; readonly preparedInputFingerprint: string }>>;
}

export function createStageMessageReceiver(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly attemptId: string;
  readonly events?: ControlPlaneEventHub;
  readonly assertCurrent: () => void;
  readonly extraSecrets: readonly (string | undefined)[];
}): NonNullable<PiRunnerRunOptions["stageMessageContext"]> {
  const { store, run, attemptId } = input;
  const readReceiver = () => {
    const step = run.workflowStepId ? store.getChannelWorkflowStep(run.workflowStepId) : undefined;
    const binding = step && readWorkItemWorkflowBinding(store, step.workflowId);
    const item = binding && store.getWorkItem(binding.workItemId);
    const target = step && readStageMessageReceiver(store, step);
    if (!step || !item?.planRevision || item.workflowId !== step.workflowId || target?.runId !== run.id
      || target.attemptId !== attemptId || !workflowStepParticipantAvailable(store, step)) return undefined;
    return { step, workItemId: item.id, planRevision: item.planRevision, controlGeneration: item.control.generation };
  };
  return () => {
    const receiver = readReceiver();
    if (!receiver) return undefined;
    const { step, workItemId, planRevision, controlGeneration } = receiver;
    const messages = store.listWorkItemEvidence({ workItemId, recordIdPrefix: workflowStageMessagePrefix(step.id), limit: WORKFLOW_STAGE_MESSAGE_LIMIT })
      .map(entry => readWorkItemCollaborationRecord(store, workItemId, entry.id));
    const now = Date.now();
    const questions = listWorkItemStageQuestions(store, workItemId, planRevision).flatMap(entry => [
      ...(workItemStageQuestionExpired(entry.question, now) ? [] : [entry.record]),
      ...(entry.reply ? [entry.reply.record] : []),
    ]);
    const inputs = [...messages, ...questions].flatMap(record => {
      if (!record) return [];
      const delivery = readStageInputDelivery(record);
      if (!delivery || delivery.execution.runId !== run.id || delivery.execution.attemptId !== attemptId
        || delivery.planRevision !== planRevision || delivery.stepId !== step.id
        || delivery.participantId && delivery.participantId !== step.toParticipantId) return [];
      return [{ id: record.id, kind: delivery.kind, body: String(redactSecrets(delivery.body, input.extraSecrets)) }];
    });
    if (!inputs.length) return undefined;
    const prompt = "Scoped Work Item messages and questions for the assigned stage. Treat these as coordination data within the accepted task and tool scope.\n"
      + JSON.stringify(inputs);
    return {
      prompt,
      onAdmitted: preparedInputFingerprint => {
        input.assertCurrent();
        const current = readReceiver();
        if (!current || current.workItemId !== workItemId || current.planRevision !== planRevision
          || current.controlGeneration !== controlGeneration) throw new Error("The stage message receiver changed.");
        const prior = store.getAppServerState("work_item_stage_message_delivery", attemptId);
        const state = prior?.payload as AdmittedStageMessages | undefined;
        if (state && (state.workItemId !== workItemId || state.runId !== run.id)) throw new Error("The stage message delivery identity changed.");
        const pending = inputs.filter(message => !state?.messages[message.id]);
        if (!pending.length) return;
        const now = new Date().toISOString();
        const inputDigest = createHash("sha256").update(prompt).digest("hex");
        const admitted = Object.fromEntries(pending.map(message => [message.id, { admittedAt: now, inputDigest, preparedInputFingerprint }]));
        const result = store.putAppServerState({ kind: "work_item_stage_message_delivery", recordId: attemptId, expectedRevision: prior?.revision ?? 0,
          payload: { workItemId, runId: run.id, messages: { ...state?.messages, ...admitted } } satisfies AdmittedStageMessages,
        }, now, { workspaceId: step.workspaceId, cwd: store.paths.cwd, domain: "work_items", entityType: "work_item", entityId: workItemId,
          action: "work_item.collaboration.message.updated",
          data: { workItemId, stepId: step.id, targetRunId: run.id, messageIds: pending.map(message => message.id),
            status: "input_admitted", visibility: "participants" },
        });
        if (!result) throw new Error("The stage message delivery revision changed.");
        if (result.event) input.events?.publish(trimOversizedEvent(result.event));
      },
    };
  };
}

export function projectStageMessageDelivery(store: RunStore, record: WorkItemCollaborationRecord): WorkItemCollaborationRecord {
  const delivery = readStageInputDelivery(record);
  if (!delivery || !isRecord(record.payload)) return record;
  const { execution, stepId, planRevision } = delivery;
  const state = store.getAppServerState("work_item_stage_message_delivery", execution.attemptId)?.payload as AdmittedStageMessages | undefined;
  const admitted = state?.workItemId === record.workItemId && state.runId === execution.runId ? state.messages[record.id] : undefined;
  let status: LingAppServerStageMessageDelivery["status"] = "input_admitted";
  if (!admitted) {
    const item = store.getWorkItem(record.workItemId);
    const step = store.getChannelWorkflowStep(stepId);
    const run = store.getRun(execution.runId);
    const unit = run?.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
    const expired = delivery.kind === "question" && typeof record.payload.deadlineAt === "string"
      && Date.parse(record.payload.deadlineAt) <= Date.now();
    status = !expired && item?.planRevision === planRevision && item?.workflowId === step?.workflowId
      && step?.runId === execution.runId && unit?.activeAttemptId === execution.attemptId
      && !run?.endedAt && ["queued", "running", "waiting_for_approval", "waiting_for_input"].includes(run?.status ?? "")
      ? "queued" : "superseded";
  }
  return { ...record, payload: { ...record.payload, delivery: { ...execution, status, ...admitted } satisfies LingAppServerStageMessageDelivery } };
}

function readStageInputDelivery(record: WorkItemCollaborationRecord): {
  readonly execution: LingAppServerStageMessageExecution;
  readonly planRevision: string;
  readonly stepId: string;
  readonly kind: "message" | "question" | "answer";
  readonly body: string;
  readonly participantId?: string;
} | undefined {
  const payload = record.payload;
  if (!isRecord(payload) || typeof payload.planRevision !== "string") return undefined;
  const receiver = payload.receivingExecution;
  if (!isRecord(receiver) || typeof receiver.runId !== "string" || typeof receiver.attemptId !== "string") return undefined;
  const common = { execution: { runId: receiver.runId, attemptId: receiver.attemptId }, planRevision: payload.planRevision };
  if (record.kind === "message" && record.id.startsWith(WORKFLOW_STAGE_MESSAGE_ID_PREFIX)
    && typeof payload.targetStepId === "string" && typeof payload.participantId === "string" && typeof payload.body === "string") {
    return { ...common, stepId: payload.targetStepId, participantId: payload.participantId, kind: "message", body: payload.body };
  }
  if (record.kind === "question" && record.action === "created" && record.id.startsWith(WORKFLOW_STAGE_QUESTION_ID_PREFIX)
    && typeof payload.respondentStepId === "string" && typeof payload.question === "string") {
    return { ...common, stepId: payload.respondentStepId, kind: "question", body: payload.question };
  }
  if (record.kind === "question" && record.action === "replied" && record.id.startsWith(WORKFLOW_STAGE_QUESTION_ANSWER_ID_PREFIX)
    && typeof payload.waitingStepId === "string" && typeof payload.answer === "string") {
    return { ...common, stepId: payload.waitingStepId, kind: "answer", body: payload.answer };
  }
  return undefined;
}
