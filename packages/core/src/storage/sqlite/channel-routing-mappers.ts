import type { SQLOutputValue } from "node:sqlite";
import {
  type ChannelIntentDecision,
  type ChannelIntentDecisionAction,
  type ChannelIntentDecisionStatus,
  type ChannelMessageRouteAlternative,
  type ChannelMessageRouteContextPackMetadata,
  type ChannelMessageRouteDecision,
  type ChannelMessageRouteDecisionCreatedBy,
  type ChannelMessageRouteDecisionStatus,
} from "../../workspace-types.js";
import {
  omitUndefined,
  parseJson,
  parseJsonStringArray,
  readNullableNumber,
  readNullableString,
  readNumber,
  readString,
} from "./helpers.js";

export function mapChannelMessageRouteDecision(row: Record<string, SQLOutputValue>): ChannelMessageRouteDecision {
  return omitUndefined({
    schemaVersion: readNumber(row, "schema_version") as 1,
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceMessageId: readString(row, "source_message_id"),
    replyMessageId: readNullableString(row, "reply_message_id"),
    mode: readString(row, "mode") as ChannelMessageRouteDecision["mode"],
    action: readString(row, "action") as ChannelMessageRouteDecision["action"],
    selectedTeammateId: readNullableString(row, "selected_teammate_id"),
    selectedProviderPresetId: readNullableString(row, "selected_provider_preset_id"),
    confidence: readNullableNumber(row, "confidence"),
    reason: readString(row, "reason"),
    alternativesConsidered: parseChannelMessageRouteAlternatives(readString(row, "alternatives_json")),
    contextPack: parseOptionalChannelMessageRouteContextPackMetadata(readNullableString(row, "context_pack_json")),
    status: readString(row, "status") as ChannelMessageRouteDecisionStatus,
    createdBy: readString(row, "created_by") as ChannelMessageRouteDecisionCreatedBy,
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapChannelIntentDecision(row: Record<string, SQLOutputValue>): ChannelIntentDecision {
  return omitUndefined({
    schemaVersion: readNumber(row, "schema_version") as 1,
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceMessageId: readString(row, "source_message_id"),
    action: readString(row, "action") as ChannelIntentDecisionAction,
    selectedTeammateId: readNullableString(row, "selected_teammate_id"),
    selectedTeammateIds: parseJsonStringArray(readNullableString(row, "selected_teammate_ids_json") ?? "[]"),
    proposalId: readNullableString(row, "proposal_id"),
    replyMessageId: readNullableString(row, "reply_message_id"),
    replyMessageIds: parseJsonStringArray(readNullableString(row, "reply_message_ids_json") ?? "[]"),
    workflowId: readNullableString(row, "workflow_id"),
    reason: readString(row, "reason"),
    status: readString(row, "status") as ChannelIntentDecisionStatus,
    createdBy: readString(row, "created_by") as ChannelIntentDecision["createdBy"],
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function parseChannelMessageRouteAlternatives(value: string): ChannelMessageRouteAlternative[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected channel message route alternatives array from SQLite");
  }
  return parsed.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Expected channel message route alternative object from SQLite");
    }
    const record = item as Record<string, unknown>;
    if (typeof record.label !== "string" || typeof record.reason !== "string") {
      throw new Error("Invalid channel message route alternative from SQLite");
    }
    const score = record.score;
    if (score !== undefined && typeof score !== "number") {
      throw new Error("Invalid channel message route alternative score from SQLite");
    }
    return omitUndefined({
      teammateId: readOptionalStringValue(record.teammateId),
      label: record.label,
      score,
      reason: record.reason,
    });
  });
}

function parseOptionalChannelMessageRouteContextPackMetadata(
  value: string | undefined,
): ChannelMessageRouteContextPackMetadata | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = parseJson(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.schemaVersion !== 1 ||
      typeof record.kind !== "string" ||
      !Array.isArray(record.sectionIds) ||
      record.sectionIds.some((item) => typeof item !== "string") ||
      !Array.isArray(record.droppedSectionIds) ||
      record.droppedSectionIds.some((item) => typeof item !== "string") ||
      !Array.isArray(record.compactionIds) ||
      record.compactionIds.some((item) => typeof item !== "string")
    ) {
      return undefined;
    }
    const sourceRefCounts =
      typeof record.sourceRefCounts === "object" &&
      record.sourceRefCounts !== null &&
      !Array.isArray(record.sourceRefCounts)
        ? record.sourceRefCounts as Record<string, unknown>
        : {};
    const normalizedSourceRefCounts: Record<string, number> = {};
    for (const [key, count] of Object.entries(sourceRefCounts)) {
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
        normalizedSourceRefCounts[key] = count;
      }
    }
    return omitUndefined({
      schemaVersion: 1 as const,
      kind: record.kind,
      providerPresetId: readOptionalStringValue(record.providerPresetId),
      modelId: readOptionalStringValue(record.modelId),
      sectionIds: record.sectionIds,
      droppedSectionIds: record.droppedSectionIds,
      sourceRefCounts: normalizedSourceRefCounts,
      compactionIds: record.compactionIds,
    });
  } catch {
    return undefined;
  }
}

function readOptionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
