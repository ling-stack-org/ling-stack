import { RemoteProtocolError } from "./errors.js";

export type CanonicalJsonPrimitive = null | boolean | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function assertValidUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new RemoteProtocolError("invalid_field", "Canonical JSON contains an unpaired surrogate", path);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new RemoteProtocolError("invalid_field", "Canonical JSON contains an unpaired surrogate", path);
    }
  }
}

function canonicalizeInternal(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RemoteProtocolError("invalid_field", "Canonical JSON numbers must be finite", path);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertValidUnicode(value, path);
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) {
    throw new RemoteProtocolError("invalid_field", "Value is not valid canonical JSON", path);
  }
  if (seen.has(value)) {
    throw new RemoteProtocolError("invalid_field", "Canonical JSON cannot contain cycles", path);
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new RemoteProtocolError("invalid_field", "Canonical JSON arrays cannot be sparse", `${path}[${index}]`);
        }
        items.push(canonicalizeInternal(value[index], `${path}[${index}]`, seen));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new RemoteProtocolError("invalid_field", "Canonical JSON objects must be plain records", path);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const properties: string[] = [];
    for (const key of keys) {
      assertValidUnicode(key, `${path}.<key>`);
      if (record[key] === undefined) {
        throw new RemoteProtocolError("invalid_field", "Canonical JSON cannot contain undefined", `${path}.${key}`);
      }
      properties.push(`${JSON.stringify(key)}:${canonicalizeInternal(record[key], `${path}.${key}`, seen)}`);
    }
    return `{${properties.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** RFC 8785 JSON Canonicalization Scheme for the I-JSON subset used by V1. */
export function canonicalizeJson(value: unknown): string {
  return canonicalizeInternal(value, "$", new Set<object>());
}

export function encodeUtf8(value: string): Uint8Array {
  assertValidUnicode(value, "$utf8");
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
      index += 1;
    }
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

export function decodeUtf8Strict(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index];
    let codePoint: number;
    let width: number;
    let minimum: number;
    if (first <= 0x7f) {
      codePoint = first;
      width = 1;
      minimum = 0;
    } else if (first >= 0xc2 && first <= 0xdf) {
      codePoint = first & 0x1f;
      width = 2;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      codePoint = first & 0x0f;
      width = 3;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      codePoint = first & 0x07;
      width = 4;
      minimum = 0x10000;
    } else {
      throw new RemoteProtocolError("invalid_json", "Frame is not valid UTF-8");
    }
    if (index + width > bytes.length) {
      throw new RemoteProtocolError("invalid_json", "Frame is not valid UTF-8");
    }
    for (let offset = 1; offset < width; offset += 1) {
      const continuation = bytes[index + offset];
      if ((continuation & 0xc0) !== 0x80) {
        throw new RemoteProtocolError("invalid_json", "Frame is not valid UTF-8");
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (
      codePoint < minimum
      || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      throw new RemoteProtocolError("invalid_json", "Frame is not valid UTF-8");
    }
    result += String.fromCodePoint(codePoint);
    index += width;
  }
  return result;
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return encodeUtf8(canonicalizeJson(value));
}

export function domainSeparatedCanonicalBytes(domain: string, value: unknown): Uint8Array {
  if (!/^[a-z0-9._-]+$/.test(domain)) {
    throw new RemoteProtocolError("invalid_field", "Invalid signing domain", "$domain");
  }
  const domainBytes = encodeUtf8(domain);
  const payloadBytes = canonicalJsonBytes(value);
  const output = new Uint8Array(domainBytes.length + 1 + payloadBytes.length);
  output.set(domainBytes, 0);
  output[domainBytes.length] = 0;
  output.set(payloadBytes, domainBytes.length + 1);
  return output;
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function encodeBase64Url(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const value = (bytes[index] << 16)
      | ((remaining > 1 ? bytes[index + 1] : 0) << 8)
      | (remaining > 2 ? bytes[index + 2] : 0);
    result += BASE64URL_ALPHABET[(value >> 18) & 0x3f];
    result += BASE64URL_ALPHABET[(value >> 12) & 0x3f];
    if (remaining > 1) {
      result += BASE64URL_ALPHABET[(value >> 6) & 0x3f];
    }
    if (remaining > 2) {
      result += BASE64URL_ALPHABET[value & 0x3f];
    }
  }
  return result;
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new RemoteProtocolError("invalid_field", "Invalid unpadded base64url value");
  }
  const values = new Map(Array.from(BASE64URL_ALPHABET, (character, index) => [character, index]));
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const remaining = value.length - index;
    const a = values.get(value[index]) ?? 0;
    const b = values.get(value[index + 1]) ?? 0;
    const c = remaining > 2 ? values.get(value[index + 2]) ?? 0 : 0;
    const d = remaining > 3 ? values.get(value[index + 3]) ?? 0 : 0;
    const packed = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((packed >> 16) & 0xff);
    if (remaining > 2) {
      bytes.push((packed >> 8) & 0xff);
    }
    if (remaining > 3) {
      bytes.push(packed & 0xff);
    }
  }
  const decoded = Uint8Array.from(bytes);
  if (encodeBase64Url(decoded) !== value) {
    throw new RemoteProtocolError("invalid_field", "Base64url value is not canonical");
  }
  return decoded;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
