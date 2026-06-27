import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { TextDecoder } from "node:util";
import type {
  ChannelAttachment,
  ConversationAttachment,
  PreviewContentKind,
  PreviewContentResponse,
  PreviewFileRef,
  RunArtifact,
  TeammatePrivateAttachment,
} from "@ling-stack/core";

const DEFAULT_PREVIEW_BYTES = 64 * 1024;
const MAX_PREVIEW_BYTES = 64 * 1024;

export interface BuildArtifactPreviewInput {
  readonly artifact: RunArtifact;
  readonly contentPath: string;
  readonly maxBytes?: number;
  readonly imageUrl?: string;
}

export interface BuildAttachmentPreviewInput {
  readonly attachment: ChannelAttachment | ConversationAttachment | TeammatePrivateAttachment;
  readonly contentPath: string;
  readonly maxBytes?: number;
  readonly imageUrl?: string;
}

export function normalizePreviewMaxBytes(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_PREVIEW_BYTES;
  }
  return Math.max(1, Math.min(Math.floor(value), MAX_PREVIEW_BYTES));
}

export function buildArtifactPreview(input: BuildArtifactPreviewInput): PreviewContentResponse {
  const maxBytes = normalizePreviewMaxBytes(input.maxBytes);
  const kind = inferArtifactPreviewKind(input.artifact);
  const ref: PreviewFileRef = {
    id: input.artifact.id,
    source: "artifact",
    scope: input.artifact.externalWorkId ? "external_work" : "run",
    label: input.artifact.title || basename(input.artifact.path) || input.artifact.id,
    displayPath: input.artifact.path,
    contentType: input.artifact.contentType,
    sizeBytes: input.artifact.sizeBytes,
    previewable: kind !== "unsupported",
  };

  return buildPreviewResponse({
    ref,
    kind,
    contentPath: input.contentPath,
    maxBytes,
    imageUrl: input.imageUrl,
    fileName: input.artifact.path,
    contentType: input.artifact.contentType,
  });
}

export function buildAttachmentPreview(input: BuildAttachmentPreviewInput): PreviewContentResponse {
  const maxBytes = normalizePreviewMaxBytes(input.maxBytes);
  const kind = inferAttachmentPreviewKind(input.attachment);
  const ref: PreviewFileRef = {
    id: input.attachment.id,
    source: "attachment",
    scope: "teammateId" in input.attachment
      ? "teammate_private"
      : "channelId" in input.attachment ? "channel" : "conversation",
    label: input.attachment.fileName,
    displayPath: input.attachment.fileName,
    contentType: input.attachment.contentType,
    sizeBytes: input.attachment.sizeBytes,
    previewable: kind !== "unsupported",
  };

  return buildPreviewResponse({
    ref,
    kind,
    contentPath: input.contentPath,
    maxBytes,
    imageUrl: input.imageUrl,
    fileName: input.attachment.fileName,
    contentType: input.attachment.contentType,
  });
}

