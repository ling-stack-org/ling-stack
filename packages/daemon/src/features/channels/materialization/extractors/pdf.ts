import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import { PDFParse } from "pdf-parse";
import type { LingInputExtractor, LingMaterializationRequest, LingMaterializationResult } from "../registry.js";

export const pdfExtractorV1: LingInputExtractor = {
  id: "pdf_text_v1",
  version: "1",
  supportedSourceKinds: ["attachment"],
  supportedContentKinds: ["pdf_text"],
  supports(input) {
    return input.sourceKind === "attachment" && input.attachment?.kind === "pdf";
  },
  async materialize(input) {
    return materializePdfAttachment(input);
  },
};

async function materializePdfAttachment(input: LingMaterializationRequest): Promise<LingMaterializationResult> {
  const attachment = input.attachment;
  if (!attachment) {
    return {
      status: "blocked",
      contentKind: "pdf_text",
      errorCode: "missing_attachment",
      errorMessage: "Attachment record is missing.",
    };
  }
  if (attachment.kind !== "pdf") {
    return {
      status: "unsupported",
      contentKind: "pdf_text",
      errorCode: "unsupported_attachment_kind",
      errorMessage: `${attachment.kind} attachment is not a PDF attachment.`,
    };
  }
  if (!input.attachmentsDir) {
    return {
      status: "blocked",
      contentKind: "pdf_text",
      errorCode: "missing_attachments_dir",
      errorMessage: "Attachment storage directory is not available.",
    };
  }
  if (attachment.sizeBytes > input.maxBytes) {
    return {
      status: "blocked",
      contentKind: "pdf_text",
      byteCount: attachment.sizeBytes,
      errorCode: "too_large",
      errorMessage: `PDF attachment is too large for text materialization (${attachment.sizeBytes} bytes).`,
    };
  }
  const absolutePath = resolveAttachmentPath(input.attachmentsDir, attachment.path);
  if (!absolutePath || !existsSync(absolutePath)) {
    return {
      status: "blocked",
      contentKind: "pdf_text",
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
        contentKind: "pdf_text",
        byteCount: bytes.byteLength,
        errorCode: "too_large",
        errorMessage: `PDF attachment is too large for text materialization (${bytes.byteLength} bytes).`,
      };
    }
    const parser = new PDFParse({ data: bytes });
    const parsed = await parser.getText().finally(async () => {
      await parser.destroy().catch(() => undefined);
    });
    const extractedText = normalizeExtractedText(parsed.text ?? "");
    if (!extractedText) {
      return {
        status: "unsupported",
        contentKind: "pdf_text",
        byteCount: bytes.byteLength,
        structuredSummary: {
          pageCount: parsed.total,
        },
        errorCode: "no_text_extracted",
        errorMessage: "No embedded PDF text was extracted.",
      };
    }
    const contentText = extractedText.slice(0, input.maxChars);
    const truncated = extractedText.length > contentText.length;
    return {
      status: "available",
      contentKind: "pdf_text",
      contentText,
      structuredSummary: {
        pageCount: parsed.total,
      },
      byteCount: bytes.byteLength,
      tokenEstimate: estimateTokens(contentText),
      truncated,
      errorMessage: truncated ? "Extracted PDF text was truncated." : undefined,
    };
  } catch (error) {
    return {
      status: "blocked",
      contentKind: "pdf_text",
      byteCount: attachment.sizeBytes,
      errorCode: "parser_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
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
