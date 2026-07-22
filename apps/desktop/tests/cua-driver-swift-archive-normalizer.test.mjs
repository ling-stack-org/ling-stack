import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSwiftModuleHashesInArchive,
} from "../scripts/cua-driver-swift-archive-normalizer.mjs";

test("Swift archive normalization removes only the non-runtime module hash", () => {
  const object = swiftMachOFixture();
  const archive = archiveFixture("swift.o", object);
  const normalized = normalizeSwiftModuleHashesInArchive(archive);

  assert.equal(normalized.machoMembers, 1);
  assert.equal(normalized.normalizedSections, 1);
  assert.equal(normalized.bytes.length, archive.length);
  assert.deepEqual(normalized.bytes.subarray(0, 8), archive.subarray(0, 8));
  const differences = [];
  for (let index = 0; index < archive.length; index += 1) {
    if (archive[index] !== normalized.bytes[index]) differences.push(index);
  }
  assert.equal(differences.length, 16);
  assert.deepEqual(
    normalized.bytes.subarray(differences[0], differences.at(-1) + 1),
    Buffer.alloc(16),
  );
});

test("Swift archive normalization accepts BSD extended names and fails closed", () => {
  const object = swiftMachOFixture();
  const extended = archiveFixture("CoreMedia.swift.o", object, true);
  assert.equal(normalizeSwiftModuleHashesInArchive(extended).normalizedSections, 1);
  assert.throws(
    () => normalizeSwiftModuleHashesInArchive(Buffer.from("not-an-archive")),
    /archive magic mismatch/u,
  );
  const withoutHash = Buffer.from(object);
  withoutHash.fill(0, 32 + 72, 32 + 72 + 16);
  assert.throws(
    () => normalizeSwiftModuleHashesInArchive(archiveFixture("plain.o", withoutHash)),
    /no module hashes/u,
  );
});

function swiftMachOFixture() {
  const headerBytes = 32;
  const segmentBytes = 72;
  const sectionBytes = 80;
  const hashBytes = 16;
  const hashOffset = headerBytes + segmentBytes + sectionBytes;
  const object = Buffer.alloc(hashOffset + hashBytes);
  object.writeUInt32LE(0xfeedfacf, 0);
  object.writeUInt32LE(1, 16);
  object.writeUInt32LE(segmentBytes + sectionBytes, 20);
  object.writeUInt32LE(0x19, headerBytes);
  object.writeUInt32LE(segmentBytes + sectionBytes, headerBytes + 4);
  object.writeUInt32LE(1, headerBytes + 64);
  const section = headerBytes + segmentBytes;
  object.write("__swift_modhash", section, "ascii");
  object.write("__LLVM", section + 16, "ascii");
  object.writeBigUInt64LE(BigInt(hashBytes), section + 40);
  object.writeUInt32LE(hashOffset, section + 48);
  for (let index = 0; index < hashBytes; index += 1) object[hashOffset + index] = index + 1;
  return object;
}

function archiveFixture(name, payload, extendedName = false) {
  const nameBytes = extendedName ? Buffer.from(name, "ascii") : Buffer.alloc(0);
  const archiveName = extendedName ? `#1/${nameBytes.length}` : `${name}/`;
  const memberSize = nameBytes.length + payload.length;
  const header = Buffer.from([
    archiveName.padEnd(16),
    "0".padEnd(12),
    "0".padEnd(6),
    "0".padEnd(6),
    "100644".padEnd(8),
    String(memberSize).padEnd(10),
    "`\n",
  ].join(""), "ascii");
  const padding = memberSize % 2 ? Buffer.from("\n") : Buffer.alloc(0);
  return Buffer.concat([Buffer.from("!<arch>\n"), header, nameBytes, payload, padding]);
}
