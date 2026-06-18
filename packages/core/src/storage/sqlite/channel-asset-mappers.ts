import type { SQLOutputValue } from "node:sqlite";
import {
  type ChannelInputMaterialization,
  type LingMaterializationContentKind,
  type LingMaterializationSourceKind,
  type LingMaterializationStatus,
} from "../../input-materialization-types.js";
import {
  type ChannelAttachment,
  type ChannelAttachmentKind,
  type ChannelLinkPreview,
  type ChannelLinkPreviewStatus,
} from "../../workspace-types.js";
import {
  omitUndefined,
  parseJsonObject,
  readNullableNumber,
  readNullableString,
  readNumber,
  readString,
} from "./helpers.js";

export function mapChannelAttachment(row: Record<string, SQLOutputValue>): ChannelAttachment {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    messageId: readNullableString(row, "message_id"),
    kind: readString(row, "kind") as ChannelAttachmentKind,
    fileName: readString(row, "file_name"),
    contentType: readString(row, "content_type"),
    sizeBytes: readNumber(row, "size_bytes"),
    path: readString(row, "path"),
    createdAt: readString(row, "created_at"),
  });
}

export function mapChannelLinkPreview(row: Record<string, SQLOutputValue>): ChannelLinkPreview {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    messageId: readNullableString(row, "message_id"),
    url: readString(row, "url"),
    normalizedUrl: readString(row, "normalized_url"),
    title: readNullableString(row, "title"),
    description: readNullableString(row, "description"),
    imageUrl: readNullableString(row, "image_url"),
    siteName: readNullableString(row, "site_name"),
    status: readString(row, "status") as ChannelLinkPreviewStatus,
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapChannelInputMaterialization(row: Record<string, SQLOutputValue>): ChannelInputMaterialization {
  const structuredSummaryJson = readNullableString(row, "structured_summary_json");
  const policyDecisionJson = readNullableString(row, "policy_decision_json");
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceKind: readString(row, "source_kind") as LingMaterializationSourceKind,
    sourceId: readString(row, "source_id"),
    sourceFingerprint: readString(row, "source_fingerprint"),
    extractorId: readString(row, "extractor_id"),
    extractorVersion: readString(row, "extractor_version"),
    contentKind: readString(row, "content_kind") as LingMaterializationContentKind,
    status: readString(row, "status") as LingMaterializationStatus,
    contentText: readNullableString(row, "content_text"),
    structuredSummaryJson: structuredSummaryJson ? parseJsonObject(structuredSummaryJson) : undefined,
    byteCount: readNullableNumber(row, "byte_count"),
    tokenEstimate: readNullableNumber(row, "token_estimate"),
    truncated: readNumber(row, "truncated") === 1,
    policyDecisionJson: policyDecisionJson ? parseJsonObject(policyDecisionJson) : undefined,
    errorCode: readNullableString(row, "error_code"),
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    expiresAt: readNullableString(row, "expires_at"),
  });
}
