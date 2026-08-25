import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import { OfficeParser } from "officeparser";
import type { LingInputExtractor, LingMaterializationRequest, LingMaterializationResult } from "../registry.js";

const SUPPORTED_OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);

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
  if (!SUPPORTED_OFFICE_EXTENSIONS.has(extension)) {
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
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile() || fileStat.size > input.maxBytes) {
      return {
        status: "blocked",
        contentKind: "office_text",
        byteCount: fileStat.size,
        errorCode: "too_large",
        errorMessage: `Office attachment is too large for text materialization (${fileStat.size} bytes).`,
      };
    }
    const result = await OfficeParser.parseOffice(absolutePath, {
      extractAttachments: false,
      includeRawContent: false,
      ocr: false,
      decompressionLimits: {
        maxUncompressedBytes: Math.min(input.maxBytes * 8, 128 * 1024 * 1024),
        maxZipEntries: 5_000,
        maxTableCells: 250_000,
      },
    });
    const extractedText = normalizeExtractedText(result.toText());
    const warningMessages = (result.warnings ?? []).slice(0, 3).map((warning) => String(warning).slice(0, 512));
    if (!extractedText) {
      return {
        status: "unsupported",
        contentKind: "office_text",
        byteCount: fileStat.size,
        structuredSummary: {
          format: extension.slice(1),
          warnings: warningMessages,
        },
        errorCode: "no_text_extracted",
        errorMessage: `No ${extension.slice(1).toUpperCase()} text was extracted.`,
      };
    }
    const contentText = extractedText.slice(0, input.maxChars);
    const truncated = extractedText.length > contentText.length;
    return {
      status: "available",
      contentKind: "office_text",
      contentText,
      structuredSummary: {
        format: extension.slice(1),
        warnings: warningMessages,
      },
      byteCount: fileStat.size,
      tokenEstimate: estimateTokens(contentText),
      truncated,
      errorMessage: truncated ? `Extracted ${extension.slice(1).toUpperCase()} text was truncated.` : undefined,
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
