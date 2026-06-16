import type { Channel, ChannelMessage, RunStore } from "@ling-stack/core";
import { defaultLingMaterializationBudgets } from "./budgets.js";
import {
  cloneChannelInputMaterializationResult,
  findAvailableChannelInputMaterializationForSource,
  findChannelInputMaterialization,
  findReusableChannelAttachmentMaterialization,
  isRetryableMaterializationFailure,
  writeChannelInputMaterialization,
} from "./cache.js";
import { imageVisionExtractorV1 } from "./extractors/image.js";
import { linkBodyExtractorV1 } from "./extractors/link-body.js";
import { officeExtractorV1 } from "./extractors/office.js";
import { pdfExtractorV1 } from "./extractors/pdf.js";
import { textAttachmentExtractorV1 } from "./extractors/text-attachment.js";
import { attachmentMaterializationFingerprintCandidates, linkPreviewMaterializationFingerprint } from "./fingerprints.js";
import type {
  LingImageVisionSummarizer,
  LingInputExtractor,
  LingMaterializationFetch,
  LingMaterializationHostResolver,
} from "./registry.js";

export interface MaterializeInlineChannelInputsInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly now: string;
  readonly fetch?: LingMaterializationFetch;
  readonly resolveHostAddresses?: LingMaterializationHostResolver;
  readonly imageVisionSummarizer?: LingImageVisionSummarizer;
}

export async function materializeInlineChannelInputs(input: MaterializeInlineChannelInputsInput): Promise<void> {
  const materializeLinkBodies = referencesLinkBody(input.sourceMessage.body);
  for (const attachmentId of input.sourceMessage.attachmentIds) {
    const attachment = input.store.getChannelAttachment(attachmentId);
    if (!attachment || attachment.channelId !== input.channel.id) {
      continue;
    }
    if (attachment.kind === "text") {
      await materializeAttachmentWithExtractor({
        ...input,
        attachment,
        extractor: textAttachmentExtractorV1,
        maxBytes: defaultLingMaterializationBudgets.textAttachmentInlineBytes,
        maxChars: defaultLingMaterializationBudgets.textAttachmentPromptChars,
      });
      continue;
    }
    if (attachment.kind === "pdf") {
      await materializeAttachmentWithExtractor({
        ...input,
        attachment,
        extractor: pdfExtractorV1,
        maxBytes: defaultLingMaterializationBudgets.pdfReadBytes,
        maxChars: defaultLingMaterializationBudgets.pdfPromptChars,
      });
      continue;
    }
    if (attachment.kind === "office") {
      await materializeAttachmentWithExtractor({
        ...input,
        attachment,
        extractor: officeExtractorV1,
        maxBytes: defaultLingMaterializationBudgets.officeReadBytes,
        maxChars: defaultLingMaterializationBudgets.officePromptChars,
      });
      continue;
    }
    if (attachment.kind === "image") {
      await materializeAttachmentWithExtractor({
        ...input,
        attachment,
        extractor: imageVisionExtractorV1,
        maxBytes: defaultLingMaterializationBudgets.imageReadBytes,
        maxChars: defaultLingMaterializationBudgets.imagePromptChars,
      });
    }
  }
  if (!materializeLinkBodies) {
    return;
  }
  for (const linkPreviewId of input.sourceMessage.linkPreviewIds) {
    const preview = input.store.getChannelLinkPreview(linkPreviewId);
    if (!preview || preview.channelId !== input.channel.id) {
      continue;
    }
    const sourceFingerprint = linkPreviewMaterializationFingerprint(preview);
    const cached = findChannelInputMaterialization({
      store: input.store,
      channelId: input.channel.id,
      sourceKind: "link_preview",
      sourceId: preview.id,
      sourceFingerprint,
      extractorId: linkBodyExtractorV1.id,
    });
    if (cached) {
      continue;
    }
    if (preview.status !== "ready") {
      continue;
    }
    const result = await linkBodyExtractorV1.materialize({
      workspaceId: preview.workspaceId,
      channelId: input.channel.id,
      sourceKind: "link_preview",
      sourceId: preview.id,
      sourceFingerprint,
      requestedBy: "turn_envelope",
      maxBytes: defaultLingMaterializationBudgets.linkBodyBytes,
      maxChars: defaultLingMaterializationBudgets.linkBodyPromptChars,
      now: input.now,
      linkPreview: preview,
      fetch: input.fetch,
      resolveHostAddresses: input.resolveHostAddresses,
      timeoutMs: defaultLingMaterializationBudgets.linkBodyTimeoutMs,
      redirectLimit: defaultLingMaterializationBudgets.linkBodyRedirects,
    });
    writeChannelInputMaterialization({
      store: input.store,
      channelId: input.channel.id,
      sourceKind: "link_preview",
      sourceId: preview.id,
      sourceFingerprint,
      extractor: linkBodyExtractorV1,
      result,
      now: input.now,
    });
  }
}

