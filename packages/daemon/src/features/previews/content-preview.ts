import { closeSync, createReadStream, openSync, readSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
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
import { HTML_INTERACTIVE_MAX_BYTES, HTML_INTERACTIVE_SANDBOX, injectInteractiveHtmlCsp, scanInteractiveHtml } from "@ling-stack/core";
import { defaultLingMaterializationBudgets } from "../channels/materialization/budgets.js";
import { officeExtractorV1 } from "../channels/materialization/extractors/office.js";
import { pdfExtractorV1 } from "../channels/materialization/extractors/pdf.js";
import { extractSpreadsheetSheetNamesSync } from "../deliverables/spreadsheet-manifest.js";

const DEFAULT_PREVIEW_BYTES = 64 * 1024;
const MAX_PREVIEW_BYTES = 64 * 1024;

export interface BuildArtifactPreviewInput {
  readonly artifact: RunArtifact;
  readonly contentPath: string;
  /** Already verified bytes; never reopen the path after a security-sensitive read. */
  readonly content?: Buffer;
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

export interface BuildWorkspaceFilePreviewInput {
  readonly contentPath: string;
  readonly displayPath: string;
  readonly maxBytes?: number;
  readonly focusLine?: number;
}

export function normalizePreviewMaxBytes(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_PREVIEW_BYTES;
  }
  return Math.max(1, Math.min(Math.floor(value), MAX_PREVIEW_BYTES));
}

export function buildArtifactPreview(input: BuildArtifactPreviewInput): PreviewContentResponse {
  const kind = inferArtifactPreviewKind(input.artifact);
  // Interactive HTML needs the contract size cap, not the 64 KB text budget.
  const maxBytes = kind === "html_interactive" ? HTML_INTERACTIVE_MAX_BYTES : normalizePreviewMaxBytes(input.maxBytes);
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
    content: input.content,
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

export async function buildWorkspaceFilePreview(input: BuildWorkspaceFilePreviewInput): Promise<PreviewContentResponse> {
  const maxBytes = normalizePreviewMaxBytes(input.maxBytes);
  // Spreadsheets render through the windowed viewer; everything else keeps
  // the textual classification. CSV stays textual until a CSV reader exists.
  const isSpreadsheet = isSpreadsheetSource(input.displayPath) && extname(input.displayPath).toLowerCase() !== ".csv";
  const inferredKind = inferTextualPreviewKind(input.displayPath);
  const kind: PreviewContentKind = isSpreadsheet ? "spreadsheet" : inferredKind === "unsupported" ? "plain_text" : inferredKind;
  const stats = statSync(input.contentPath);
  const ref: PreviewFileRef = {
    id: `workspace:${input.displayPath}`,
    source: "workspace_file",
    scope: "workspace",
    label: basename(input.displayPath) || input.displayPath,
    displayPath: input.displayPath,
    sizeBytes: stats.size,
    previewable: true,
  };

  if (kind === "spreadsheet") {
    return {
      ref,
      kind,
      spreadsheet: extractSpreadsheetSheetNamesSync(input.contentPath, Math.max(maxBytes, 8 * 1024 * 1024)),
      truncated: false,
      sizeBytes: stats.size,
      redactionNotes: ["Preview is read-only and not included in AI context."],
    };
  }

  if (input.focusLine !== undefined && kind !== "image" && kind !== "pdf" && kind !== "office") {
    const window = await readWorkspaceTextLineWindow(input.contentPath, input.focusLine, maxBytes);
    if (!window.ok) {
      return {
        ref: { ...ref, previewable: false },
        kind: "unsupported",
        truncated: window.truncated,
        sizeBytes: stats.size,
        redactionNotes: ["Preview unavailable because the content is not valid UTF-8."],
      };
    }
    return {
      ref,
      kind,
      text: kind === "json" && window.startLine === 1 && !window.truncated ? formatJsonPreview(window.text) : window.text,
      textStartLine: window.startLine,
      truncated: window.truncated,
      sizeBytes: stats.size,
      redactionNotes: [
        "Preview is read-only and not included in AI context.",
        ...(window.truncated ? ["Preview truncated"] : []),
      ],
    };
  }

  return buildPreviewResponse({
    ref,
    kind,
    contentPath: input.contentPath,
    maxBytes,
    fileName: input.displayPath,
  });
}

async function readWorkspaceTextLineWindow(
  path: string,
  focusLine: number,
  maxBytes: number,
): Promise<
  | { readonly ok: true; readonly text: string; readonly startLine: number; readonly truncated: boolean }
  | { readonly ok: false; readonly truncated: boolean }
> {
  const startLine = Math.max(1, Math.floor(focusLine) - 90);
  const endLine = Math.max(startLine, Math.floor(focusLine) + 89);
  const selected: string[] = [];
  let selectedBytes = 0;
  let lineNumber = 0;
  let truncatedAfter = false;
  const fileStream = createReadStream(path);
  const decodedStream = Readable.from(decodeUtf8Chunks(fileStream));
  const lines = createInterface({ input: decodedStream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (lineNumber < startLine) {
        continue;
      }
      if (lineNumber > endLine) {
        truncatedAfter = true;
        break;
      }
      const nextBytes = Buffer.byteLength(line, "utf8") + (selected.length > 0 ? 1 : 0);
      if (selectedBytes + nextBytes > maxBytes) {
        truncatedAfter = true;
        break;
      }
      selected.push(line);
      selectedBytes += nextBytes;
    }
  } catch {
    return { ok: false, truncated: startLine > 1 || truncatedAfter };
  } finally {
    lines.close();
    decodedStream.destroy();
    fileStream.destroy();
  }
  return {
    ok: true,
    text: selected.join("\n"),
    startLine,
    truncated: startLine > 1 || truncatedAfter,
  };
}

async function* decodeUtf8Chunks(stream: Readable): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of stream) {
    const decoded = decoder.decode(chunk as Buffer, { stream: true });
    if (decoded) {
      yield decoded;
    }
  }
  const tail = decoder.decode();
  if (tail) {
    yield tail;
  }
}

