import {
  REMOTE_ERROR_CODES_V1,
  REMOTE_LIFECYCLE_COMMAND_TYPES_V1,
  REMOTE_PROTOCOL_LIMITS,
  type RemoteCommandAcceptedV1,
  type RemoteCommandCompletedV1,
  type RemoteCommandFailedV1,
  type RemoteCommandResultV1,
  type RemoteErrorV1,
  type RemoteLifecycleCommandTypeV1,
  type RemoteSecurityRevokedV1,
  type RemoteServerEventPayloadMapV1,
  type RemoteServerEventTypeV1,
  type RemoteSessionReadyV1,
  type RemoteStreamResyncRequiredV1,
  type RemoteWorkspaceBindingChangedV1,
} from "@ling-stack/contracts";

import { RemoteProtocolError } from "../errors.js";
import { validatePolicySummary } from "./policy.js";
import {
  validateConversationDelta,
  validateConversationListSnapshot,
  validateConversationSnapshot,
  validateUserProfile,
  validateWorkspaceSummary,
} from "./projections.js";
import {
  assertStrictKeys,
  expectBoolean,
  expectEnum,
  expectIdentifier,
  expectLiteral,
  expectRecord,
  expectRfc3339,
  expectSafeInteger,
  expectString,
} from "./primitives.js";

function validateCommandResult(value: unknown, path: string): RemoteCommandResultV1 {
  const record = expectRecord(value, path);
  const kind = expectEnum(record.kind, [
    "pong",
    "subscribed",
    "unsubscribed",
    "snapshot_requested",
    "conversation_list_requested",
    "conversation_opened",
    "message_created",
    "conversation_marked_read",
    "profile_read_requested",
    "profile_updated",
    "device_unpaired",
  ] as const, `${path}.kind`);
  switch (kind) {
    case "pong":
      assertStrictKeys(record, ["kind", "nonce"], [], path);
      return { kind, nonce: expectIdentifier(record.nonce, `${path}.nonce`) };
    case "subscribed":
      assertStrictKeys(record, ["kind", "snapshotRequired"], [], path);
      return { kind, snapshotRequired: expectBoolean(record.snapshotRequired, `${path}.snapshotRequired`) };
    case "unsubscribed":
    case "snapshot_requested":
    case "conversation_list_requested":
    case "profile_read_requested":
    case "device_unpaired":
      assertStrictKeys(record, ["kind"], [], path);
      return { kind };
    case "conversation_opened":
      assertStrictKeys(record, ["kind", "conversationId"], [], path);
      return { kind, conversationId: expectIdentifier(record.conversationId, `${path}.conversationId`) };
    case "message_created":
      assertStrictKeys(record, ["kind", "conversationId", "messageId"], [], path);
      return {
        kind,
        conversationId: expectIdentifier(record.conversationId, `${path}.conversationId`),
        messageId: expectIdentifier(record.messageId, `${path}.messageId`),
      };
    case "conversation_marked_read":
      assertStrictKeys(record, ["kind", "conversationId", "readThroughActivitySeq"], [], path);
      return {
        kind,
        conversationId: expectIdentifier(record.conversationId, `${path}.conversationId`),
        readThroughActivitySeq: expectSafeInteger(record.readThroughActivitySeq, `${path}.readThroughActivitySeq`, { minimum: 0 }),
      };
    case "profile_updated":
      assertStrictKeys(record, ["kind", "revision"], [], path);
      return { kind, revision: expectSafeInteger(record.revision, `${path}.revision`, { minimum: 0 }) };
  }
}

function validateRemoteError(value: unknown, path: string): RemoteErrorV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["code", "message", "retryable"], [], path);
  return {
    code: expectEnum(record.code, REMOTE_ERROR_CODES_V1, `${path}.code`),
    message: expectString(record.message, `${path}.message`, {
      minBytes: 1,
      maxBytes: REMOTE_PROTOCOL_LIMITS.maxSafeMessageBytes,
    }),
    retryable: expectBoolean(record.retryable, `${path}.retryable`),
  };
}

function validateSessionReady(value: unknown, path: string): RemoteSessionReadyV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["deviceId", "protocolVersion", "policy", "connectedAt"], [], path);
  return {
    deviceId: expectIdentifier(record.deviceId, `${path}.deviceId`),
    protocolVersion: expectLiteral(record.protocolVersion, 1, `${path}.protocolVersion`),
    policy: validatePolicySummary(record.policy, `${path}.policy`),
    connectedAt: expectRfc3339(record.connectedAt, `${path}.connectedAt`),
  };
}

function validateCommandAccepted(value: unknown, path: string): RemoteCommandAcceptedV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["commandId", "commandType", "acceptedAt"], [], path);
  return {
    commandId: expectIdentifier(record.commandId, `${path}.commandId`),
    commandType: expectEnum(record.commandType, REMOTE_LIFECYCLE_COMMAND_TYPES_V1, `${path}.commandType`),
    acceptedAt: expectRfc3339(record.acceptedAt, `${path}.acceptedAt`),
  };
}

