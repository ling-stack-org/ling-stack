import type { ChannelMessage, RunStore, TerminalReport } from "@ling-stack/core";
import { LING_AGENT_EXECUTOR_ID } from "./ling-agent-executor.js";
import {
  appendChannelAssistantMessage,
  getChannelMessageView,
} from "./conversation-item-messages.js";

export function publishTerminalReport(input: {
  readonly store: RunStore;
  readonly report: TerminalReport;
  readonly linkedRunId?: string;
  readonly now: string;
}): ChannelMessage | undefined {
  if (!input.report.channelId || !input.report.sourceMessageId) {
    return undefined;
  }
  const sourceMessage = getChannelMessageView(input.store, input.report.sourceMessageId);
  if (!sourceMessage || sourceMessage.channelId !== input.report.channelId) {
    return undefined;
  }
  const currentRecord = input.store.getTerminalReport(input.report.id);
  if (currentRecord?.publishedMessageId) {
    return getChannelMessageView(input.store, currentRecord.publishedMessageId);
  }

  const messageId = terminalReportMessageId(input.report.id);
  const existing = getChannelMessageView(input.store, messageId);
  const message = existing ?? appendChannelAssistantMessage({
    store: input.store,
    sourceItemId: sourceMessage.id,
    itemId: messageId,
    idempotencyKey: `terminal-report:${input.report.id}`,
    actorId: LING_AGENT_EXECUTOR_ID,
    body: renderTerminalReportMarkdown(input.report),
    status: "ready",
    linkedRunId: input.linkedRunId,
    now: input.now,
  });
  input.store.markTerminalReportPublished({
    reportId: input.report.id,
    messageId: message.id,
    now: input.now,
  });
  return message;
}

export const publishWorkflowTerminalReport = publishTerminalReport;

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
