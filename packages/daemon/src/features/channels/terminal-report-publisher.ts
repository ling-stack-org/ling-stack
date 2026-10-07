import type { ChannelMessage, ControlPlaneEvent, NormalTerminalReportBasis, RunStore, TerminalReport } from "@ling-stack/core";
import type { ConversationItemV1 } from "@ling-stack/contracts";
import { getChannelMessageView } from "./conversation-item-messages.js";
import { evaluateWorkflowCompletion } from "./workflow-completion-gate.js";
import { publishNormalTerminalReport } from "./normal-terminal-report-publisher.js";

export interface TerminalReportPublication {
  readonly message?: ChannelMessage;
  readonly resultItem?: ConversationItemV1;
  readonly controlPlaneEvent?: ControlPlaneEvent;
  readonly duplicate: boolean;
}

export function publishTerminalReport(input: {
  readonly store: RunStore;
  readonly report: TerminalReport;
  readonly linkedRunId?: string;
  readonly now: string;
}): ChannelMessage | undefined {
  return publishTerminalReportPublication(input)?.message;
}

export function publishTerminalReportPublication(input: {
  readonly store: RunStore;
  readonly report: TerminalReport;
  readonly linkedRunId?: string;
  readonly expectedNormalBasis?: NormalTerminalReportBasis;
  readonly now: string;
}): TerminalReportPublication | undefined {
  if (!input.report.channelId && input.report.source.kind !== "workflow" && input.report.threadId
    && input.store.getLingThread(input.report.threadId)?.kind === "conversation") {
    return publishNormalTerminalReport(input);
  }
  if (!input.report.channelId || !input.report.sourceMessageId) {
    return undefined;
  }
  const sourceMessage = getChannelMessageView(input.store, input.report.sourceMessageId);
  if (!sourceMessage || sourceMessage.channelId !== input.report.channelId) {
    return undefined;
  }
  if (input.report.source.kind !== "workflow") return publishLegacyTerminalReport(input, sourceMessage);
  const workflow = input.store.getChannelWorkflow(input.report.source.id);
  const sourceTurnId = workflow?.metadata?.sourceTurnId;
  const sourceTurn = sourceTurnId ? input.store.getLingTurn(sourceTurnId) : undefined;
  const sourceItem = input.store.getConversationItem(sourceMessage.id);
  if (!workflow || !sourceTurn || sourceItem?.turnId !== sourceTurn.id || sourceItem.threadId !== sourceTurn.threadId) {
    throw new TerminalReportPublicationError("source_turn_conflict", `Workflow publication source lineage is incomplete: ${input.report.id}`);
  }
  const steps = input.store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true });
  const expectedCompletion = workflow.metadata?.requiredParticipantManifest
    ? evaluateWorkflowCompletion({ store: input.store, workflow, steps, now: input.now })
    : undefined;
  if (workflow.metadata?.requiredParticipantManifest
    && (!expectedCompletion
      || expectedCompletion.gate.status === "pending"
      || expectedCompletion.gate.basisFingerprint !== workflow.metadata.completionGate?.basisFingerprint
      || expectedCompletion.gate.status !== workflow.metadata.completionGate?.status)) {
    throw new TerminalReportPublicationError("stale_completion_basis", `Workflow completion gate is stale or unverified: ${workflow.id}`);
  }

  const supersededResultItemId = input.store.listTerminalReports({
    sourceKind: "workflow",
    sourceId: workflow.id,
    limit: 500,
  })
    .filter((record) => record.generation < (input.store.getTerminalReport(input.report.id)?.generation ?? Number.MAX_SAFE_INTEGER))
    .sort((left, right) => right.generation - left.generation)
    .map((record) => record.resultItemId)
    .find((itemId): itemId is string => Boolean(itemId));

  const resultItemId = terminalReportResultItemId(input.report.id);
  const result = input.store.commitTerminalReportPublication({
    reportId: input.report.id,
    expectedReportStatus: input.report.status,
    expectedEvidenceFingerprint: input.report.evidenceFingerprint,
    expectedWorkflowId: workflow.id,
    ...(expectedCompletion ? { expectedCompletion } : {}),
    expectedSourceTurn: {
      id: sourceTurn.id,
      status: sourceTurn.status,
      updatedAt: sourceTurn.updatedAt,
    },
    publicationItem: {
      id: resultItemId,
      channelId: workflow.channelId,
      threadId: sourceTurn.threadId,
      turnId: sourceTurn.id,
      kind: "terminal_report",
      status: "committed",
      actorType: "system",
      visibility: "channel",
      payload: {
        reportId: input.report.id,
        generation: input.store.getTerminalReport(input.report.id)?.generation ?? 1,
        sourceKind: input.report.source.kind,
        sourceId: input.report.source.id,
        evidenceFingerprint: input.report.evidenceFingerprint,
        outcomeStatus: input.report.outcome.status,
      },
      domainRefs: [
        { type: "terminal_report", id: input.report.id },
        { type: "workflow", id: workflow.id },
        { type: "conversation_item", id: sourceMessage.id },
        { type: "turn", id: sourceTurn.id },
        ...(input.linkedRunId ? [{ type: "run" as const, id: input.linkedRunId }] : []),
      ],
      idempotencyKey: `terminal-report:${input.report.id}`,
      ...(supersededResultItemId ? { supersedesItemId: supersededResultItemId } : {}),
    },
    publicationEventIdempotencyKey: `terminal-report:${input.report.id}:published`,
    now: input.now,
  });
  if (!result.ok) {
    throw new TerminalReportPublicationError(result.code, `Terminal report publication conflict: ${input.report.id}/${result.code}`);
  }
  const message = getChannelMessageView(input.store, result.item.id);
  if (!message) throw new Error(`Published TerminalReport message is not projectable: ${result.item.id}`);
  return { message, controlPlaneEvent: result.controlPlaneEvent, duplicate: result.duplicate };
}

