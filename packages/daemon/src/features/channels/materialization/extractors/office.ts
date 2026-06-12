import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import type { LingInputExtractor, LingMaterializationRequest, LingMaterializationResult } from "../registry.js";

const require = createRequire(import.meta.url);
const mammoth = require("mammoth") as {
  readonly extractRawText: (input: { readonly buffer: Buffer }) => Promise<{
    readonly value?: string;
    readonly messages?: readonly { readonly type?: string; readonly message?: string }[];
  }>;
};

export const officeExtractorV1: LingInputExtractor = {
  id: "office_text_v1",
  version: "1",
  supportedSourceKinds: ["attachment"],
  supportedContentKinds: ["office_text"],
  supports(input) {
    return input.sourceKind === "attachment" && input.attachment?.kind === "office";
  },
  async materialize(input) {
    return materializeOfficeAttachment(input);
  },
};

async function materializeOfficeAttachment(input: LingMaterializationRequest): Promise<LingMaterializationResult> {
  const attachment = input.attachment;
  if (!attachment) {
    return {
      status: "blocked",
      contentKind: "office_text",
      errorCode: "missing_attachment",
      errorMessage: "Attachment record is missing.",
    };
  }
  if (attachment.kind !== "office") {
    return {
      status: "unsupported",
      contentKind: "office_text",
      errorCode: "unsupported_attachment_kind",
      errorMessage: `${attachment.kind} attachment is not an Office attachment.`,
    };
  }
  const extension = officeExtension(attachment.fileName);
  if (extension !== ".docx") {
    return {
      status: "unsupported",
      contentKind: "office_text",
      byteCount: attachment.sizeBytes,
      errorCode: "unsupported_office_format",
      errorMessage: `${extension || "unknown"} Office attachments are not supported by office_text_v1.`,
    };
  }
  if (!input.attachmentsDir) {
    return {
      status: "blocked",
      contentKind: "office_text",
      errorCode: "missing_attachments_dir",
      errorMessage: "Attachment storage directory is not available.",
    };
  }
  if (attachment.sizeBytes > input.maxBytes) {
    return {
      status: "blocked",
      contentKind: "office_text",
      byteCount: attachment.sizeBytes,
      errorCode: "too_large",
      errorMessage: `Office attachment is too large for text materialization (${attachment.sizeBytes} bytes).`,
    };
  }
  const absolutePath = resolveAttachmentPath(input.attachmentsDir, attachment.path);
  if (!absolutePath || !existsSync(absolutePath)) {
    return {
      status: "blocked",
      contentKind: "office_text",
      byteCount: attachment.sizeBytes,
      errorCode: "missing_file",
      errorMessage: "Attachment file is missing on disk.",
    };
  }
  try {
    const bytes = readFileSync(absolutePath);
    if (bytes.byteLength > input.maxBytes) {
      return {
        status: "blocked",
        contentKind: "office_text",
        byteCount: bytes.byteLength,
        errorCode: "too_large",
        errorMessage: `Office attachment is too large for text materialization (${bytes.byteLength} bytes).`,
      };
    }
    const result = await mammoth.extractRawText({ buffer: bytes });
    const extractedText = normalizeExtractedText(result.value ?? "");
    const warningMessages = (result.messages ?? [])
      .map((message) => message.message)
      .filter((message): message is string => Boolean(message))
      .slice(0, 3);
    if (!extractedText) {
      return {
        status: "unsupported",
        contentKind: "office_text",
        byteCount: bytes.byteLength,
        structuredSummary: {
          format: "docx",
          warnings: warningMessages,
        },
        errorCode: "no_text_extracted",
        errorMessage: "No DOCX text was extracted.",
      };
    }
    const contentText = extractedText.slice(0, input.maxChars);
    const truncated = extractedText.length > contentText.length;
    return {
      status: "available",
      contentKind: "office_text",
      contentText,
      structuredSummary: {
        format: "docx",
        warnings: warningMessages,
      },
      byteCount: bytes.byteLength,
      tokenEstimate: estimateTokens(contentText),
      truncated,
      errorMessage: truncated ? "Extracted DOCX text was truncated." : undefined,
    };
  } catch (error) {
    return {
      status: "blocked",
      contentKind: "office_text",
      byteCount: attachment.sizeBytes,
      errorCode: "parser_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function officeExtension(fileName: string): string {
  return extname(fileName).toLowerCase();
}

function resolveAttachmentPath(attachmentsDir: string, attachmentPath: string): string | undefined {
  const absolutePath = isAbsolute(attachmentPath)
    ? resolvePath(attachmentPath)
    : resolvePath(attachmentsDir, attachmentPath);
  if (!isPathInsideRoot(attachmentsDir, absolutePath)) {
    return undefined;
  }
  return absolutePath;
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relation = relativePath(resolvePath(root), resolvePath(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\u0000/gu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}
