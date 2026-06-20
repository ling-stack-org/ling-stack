import type {
  ReplaceAiCouncilMemberInput,
  UpsertChannelCouncilPolicyInput,
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

export function parseReplaceAiCouncilMembersRequest(value: unknown): readonly ReplaceAiCouncilMemberInput[] {
  if (!isRecord(value) || !Array.isArray(value.members)) {
    throw new Error("members must be an array");
  }
  return value.members.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`members[${index}] must be an object`);
    }
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

export function parseUpsertChannelCouncilPolicyRequest(value: unknown): UpsertChannelCouncilPolicyInput {
  if (!isRecord(value)) {
    throw new Error("channel council policy request must be a JSON object");
  }
  return {
    attachedCouncilIds: readOptionalStringArray(value, "attachedCouncilIds"),
    preferredCouncilId: readNullableString(value, "preferredCouncilId"),
  };
}
