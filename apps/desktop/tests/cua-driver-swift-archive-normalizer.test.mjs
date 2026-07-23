import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSwiftArchiveForReproducibility,
} from "../scripts/cua-driver-swift-archive-normalizer.mjs";

test("Swift archive normalization removes non-runtime module hashes and DWARF", () => {
  const object = swiftMachOFixture();
  const archive = archiveFixture("swift.o", object);
  const normalized = normalizeSwiftArchiveForReproducibility(archive);

  assert.equal(normalized.machoMembers, 1);
  assert.equal(normalized.normalizedSections, 1);
  assert.equal(normalized.normalizedDwarfSections, 1);
  assert.equal(normalized.bytes.length, archive.length);
  assert.deepEqual(normalized.bytes.subarray(0, 8), archive.subarray(0, 8));
  const differences = [];
  for (let index = 0; index < archive.length; index += 1) {
    if (archive[index] !== normalized.bytes[index]) differences.push(index);
  }
  assert.equal(differences.length, 28);
  for (const index of differences) assert.equal(normalized.bytes[index], 0);
});

test("Swift archive normalization accepts BSD extended names and fails closed", () => {
  const object = swiftMachOFixture();
  const extended = archiveFixture("CoreMedia.swift.o", object, true);
  assert.equal(normalizeSwiftArchiveForReproducibility(extended).normalizedSections, 1);
  assert.throws(
    () => normalizeSwiftArchiveForReproducibility(Buffer.from("not-an-archive")),
    /archive magic mismatch/u,
  );
  const withoutHash = Buffer.from(object);
  withoutHash.fill(0, 32 + 72, 32 + 72 + 16);
  assert.throws(
    () => normalizeSwiftArchiveForReproducibility(archiveFixture("plain.o", withoutHash)),
    /no module hashes/u,
  );
});

test("Swift archive normalization leaves non-Swift Mach-O DWARF untouched", () => {
  const plainObject = swiftMachOFixture();
  plainObject.fill(0, 32 + 72, 32 + 72 + 16);
  const plainArchive = archiveFixture("plain.o", plainObject);
  const swiftArchive = archiveFixture("swift.o", swiftMachOFixture());
  const combined = Buffer.concat([swiftArchive, plainArchive.subarray(8)]);

  const normalized = normalizeSwiftArchiveForReproducibility(combined);
  assert.equal(normalized.machoMembers, 2);
  assert.equal(normalized.normalizedSections, 1);
  assert.equal(normalized.normalizedDwarfSections, 1);
  assert.deepEqual(
    normalized.bytes.subarray(swiftArchive.length),
    plainArchive.subarray(8),
  );
});

function swiftMachOFixture() {
  const headerBytes = 32;
  const segmentBytes = 72;
  const sectionBytes = 80;
  const hashBytes = 16;
  const dwarfBytes = 12;
  const sectionCount = 2;
  const hashOffset = headerBytes + segmentBytes + sectionBytes * sectionCount;
  const dwarfOffset = hashOffset + hashBytes;
  const object = Buffer.alloc(dwarfOffset + dwarfBytes + 1);
  object.writeUInt32LE(0xfeedfacf, 0);
  object.writeUInt32LE(1, 16);
  object.writeUInt32LE(segmentBytes + sectionBytes * sectionCount, 20);
  object.writeUInt32LE(0x19, headerBytes);
  object.writeUInt32LE(segmentBytes + sectionBytes * sectionCount, headerBytes + 4);
  object.writeUInt32LE(sectionCount, headerBytes + 64);
  const section = headerBytes + segmentBytes;
  object.write("__swift_modhash", section, "ascii");
  object.write("__LLVM", section + 16, "ascii");
  object.writeBigUInt64LE(BigInt(hashBytes), section + 40);
  object.writeUInt32LE(hashOffset, section + 48);
  const dwarfSection = section + sectionBytes;
  object.write("__debug_str", dwarfSection, "ascii");
  object.write("__DWARF", dwarfSection + 16, "ascii");
  object.writeBigUInt64LE(BigInt(dwarfBytes), dwarfSection + 40);
  object.writeUInt32LE(dwarfOffset, dwarfSection + 48);
  for (let index = 0; index < hashBytes; index += 1) object[hashOffset + index] = index + 1;
  for (let index = 0; index < dwarfBytes; index += 1) object[dwarfOffset + index] = index + 17;
  object[object.length - 1] = 0xff;
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
