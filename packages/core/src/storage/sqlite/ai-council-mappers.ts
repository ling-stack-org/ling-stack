import type { SQLOutputValue } from "node:sqlite";
import {
  aiCouncilRoutingModes,
  aiCouncilSources,
  aiCouncilStatuses,
  type AiCouncil,
  type AiCouncilGovernanceProfile,
  type AiCouncilMember,
  type AiCouncilRoutingPolicy,
  type AiCouncilSource,
  type AiCouncilStatus,
  type ChannelCouncilPolicy,
} from "../../workspace-types.js";
import {
  omitUndefined,
  parseJsonObject,
  parseJsonStringArray,
  readBoolean,
  readNullableString,
  readNumber,
  readString,
} from "./helpers.js";

export function mapAiCouncil(row: Record<string, SQLOutputValue>): AiCouncil {
  const source = readString(row, "source");
  if (!aiCouncilSources.includes(source as AiCouncilSource)) {
    throw new Error(`Expected AI council source from SQLite: ${source}`);
  }
  const status = readString(row, "status");
  if (!aiCouncilStatuses.includes(status as AiCouncilStatus)) {
    throw new Error(`Expected AI council status from SQLite: ${status}`);
  }
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    source: source as AiCouncilSource,
    templateId: readNullableString(row, "template_id"),
    displayName: readString(row, "display_name"),
    description: readString(row, "description"),
    routingPolicy: parseAiCouncilRoutingPolicy(readString(row, "routing_policy_json")),
    governanceProfile: parseAiCouncilGovernanceProfile(readString(row, "governance_profile_json")),
    status: status as AiCouncilStatus,
    pinned: readBoolean(row, "pinned"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapAiCouncilMember(row: Record<string, SQLOutputValue>): AiCouncilMember {
  return omitUndefined({
    councilId: readString(row, "council_id"),
    teammateId: readString(row, "teammate_id"),
    slotKey: readNullableString(row, "slot_key"),
    label: readNullableString(row, "label"),
    position: readNumber(row, "position"),
    enabled: readBoolean(row, "enabled"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapChannelCouncilPolicy(row: Record<string, SQLOutputValue>): ChannelCouncilPolicy {
  return omitUndefined({
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    attachedCouncilIds: parseJsonStringArray(readString(row, "attached_council_ids_json")),
    preferredCouncilId: readNullableString(row, "preferred_council_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function parseAiCouncilRoutingPolicy(value: string): AiCouncilRoutingPolicy {
  const parsed = parseJsonObject(value);
  const defaultMode = readStringField(parsed, "defaultMode");
  if (!aiCouncilRoutingModes.includes(defaultMode as AiCouncilRoutingPolicy["defaultMode"])) {
    throw new Error(`Expected AI council routing mode from SQLite: ${defaultMode}`);
  }
  const maxActiveMembers = parsed.maxActiveMembers;
  if (maxActiveMembers !== undefined && typeof maxActiveMembers !== "number") {
    throw new Error("Expected AI council maxActiveMembers to be a number");
  }
  return omitUndefined({
    defaultMode: defaultMode as AiCouncilRoutingPolicy["defaultMode"],
    maxActiveMembers,
    notes: readStringArrayField(parsed, "notes"),
  });
}

function parseAiCouncilGovernanceProfile(value: string): AiCouncilGovernanceProfile {
  const parsed = parseJsonObject(value);
  const profile: AiCouncilGovernanceProfile = {
    permissionBoundary: readExactStringField(parsed, "permissionBoundary", "restrict_only"),
    approvalBoundary: readExactStringField(parsed, "approvalBoundary", "cannot_bypass"),
    toolGrantBoundary: readExactStringField(parsed, "toolGrantBoundary", "cannot_grant"),
    credentialBoundary: readExactStringField(parsed, "credentialBoundary", "cannot_grant"),
    notes: readStringArrayField(parsed, "notes"),
  };
  return profile;
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Expected JSON field ${key} to be a string`);
  }
  return value;
}

function readExactStringField<T extends string>(record: Record<string, unknown>, key: string, expected: T): T {
  const value = readStringField(record, key);
  if (value !== expected) {
    throw new Error(`Expected JSON field ${key} to be ${expected}`);
  }
  return expected;
}

function readStringArrayField(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Expected JSON field ${key} to be a string array`);
  }
  return value as string[];
}
