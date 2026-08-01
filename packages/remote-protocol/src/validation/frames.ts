import {
  REMOTE_CLIENT_COMMAND_TYPES_V1,
  REMOTE_PROTOCOL_LIMITS,
  REMOTE_SERVER_EVENT_TYPES_V1,
  type RemoteClientFrameV1,
  type RemoteServerFrameV1,
} from "@ling-stack/contracts";

import { RemoteProtocolError } from "../errors.js";
import { parseJsonInput } from "./json-input.js";
import { validateClientPayload, validateServerPayload } from "./payloads.js";
import {
  assertStrictKeys,
  expectIdentifier,
  expectLiteral,
  expectRecord,
  expectRfc3339,
  expectSafeInteger,
} from "./primitives.js";
import { assertExpiryWindow, type RemoteValidationClockOptions } from "./time.js";

function parseFrameRecord(input: string | Uint8Array): Record<string, unknown> {
  return expectRecord(parseJsonInput(input, REMOTE_PROTOCOL_LIMITS.maxFrameBytes), "$frame");
}

function validateFrameBase(record: Record<string, unknown>): {
  readonly version: 1;
  readonly messageId: string;
  readonly gatewayId: string;
  readonly sessionId: string;
  readonly sentAt: string;
  readonly requestId?: string;
} {
  return {
    version: expectLiteral(record.version, 1, "$frame.version"),
    messageId: expectIdentifier(record.messageId, "$frame.messageId"),
    gatewayId: expectIdentifier(record.gatewayId, "$frame.gatewayId"),
    sessionId: expectIdentifier(record.sessionId, "$frame.sessionId"),
    sentAt: expectRfc3339(record.sentAt, "$frame.sentAt"),
    ...(record.requestId === undefined ? {} : { requestId: expectIdentifier(record.requestId, "$frame.requestId") }),
  };
}

export function parseRemoteClientFrameV1(
  input: string | Uint8Array,
  options: RemoteValidationClockOptions = {},
): RemoteClientFrameV1 {
  const record = parseFrameRecord(input);
  assertStrictKeys(record, [
    "version",
    "type",
    "messageId",
    "gatewayId",
    "sessionId",
    "sentAt",
    "payload",
    "clientSeq",
    "expiresAt",
  ], ["requestId"], "$frame");
  if (typeof record.type !== "string" || !REMOTE_CLIENT_COMMAND_TYPES_V1.includes(record.type as never)) {
    throw new RemoteProtocolError("unknown_frame_type", "Client frame type is not allowed", "$frame.type");
  }
  const type = record.type as (typeof REMOTE_CLIENT_COMMAND_TYPES_V1)[number];
  const base = validateFrameBase(record);
  const clientSeq = expectSafeInteger(record.clientSeq, "$frame.clientSeq", { minimum: 1 });
  const expiresAt = expectRfc3339(record.expiresAt, "$frame.expiresAt");
  assertExpiryWindow(base.sentAt, expiresAt, REMOTE_PROTOCOL_LIMITS.maxCommandLifetimeMs, options, "$frame");
  const payload = validateClientPayload(type, record.payload, "$frame.payload");
  return {
    ...base,
    type,
    clientSeq,
    expiresAt,
    payload,
  } as RemoteClientFrameV1;
}

export function parseRemoteServerFrameV1(input: string | Uint8Array): RemoteServerFrameV1 {
  const record = parseFrameRecord(input);
  assertStrictKeys(record, [
    "version",
    "type",
    "messageId",
    "gatewayId",
    "sessionId",
    "sentAt",
    "payload",
    "streamId",
    "eventId",
    "serverSeq",
    "occurredAt",
  ], ["requestId"], "$frame");
  if (typeof record.type !== "string" || !REMOTE_SERVER_EVENT_TYPES_V1.includes(record.type as never)) {
    throw new RemoteProtocolError("unknown_frame_type", "Server frame type is not allowed", "$frame.type");
  }
  const type = record.type as (typeof REMOTE_SERVER_EVENT_TYPES_V1)[number];
  const base = validateFrameBase(record);
  return {
    ...base,
    type,
    streamId: expectIdentifier(record.streamId, "$frame.streamId"),
    eventId: expectIdentifier(record.eventId, "$frame.eventId"),
    serverSeq: expectSafeInteger(record.serverSeq, "$frame.serverSeq", { minimum: 0 }),
    occurredAt: expectRfc3339(record.occurredAt, "$frame.occurredAt"),
    payload: validateServerPayload(type, record.payload, "$frame.payload"),
  } as RemoteServerFrameV1;
}
