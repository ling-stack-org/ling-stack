import type { SQLOutputValue } from "node:sqlite";
import {
  channelTeamEvidenceGrades,
  channelTeamEvidenceKinds,
  channelTeamEvidenceSourceRefTypes,
  channelTeamEvidenceStatuses,
  channelTeamEvidenceVisibilities,
  type ChannelTeamEvidenceGrade,
  type ChannelTeamEvidenceItem,
  type ChannelTeamEvidenceKind,
  type ChannelTeamEvidenceSourceRef,
  type ChannelTeamEvidenceSourceRefType,
  type ChannelTeamEvidenceStatus,
  type ChannelTeamEvidenceVisibility,
} from "../../channel-team-types.js";
import {
  omitUndefined,
  parseJson,
  parseJsonObject,
  parseJsonStringArray,
  readNullableNumber,
  readNullableString,
  readString,
} from "./helpers.js";

export function mapChannelTeamEvidenceItem(row: Record<string, SQLOutputValue>): ChannelTeamEvidenceItem {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    turnId: readNullableString(row, "turn_id"),
    agentId: readNullableString(row, "agent_id"),
    kind: readChannelTeamEvidenceKind(row, "kind"),
    status: readChannelTeamEvidenceStatus(row, "status"),
    visibility: readChannelTeamEvidenceVisibility(row, "visibility"),
    evidenceGrade: readNullableChannelTeamEvidenceGrade(row, "evidence_grade"),
    summary: readString(row, "summary"),
    concerns: parseJsonStringArray(readString(row, "concerns_json")),
    recommendations: parseJsonStringArray(readString(row, "recommendations_json")),
    confidence: readNullableNumber(row, "confidence"),
    sourceRefs: parseChannelTeamEvidenceSourceRefs(readString(row, "source_refs_json")),
    payload: parseJsonObject(readString(row, "payload_json")),
    expiresAt: readNullableString(row, "expires_at"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function parseChannelTeamEvidenceSourceRefs(value: string): ChannelTeamEvidenceSourceRef[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected channel team evidence source refs array from SQLite");
  }
  return parsed.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Expected channel team evidence source ref object from SQLite");
    }
    const record = item as Record<string, unknown>;
    if (!isChannelTeamEvidenceSourceRefTypeValue(record.type) || typeof record.id !== "string" || record.id.trim().length === 0) {
      throw new Error("Invalid channel team evidence source ref from SQLite");
    }
    return omitUndefined({
      type: record.type,
      id: record.id,
      label: readOptionalStringValue(record.label),
    });
  });
}

function readChannelTeamEvidenceKind(row: Record<string, SQLOutputValue>, key: string): ChannelTeamEvidenceKind {
  const value = readString(row, key);
  if (!channelTeamEvidenceKinds.includes(value as ChannelTeamEvidenceKind)) {
    throw new Error(`Expected SQLite column ${key} to be a channel team evidence kind`);
  }
  return value as ChannelTeamEvidenceKind;
}

function readChannelTeamEvidenceStatus(row: Record<string, SQLOutputValue>, key: string): ChannelTeamEvidenceStatus {
  const value = readString(row, key);
  if (!channelTeamEvidenceStatuses.includes(value as ChannelTeamEvidenceStatus)) {
    throw new Error(`Expected SQLite column ${key} to be a channel team evidence status`);
  }
  return value as ChannelTeamEvidenceStatus;
}

function readChannelTeamEvidenceVisibility(row: Record<string, SQLOutputValue>, key: string): ChannelTeamEvidenceVisibility {
  const value = readString(row, key);
  if (!channelTeamEvidenceVisibilities.includes(value as ChannelTeamEvidenceVisibility)) {
    throw new Error(`Expected SQLite column ${key} to be a channel team evidence visibility`);
  }
  return value as ChannelTeamEvidenceVisibility;
}

function readNullableChannelTeamEvidenceGrade(
  row: Record<string, SQLOutputValue>,
  key: string,
): ChannelTeamEvidenceGrade | undefined {
  const value = readNullableString(row, key);
  if (value === undefined) {
    return undefined;
  }
  if (!channelTeamEvidenceGrades.includes(value as ChannelTeamEvidenceGrade)) {
    throw new Error(`Expected SQLite column ${key} to be a channel team evidence grade`);
  }
  return value as ChannelTeamEvidenceGrade;
}

function readOptionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isChannelTeamEvidenceSourceRefTypeValue(value: unknown): value is ChannelTeamEvidenceSourceRefType {
  return typeof value === "string" && channelTeamEvidenceSourceRefTypes.includes(value as ChannelTeamEvidenceSourceRefType);
}
