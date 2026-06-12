import type { Channel, ChannelMessage, RunStore } from "@ling-stack/core";
import { defaultLingMaterializationBudgets } from "./budgets.js";
import { findChannelInputMaterialization, writeChannelInputMaterialization } from "./cache.js";
import { linkBodyExtractorV1 } from "./extractors/link-body.js";
import { officeExtractorV1 } from "./extractors/office.js";
import { pdfExtractorV1 } from "./extractors/pdf.js";
import { textAttachmentExtractorV1 } from "./extractors/text-attachment.js";
import { attachmentMaterializationFingerprint, linkPreviewMaterializationFingerprint } from "./fingerprints.js";
import type { LingInputExtractor, LingMaterializationFetch, LingMaterializationHostResolver } from "./registry.js";

export interface MaterializeInlineChannelInputsInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly now: string;
  readonly fetch?: LingMaterializationFetch;
  readonly resolveHostAddresses?: LingMaterializationHostResolver;
}

export async function materializeInlineChannelInputs(input: MaterializeInlineChannelInputsInput): Promise<void> {
  const materializeLinkBodies = referencesLinkBody(input.sourceMessage.body);
  const materializeDocumentAttachments = referencesDocumentOrAttachmentBody(input.sourceMessage.body);
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
    if (!materializeDocumentAttachments) {
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
  const sourceFingerprint = attachmentMaterializationFingerprint(input.attachment);
  const cached = findChannelInputMaterialization({
    store: input.store,
    channelId: input.channel.id,
    sourceKind: "attachment",
    sourceId: input.attachment.id,
    sourceFingerprint,
    extractorId: input.extractor.id,
  });
  if (cached) {
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
  });
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

function referencesDocumentOrAttachmentBody(text: string): boolean {
  const sourceHint = /(附件|文件内容|这个文件|文档|这份文档|pdf|docx|word|office|document|attached file|attachment|this file|this document)/iu;
  const actionHint = /(总结|概括|读取|读一下|提取|分析|看看|使用|根据|写进|写入|summarize|read|extract|analy[sz]e|use|write|based on|what.*about)/iu;
  return sourceHint.test(text) && actionHint.test(text);
}

function referencesLinkBody(text: string): boolean {
  return /(链接|网页|页面|网址|url|link|page|article)/iu.test(text) &&
    /(总结|概括|读取|读一下|提取|分析|看看|summarize|read|extract|analy[sz]e|what.*about)/iu.test(text);
}
