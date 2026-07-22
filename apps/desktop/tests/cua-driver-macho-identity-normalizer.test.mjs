import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectCuaDriverMachOIdentity,
  normalizeCuaDriverMachOIdentity,
  summarizeCuaDriverMachOReproducibility,
} from "../scripts/cua-driver-macho-identity-normalizer.mjs";
import {
  summarizeArchive,
} from "../scripts/diagnose-cua-driver-darwin-reproducibility.mjs";

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

test("Mach-O reproducibility diagnostics ignore derived identity and retain runtime sections", () => {
  const left = machoSectionFixture({ signatureByte: 0x11, uuidByte: 0x22 });
  const right = machoSectionFixture({ signatureByte: 0x77, uuidByte: 0x88 });
  const leftSummary = summarizeCuaDriverMachOReproducibility(left);
  const rightSummary = summarizeCuaDriverMachOReproducibility(right);

  assert.equal(leftSummary.sourceSha256, rightSummary.sourceSha256);
  assert.deepEqual(leftSummary.sections, rightSummary.sections);
  assert.equal(leftSummary.sections[0].name, "__TEXT,__text");

  right[0x110] ^= 0xff;
  const changed = summarizeCuaDriverMachOReproducibility(right);
  assert.notEqual(leftSummary.sourceSha256, changed.sourceSha256);
  assert.notEqual(leftSummary.sections[0].sha256, changed.sections[0].sha256);
});

test("archive diagnostics distinguish header-only drift from member-byte drift", () => {
  const left = archiveFixture({ timestamp: "1" });
  const right = archiveFixture({ timestamp: "2" });
  const leftSummary = summarizeArchive(left);
  const rightSummary = summarizeArchive(right);
  assert.notEqual(leftSummary.sha256, rightSummary.sha256);
  assert.equal(
    leftSummary.canonicalMembersSha256,
    rightSummary.canonicalMembersSha256,
  );

  right[68] ^= 0xff;
  assert.notEqual(
    leftSummary.canonicalMembersSha256,
    summarizeArchive(right).canonicalMembersSha256,
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

function machoSectionFixture({ signatureByte, uuidByte }) {
  const segmentBytes = 72 + 80;
  const commandBytes = segmentBytes + 24 + 16;
  const signatureOffset = 0x140;
  const signatureSize = 32;
  const bytes = Buffer.alloc(signatureOffset + signatureSize, 0);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(0x2, 12);
  bytes.writeUInt32LE(3, 16);
  bytes.writeUInt32LE(commandBytes, 20);

  bytes.writeUInt32LE(0x19, 32);
  bytes.writeUInt32LE(segmentBytes, 36);
  bytes.write("__TEXT", 40, "ascii");
  bytes.writeBigUInt64LE(0x100000000n, 56);
  bytes.writeBigUInt64LE(BigInt(signatureOffset), 64);
  bytes.writeBigUInt64LE(0n, 72);
  bytes.writeBigUInt64LE(BigInt(signatureOffset), 80);
  bytes.writeUInt32LE(1, 96);

  bytes.write("__text", 104, "ascii");
  bytes.write("__TEXT", 120, "ascii");
  bytes.writeBigUInt64LE(0x100000100n, 136);
  bytes.writeBigUInt64LE(0x20n, 144);
  bytes.writeUInt32LE(0x100, 152);
  bytes.writeUInt32LE(0x80000400, 168);

  const uuidCommand = 32 + segmentBytes;
  bytes.writeUInt32LE(0x1b, uuidCommand);
  bytes.writeUInt32LE(24, uuidCommand + 4);
  bytes.fill(uuidByte, uuidCommand + 8, uuidCommand + 24);

  const signatureCommand = uuidCommand + 24;
  bytes.writeUInt32LE(0x1d, signatureCommand);
  bytes.writeUInt32LE(16, signatureCommand + 4);
  bytes.writeUInt32LE(signatureOffset, signatureCommand + 8);
  bytes.writeUInt32LE(signatureSize, signatureCommand + 12);

  bytes.fill(0x5a, 0x100, 0x120);
  bytes.fill(signatureByte, signatureOffset);
  return bytes;
}

function archiveFixture({ timestamp }) {
  const payload = Buffer.from("runtime-link-input", "ascii");
  const header = Buffer.alloc(60, 0x20);
  writeArchiveField(header, 0, 16, "member.o/");
  writeArchiveField(header, 16, 12, timestamp);
  writeArchiveField(header, 28, 6, "0");
  writeArchiveField(header, 34, 6, "0");
  writeArchiveField(header, 40, 8, "100644");
  writeArchiveField(header, 48, 10, String(payload.length));
  header.write("`\n", 58, "ascii");
  return Buffer.concat([
    Buffer.from("!<arch>\n", "ascii"),
    header,
    payload,
    ...(payload.length % 2 === 0 ? [] : [Buffer.from("\n", "ascii")]),
  ]);
}

function writeArchiveField(header, offset, width, value) {
  header.write(value.padEnd(width, " "), offset, width, "ascii");
}
