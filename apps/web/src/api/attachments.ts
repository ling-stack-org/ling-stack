import type {
  ChannelAttachment,
  ChannelAttachmentListResponse,
  ChannelAttachmentMutationResponse,
  ConversationAttachment,
  PreviewContentResponse,
  TeammatePrivateAttachment,
} from "@ling-stack/contracts";
import { daemonClient } from "./client.js";
import { fileToBase64 } from "./file-uploads.js";

export async function listChannelAttachments(cwd: string, channelId: string): Promise<ChannelAttachmentListResponse> {
  return daemonClient.listChannelAttachments(cwd, channelId);
}

export async function uploadChannelAttachment(
  cwd: string,
  channelId: string,
  file: File,
  messageId?: string,
): Promise<ChannelAttachmentMutationResponse> {
  return daemonClient.createChannelAttachment(cwd, channelId, {
    fileName: file.name,
    contentType: file.type || undefined,
    contentBase64: await fileToBase64(file),
    messageId,
  });
}

export async function deleteChannelAttachment(cwd: string, attachmentId: string): Promise<void> {
  await daemonClient.deleteChannelAttachment(cwd, attachmentId);
}

export function channelAttachmentContentUrl(attachment: ChannelAttachment, cwd?: string): string {
  return daemonClient.attachmentContentUrl(attachment.id, cwd);
}

export async function deleteAttachment(cwd: string, attachmentId: string): Promise<void> {
  await daemonClient.deleteChannelAttachment(cwd, attachmentId);
}

export function attachmentContentUrl(attachment: ChannelAttachment | ConversationAttachment | TeammatePrivateAttachment, cwd?: string): string {
  return daemonClient.attachmentContentUrl(attachment.id, cwd);
}

export function attachmentContentUrlById(attachmentId: string, cwd?: string): string {
  return daemonClient.attachmentContentUrl(attachmentId, cwd);
}

export async function previewAttachmentContent(
  cwd: string,
  attachmentId: string,
  options: {
    readonly maxBytes?: number;
    readonly scope?: "channel" | "teammate_private" | "conversation";
    readonly channelId?: string;
    readonly teammateId?: string;
    readonly threadId?: string;
  } = {},
): Promise<PreviewContentResponse> {
  return daemonClient.previewAttachmentContent(cwd, attachmentId, options);
}
