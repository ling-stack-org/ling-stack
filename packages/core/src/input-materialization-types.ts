import { randomUUID } from "node:crypto";

export type LingMaterializationSourceKind =
  | "attachment"
  | "link_preview"
  | "workspace_file_ref";

export type LingMaterializationContentKind =
  | "plain_text"
  | "ocr_text"
  | "vision_summary"
  | "pdf_text"
  | "office_text"
  | "html_text"
  | "metadata";

export type LingMaterializationStatus =
  | "available"
  | "metadata_only"
  | "not_loaded"
  | "unsupported"
  | "blocked";

export interface ChannelInputMaterialization {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceKind: LingMaterializationSourceKind;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly contentKind: LingMaterializationContentKind;
  readonly status: LingMaterializationStatus;
  readonly contentText?: string;
  readonly structuredSummaryJson?: Record<string, unknown>;
  readonly byteCount?: number;
  readonly tokenEstimate?: number;
  readonly truncated: boolean;
  readonly policyDecisionJson?: Record<string, unknown>;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}

export interface CreateChannelInputMaterializationInput {
  readonly channelId: string;
  readonly sourceKind: LingMaterializationSourceKind;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly contentKind: LingMaterializationContentKind;
  readonly status: LingMaterializationStatus;
  readonly contentText?: string;
  readonly structuredSummaryJson?: Record<string, unknown>;
  readonly byteCount?: number;
  readonly tokenEstimate?: number;
  readonly truncated?: boolean;
  readonly policyDecisionJson?: Record<string, unknown>;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly expiresAt?: string;
}

export interface ListChannelInputMaterializationsOptions {
  readonly channelId: string;
  readonly sourceKind?: LingMaterializationSourceKind;
  readonly sourceId?: string;
  readonly status?: LingMaterializationStatus;
  readonly limit?: number;
}

export function createChannelInputMaterializationId(): string {
  return `mat_${randomUUID()}`;
}
