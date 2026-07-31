import {
  REMOTE_PROTOCOL_LIMITS,
  type RemoteClientCommandPayloadMapV1,
  type RemoteClientCommandTypeV1,
  type RemoteStreamScopeV1,
} from "@ling-stack/contracts";

import { RemoteProtocolError } from "../errors.js";
import {
  assertStrictKeys,
  expectAvatarDataUrl,
  expectEnum,
  expectIdentifier,
  expectRecord,
  expectRfc3339,
  expectSafeInteger,
  expectString,
  validateResumeCursor,
} from "./primitives.js";

function validateStreamScope(value: unknown, path: string): RemoteStreamScopeV1 {
  const record = expectRecord(value, path);
  const kind = expectEnum(record.kind, ["workspace", "conversation"] as const, `${path}.kind`);
  if (kind === "workspace") {
    assertStrictKeys(record, ["kind", "workspaceId"], [], path);
    return {
      kind,
      workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    };
  }
  assertStrictKeys(record, ["kind", "workspaceId", "conversationId"], [], path);
  return {
    kind,
    workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
    conversationId: expectIdentifier(record.conversationId, `${path}.conversationId`),
  };
}

function validateCommandRetryWindow(issuedAt: string, retryUntil: string, path: string): void {
  const issuedAtMs = Date.parse(issuedAt);
  const retryUntilMs = Date.parse(retryUntil);
  if (
    retryUntilMs <= issuedAtMs
    || retryUntilMs - issuedAtMs > REMOTE_PROTOCOL_LIMITS.maxCommandRetryWindowMs
  ) {
    throw new RemoteProtocolError("invalid_time", "Command retry window is outside the protocol limit", path);
  }
}

export function validateClientPayload<TType extends RemoteClientCommandTypeV1>(
  type: TType,
  value: unknown,
  path: string,
): RemoteClientCommandPayloadMapV1[TType] {
  const record = expectRecord(value, path);
  let payload: RemoteClientCommandPayloadMapV1[RemoteClientCommandTypeV1];
  switch (type) {
    case "session.ping":
      assertStrictKeys(record, ["commandId", "nonce"], [], path);
      payload = {
        commandId: expectIdentifier(record.commandId, `${path}.commandId`),
        nonce: expectIdentifier(record.nonce, `${path}.nonce`),
      };
      break;
    case "stream.subscribe":
      assertStrictKeys(record, ["commandId", "scope"], ["resume"], path);
      payload = {
        commandId: expectIdentifier(record.commandId, `${path}.commandId`),
        scope: validateStreamScope(record.scope, `${path}.scope`),
        ...(record.resume === undefined ? {} : { resume: validateResumeCursor(record.resume, `${path}.resume`) }),
      };
      break;
    case "stream.unsubscribe":
      assertStrictKeys(record, ["commandId", "streamId"], [], path);
      payload = {
        commandId: expectIdentifier(record.commandId, `${path}.commandId`),
        streamId: expectIdentifier(record.streamId, `${path}.streamId`),
      };
      break;
    case "stream.ack":
      assertStrictKeys(record, ["streamId", "ackServerSeq"], [], path);
      payload = {
        streamId: expectIdentifier(record.streamId, `${path}.streamId`),
        ackServerSeq: expectSafeInteger(record.ackServerSeq, `${path}.ackServerSeq`, { minimum: 0 }),
      };
      break;
    case "snapshot.request":
      assertStrictKeys(record, ["commandId", "scope"], [], path);
      payload = {
        commandId: expectIdentifier(record.commandId, `${path}.commandId`),
        scope: validateStreamScope(record.scope, `${path}.scope`),
      };
      break;
    case "conversation.list":
    case "profile.read":
      assertStrictKeys(record, ["commandId", "workspaceId"], [], path);
      payload = {
        commandId: expectIdentifier(record.commandId, `${path}.commandId`),
        workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
      };
      break;
    case "conversation.open":
      assertStrictKeys(record, ["commandId", "workspaceId", "conversationId"], ["olderPageCursor"], path);
      payload = {
        commandId: expectIdentifier(record.commandId, `${path}.commandId`),
        workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
        conversationId: expectIdentifier(record.conversationId, `${path}.conversationId`),
        ...(record.olderPageCursor === undefined ? {} : {
          olderPageCursor: expectIdentifier(record.olderPageCursor, `${path}.olderPageCursor`),
        }),
      };
      break;
    case "conversation.send_text": {
      assertStrictKeys(
        record,
        ["commandId", "workspaceId", "conversationId", "body", "issuedAt", "retryUntil"],
        [],
        path,
      );
      const issuedAt = expectRfc3339(record.issuedAt, `${path}.issuedAt`);
      const retryUntil = expectRfc3339(record.retryUntil, `${path}.retryUntil`);
      validateCommandRetryWindow(issuedAt, retryUntil, `${path}.retryUntil`);
      payload = {
        commandId: expectIdentifier(record.commandId, `${path}.commandId`),
        workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
        conversationId: expectIdentifier(record.conversationId, `${path}.conversationId`),
        body: expectString(record.body, `${path}.body`, {
          minBytes: 1,
          maxBytes: REMOTE_PROTOCOL_LIMITS.maxTextBodyBytes,
        }),
        issuedAt,
        retryUntil,
      };
      break;
    }
    case "conversation.mark_read":
      assertStrictKeys(record, ["commandId", "workspaceId", "conversationId", "throughActivitySeq"], [], path);
      payload = {
        commandId: expectIdentifier(record.commandId, `${path}.commandId`),
        workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
        conversationId: expectIdentifier(record.conversationId, `${path}.conversationId`),
        throughActivitySeq: expectSafeInteger(record.throughActivitySeq, `${path}.throughActivitySeq`, { minimum: 0 }),
      };
      break;
    case "profile.update": {
      assertStrictKeys(record, ["commandId", "workspaceId"], ["displayName", "avatarDataUrl"], path);
      if (record.displayName === undefined && record.avatarDataUrl === undefined) {
        throw new RemoteProtocolError("invalid_field", "Profile update must include an editable field", path);
      }
      payload = {
        commandId: expectIdentifier(record.commandId, `${path}.commandId`),
        workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
        ...(record.displayName === undefined ? {} : {
          displayName: expectString(record.displayName, `${path}.displayName`, {
            minBytes: 1,
            maxBytes: REMOTE_PROTOCOL_LIMITS.maxDisplayNameBytes,
          }),
        }),
        ...(record.avatarDataUrl === undefined
          ? {}
          : { avatarDataUrl: record.avatarDataUrl === null ? null : expectAvatarDataUrl(record.avatarDataUrl, `${path}.avatarDataUrl`) }),
      };
      break;
    }
  }
  return payload as RemoteClientCommandPayloadMapV1[TType];
}
