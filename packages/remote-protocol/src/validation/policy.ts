import {
  REMOTE_CAPABILITIES_V1,
  REMOTE_PROTOCOL_LIMITS,
  type RemoteAccessPolicySummaryV1,
} from "@ling-stack/contracts";

import { RemoteProtocolError } from "../errors.js";
import {
  assertStrictKeys,
  expectArray,
  expectEnum,
  expectIdentifier,
  expectLiteral,
  expectRecord,
  expectSafeInteger,
} from "./primitives.js";

function validateCapabilities(value: unknown, path: string): readonly RemoteAccessPolicySummaryV1["capabilities"][number][] {
  const capabilities = expectArray(
    value,
    path,
    (item, itemPath) => expectEnum(item, REMOTE_CAPABILITIES_V1, itemPath),
    { maxItems: REMOTE_CAPABILITIES_V1.length },
  );
  if (new Set(capabilities).size !== capabilities.length) {
    throw new RemoteProtocolError("invalid_field", "Capabilities cannot contain duplicates", path);
  }
  if (!capabilities.includes("channel.read")) {
    throw new RemoteProtocolError("invalid_field", "Remote policy must retain channel.read", path);
  }
  return capabilities;
}

function validateChannelAccess(value: unknown, path: string): RemoteAccessPolicySummaryV1["channelAccess"] {
  const record = expectRecord(value, path);
  const mode = expectEnum(record.mode, ["selected", "all_in_workspace"] as const, `${path}.mode`);
  if (mode === "selected") {
    assertStrictKeys(record, ["mode", "channelIds"], [], path);
    const channelIds = expectArray(
      record.channelIds,
      `${path}.channelIds`,
      expectIdentifier,
      { maxItems: REMOTE_PROTOCOL_LIMITS.maxChannelsPerSnapshot },
    );
    if (new Set(channelIds).size !== channelIds.length) {
      throw new RemoteProtocolError("invalid_field", "Channel allowlist cannot contain duplicates", `${path}.channelIds`);
    }
    return { mode, channelIds };
  }
  assertStrictKeys(record, ["mode"], [], path);
  return { mode };
}

export function validatePolicySummary(value: unknown, path: string): RemoteAccessPolicySummaryV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["version", "workspaceId", "policyVersion", "channelAccess", "capabilities"], [], path);
  return {
    version: expectLiteral(record.version, 1, `${path}.version`),
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    policyVersion: expectSafeInteger(record.policyVersion, `${path}.policyVersion`, { minimum: 1 }),
    channelAccess: validateChannelAccess(record.channelAccess, `${path}.channelAccess`),
    capabilities: validateCapabilities(record.capabilities, `${path}.capabilities`),
  };
}
