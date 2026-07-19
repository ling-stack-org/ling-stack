import {
  REMOTE_PROTOCOL_LIMITS,
  type RemoteP256PublicJwkV1,
  type RemoteResumeCursorV1,
} from "@ling-stack/contracts";
import { decodeBase64Url, encodeUtf8 } from "../canonical.js";
import { RemoteProtocolError } from "../errors.js";

export type UnknownRecord = Record<string, unknown>;

export function expectRecord(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RemoteProtocolError("invalid_field", "Expected an object", path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RemoteProtocolError("invalid_field", "Expected a plain object", path);
  }
  return value as UnknownRecord;
}

export function assertStrictKeys(
  record: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new RemoteProtocolError("invalid_field", "Object contains an unknown field", `${path}.${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      throw new RemoteProtocolError("invalid_field", "Object is missing a required field", `${path}.${key}`);
    }
  }
}

export function expectString(
  value: unknown,
  path: string,
  options: { readonly minBytes?: number; readonly maxBytes?: number } = {},
): string {
  if (typeof value !== "string") {
    throw new RemoteProtocolError("invalid_field", "Expected a string", path);
  }
  const bytes = encodeUtf8(value).length;
  if (bytes < (options.minBytes ?? 0) || bytes > (options.maxBytes ?? Number.MAX_SAFE_INTEGER)) {
    throw new RemoteProtocolError("invalid_field", "String length is outside the allowed range", path);
  }
  return value;
}

export function expectIdentifier(value: unknown, path: string): string {
  const identifier = expectString(value, path, {
    minBytes: 1,
    maxBytes: REMOTE_PROTOCOL_LIMITS.maxIdentifierBytes,
  });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(identifier)) {
    throw new RemoteProtocolError("invalid_field", "Expected an opaque identifier", path);
  }
  return identifier;
}

export function expectBase64UrlBytes(value: unknown, expectedBytes: number, path: string): string {
  const encoded = expectString(value, path, { minBytes: 1, maxBytes: expectedBytes * 2 });
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Url(encoded);
  } catch {
    throw new RemoteProtocolError("invalid_field", "Expected canonical unpadded base64url", path);
  }
  if (decoded.length !== expectedBytes) {
    throw new RemoteProtocolError("invalid_field", "Encoded value has the wrong byte length", path);
  }
  return encoded;
}

export function expectP256Coordinate(value: unknown, path: string): string {
  return expectBase64UrlBytes(value, 32, path);
}

export function expectNonce(value: unknown, path: string): string {
  return expectBase64UrlBytes(value, 32, path);
}

export function expectSha256(value: unknown, path: string): string {
  return expectBase64UrlBytes(value, 32, path);
}

/** V1 ES256 wire signatures are fixed-width IEEE P1363 r || s, not ASN.1 DER. */
export function expectEs256Signature(value: unknown, path: string): string {
  return expectBase64UrlBytes(value, 64, path);
}

export function expectRfc3339(value: unknown, path: string): string {
  const timestamp = expectString(value, path, { minBytes: 24, maxBytes: 24 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) {
    throw new RemoteProtocolError("invalid_time", "Expected canonical UTC RFC3339 milliseconds", path);
  }
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new RemoteProtocolError("invalid_time", "Timestamp is not a real UTC instant", path);
  }
  return timestamp;
}

export function expectHttpsOrigin(value: unknown, path: string): string {
  const origin = expectString(value, path, {
    minBytes: 1,
    maxBytes: REMOTE_PROTOCOL_LIMITS.maxOriginBytes,
  });
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new RemoteProtocolError("invalid_field", "Gateway origin is not a valid URL", path);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || (parsed.pathname !== "/" && parsed.pathname !== "")
    || parsed.origin !== origin.replace(/\/$/, "")
  ) {
    throw new RemoteProtocolError("invalid_field", "Gateway origin must be a bare HTTPS origin", path);
  }
  return parsed.origin;
}

export function expectSafeInteger(
  value: unknown,
  path: string,
  options: { readonly minimum?: number; readonly maximum?: number } = {},
): number {
  if (!Number.isSafeInteger(value)) {
    throw new RemoteProtocolError("invalid_field", "Expected a safe integer", path);
  }
  const integer = value as number;
  if (integer < (options.minimum ?? Number.MIN_SAFE_INTEGER) || integer > (options.maximum ?? Number.MAX_SAFE_INTEGER)) {
    throw new RemoteProtocolError("invalid_field", "Integer is outside the allowed range", path);
  }
  return integer;
}

export function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new RemoteProtocolError("invalid_field", "Expected a boolean", path);
  }
  return value;
}

export function expectLiteral<T extends string | number | boolean>(
  value: unknown,
  literal: T,
  path: string,
): T {
  if (value !== literal) {
    throw new RemoteProtocolError(
      literal === 1 && path.endsWith("version") ? "protocol_incompatible" : "invalid_field",
      "Value does not match the required protocol literal",
      path,
    );
  }
  return literal;
}

export function expectEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new RemoteProtocolError("invalid_field", "Value is not in the protocol allowlist", path);
  }
  return value as T[number];
}

export function expectArray<T>(
  value: unknown,
  path: string,
  itemValidator: (item: unknown, itemPath: string) => T,
  options: { readonly maxItems: number; readonly minItems?: number },
): readonly T[] {
  if (!Array.isArray(value)) {
    throw new RemoteProtocolError("invalid_field", "Expected an array", path);
  }
  if (value.length < (options.minItems ?? 0) || value.length > options.maxItems) {
    throw new RemoteProtocolError("invalid_field", "Array length is outside the allowed range", path);
  }
  return value.map((item, index) => itemValidator(item, `${path}[${index}]`));
}

export function validateP256PublicJwk(value: unknown, path: string): RemoteP256PublicJwkV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(record, ["kty", "crv", "x", "y"], [], path);
  return {
    kty: expectLiteral(record.kty, "EC", `${path}.kty`),
    crv: expectLiteral(record.crv, "P-256", `${path}.crv`),
    x: expectP256Coordinate(record.x, `${path}.x`),
    y: expectP256Coordinate(record.y, `${path}.y`),
  };
}

export function validateResumeCursor(value: unknown, path: string): RemoteResumeCursorV1 {
  const record = expectRecord(value, path);
  assertStrictKeys(
    record,
    ["streamId", "snapshotId", "lastAckServerSeq", "hasMaterializedSnapshot"],
    [],
    path,
  );
  return {
    streamId: expectIdentifier(record.streamId, `${path}.streamId`),
    snapshotId: expectIdentifier(record.snapshotId, `${path}.snapshotId`),
    lastAckServerSeq: expectSafeInteger(record.lastAckServerSeq, `${path}.lastAckServerSeq`, { minimum: 0 }),
    hasMaterializedSnapshot: expectLiteral(record.hasMaterializedSnapshot, true, `${path}.hasMaterializedSnapshot`),
  };
}