function buildPreviewResponse(input: {
  readonly ref: PreviewFileRef;
  readonly kind: PreviewContentKind;
  readonly contentPath: string;
  readonly content?: Buffer;
  readonly maxBytes: number;
  readonly imageUrl?: string;
  readonly fileName: string;
  readonly contentType?: string;
  readonly extractedText?: string;
  readonly extractedTextTruncated?: boolean;
}): PreviewContentResponse {
  const stats = input.content ? undefined : statSync(input.contentPath);
  const sizeBytes = input.content?.length ?? stats!.size;

  if (stats && !stats.isFile()) {
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

  if (input.kind === "spreadsheet") {
    // Names only; cell contents stream through the windowed route so a large
    // workbook never crosses the wire whole.
    const workbook = extractSpreadsheetSheetNamesSync(input.contentPath, Math.max(input.maxBytes, 8 * 1024 * 1024));
    return {
      ref: input.ref,
      kind: "spreadsheet",
      spreadsheet: workbook,
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

  const { buffer, truncated } = input.content
    ? { buffer: input.content.subarray(0, input.maxBytes), truncated: input.content.length > input.maxBytes }
    : readPreviewBytes(input.contentPath, input.maxBytes);
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
  if (input.kind === "html_interactive") {
    const scan = scanInteractiveHtml(decoded.text);
    if (!scan.ok) {
      return {
        ref: { ...input.ref, previewable: false },
        kind: "code",
        text: decoded.text,
        truncated,
        sizeBytes,
        redactionNotes: [
          "Interactive preview was rejected by the safety scan.",
          ...(scan.reason ? [scan.reason] : []),
          "Rendered as source code instead.",
        ],
      };
    }
    return {
      ref: input.ref,
      kind: "html_interactive",
      htmlInteractive: { html: injectInteractiveHtmlCsp(decoded.text), sandbox: HTML_INTERACTIVE_SANDBOX },
      truncated,
      sizeBytes,
      redactionNotes: [
        "Interactive preview runs in a sandboxed frame and is not included in AI context.",
        ...(truncated ? ["Preview truncated"] : []),
      ],
    };
  }
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

function isSpreadsheetSource(fileName: string, contentType?: string): boolean {
  const lowerType = contentType?.toLowerCase() ?? "";
  if (lowerType.includes("spreadsheetml") || lowerType.includes("vnd.ms-excel") || lowerType.includes("text/csv")) return true;
  const extension = extname(fileName).toLowerCase();
  return [".xlsx", ".xlsm", ".csv"].includes(extension);
}

function inferArtifactPreviewKind(artifact: RunArtifact): PreviewContentKind {
  if (isInteractiveHtmlSource(artifact.path, artifact.contentType)) {
    return "html_interactive";
  }
  if (isSpreadsheetSource(artifact.path, artifact.contentType)) {
    return "spreadsheet";
  }
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
  if (isInteractiveHtmlSource(attachment.fileName, attachment.contentType)) {
    return "html_interactive";
  }
  if (isSpreadsheetSource(attachment.fileName, attachment.contentType)) {
    return "spreadsheet";
  }
  return inferTextualPreviewKind(attachment.fileName, attachment.contentType);
}

function isInteractiveHtmlSource(fileName: string, contentType?: string): boolean {
  const lowerType = contentType?.toLowerCase() ?? "";
  if (lowerType.includes("text/html")) return true;
  return extname(fileName).toLowerCase() === ".html" || extname(fileName).toLowerCase() === ".htm";
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
