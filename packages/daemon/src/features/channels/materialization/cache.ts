import type {
  ChannelInputMaterialization,
  LingMaterializationSourceKind,
  RunStore,
} from "@ling-stack/core";
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
    (!row.expiresAt || Date.parse(row.expiresAt) > now)
  );
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

export function materializationHasPromptContent(row: ChannelInputMaterialization | undefined): row is ChannelInputMaterialization {
  return Boolean(row?.status === "available" && row.contentText?.trim());
}
