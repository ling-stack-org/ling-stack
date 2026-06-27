import type { SQLOutputValue } from "node:sqlite";
import {
  channelTeamPatternCreatedByValues,
  channelTeamPatternStatuses,
  channelTeamShadowArtifactGuardrails,
  channelTeamProvisionalRuleEffects,
  type ChannelTeamPattern,
  type ChannelTeamPatternCreatedBy,
  type ChannelTeamPatternStatus,
  type ChannelTeamProvisionalRuleEffect,
} from "../../channel-team-types.js";
import {
  omitUndefined,
  readBoolean,
  readNullableString,
  readNumber,
  readString,
} from "./helpers.js";
import { parseChannelTeamEvidenceSourceRefs } from "./channel-team-evidence-mappers.js";

export function mapChannelTeamPattern(row: Record<string, SQLOutputValue>): ChannelTeamPattern {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    pattern: readString(row, "pattern"),
    summary: readString(row, "summary"),
    evidenceCount: readNumber(row, "evidence_count"),
    adoptedCount: readNumber(row, "adopted_count"),
    failureCount: readNumber(row, "failure_count"),
    sourceRefs: parseChannelTeamEvidenceSourceRefs(readString(row, "source_refs_json")),
    status: readChannelTeamPatternStatus(row, "status"),
    createdBy: readChannelTeamPatternCreatedBy(row, "created_by"),
    guardrails: channelTeamShadowArtifactGuardrails,
    provisionalEffect: readNullableChannelTeamProvisionalRuleEffect(row, "provisional_effect"),
    provisionalRationale: readNullableString(row, "provisional_rationale"),
    verifyBeforeUse: readBoolean(row, "verify_before_use"),
    supersededByPatternId: readNullableString(row, "superseded_by_pattern_id"),
    lastSeenAt: readString(row, "last_seen_at"),
    expiresAt: readNullableString(row, "expires_at"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function readChannelTeamPatternStatus(row: Record<string, SQLOutputValue>, key: string): ChannelTeamPatternStatus {
  const value = readString(row, key);
  if (!channelTeamPatternStatuses.includes(value as ChannelTeamPatternStatus)) {
    throw new Error(`Expected SQLite column ${key} to be a channel team pattern status`);
  }
  return value as ChannelTeamPatternStatus;
}

function readChannelTeamPatternCreatedBy(row: Record<string, SQLOutputValue>, key: string): ChannelTeamPatternCreatedBy {
  const value = readString(row, key);
  if (!channelTeamPatternCreatedByValues.includes(value as ChannelTeamPatternCreatedBy)) {
    throw new Error(`Expected SQLite column ${key} to be a channel team pattern creator`);
  }
  return value as ChannelTeamPatternCreatedBy;
}

function readNullableChannelTeamProvisionalRuleEffect(
  row: Record<string, SQLOutputValue>,
  key: string,
): ChannelTeamProvisionalRuleEffect | undefined {
  const value = readNullableString(row, key);
  if (value === undefined) {
    return undefined;
  }
  if (!channelTeamProvisionalRuleEffects.includes(value as ChannelTeamProvisionalRuleEffect)) {
    throw new Error(`Expected SQLite column ${key} to be a channel team provisional rule effect`);
  }
  return value as ChannelTeamProvisionalRuleEffect;
}
