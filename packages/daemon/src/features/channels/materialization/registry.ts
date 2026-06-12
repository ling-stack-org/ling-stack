import type {
  ChannelAttachment,
  ChannelLinkPreview,
  LingMaterializationContentKind,
  LingMaterializationSourceKind,
  LingMaterializationStatus,
} from "@ling-stack/core";

export type LingMaterializationFetch = typeof globalThis.fetch;
export type LingMaterializationHostResolver = (hostname: string) => Promise<readonly string[]>;

export interface LingImageVisionSummary {
  readonly contentText: string;
  readonly structuredSummary?: Record<string, unknown>;
  readonly byteCount?: number;
  readonly tokenEstimate?: number;
  readonly truncated?: boolean;
  readonly policyDecision?: Record<string, unknown>;
}

export type LingImageVisionSummarizer = (input: {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly requestedBy: "turn_envelope" | "workflow_inspection" | "user_action";
  readonly attachment: ChannelAttachment;
  readonly absolutePath: string;
  readonly maxBytes: number;
  readonly maxChars: number;
  readonly now: string;
}) => Promise<LingImageVisionSummary>;

export interface LingMaterializationRequest {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceKind: LingMaterializationSourceKind;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly requestedBy: "turn_envelope" | "workflow_inspection" | "user_action";
  readonly maxBytes: number;
  readonly maxChars: number;
  readonly now: string;
  readonly attachment?: ChannelAttachment;
  readonly attachmentsDir?: string;
  readonly linkPreview?: ChannelLinkPreview;
  readonly fetch?: LingMaterializationFetch;
  readonly resolveHostAddresses?: LingMaterializationHostResolver;
  readonly imageVisionSummarizer?: LingImageVisionSummarizer;
  readonly timeoutMs?: number;
  readonly redirectLimit?: number;
}

export interface LingMaterializationResult {
  readonly status: LingMaterializationStatus;
  readonly contentKind: LingMaterializationContentKind;
  readonly contentText?: string;
  readonly structuredSummary?: Record<string, unknown>;
  readonly byteCount?: number;
  readonly tokenEstimate?: number;
  readonly truncated?: boolean;
  readonly policyDecision?: Record<string, unknown>;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface LingInputExtractor {
  readonly id: string;
  readonly version: string;
  readonly supportedSourceKinds: readonly LingMaterializationSourceKind[];
  readonly supportedContentKinds: readonly LingMaterializationContentKind[];
  supports(input: LingMaterializationRequest): boolean;
  materialize(input: LingMaterializationRequest): Promise<LingMaterializationResult>;
}

export interface LingInputExtractorRegistry {
  readonly extractors: readonly LingInputExtractor[];
  findExtractor(input: LingMaterializationRequest): LingInputExtractor | undefined;
}

export function createLingInputExtractorRegistry(
  extractors: readonly LingInputExtractor[] = [],
): LingInputExtractorRegistry {
  return {
    extractors: [...extractors],
    findExtractor(input) {
      return extractors.find((extractor) => extractor.supports(input));
    },
  };
}
