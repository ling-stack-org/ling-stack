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
} from "@ling-stack/contracts";

import { RemoteProtocolError } from "../errors.js";
import { validatePolicySummary } from "./policy.js";
import {
  validateApprovalSummary,
  validateChannelListSnapshot,
  validateChannelSnapshot,
  validateRunSummary,
  validateTranscriptDelta,
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
  expectString,
} from "./primitives.js";

function validateCommandResult(value: unknown, path: string): RemoteCommandResultV1 {
  const record = expectRecord(value, path);
  const kind = expectEnum(record.kind, [
    "pong",
    "subscribed",
    "unsubscribed",
    "snapshot_requested",
    "channel_list_requested",
    "channel_opened",
    "message_created",
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
    case "channel_list_requested":
      assertStrictKeys(record, ["kind"], [], path);
      return { kind };
    case "channel_opened":
      assertStrictKeys(record, ["kind", "channelId"], [], path);
      return { kind, channelId: expectIdentifier(record.channelId, `${path}.channelId`) };
    case "message_created":
      assertStrictKeys(record, ["kind", "messageId"], [], path);
      return { kind, messageId: expectIdentifier(record.messageId, `${path}.messageId`) };
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

function validateCommandCompleted(value: unknown, path: string): RemoteCommandCompletedV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["commandId", "commandType", "result", "completedAt"], [], path);
  const commandType = expectEnum(record.commandType, REMOTE_LIFECYCLE_COMMAND_TYPES_V1, `${path}.commandType`);
  const result = validateCommandResult(record.result, `${path}.result`);
  const expectedResultKinds: Record<RemoteLifecycleCommandTypeV1, RemoteCommandResultV1["kind"]> = {
    "session.ping": "pong",
    "stream.subscribe": "subscribed",
    "stream.unsubscribe": "unsubscribed",
    "snapshot.request": "snapshot_requested",
    "channel.list": "channel_list_requested",
    "channel.open": "channel_opened",
    "channel.send_text": "message_created",
  };
  if (result.kind !== expectedResultKinds[commandType]) {
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
    case "channel.list_snapshot":
      payload = validateChannelListSnapshot(value, path);
      break;
    case "channel.snapshot":
      payload = validateChannelSnapshot(value, path);
      break;
    case "transcript.delta":
      payload = validateTranscriptDelta(value, path);
      break;
    case "run.summary":
      payload = validateRunSummary(value, path);
      break;
    case "approval.summary":
      payload = validateApprovalSummary(value, path);
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
  }
  return payload as RemoteServerEventPayloadMapV1[TType];
}
