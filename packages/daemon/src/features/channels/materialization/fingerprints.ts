import type { ChannelAttachment, ChannelLinkPreview } from "@ling-stack/core";
import type { LingTurnWorkspaceFileRef } from "../ling-agent-turn-envelope.js";

export function attachmentMaterializationFingerprint(attachment: ChannelAttachment): string {
  return [
    "attachment",
    attachment.id,
    attachment.path,
    attachment.sizeBytes,
    attachment.contentType,
    attachment.createdAt,
  ].join(":");
}

export function linkPreviewMaterializationFingerprint(preview: ChannelLinkPreview): string {
  return [
    "link_preview",
    preview.normalizedUrl,
    preview.status,
    preview.title ?? "",
    preview.description ?? "",
    preview.updatedAt,
  ].join(":");
}

export function workspaceFileRefMaterializationFingerprint(ref: LingTurnWorkspaceFileRef): string {
  return [
    "workspace_file_ref",
    ref.path,
    ref.rootRelation,
    ref.kind,
    ref.line ?? "",
  ].join(":");
}
