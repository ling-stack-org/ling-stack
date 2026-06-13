import type { AiTeammate, TeammateDirectMessage, TeammatePrivateAttachment } from "@ling-stack/core";
import type { TeammateDirectAttachmentMaterialization } from "./direct-materialization.js";

export function formatTeammateDirectPrompt(
  teammate: AiTeammate,
  messages: readonly TeammateDirectMessage[],
  sourceMessage: TeammateDirectMessage,
  attachmentsById: ReadonlyMap<string, TeammatePrivateAttachment> = new Map(),
  materializationsByAttachmentId: ReadonlyMap<string, TeammateDirectAttachmentMaterialization> = new Map(),
): string {
  const history = messages
    .filter((message) => message.status === "ready" && message.id !== sourceMessage.id && !isHistoricalGuidanceMessage(message))
    .slice(-20)
    .map((message) => renderDirectMessageLine(teammate, message, attachmentsById, new Map()))
    .join("\n");
  const latestMessage = renderDirectMessageLine(teammate, sourceMessage, attachmentsById, materializationsByAttachmentId);
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
    "If the latest message includes attachments, use only attachment content explicitly listed under Attachment content. Metadata-only attachments do not expose their body. Do not infer unseen attachment contents, including image, PDF, Office, or file contents.",
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
  materializationsByAttachmentId: ReadonlyMap<string, TeammateDirectAttachmentMaterialization>,
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
  const attachmentContent = message.attachmentIds
    .map((attachmentId) => materializationsByAttachmentId.get(attachmentId))
    .filter(hasDirectAttachmentPromptContent)
    .map((materialization) => [
      `- ${materialization.fileName}${materialization.truncated ? " (truncated)" : ""}:`,
      materialization.contentText?.trim(),
    ].filter(Boolean).join("\n"));
  if (attachments.length === 0) {
    return `${author}: ${body}`;
  }
  return [
    `${author}: ${body}`,
    `Attachments: ${attachments.join("; ")}`,
    attachmentContent.length > 0 ? `Attachment content:\n${attachmentContent.join("\n")}` : undefined,
  ].filter(Boolean).join("\n");
}

function hasDirectAttachmentPromptContent(
  materialization: TeammateDirectAttachmentMaterialization | undefined,
): materialization is TeammateDirectAttachmentMaterialization & { readonly contentText: string } {
  return Boolean(materialization?.status === "available" && materialization.contentText?.trim());
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
