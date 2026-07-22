import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectCuaDriverMachOIdentity,
  normalizeCuaDriverMachOIdentity,
} from "../scripts/cua-driver-macho-identity-normalizer.mjs";

test("Mach-O identity normalization removes UUID and linker-signature drift", () => {
  const left = machoFixture({ signatureByte: 0x11, uuidByte: 0x22 });
  const right = machoFixture({ signatureByte: 0x77, uuidByte: 0x88 });
  const normalizedLeft = normalizeCuaDriverMachOIdentity(left);
  const normalizedRight = normalizeCuaDriverMachOIdentity(right);

  assert.equal(normalizedLeft.sourceSha256, normalizedRight.sourceSha256);
  assert.equal(normalizedLeft.uuid, normalizedRight.uuid);
  assert.match(normalizedLeft.uuid, /^[0-9A-F]{8}-[0-9A-F]{4}-3[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/u);
  assert.deepEqual(normalizedLeft.bytes.subarray(40, 56), normalizedRight.bytes.subarray(40, 56));
  assert.deepEqual(normalizedLeft.bytes.subarray(72, 96), normalizedRight.bytes.subarray(72, 96));
  assert.notDeepEqual(
    normalizedLeft.bytes.subarray(96),
    normalizedRight.bytes.subarray(96),
    "the structurally valid linker signatures stay intact until codesign replaces them",
  );

  const runtimeDrift = Buffer.from(right);
  runtimeDrift[80] ^= 0xff;
  assert.notEqual(
    normalizeCuaDriverMachOIdentity(runtimeDrift).sourceSha256,
    normalizedLeft.sourceSha256,
    "runtime byte drift must remain visible to A/B comparison",
  );
});

test("Mach-O identity normalization accepts unsigned x64 shape and rejects malformed commands", () => {
  const unsigned = machoFixture({ includeSignature: false, uuidByte: 0x44 });
  const normalized = normalizeCuaDriverMachOIdentity(unsigned);
  assert.equal(normalized.bytes.length, unsigned.length);
  assert.equal(inspectCuaDriverMachOIdentity(unsigned).codeSignature, undefined);

  const missingUuid = Buffer.from(unsigned);
  missingUuid.writeUInt32LE(0x2, 32);
  assert.throws(
    () => normalizeCuaDriverMachOIdentity(missingUuid),
    /LC_UUID is missing/u,
  );

  const escapedSignature = machoFixture({ signatureByte: 1, uuidByte: 2 });
  escapedSignature.writeUInt32LE(escapedSignature.length + 1, 64);
  assert.throws(
    () => normalizeCuaDriverMachOIdentity(escapedSignature),
    /code signature range is invalid/u,
  );
});

function machoFixture({ includeSignature = true, signatureByte = 0xaa, uuidByte = 0xbb }) {
  const signatureOffset = 96;
  const signatureSize = 32;
  const commandBytes = includeSignature ? 40 : 24;
  const bytes = Buffer.alloc(includeSignature ? signatureOffset + signatureSize : signatureOffset, 0);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(0x2, 12);
  bytes.writeUInt32LE(includeSignature ? 2 : 1, 16);
  bytes.writeUInt32LE(commandBytes, 20);
  bytes.writeUInt32LE(0, 24);
  bytes.writeUInt32LE(0, 28);
  bytes.writeUInt32LE(0x1b, 32);
  bytes.writeUInt32LE(24, 36);
  bytes.fill(uuidByte, 40, 56);
  if (includeSignature) {
    bytes.writeUInt32LE(0x1d, 56);
    bytes.writeUInt32LE(16, 60);
    bytes.writeUInt32LE(signatureOffset, 64);
    bytes.writeUInt32LE(signatureSize, 68);
    bytes.fill(signatureByte, signatureOffset);
  }
  bytes.fill(0x5a, 72, signatureOffset);
  return bytes;
}
