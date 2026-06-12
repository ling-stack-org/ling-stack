import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import type { LingInputExtractor, LingMaterializationRequest, LingMaterializationResult } from "../registry.js";

export const textAttachmentExtractorV1: LingInputExtractor = {
  id: "text_attachment_v1",
  version: "1",
  supportedSourceKinds: ["attachment"],
  supportedContentKinds: ["plain_text"],
  supports(input) {
    return input.sourceKind === "attachment" && input.attachment?.kind === "text";
  },
  async materialize(input) {
    return materializeTextAttachment(input);
  },
};

function materializeTextAttachment(input: LingMaterializationRequest): LingMaterializationResult {
  const attachment = input.attachment;
  if (!attachment) {
    return {
      status: "blocked",
      contentKind: "plain_text",
      errorCode: "missing_attachment",
      errorMessage: "Attachment record is missing.",
    };
  }
  if (attachment.kind !== "text") {
    return {
      status: "unsupported",
      contentKind: "plain_text",
      errorCode: "unsupported_attachment_kind",
      errorMessage: `${attachment.kind} attachment is not a text attachment.`,
    };
  }
  if (!input.attachmentsDir) {
    return {
      status: "blocked",
      contentKind: "plain_text",
      errorCode: "missing_attachments_dir",
      errorMessage: "Attachment storage directory is not available.",
    };
  }
  if (attachment.sizeBytes > input.maxBytes) {
    return {
      status: "blocked",
      contentKind: "plain_text",
      byteCount: attachment.sizeBytes,
      errorCode: "too_large",
      errorMessage: `Text attachment is too large for inline materialization (${attachment.sizeBytes} bytes).`,
    };
  }
  const absolutePath = resolveAttachmentPath(input.attachmentsDir, attachment.path);
  if (!absolutePath || !existsSync(absolutePath)) {
    return {
      status: "blocked",
      contentKind: "plain_text",
      byteCount: attachment.sizeBytes,
      errorCode: "missing_file",
      errorMessage: "Attachment file is missing on disk.",
    };
  }
  try {
    const bytes = readFileSync(absolutePath);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const contentText = decoded.slice(0, input.maxChars);
    const truncated = decoded.length > contentText.length;
    return {
      status: "available",
      contentKind: "plain_text",
      contentText,
      byteCount: bytes.byteLength,
      tokenEstimate: estimateTokens(contentText),
      truncated,
      errorMessage: truncated ? "Preview was truncated." : undefined,
    };
  } catch (error) {
    return {
      status: "blocked",
      contentKind: "plain_text",
      byteCount: attachment.sizeBytes,
      errorCode: "invalid_utf8_or_read_failed",
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

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}