const EXPECTED_RESULT_KINDS: Record<RemoteLifecycleCommandTypeV1, RemoteCommandResultV1["kind"]> = {
  "session.ping": "pong",
  "stream.subscribe": "subscribed",
  "stream.unsubscribe": "unsubscribed",
  "snapshot.request": "snapshot_requested",
  "conversation.list": "conversation_list_requested",
  "conversation.open": "conversation_opened",
  "conversation.send_text": "message_created",
  "conversation.mark_read": "conversation_marked_read",
  "profile.read": "profile_read_requested",
  "profile.update": "profile_updated",
  "security.unpair": "device_unpaired",
};

function validateCommandCompleted(value: unknown, path: string): RemoteCommandCompletedV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["commandId", "commandType", "result", "completedAt"], [], path);
  const commandType = expectEnum(record.commandType, REMOTE_LIFECYCLE_COMMAND_TYPES_V1, `${path}.commandType`);
  const result = validateCommandResult(record.result, `${path}.result`);
  if (result.kind !== EXPECTED_RESULT_KINDS[commandType]) {
    throw new RemoteProtocolError("invalid_field", "Command result does not match command type", `${path}.result.kind`);
  }
  return {
    commandId: expectIdentifier(record.commandId, `${path}.commandId`),
    commandType,
    result,
    completedAt: expectRfc3339(record.completedAt, `${path}.completedAt`),
  } as RemoteCommandCompletedV1;
}

function validateCommandFailed(value: unknown, path: string): RemoteCommandFailedV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["commandId", "commandType", "error", "failedAt"], [], path);
  return {
    commandId: expectIdentifier(record.commandId, `${path}.commandId`),
    commandType: expectEnum(record.commandType, REMOTE_LIFECYCLE_COMMAND_TYPES_V1, `${path}.commandType`),
    error: validateRemoteError(record.error, `${path}.error`),
    failedAt: expectRfc3339(record.failedAt, `${path}.failedAt`),
  } as RemoteCommandFailedV1;
}

function validateResyncRequired(value: unknown, path: string): RemoteStreamResyncRequiredV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["reason", "requiredAt"], [], path);
  return {
    reason: expectEnum(record.reason, [
      "cursor_missing",
      "cursor_stale",
      "sequence_gap",
      "buffer_overflow",
      "generation_changed",
    ] as const, `${path}.reason`),
    requiredAt: expectRfc3339(record.requiredAt, `${path}.requiredAt`),
  };
}

function validateSecurityRevoked(value: unknown, path: string): RemoteSecurityRevokedV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["reason", "revokedAt"], [], path);
  return {
    reason: expectEnum(record.reason, ["revoked", "replaced", "disabled", "identity_reset"] as const, `${path}.reason`),
    revokedAt: expectRfc3339(record.revokedAt, `${path}.revokedAt`),
  };
}

function validateBindingChanged(value: unknown, path: string): RemoteWorkspaceBindingChangedV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["previousWorkspaceBindingId", "changedAt"], ["nextWorkspaceBindingId"], path);
  return {
    previousWorkspaceBindingId: expectIdentifier(record.previousWorkspaceBindingId, `${path}.previousWorkspaceBindingId`),
    ...(record.nextWorkspaceBindingId === undefined ? {} : {
      nextWorkspaceBindingId: expectIdentifier(record.nextWorkspaceBindingId, `${path}.nextWorkspaceBindingId`),
    }),
    changedAt: expectRfc3339(record.changedAt, `${path}.changedAt`),
  };
}

export function validateServerPayload<TType extends RemoteServerEventTypeV1>(
  type: TType,
  value: unknown,
  path: string,
): RemoteServerEventPayloadMapV1[TType] {
  let payload: RemoteServerEventPayloadMapV1[RemoteServerEventTypeV1];
  switch (type) {
    case "session.ready":
      payload = validateSessionReady(value, path);
      break;
    case "workspace.summary":
      payload = validateWorkspaceSummary(value, path);
      break;
    case "conversation.list_snapshot":
      payload = validateConversationListSnapshot(value, path);
      break;
    case "conversation.snapshot":
      payload = validateConversationSnapshot(value, path);
      break;
    case "conversation.delta":
      payload = validateConversationDelta(value, path);
      break;
    case "profile.snapshot":
      payload = validateUserProfile(value, path);
      break;
    case "command.accepted":
      payload = validateCommandAccepted(value, path);
      break;
    case "command.completed":
      payload = validateCommandCompleted(value, path);
      break;
    case "command.failed":
      payload = validateCommandFailed(value, path);
      break;
    case "stream.resync_required":
      payload = validateResyncRequired(value, path);
      break;
    case "security.revoked":
      payload = validateSecurityRevoked(value, path);
      break;
    case "workspace.binding_changed":
      payload = validateBindingChanged(value, path);
      break;
  }
  return payload as RemoteServerEventPayloadMapV1[TType];
}
