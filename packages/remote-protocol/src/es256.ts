import { RemoteProtocolError } from "./errors.js";

const ES256_COMPONENT_BYTES = 32;
const ES256_P1363_BYTES = ES256_COMPONENT_BYTES * 2;
const P256_ORDER = Uint8Array.of(
  0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84,
  0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
);

function assertValidP256Scalar(component: Uint8Array): void {
  let nonZero = false;
  let orderComparison = 0;
  for (let index = 0; index < ES256_COMPONENT_BYTES; index += 1) {
    nonZero ||= component[index] !== 0;
    if (orderComparison === 0) {
      orderComparison = component[index] < P256_ORDER[index]
        ? -1
        : component[index] > P256_ORDER[index]
          ? 1
          : 0;
    }
  }
  if (!nonZero || orderComparison >= 0) {
    throw new RemoteProtocolError("invalid_field", "ES256 scalar is outside the P-256 order");
  }
}

function readDerLength(bytes: Uint8Array, offset: number): { readonly length: number; readonly next: number } {
  if (offset >= bytes.length) {
    throw new RemoteProtocolError("invalid_field", "Truncated DER length");
  }
  const first = bytes[offset];
  if (first < 0x80) {
    return { length: first, next: offset + 1 };
  }
  if (first !== 0x81 || offset + 1 >= bytes.length || bytes[offset + 1] < 0x80) {
    throw new RemoteProtocolError("invalid_field", "Non-canonical DER length");
  }
  return { length: bytes[offset + 1], next: offset + 2 };
}

function readDerInteger(bytes: Uint8Array, offset: number): { readonly component: Uint8Array; readonly next: number } {
  if (bytes[offset] !== 0x02) {
    throw new RemoteProtocolError("invalid_field", "Expected a DER INTEGER");
  }
  const encodedLength = readDerLength(bytes, offset + 1);
  const end = encodedLength.next + encodedLength.length;
  if (encodedLength.length < 1 || encodedLength.length > ES256_COMPONENT_BYTES + 1 || end > bytes.length) {
    throw new RemoteProtocolError("invalid_field", "Invalid ES256 DER integer length");
  }
  let integer = bytes.slice(encodedLength.next, end);
  if ((integer[0] & 0x80) !== 0) {
    throw new RemoteProtocolError("invalid_field", "ES256 DER integers must be positive");
  }
  if (integer.length > 1 && integer[0] === 0) {
    if ((integer[1] & 0x80) === 0) {
      throw new RemoteProtocolError("invalid_field", "ES256 DER integer has redundant padding");
    }
    integer = integer.slice(1);
  }
  if (integer.length > ES256_COMPONENT_BYTES) {
    throw new RemoteProtocolError("invalid_field", "ES256 DER integer exceeds P-256 width");
  }
  const component = new Uint8Array(ES256_COMPONENT_BYTES);
  component.set(integer, ES256_COMPONENT_BYTES - integer.length);
  assertValidP256Scalar(component);
  return { component, next: end };
}

/** Convert the native Apple/Android X9.62 DER signature to the V1 64-byte wire format. */
export function es256DerToP1363(der: Uint8Array): Uint8Array {
  if (der.length < 8 || der[0] !== 0x30) {
    throw new RemoteProtocolError("invalid_field", "Expected an ES256 DER sequence");
  }
  const sequenceLength = readDerLength(der, 1);
  if (sequenceLength.next + sequenceLength.length !== der.length) {
    throw new RemoteProtocolError("invalid_field", "ES256 DER sequence length does not match input");
  }
  const r = readDerInteger(der, sequenceLength.next);
  const s = readDerInteger(der, r.next);
  if (s.next !== der.length) {
    throw new RemoteProtocolError("invalid_field", "ES256 DER signature contains trailing data");
  }
  const output = new Uint8Array(ES256_P1363_BYTES);
  output.set(r.component, 0);
  output.set(s.component, ES256_COMPONENT_BYTES);
  return output;
}

function encodeDerInteger(component: Uint8Array): Uint8Array {
  let firstNonZero = 0;
  while (firstNonZero < component.length - 1 && component[firstNonZero] === 0) {
    firstNonZero += 1;
  }
  const value = component.slice(firstNonZero);
  const needsPositivePadding = (value[0] & 0x80) !== 0;
  const output = new Uint8Array(2 + value.length + (needsPositivePadding ? 1 : 0));
  output[0] = 0x02;
  output[1] = value.length + (needsPositivePadding ? 1 : 0);
  output.set(value, needsPositivePadding ? 3 : 2);
  return output;
}

/** Convert the V1 fixed-width wire signature to native Apple/Android X9.62 DER. */
export function es256P1363ToDer(signature: Uint8Array): Uint8Array {
  if (signature.length !== ES256_P1363_BYTES) {
    throw new RemoteProtocolError("invalid_field", "ES256 P1363 signature must be exactly 64 bytes");
  }
  const rComponent = signature.slice(0, ES256_COMPONENT_BYTES);
  const sComponent = signature.slice(ES256_COMPONENT_BYTES);
  assertValidP256Scalar(rComponent);
  assertValidP256Scalar(sComponent);
  const r = encodeDerInteger(rComponent);
  const s = encodeDerInteger(sComponent);
  const bodyLength = r.length + s.length;
  const output = new Uint8Array(2 + bodyLength);
  output[0] = 0x30;
  output[1] = bodyLength;
  output.set(r, 2);
  output.set(s, 2 + r.length);
  return output;
}