function buildPreviewResponse(input: {
  readonly ref: PreviewFileRef;
  readonly kind: PreviewContentKind;
  readonly contentPath: string;
  readonly maxBytes: number;
  readonly imageUrl?: string;
  readonly fileName: string;
  readonly contentType?: string;
}): PreviewContentResponse {
  const stats = statSync(input.contentPath);
  const sizeBytes = stats.size;

  if (!stats.isFile()) {
    return {
      ref: { ...input.ref, previewable: false },
      kind: "unsupported",
      truncated: false,
      sizeBytes,
      redactionNotes: ["Preview unavailable because the content is not a file."],
    };
  }

  if (input.kind === "image") {
    return {
      ref: input.ref,
      kind: "image",
      imageUrl: input.imageUrl,
      truncated: false,
      sizeBytes,
      redactionNotes: ["Preview is read-only and not included in AI context."],
    };
  }

  if (input.kind === "pdf" || input.kind === "office" || input.kind === "unsupported") {
    return {
      ref: { ...input.ref, previewable: false },
      kind: input.kind,
      truncated: false,
      sizeBytes,
      redactionNotes: ["Preview content is not available for this file type."],
    };
  }

  const { buffer, truncated } = readPreviewBytes(input.contentPath, input.maxBytes);
  const decoded = decodeUtf8(buffer);
  if (!decoded.ok) {
    return {
      ref: { ...input.ref, previewable: false },
      kind: "unsupported",
      truncated,
      sizeBytes,
      redactionNotes: ["Preview unavailable because the content is not valid UTF-8."],
    };
  }

  const text = input.kind === "json" ? formatJsonPreview(decoded.text) : decoded.text;
  return {
    ref: input.ref,
    kind: input.kind,
    text,
    truncated,
    sizeBytes,
    redactionNotes: [
      "Preview is read-only and not included in AI context.",
      ...(truncated ? ["Preview truncated"] : []),
    ],
  };
}

function readPreviewBytes(path: string, maxBytes: number): { readonly buffer: Buffer; readonly truncated: boolean } {
  const file = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const bytesRead = readSync(file, buffer, 0, maxBytes + 1, 0);
    return {
      buffer: buffer.subarray(0, Math.min(bytesRead, maxBytes)),
      truncated: bytesRead > maxBytes,
    };
  } finally {
    closeSync(file);
  }
}

function decodeUtf8(buffer: Buffer): { readonly ok: true; readonly text: string } | { readonly ok: false } {
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
  } catch {
    return { ok: false };
  }
}

function formatJsonPreview(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function inferArtifactPreviewKind(artifact: RunArtifact): PreviewContentKind {
  if (artifact.type === "markdown") {
    return "markdown_text";
  }
  if (artifact.type === "json") {
    return "json";
  }
  if (artifact.type === "diff") {
    return "diff";
  }
  if (artifact.type === "log") {
    return "log";
  }
  if (artifact.type === "image") {
    return "image";
  }
  if (artifact.type === "video") {
    return "unsupported";
  }
  return inferTextualPreviewKind(artifact.path, artifact.contentType);
}

function inferAttachmentPreviewKind(attachment: ChannelAttachment | ConversationAttachment | TeammatePrivateAttachment): PreviewContentKind {
  if (attachment.kind === "image") {
    return "image";
  }
  if (attachment.kind === "pdf") {
    return "pdf";
  }
  if (attachment.kind === "office") {
    return "office";
  }
  return inferTextualPreviewKind(attachment.fileName, attachment.contentType);
}

function inferTextualPreviewKind(fileName: string, contentType?: string): PreviewContentKind {
  const lowerType = contentType?.toLowerCase() ?? "";
  const extension = extname(fileName).toLowerCase();
  if (lowerType.includes("json") || extension === ".json") {
    return "json";
  }
  if (lowerType.includes("markdown") || extension === ".md") {
    return "markdown_text";
  }
  if (lowerType.includes("x-diff") || extension === ".diff" || extension === ".patch") {
    return "diff";
  }
  if (extension === ".log") {
    return "log";
  }
  if (isCodeExtension(extension)) {
    return "code";
  }
  if (lowerType.startsWith("text/") || lowerType.includes("xml") || lowerType.includes("yaml") || lowerType.includes("javascript")) {
    return "plain_text";
  }
  return extension ? "plain_text" : "unsupported";
}

function isCodeExtension(extension: string): boolean {
  return [
    ".c",
    ".cc",
    ".cpp",
    ".cs",
    ".css",
    ".go",
    ".h",
    ".html",
    ".java",
    ".js",
    ".jsx",
    ".kt",
    ".mjs",
    ".py",
    ".rb",
    ".rs",
    ".sh",
    ".sql",
    ".swift",
    ".ts",
    ".tsx",
  ].includes(extension);
}
