import {
  REMOTE_PROTOCOL_LIMITS,
  type RemoteClientCommandPayloadMapV1,
  type RemoteClientCommandTypeV1,
} from "@ling-stack/contracts";

import {
  assertStrictKeys,
  expectIdentifier,
  expectRecord,
  expectSafeInteger,
  expectString,
  validateResumeCursor,
} from "./primitives.js";

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
      assertStrictKeys(record, ["commandId", "workspaceId", "channelId"], ["resume"], path);
      payload = {
        commandId: expectIdentifier(record.commandId, `${path}.commandId`),
        workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
        channelId: expectIdentifier(record.channelId, `${path}.channelId`),
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
    case "channel.open":
      assertStrictKeys(record, ["commandId", "workspaceId", "channelId"], [], path);
      payload = {
        commandId: expectIdentifier(record.commandId, `${path}.commandId`),
        workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
        channelId: expectIdentifier(record.channelId, `${path}.channelId`),
      };
      break;
    case "channel.list":
      assertStrictKeys(record, ["commandId", "workspaceId"], [], path);
      payload = {
        commandId: expectIdentifier(record.commandId, `${path}.commandId`),
        workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
      };
      break;
    case "channel.send_text":
      assertStrictKeys(record, ["commandId", "workspaceId", "channelId", "body"], [], path);
      payload = {
        commandId: expectIdentifier(record.commandId, `${path}.commandId`),
        workspaceId: expectIdentifier(record.workspaceId, `${path}.workspaceId`),
        channelId: expectIdentifier(record.channelId, `${path}.channelId`),
        body: expectString(record.body, `${path}.body`, {
          minBytes: 1,
          maxBytes: REMOTE_PROTOCOL_LIMITS.maxTextBodyBytes,
        }),
      };
      break;
  }
  return payload as RemoteClientCommandPayloadMapV1[TType];
}
