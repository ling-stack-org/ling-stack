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
import { defaultLingMaterializationBudgets } from "../channels/materialization/budgets.js";
import { officeExtractorV1 } from "../channels/materialization/extractors/office.js";
import { pdfExtractorV1 } from "../channels/materialization/extractors/pdf.js";

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
  readonly attachmentsDir: string;
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

export async function buildAttachmentPreview(input: BuildAttachmentPreviewInput): Promise<PreviewContentResponse> {
  const maxBytes = normalizePreviewMaxBytes(input.maxBytes);
  const kind = inferAttachmentPreviewKind(input.attachment);
  const extractedDocument = await extractAttachmentDocumentPreview(input, maxBytes);
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
    extractedText: extractedDocument?.text,
    extractedTextTruncated: extractedDocument?.truncated,
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
  readonly extractedText?: string;
  readonly extractedTextTruncated?: boolean;
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

  if ((input.kind === "pdf" || input.kind === "office") && input.extractedText?.trim()) {
    return {
      ref: input.ref,
      kind: input.kind,
      text: input.extractedText,
      truncated: input.extractedTextTruncated ?? false,
      sizeBytes,
      redactionNotes: [
        "Preview contains extracted document text and is not included in AI context.",
        ...(input.extractedTextTruncated ? ["Preview truncated"] : []),
      ],
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

async function extractAttachmentDocumentPreview(
  input: BuildAttachmentPreviewInput,
  maxChars: number,
): Promise<{ readonly text: string; readonly truncated: boolean } | undefined> {
  const extractor = input.attachment.kind === "pdf"
    ? pdfExtractorV1
    : input.attachment.kind === "office" && extname(input.attachment.fileName).toLowerCase() === ".docx"
      ? officeExtractorV1
      : undefined;
  if (!extractor) {
    return undefined;
  }
  const attachment = toPreviewChannelAttachment(input.attachment);
  const rawByteLimit = input.attachment.kind === "pdf"
    ? defaultLingMaterializationBudgets.pdfReadBytes
    : defaultLingMaterializationBudgets.officeReadBytes;
  const result = await extractor.materialize({
    workspaceId: attachment.workspaceId,
    channelId: attachment.channelId,
    sourceKind: "attachment",
    sourceId: attachment.id,
    sourceFingerprint: `preview:${attachment.id}:${attachment.sizeBytes}`,
    requestedBy: "turn_envelope",
    maxBytes: rawByteLimit,
    maxChars,
    now: new Date().toISOString(),
    attachment,
    attachmentsDir: input.attachmentsDir,
  });
  if (result.status !== "available" || !result.contentText?.trim()) {
    return undefined;
  }
  return {
    text: result.contentText,
    truncated: result.truncated === true,
  };
}

function toPreviewChannelAttachment(
  attachment: ChannelAttachment | ConversationAttachment | TeammatePrivateAttachment,
): ChannelAttachment {
  if ("channelId" in attachment) {
    return attachment;
  }
  const channelId = "teammateId" in attachment
    ? `teammate_direct:${attachment.teammateId}:${attachment.threadId ?? "thread"}`
    : `conversation:${attachment.threadId ?? "pending"}`;
  const messageId = "teammateId" in attachment ? attachment.messageId : attachment.turnId;
  return {
    id: attachment.id,
    workspaceId: attachment.workspaceId,
    channelId,
    messageId,
    kind: attachment.kind,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    path: attachment.path,
    createdAt: attachment.createdAt,
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
