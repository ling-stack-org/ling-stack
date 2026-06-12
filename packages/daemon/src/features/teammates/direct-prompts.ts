import type { AiTeammate, TeammateDirectMessage, TeammatePrivateAttachment } from "@ling-stack/core";

export function formatTeammateDirectPrompt(
  teammate: AiTeammate,
  messages: readonly TeammateDirectMessage[],
  sourceMessage: TeammateDirectMessage,
  attachmentsById: ReadonlyMap<string, TeammatePrivateAttachment> = new Map(),
): string {
  const history = messages
    .filter((message) => message.status === "ready" && message.id !== sourceMessage.id && !isHistoricalGuidanceMessage(message))
    .slice(-20)
    .map((message) => renderDirectMessageLine(teammate, message, attachmentsById))
    .join("\n");
  const latestMessage = renderDirectMessageLine(teammate, sourceMessage, attachmentsById);
  return [
    `Teammate: ${teammate.displayName}`,
    `Role: ${teammate.roleKey}`,
    `Description: ${teammate.description}`,
    "",
    "Private conversation:",
    history || "No prior messages.",
    "",
    "Latest message to answer now:",
    latestMessage,
    "",
    "Reply to the Latest message to answer now. Use older conversation only as context.",
    "If the latest message includes attachments, this runtime currently exposes attachment metadata only, not image or file bytes. Do not infer unseen attachment contents; say that you cannot inspect the attachment content directly unless the user provides the content or enables a future vision/file-reading flow.",
  ].join("\n");
}

function isHistoricalGuidanceMessage(message: TeammateDirectMessage): boolean {
  if (message.authorType !== "system") {
    return false;
  }
  const body = message.body.trim();
  return body.startsWith("排队引导：") || body.startsWith("已停止上一条回复，并按新引导继续：");
}

function renderDirectMessageLine(
  teammate: AiTeammate,
  message: TeammateDirectMessage,
  attachmentsById: ReadonlyMap<string, TeammatePrivateAttachment>,
): string {
  const author = message.authorType === "ai-teammate"
    ? teammate.displayName
    : message.authorType === "system"
      ? "System"
      : "User";
  const body = message.body.trim() || "(no text)";
  const attachments = message.attachmentIds
    .map((attachmentId) => attachmentsById.get(attachmentId))
    .filter((attachment): attachment is TeammatePrivateAttachment => Boolean(attachment))
    .map((attachment) => `${attachment.fileName} (${attachment.kind}, ${attachment.contentType}, ${formatBytes(attachment.sizeBytes)})`);
  if (attachments.length === 0) {
    return `${author}: ${body}`;
  }
  return `${author}: ${body}\nAttachments: ${attachments.join("; ")}`;
}

function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "0 B";
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  const sizeKiB = sizeBytes / 1024;
  if (sizeKiB < 1024) {
    return `${sizeKiB.toFixed(sizeKiB >= 10 ? 0 : 1)} KiB`;
  }
  const sizeMiB = sizeKiB / 1024;
  return `${sizeMiB.toFixed(sizeMiB >= 10 ? 0 : 1)} MiB`;
}
