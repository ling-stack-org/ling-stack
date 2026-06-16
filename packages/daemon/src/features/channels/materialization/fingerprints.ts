import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import type { ChannelAttachment, ChannelLinkPreview } from "@ling-stack/core";
import type { LingTurnWorkspaceFileRef } from "../ling-agent-turn-envelope.js";

export interface AttachmentMaterializationFingerprintOptions {
  readonly attachmentsDir?: string;
}

export function attachmentMaterializationFingerprint(
  attachment: ChannelAttachment,
  options?: AttachmentMaterializationFingerprintOptions,
): string {
  return attachmentMaterializationFingerprintCandidates(attachment, options)[0] ?? legacyAttachmentMaterializationFingerprint(attachment);
}

export function attachmentMaterializationFingerprintCandidates(
  attachment: ChannelAttachment,
  options?: AttachmentMaterializationFingerprintOptions,
): string[] {
  const legacy = legacyAttachmentMaterializationFingerprint(attachment);
  const contentFingerprint = options?.attachmentsDir
    ? attachmentContentMaterializationFingerprint(attachment, options.attachmentsDir)
    : undefined;
  return [...new Set([contentFingerprint, legacy].filter((value): value is string => Boolean(value)))];
}

export function attachmentContentDigest(attachment: Pick<ChannelAttachment, "path">, attachmentsDir: string): string | undefined {
  const absolutePath = resolveAttachmentPath(attachmentsDir, attachment.path);
  if (!absolutePath || !existsSync(absolutePath)) {
    return undefined;
  }
  try {
    return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  } catch {
    return undefined;
  }
}

function attachmentContentMaterializationFingerprint(attachment: ChannelAttachment, attachmentsDir: string): string | undefined {
  const digest = attachmentContentDigest(attachment, attachmentsDir);
  if (!digest) {
    return undefined;
  }
  return [
    "attachment-content",
    attachment.kind,
    attachment.sizeBytes,
    normalizeContentType(attachment.contentType),
    digest,
  ].join(":");
}

function legacyAttachmentMaterializationFingerprint(attachment: ChannelAttachment): string {
  return [
    "attachment",
    attachment.id,
    attachment.path,
    attachment.sizeBytes,
    attachment.contentType,
    attachment.createdAt,
  ].join(":");
}

function resolveAttachmentPath(attachmentsDir: string, attachmentPath: string): string | undefined {
  const absolutePath = isAbsolute(attachmentPath)
    ? resolvePath(attachmentPath)
    : resolvePath(attachmentsDir, attachmentPath);
  const relation = relativePath(resolvePath(attachmentsDir), absolutePath);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    return absolutePath;
  }
  return undefined;
}

function normalizeContentType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
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
