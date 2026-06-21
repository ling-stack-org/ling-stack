import type {
  AiCouncilRoutingMode,
  AiCouncilStatus,
  CloneAiCouncilInput,
  CreateAiCouncilInput,
  ReplaceAiCouncilMemberInput,
  UpdateAiCouncilInput,
  UpsertChannelCouncilPolicyInput,
} from "@ling-stack/core";
import {
  aiCouncilRoutingModes,
  aiCouncilStatuses,
} from "@ling-stack/core";
import {
  isRecord,
  readNullableString,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalString,
  readOptionalStringArray,
  readString,
} from "../../shared/validation.js";

const replaceAiCouncilMembersRequestKeys = new Set(["members"]);
const replaceAiCouncilMemberKeys = new Set(["teammateId", "slotKey", "label", "position", "enabled"]);
const upsertChannelCouncilPolicyKeys = new Set(["attachedCouncilIds", "preferredCouncilId"]);
const createAiCouncilRequestKeys = new Set(["displayName", "description", "routingPolicy", "members", "pinned"]);
const createAiCouncilRoutingPolicyKeys = new Set(["defaultMode", "maxActiveMembers", "notes"]);
const cloneAiCouncilRequestKeys = new Set(["displayName", "description", "pinned"]);
const updateAiCouncilRequestKeys = new Set(["displayName", "description", "status", "pinned"]);

export function parseReplaceAiCouncilMembersRequest(value: unknown): readonly ReplaceAiCouncilMemberInput[] {
  if (!isRecord(value)) {
    throw new Error("AI council members request must be a JSON object");
  }
  assertOnlySupportedKeys(value, replaceAiCouncilMembersRequestKeys, "AI council members request");
  if (!Array.isArray(value.members)) {
    throw new Error("members must be an array");
  }
  return parseAiCouncilMemberInputs(value.members);
}

export function parseCreateAiCouncilRequest(value: unknown): CreateAiCouncilInput {
  if (!isRecord(value)) {
    throw new Error("AI council create request must be a JSON object");
  }
  assertOnlySupportedKeys(value, createAiCouncilRequestKeys, "AI council create request");
  const routingPolicy = readOptionalRoutingPolicy(value);
  const members = value.members === undefined ? undefined : parseAiCouncilMemberInputs(value.members);
  return {
    displayName: readString(value, "displayName"),
    description: readOptionalString(value, "description"),
    routingPolicy,
    members,
    pinned: readOptionalBoolean(value, "pinned"),
  };
}

export function parseCloneAiCouncilRequest(value: unknown): CloneAiCouncilInput {
  if (!isRecord(value)) {
    throw new Error("AI council clone request must be a JSON object");
  }
  assertOnlySupportedKeys(value, cloneAiCouncilRequestKeys, "AI council clone request");
  return {
    displayName: readOptionalString(value, "displayName"),
    description: readOptionalString(value, "description"),
    pinned: readOptionalBoolean(value, "pinned"),
  };
}

export function parseUpdateAiCouncilRequest(value: unknown): UpdateAiCouncilInput {
  if (!isRecord(value)) {
    throw new Error("AI council update request must be a JSON object");
  }
  assertOnlySupportedKeys(value, updateAiCouncilRequestKeys, "AI council update request");
  const status = readOptionalString(value, "status");
  if (status !== undefined && !aiCouncilStatuses.includes(status as AiCouncilStatus)) {
    throw new Error(`status must be one of: ${aiCouncilStatuses.join(", ")}`);
  }
  return {
    displayName: readOptionalString(value, "displayName"),
    description: readOptionalString(value, "description"),
    status: status as UpdateAiCouncilInput["status"],
    pinned: readOptionalBoolean(value, "pinned"),
  };
}

function parseAiCouncilMemberInputs(value: unknown): readonly ReplaceAiCouncilMemberInput[] {
  if (!Array.isArray(value)) {
    throw new Error("members must be an array");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`members[${index}] must be an object`);
    }
    assertOnlySupportedKeys(item, replaceAiCouncilMemberKeys, `members[${index}]`);
    const position = readOptionalNumber(item, "position");
    if (position !== undefined && (!Number.isInteger(position) || position < 0)) {
      throw new Error(`members[${index}].position must be a non-negative integer`);
    }
    return {
      teammateId: readString(item, "teammateId"),
      slotKey: readOptionalString(item, "slotKey"),
      label: readOptionalString(item, "label"),
      position,
      enabled: readOptionalBoolean(item, "enabled"),
    };
  });
}

function readOptionalRoutingPolicy(record: Record<string, unknown>): CreateAiCouncilInput["routingPolicy"] {
  const value = record.routingPolicy;
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("routingPolicy must be an object");
  }
  assertOnlySupportedKeys(value, createAiCouncilRoutingPolicyKeys, "routingPolicy");
  const defaultMode = readOptionalString(value, "defaultMode");
  if (defaultMode !== undefined && !aiCouncilRoutingModes.includes(defaultMode as AiCouncilRoutingMode)) {
    throw new Error(`routingPolicy.defaultMode must be one of: ${aiCouncilRoutingModes.join(", ")}`);
  }
  const maxActiveMembers = readOptionalNumber(value, "maxActiveMembers");
  if (maxActiveMembers !== undefined && (!Number.isInteger(maxActiveMembers) || maxActiveMembers < 1)) {
    throw new Error("routingPolicy.maxActiveMembers must be a positive integer");
  }
  return {
    defaultMode: defaultMode as AiCouncilRoutingMode,
    maxActiveMembers,
    notes: readOptionalStringArray(value, "notes"),
  };
}

export function parseUpsertChannelCouncilPolicyRequest(value: unknown): UpsertChannelCouncilPolicyInput {
  if (!isRecord(value)) {
    throw new Error("channel council policy request must be a JSON object");
  }
  assertOnlySupportedKeys(value, upsertChannelCouncilPolicyKeys, "channel council policy request");
  return {
    attachedCouncilIds: readOptionalStringArray(value, "attachedCouncilIds"),
    preferredCouncilId: readNullableString(value, "preferredCouncilId"),
  };
}

function assertOnlySupportedKeys(
  record: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${path}.${key} is not supported`);
    }
  }
}
