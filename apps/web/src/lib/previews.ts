import { previewArtifactContent, previewAttachmentContent } from "../api.js";
import type { PreviewContentKind, PreviewContentResponse, RunArtifact, ChannelAttachment, ConversationAttachment, TeammatePrivateAttachment } from "../types.js";

export type PreviewRequest =
  | {
    readonly source: "artifact";
    readonly cwd: string;
    readonly artifactId: string;
    readonly maxBytes?: number;
  }
  | {
    readonly source: "attachment";
    readonly cwd: string;
    readonly attachmentId: string;
    readonly maxBytes?: number;
    readonly scope?: "channel" | "teammate_private" | "conversation";
    readonly channelId?: string;
    readonly teammateId?: string;
    readonly threadId?: string;
  };

export async function loadPreviewContent(request: PreviewRequest): Promise<PreviewContentResponse> {
  if (request.source === "artifact") {
    return previewArtifactContent(request.cwd, request.artifactId, request.maxBytes);
  }
  return previewAttachmentContent(request.cwd, request.attachmentId, {
    maxBytes: request.maxBytes,
    scope: request.scope,
    channelId: request.channelId,
    teammateId: request.teammateId,
    threadId: request.threadId,
  });
}

export function artifactCanPreview(artifact: RunArtifact): boolean {
  return artifact.type !== "video";
}

export function attachmentCanPreview(attachment: ChannelAttachment | ConversationAttachment | TeammatePrivateAttachment): boolean {
  return attachment.kind !== "office" || attachment.fileName.toLowerCase().endsWith(".docx");
}

export function previewKindLabel(kind: PreviewContentKind): string {
  if (kind === "markdown_text") {
    return "Markdown";
  }
  if (kind === "plain_text") {
    return "Text";
  }
  if (kind === "json") {
    return "JSON";
  }
  if (kind === "diff") {
    return "Diff";
  }
  if (kind === "log") {
    return "Log";
  }
  if (kind === "code") {
    return "Code";
  }
  if (kind === "image") {
    return "Image";
  }
  if (kind === "pdf") {
    return "PDF";
  }
  if (kind === "office") {
    return "Office";
  }
  return "Unsupported";
}
