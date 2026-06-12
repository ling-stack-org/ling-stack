import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import type { LingInputExtractor, LingMaterializationRequest, LingMaterializationResult } from "../registry.js";

export const imageVisionExtractorV1: LingInputExtractor = {
  id: "image_vision_summary_v1",
  version: "1",
  supportedSourceKinds: ["attachment"],
  supportedContentKinds: ["vision_summary"],
  supports(input) {
    return input.sourceKind === "attachment" && input.attachment?.kind === "image";
  },
  async materialize(input) {
    return materializeImageAttachment(input);
  },
};

async function materializeImageAttachment(input: LingMaterializationRequest): Promise<LingMaterializationResult> {
  const attachment = input.attachment;
  if (!attachment) {
    return {
      status: "blocked",
      contentKind: "vision_summary",
      errorCode: "missing_attachment",
      errorMessage: "Attachment record is missing.",
    };
  }
  if (attachment.kind !== "image") {
    return {
      status: "unsupported",
      contentKind: "vision_summary",
      errorCode: "unsupported_attachment_kind",
      errorMessage: `${attachment.kind} attachment is not an image attachment.`,
    };
  }
  if (!input.attachmentsDir) {
    return {
      status: "blocked",
      contentKind: "vision_summary",
      errorCode: "missing_attachments_dir",
      errorMessage: "Attachment storage directory is not available.",
    };
  }
  if (attachment.sizeBytes > input.maxBytes) {
    return {
      status: "blocked",
      contentKind: "vision_summary",
      byteCount: attachment.sizeBytes,
      errorCode: "too_large",
      errorMessage: `Image attachment is too large for vision summary materialization (${attachment.sizeBytes} bytes).`,
    };
  }
  const absolutePath = resolveAttachmentPath(input.attachmentsDir, attachment.path);
  if (!absolutePath || !existsSync(absolutePath)) {
    return {
      status: "blocked",
      contentKind: "vision_summary",
      byteCount: attachment.sizeBytes,
      errorCode: "missing_file",
      errorMessage: "Attachment file is missing on disk.",
    };
  }
  let byteCount = attachment.sizeBytes;
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      return {
        status: "blocked",
        contentKind: "vision_summary",
        byteCount,
        errorCode: "missing_file",
        errorMessage: "Attachment path is not a regular file.",
      };
    }
    byteCount = stat.size;
  } catch (error) {
    return {
      status: "blocked",
      contentKind: "vision_summary",
      byteCount,
      errorCode: "stat_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
  if (byteCount > input.maxBytes) {
    return {
      status: "blocked",
      contentKind: "vision_summary",
      byteCount,
      errorCode: "too_large",
      errorMessage: `Image attachment is too large for vision summary materialization (${byteCount} bytes).`,
    };
  }
  if (!input.imageVisionSummarizer) {
    return {
      status: "unsupported",
      contentKind: "vision_summary",
      byteCount,
      errorCode: "no_image_vision_summarizer",
      errorMessage: "Image vision summarizer is not configured.",
    };
  }

  try {
    const summary = await input.imageVisionSummarizer({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      sourceId: input.sourceId,
      sourceFingerprint: input.sourceFingerprint,
      requestedBy: input.requestedBy,
      attachment,
      absolutePath,
      maxBytes: input.maxBytes,
      maxChars: input.maxChars,
      now: input.now,
    });
    const normalized = normalizeVisionSummary(summary.contentText);
    if (!normalized) {
      return {
        status: "unsupported",
        contentKind: "vision_summary",
        byteCount: summary.byteCount ?? byteCount,
        structuredSummary: summary.structuredSummary,
        policyDecision: summary.policyDecision,
        errorCode: "no_summary",
        errorMessage: "Image vision summarizer returned no summary text.",
      };
    }
    const contentText = normalized.slice(0, input.maxChars);
    const truncated = summary.truncated === true || normalized.length > contentText.length;
    return {
      status: "available",
      contentKind: "vision_summary",
      contentText,
      structuredSummary: summary.structuredSummary,
      byteCount: summary.byteCount ?? byteCount,
      tokenEstimate: summary.tokenEstimate ?? estimateTokens(contentText),
      truncated,
      policyDecision: summary.policyDecision,
      errorMessage: truncated ? "Image vision summary was truncated." : undefined,
    };
  } catch (error) {
    return {
      status: "blocked",
      contentKind: "vision_summary",
      byteCount,
      errorCode: "summarizer_failed",
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

function normalizeVisionSummary(value: string): string {
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
