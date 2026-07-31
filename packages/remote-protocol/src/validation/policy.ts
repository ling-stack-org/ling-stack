import {
  REMOTE_CAPABILITIES_V1,
  REMOTE_CONVERSATION_KINDS_V1,
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
  if (!capabilities.includes("conversation.read")) {
    throw new RemoteProtocolError("invalid_field", "Remote policy must retain conversation.read", path);
  }
  return capabilities;
}

function validateConversationAccess(value: unknown, path: string): RemoteAccessPolicySummaryV1["conversationAccess"] {
  const record = expectRecord(value, path);
  const mode = expectEnum(record.mode, ["selected", "all_in_workspace"] as const, `${path}.mode`);
  if (mode === "selected") {
    assertStrictKeys(record, ["mode", "conversationIds"], [], path);
    const conversationIds = expectArray(record.conversationIds, `${path}.conversationIds`, expectIdentifier, {
      maxItems: REMOTE_PROTOCOL_LIMITS.maxConversationsPerSnapshot,
    });
    if (new Set(conversationIds).size !== conversationIds.length) {
      throw new RemoteProtocolError("invalid_field", "Conversation allowlist cannot contain duplicates", `${path}.conversationIds`);
    }
    return { mode, conversationIds };
  }
  assertStrictKeys(record, ["mode", "kinds"], [], path);
  const kinds = expectArray(
    record.kinds,
    `${path}.kinds`,
    (item, itemPath) => expectEnum(item, REMOTE_CONVERSATION_KINDS_V1, itemPath),
    { minItems: 1, maxItems: REMOTE_CONVERSATION_KINDS_V1.length },
  );
  if (new Set(kinds).size !== kinds.length) {
    throw new RemoteProtocolError("invalid_field", "Conversation kinds cannot contain duplicates", `${path}.kinds`);
  }
  return { mode, kinds };
}

export function validatePolicySummary(value: unknown, path: string): RemoteAccessPolicySummaryV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(
    record,
    ["version", "workspaceId", "workspaceBindingId", "policyVersion", "conversationAccess", "capabilities"],
    [],
    path,
  );
  return {
    version: expectLiteral(record.version, 1, `${path}.version`),
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    workspaceBindingId: expectIdentifier(record.workspaceBindingId, `${path}.workspaceBindingId`),
    policyVersion: expectSafeInteger(record.policyVersion, `${path}.policyVersion`, { minimum: 1 }),
    conversationAccess: validateConversationAccess(record.conversationAccess, `${path}.conversationAccess`),
    capabilities: validateCapabilities(record.capabilities, `${path}.capabilities`),
  };
}