function publishLegacyTerminalReport(
  input: {
    readonly store: RunStore;
    readonly report: TerminalReport;
    readonly linkedRunId?: string;
    readonly now: string;
  },
  sourceMessage: ChannelMessage,
): TerminalReportPublication {
  const currentRecord = input.store.getTerminalReport(input.report.id);
  if (currentRecord?.resultItemId) {
    const published = getChannelMessageView(input.store, currentRecord.resultItemId);
    if (!published) throw new Error(`Published TerminalReport result item not found: ${currentRecord.resultItemId}`);
    return { message: published, duplicate: true };
  }
  const resultItemId = terminalReportResultItemId(input.report.id);
  const sourceItem = input.store.getConversationItem(sourceMessage.id);
  if (!sourceItem?.turnId) throw new Error(`TerminalReport source Item has no Turn: ${sourceMessage.id}`);
  const existing = input.store.getConversationItem(resultItemId);
  const item = existing ?? input.store.appendConversationItem({
    id: resultItemId,
    channelId: input.report.channelId,
    threadId: sourceItem.threadId,
    turnId: sourceItem.turnId,
    kind: "terminal_report",
    status: "committed",
    actorType: "system",
    idempotencyKey: `terminal-report:${input.report.id}`,
    visibility: "channel",
    payload: {
      reportId: input.report.id,
      generation: input.store.getTerminalReport(input.report.id)?.generation ?? 1,
      sourceKind: input.report.source.kind,
      sourceId: input.report.source.id,
      evidenceFingerprint: input.report.evidenceFingerprint,
      outcomeStatus: input.report.outcome.status,
    },
    domainRefs: [
      { type: "terminal_report", id: input.report.id },
      { type: "conversation_item", id: sourceMessage.id },
      { type: "turn", id: sourceItem.turnId },
      ...(input.linkedRunId ? [{ type: "run" as const, id: input.linkedRunId }] : []),
    ],
  }, input.now);
  input.store.markTerminalReportPublished({
    reportId: input.report.id,
    messageId: item.id,
    now: input.now,
  });
  const message = getChannelMessageView(input.store, item.id);
  if (!message) throw new Error(`Published TerminalReport message is not projectable: ${item.id}`);
  return { message, duplicate: false };
}

export const publishWorkflowTerminalReport = publishTerminalReport;

export class TerminalReportPublicationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TerminalReportPublicationError";
  }
}

export function terminalReportResultItemId(reportId: string): string {
  return `result_terminal_report:${reportId}`;
}
