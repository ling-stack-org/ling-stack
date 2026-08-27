import type { ChannelMessage, ControlPlaneEvent, RunStore, TerminalReport } from "@ling-stack/core";
import { LING_AGENT_EXECUTOR_ID } from "./ling-agent-executor.js";
import { getChannelMessageView } from "./conversation-item-messages.js";
import { evaluateWorkflowCompletion } from "./workflow-completion-gate.js";

export interface TerminalReportPublication {
  readonly message: ChannelMessage;
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
  readonly now: string;
}): TerminalReportPublication | undefined {
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

  const supersededMessageId = input.store.listTerminalReports({
    sourceKind: "workflow",
    sourceId: workflow.id,
    limit: 500,
  })
    .filter((record) => record.generation < (input.store.getTerminalReport(input.report.id)?.generation ?? Number.MAX_SAFE_INTEGER))
    .sort((left, right) => right.generation - left.generation)
    .map((record) => record.publishedMessageId)
    .find((messageId): messageId is string => Boolean(messageId));

  const messageId = terminalReportMessageId(input.report.id);
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
      id: messageId,
      channelId: workflow.channelId,
      threadId: sourceTurn.threadId,
      turnId: sourceTurn.id,
      kind: "assistant_message",
      status: "committed",
      actorType: "ling_agent",
      actorId: LING_AGENT_EXECUTOR_ID,
      visibility: "channel",
      payload: {
        body: renderTerminalReportMarkdown(input.report),
        format: "markdown",
        streaming: false,
        deliveryStatus: "ready",
      },
      domainRefs: [
        { type: "terminal_report", id: input.report.id },
        { type: "workflow", id: workflow.id },
        { type: "conversation_item", id: sourceMessage.id },
        { type: "turn", id: sourceTurn.id },
        ...(input.linkedRunId ? [{ type: "run" as const, id: input.linkedRunId }] : []),
      ],
      idempotencyKey: `terminal-report:${input.report.id}`,
      ...(supersededMessageId ? { supersedesItemId: supersededMessageId } : {}),
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
  if (currentRecord?.publishedMessageId) {
    const published = getChannelMessageView(input.store, currentRecord.publishedMessageId);
    if (!published) throw new Error(`Published TerminalReport message not found: ${currentRecord.publishedMessageId}`);
    return { message: published, duplicate: true };
  }
  const messageId = terminalReportMessageId(input.report.id);
  const sourceItem = input.store.getConversationItem(sourceMessage.id);
  if (!sourceItem?.turnId) throw new Error(`TerminalReport source Item has no Turn: ${sourceMessage.id}`);
  const existing = input.store.getConversationItem(messageId);
  const item = existing ?? input.store.appendConversationItem({
    id: messageId,
    channelId: input.report.channelId,
    threadId: sourceItem.threadId,
    turnId: sourceItem.turnId,
    kind: "assistant_message",
    status: "committed",
    actorType: "ling_agent",
    idempotencyKey: `terminal-report:${input.report.id}`,
    actorId: LING_AGENT_EXECUTOR_ID,
    visibility: "channel",
    payload: { body: renderTerminalReportMarkdown(input.report), format: "markdown", streaming: false, deliveryStatus: "ready" },
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

export function renderTerminalReportMarkdown(report: TerminalReport): string {
  const zh = report.language === "zh-CN";
  const sections: string[] = [
    `**${report.outcome.title}**`,
    report.outcome.summary,
  ];
  if (report.changes.length > 0) {
    sections.push(
      zh ? "**主要改动**" : "**Changes**",
      ...report.changes.map((change) => `- ${change.summary}`),
    );
  }
  if (report.verification.length > 0) {
    sections.push(
      zh ? "**验证**" : "**Verification**",
      ...report.verification.map((verification) => {
        const status = verificationStatusLabel(verification.status, zh);
        const command = verification.command ? ` · \`${verification.command}\`` : "";
        return `- ${status} ${verification.title}${command}`;
      }),
    );
  }
  if (report.participants.length > 0) {
    sections.push(
      zh ? "**参与 Agent**" : "**Participants**",
      ...report.participants.map((participant) => `- **${participant.displayName}**：${participant.contribution}`),
    );
  }
  if (report.risks.length > 0) {
    sections.push(
      zh ? "**未解决事项**" : "**Open Issues**",
      ...report.risks.map((risk) => `- ${risk.summary}${risk.nextAction ? ` ${risk.nextAction}` : ""}`),
    );
  }
  return sections.join("\n\n");
}

export function terminalReportMessageId(reportId: string): string {
  return `message_${reportId}`;
}

function verificationStatusLabel(status: TerminalReport["verification"][number]["status"], zh: boolean): string {
  if (status === "passed") {
    return zh ? "已通过" : "Passed";
  }
  if (status === "failed") {
    return zh ? "失败" : "Failed";
  }
  if (status === "blocked") {
    return zh ? "受阻" : "Blocked";
  }
  if (status === "cancelled") {
    return zh ? "已取消" : "Cancelled";
  }
  if (status === "skipped") {
    return zh ? "已跳过" : "Skipped";
  }
  return zh ? "未验证" : "Unverified";
}
