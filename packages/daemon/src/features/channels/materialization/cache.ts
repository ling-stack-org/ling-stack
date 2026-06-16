import type {
  ChannelAttachment,
  ChannelInputMaterialization,
  LingMaterializationSourceKind,
  RunStore,
} from "@ling-stack/core";
import {
  attachmentContentDigest,
  attachmentMaterializationFingerprintCandidates,
} from "./fingerprints.js";
import type { LingInputExtractor, LingMaterializationResult } from "./registry.js";

export interface FindChannelInputMaterializationInput {
  readonly store: RunStore;
  readonly channelId: string;
  readonly sourceKind: LingMaterializationSourceKind;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly extractorId?: string;
}

export interface WriteChannelInputMaterializationInput {
  readonly store: RunStore;
  readonly channelId: string;
  readonly sourceKind: LingMaterializationSourceKind;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly extractor: Pick<LingInputExtractor, "id" | "version">;
  readonly result: LingMaterializationResult;
  readonly now: string;
  readonly expiresAt?: string;
}

export function findChannelInputMaterialization(
  input: FindChannelInputMaterializationInput,
): ChannelInputMaterialization | undefined {
  const rows = input.store.listChannelInputMaterializations({
    channelId: input.channelId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    limit: 20,
  });
  const now = Date.now();
  return rows.find((row) =>
    row.sourceFingerprint === input.sourceFingerprint &&
    (!input.extractorId || row.extractorId === input.extractorId) &&
    (!row.expiresAt || Date.parse(row.expiresAt) > now) &&
    !isRetryableMaterializationFailure(row)
  );
}

export function findAvailableChannelInputMaterializationForSource(
  input: Omit<FindChannelInputMaterializationInput, "sourceFingerprint">,
): ChannelInputMaterialization | undefined {
  const rows = input.store.listChannelInputMaterializations({
    channelId: input.channelId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    status: "available",
    limit: 20,
  });
  const now = Date.now();
  return rows.find((row) =>
    (!input.extractorId || row.extractorId === input.extractorId) &&
    (!row.expiresAt || Date.parse(row.expiresAt) > now)
  );
}

export interface FindReusableChannelAttachmentMaterializationInput {
  readonly store: RunStore;
  readonly channelId: string;
  readonly attachment: ChannelAttachment;
  readonly extractorId: string;
}

export function findReusableChannelAttachmentMaterialization(
  input: FindReusableChannelAttachmentMaterializationInput,
): ChannelInputMaterialization | undefined {
  const fingerprints = new Set(attachmentMaterializationFingerprintCandidates(input.attachment, {
    attachmentsDir: input.store.paths.attachmentsDir,
  }));
  const rows = input.store.listChannelInputMaterializations({
    channelId: input.channelId,
    sourceKind: "attachment",
    status: "available",
    limit: 500,
  });
  const now = Date.now();
  const currentDigest = attachmentContentDigest(input.attachment, input.store.paths.attachmentsDir);
  for (const row of rows) {
    if (row.extractorId !== input.extractorId || (row.expiresAt && Date.parse(row.expiresAt) <= now)) {
      continue;
    }
    if (fingerprints.has(row.sourceFingerprint)) {
      return row;
    }
    if (!currentDigest) {
      continue;
    }
    const candidate = input.store.getChannelAttachment(row.sourceId);
    if (!candidate || candidate.channelId !== input.channelId) {
      continue;
    }
    if (
      candidate.kind !== input.attachment.kind ||
      candidate.sizeBytes !== input.attachment.sizeBytes ||
      normalizeContentType(candidate.contentType) !== normalizeContentType(input.attachment.contentType)
    ) {
      continue;
    }
    if (attachmentContentDigest(candidate, input.store.paths.attachmentsDir) === currentDigest) {
      return row;
    }
  }
  return undefined;
}

export function writeChannelInputMaterialization(
  input: WriteChannelInputMaterializationInput,
): ChannelInputMaterialization {
  return input.store.createChannelInputMaterialization({
    channelId: input.channelId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourceFingerprint: input.sourceFingerprint,
    extractorId: input.extractor.id,
    extractorVersion: input.extractor.version,
    contentKind: input.result.contentKind,
    status: input.result.status,
    contentText: input.result.contentText,
    structuredSummaryJson: input.result.structuredSummary,
    byteCount: input.result.byteCount,
    tokenEstimate: input.result.tokenEstimate,
    truncated: input.result.truncated,
    policyDecisionJson: input.result.policyDecision,
    errorCode: input.result.errorCode,
    errorMessage: input.result.errorMessage,
    expiresAt: input.expiresAt,
  }, input.now);
}

export function cloneChannelInputMaterializationResult(row: ChannelInputMaterialization): LingMaterializationResult {
  return {
    status: row.status,
    contentKind: row.contentKind,
    contentText: row.contentText,
    structuredSummary: row.structuredSummaryJson,
    byteCount: row.byteCount,
    tokenEstimate: row.tokenEstimate,
    truncated: row.truncated,
    policyDecision: row.policyDecisionJson,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}

export function materializationHasPromptContent(row: ChannelInputMaterialization | undefined): row is ChannelInputMaterialization {
  return Boolean(row?.status === "available" && row.contentText?.trim());
}

export function isRetryableMaterializationFailure(
  value: Pick<ChannelInputMaterialization | LingMaterializationResult, "status" | "errorCode" | "errorMessage">,
): boolean {
  if (value.status !== "blocked" || value.errorCode !== "summarizer_failed") {
    return false;
  }
  return /(aborted|aborterror|timeout|timed out|fetch failed|network|econnreset|etimedout|eai_again|http 408|http 429|http 5\d\d)/iu
    .test(value.errorMessage ?? "");
}

function normalizeContentType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}