interface MaterializeAttachmentWithExtractorInput extends MaterializeInlineChannelInputsInput {
  readonly attachment: NonNullable<ReturnType<RunStore["getChannelAttachment"]>>;
  readonly extractor: LingInputExtractor;
  readonly maxBytes: number;
  readonly maxChars: number;
}

async function materializeAttachmentWithExtractor(input: MaterializeAttachmentWithExtractorInput): Promise<void> {
  const sourceFingerprints = attachmentMaterializationFingerprintCandidates(input.attachment, {
    attachmentsDir: input.store.paths.attachmentsDir,
  });
  const sourceFingerprint = sourceFingerprints[0] ?? "";
  const cached = sourceFingerprints
    .map((fingerprint) => findChannelInputMaterialization({
      store: input.store,
      channelId: input.channel.id,
      sourceKind: "attachment",
      sourceId: input.attachment.id,
      sourceFingerprint: fingerprint,
      extractorId: input.extractor.id,
    }))
    .find(Boolean) ?? findAvailableChannelInputMaterializationForSource({
      store: input.store,
      channelId: input.channel.id,
      sourceKind: "attachment",
      sourceId: input.attachment.id,
      extractorId: input.extractor.id,
    });
  if (cached) {
    return;
  }
  const reusable = findReusableChannelAttachmentMaterialization({
    store: input.store,
    channelId: input.channel.id,
    attachment: input.attachment,
    extractorId: input.extractor.id,
  });
  if (reusable) {
    writeChannelInputMaterialization({
      store: input.store,
      channelId: input.channel.id,
      sourceKind: "attachment",
      sourceId: input.attachment.id,
      sourceFingerprint,
      extractor: input.extractor,
      result: cloneChannelInputMaterializationResult(reusable),
      now: input.now,
      expiresAt: reusable.expiresAt,
    });
    return;
  }
  const result = await input.extractor.materialize({
    workspaceId: input.attachment.workspaceId,
    channelId: input.channel.id,
    sourceKind: "attachment",
    sourceId: input.attachment.id,
    sourceFingerprint,
    requestedBy: "turn_envelope",
    maxBytes: input.maxBytes,
    maxChars: input.maxChars,
    now: input.now,
    attachment: input.attachment,
    attachmentsDir: input.store.paths.attachmentsDir,
    imageVisionSummarizer: input.imageVisionSummarizer,
  });
  if (result.errorCode === "no_image_vision_summarizer") {
    return;
  }
  if (isRetryableMaterializationFailure(result)) {
    return;
  }
  writeChannelInputMaterialization({
    store: input.store,
    channelId: input.channel.id,
    sourceKind: "attachment",
    sourceId: input.attachment.id,
    sourceFingerprint,
    extractor: input.extractor,
    result,
    now: input.now,
  });
}

function referencesLinkBody(text: string): boolean {
  return /(链接|网页|页面|网址|url|link|page|article)/iu.test(text) &&
    /(总结|概括|读取|读一下|提取|分析|看看|summarize|read|extract|analy[sz]e|what.*about)/iu.test(text);
}
