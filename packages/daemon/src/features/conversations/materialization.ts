import type { ChannelAttachment, ConversationAttachment, RunStorePathsFacet } from "@ling-stack/core";
import { defaultLingMaterializationBudgets } from "../channels/materialization/budgets.js";
import { imageVisionExtractorV1 } from "../channels/materialization/extractors/image.js";
import { officeExtractorV1 } from "../channels/materialization/extractors/office.js";
import { pdfExtractorV1 } from "../channels/materialization/extractors/pdf.js";
import { textAttachmentExtractorV1 } from "../channels/materialization/extractors/text-attachment.js";
import type { LingImageVisionSummarizer, LingInputExtractor } from "../channels/materialization/registry.js";

export interface ConversationAttachmentMaterialization {
  readonly attachmentId: string;
  readonly fileName: string;
  readonly kind: ConversationAttachment["kind"];
  readonly contentType: string;
  readonly status: "available" | "metadata_only" | "unsupported" | "blocked";
  readonly contentText?: string;
  readonly truncated?: boolean;
}

export async function materializeInlineConversationAttachments(input: {
  readonly store: RunStorePathsFacet;
  readonly attachments: readonly ConversationAttachment[];
  readonly now: string;
  readonly imageVisionSummarizer?: LingImageVisionSummarizer;
}): Promise<ReadonlyMap<string, ConversationAttachmentMaterialization>> {
  const materializations = new Map<string, ConversationAttachmentMaterialization>();
  for (const attachment of input.attachments) {
    const extractorConfig = extractorForConversationAttachment(attachment);
    if (!extractorConfig) {
      materializations.set(attachment.id, {
        attachmentId: attachment.id,
        fileName: attachment.fileName,
        kind: attachment.kind,
        contentType: attachment.contentType,
        status: "metadata_only",
      });
      continue;
    }
    const result = await extractorConfig.extractor.materialize({
      workspaceId: attachment.workspaceId,
      channelId: conversationAttachmentMaterializationNamespace(attachment),
      sourceKind: "attachment",
      sourceId: attachment.id,
      sourceFingerprint: conversationAttachmentMaterializationFingerprint(attachment),
      requestedBy: "turn_envelope",
      maxBytes: extractorConfig.maxBytes,
      maxChars: extractorConfig.maxChars,
      now: input.now,
      attachment: conversationAttachmentAsChannelAttachment(attachment),
      attachmentsDir: input.store.paths.attachmentsDir,
      imageVisionSummarizer: input.imageVisionSummarizer,
    });
    materializations.set(attachment.id, {
      attachmentId: attachment.id,
      fileName: attachment.fileName,
      kind: attachment.kind,
      contentType: attachment.contentType,
      status: result.status === "not_loaded" ? "metadata_only" : result.status,
      contentText: result.status === "available" ? result.contentText : undefined,
      truncated: result.truncated,
    });
  }
  return materializations;
}

function extractorForConversationAttachment(
  attachment: ConversationAttachment,
): { readonly extractor: LingInputExtractor; readonly maxBytes: number; readonly maxChars: number } | undefined {
  if (attachment.kind === "text") {
    return {
      extractor: textAttachmentExtractorV1,
      maxBytes: defaultLingMaterializationBudgets.textAttachmentInlineBytes,
      maxChars: defaultLingMaterializationBudgets.textAttachmentPromptChars,
    };
  }
  if (attachment.kind === "pdf") {
    return {
      extractor: pdfExtractorV1,
      maxBytes: defaultLingMaterializationBudgets.pdfReadBytes,
      maxChars: defaultLingMaterializationBudgets.pdfPromptChars,
    };
  }
  if (attachment.kind === "office") {
    return {
      extractor: officeExtractorV1,
      maxBytes: defaultLingMaterializationBudgets.officeReadBytes,
      maxChars: defaultLingMaterializationBudgets.officePromptChars,
    };
  }
  if (attachment.kind === "image") {
    return {
      extractor: imageVisionExtractorV1,
      maxBytes: defaultLingMaterializationBudgets.imageReadBytes,
      maxChars: defaultLingMaterializationBudgets.imagePromptChars,
    };
  }
  return undefined;
}

function conversationAttachmentAsChannelAttachment(attachment: ConversationAttachment): ChannelAttachment {
  return {
    id: attachment.id,
    workspaceId: attachment.workspaceId,
    channelId: conversationAttachmentMaterializationNamespace(attachment),
    messageId: attachment.turnId,
    kind: attachment.kind,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    path: attachment.path,
    createdAt: attachment.createdAt,
  };
}

function conversationAttachmentMaterializationFingerprint(attachment: ConversationAttachment): string {
  return [
    "conversation_attachment",
    attachment.id,
    attachment.threadId ?? "",
    attachment.turnId ?? "",
    attachment.path,
    attachment.sizeBytes,
    attachment.contentType,
    attachment.createdAt,
  ].join(":");
}

function conversationAttachmentMaterializationNamespace(attachment: ConversationAttachment): string {
  return `conversation:${attachment.threadId ?? "pending"}`;
}
