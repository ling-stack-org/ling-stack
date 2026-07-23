import { createHash } from "node:crypto";

const PE_MACHINE_AMD64 = 0x8664;
const PE32_PLUS_MAGIC = 0x20b;
const PE_RESOURCE_DIRECTORY_INDEX = 2;
const PE_SECURITY_DIRECTORY_INDEX = 4;
const RT_MANIFEST = 24;
const MACHO_FAT_MAGIC = 0xcafebabe;
const MACHO_FAT_MAGIC_64 = 0xcafebabf;
const MACHO_MAGIC_64 = 0xfeedfacf;
const MACHO_FILETYPE_EXECUTE = 0x2;
const LC_BUILD_VERSION = 0x32;

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function verifyPinnedBytes(buffer, expected, label) {
  assert(Buffer.isBuffer(buffer), `${label} is not a Buffer`);
  if (expected.sizeBytes !== undefined) {
    assert(buffer.length === expected.sizeBytes, `${label} size mismatch: expected ${expected.sizeBytes}, found ${buffer.length}`);
  }
  const sha256 = sha256Bytes(buffer);
  assert(sha256 === expected.sha256, `${label} SHA-256 mismatch: expected ${expected.sha256}, found ${sha256}`);
  return { sizeBytes: buffer.length, sha256 };
}

export function inspectWindowsPe(buffer, label = "Windows provider binary") {
  assert(Buffer.isBuffer(buffer) && buffer.length >= 0x100, `${label} is too small to be a PE executable`);
  assert(buffer[0] === 0x4d && buffer[1] === 0x5a, `${label} is missing the DOS MZ header`);
  const peOffset = readU32LE(buffer, 0x3c, label);
  assert(peOffset >= 0x40 && peOffset + 24 <= buffer.length, `${label} has an invalid PE header offset`);
  assert(buffer.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0])), `${label} is missing the PE signature`);

  const machine = readU16LE(buffer, peOffset + 4, label);
  assert(machine === PE_MACHINE_AMD64, `${label} must target Windows x86_64 (PE machine 0x8664)`);
  const sectionCount = readU16LE(buffer, peOffset + 6, label);
  const optionalHeaderSize = readU16LE(buffer, peOffset + 20, label);
  const optionalHeaderOffset = peOffset + 24;
  assert(optionalHeaderSize >= 112 + 16 * 8, `${label} has an incomplete PE32+ optional header`);
  assert(optionalHeaderOffset + optionalHeaderSize <= buffer.length, `${label} has an invalid PE32+ optional header`);
  assert(readU16LE(buffer, optionalHeaderOffset, label) === PE32_PLUS_MAGIC, `${label} must be PE32+`);

  const dataDirectoryOffset = optionalHeaderOffset + 112;
  const resourceRva = readU32LE(buffer, dataDirectoryOffset + PE_RESOURCE_DIRECTORY_INDEX * 8, label);
  const resourceSize = readU32LE(buffer, dataDirectoryOffset + PE_RESOURCE_DIRECTORY_INDEX * 8 + 4, label);
  const certificateTableOffset = readU32LE(buffer, dataDirectoryOffset + PE_SECURITY_DIRECTORY_INDEX * 8, label);
  const certificateTableSize = readU32LE(buffer, dataDirectoryOffset + PE_SECURITY_DIRECTORY_INDEX * 8 + 4, label);
  const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
  assert(sectionTableOffset + sectionCount * 40 <= buffer.length, `${label} has a truncated section table`);
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTableOffset + index * 40;
    sections.push({
      virtualSize: readU32LE(buffer, offset + 8, label),
      virtualAddress: readU32LE(buffer, offset + 12, label),
      rawSize: readU32LE(buffer, offset + 16, label),
      rawOffset: readU32LE(buffer, offset + 20, label),
    });
  }
  assert(resourceRva > 0 && resourceSize > 0, `${label} is missing its manifest resource directory`);
  const resourceOffset = rvaToOffset(resourceRva, sections, buffer.length, label);
  const manifestBytes = extractManifestResource(buffer, resourceOffset, resourceRva, sections, label);
  const manifestText = decodeManifest(manifestBytes, label);
  const execution = parseRequestedExecutionLevel(manifestText, label);

  return {
    format: "PE32+",
    machine: "0x8664",
    architecture: "x86_64",
    embeddedCertificateTablePresent: certificateTableOffset > 0 || certificateTableSize > 0,
    manifest: {
      sha256: sha256Bytes(manifestBytes),
      executionLevel: execution.level,
      uiAccess: execution.uiAccess,
    },
  };
}

export function inspectUniversalMachO(buffer, label = "macOS provider binary") {
  assert(Buffer.isBuffer(buffer) && buffer.length >= 8, `${label} is too small to be a Mach-O universal binary`);
  const magic = buffer.readUInt32BE(0);
  assert(magic === MACHO_FAT_MAGIC || magic === MACHO_FAT_MAGIC_64, `${label} is not a Mach-O universal binary`);
  const is64BitFat = magic === MACHO_FAT_MAGIC_64;
  const sliceCount = buffer.readUInt32BE(4);
  assert(sliceCount > 0 && sliceCount <= 8, `${label} has an invalid Mach-O slice count`);
  const entrySize = is64BitFat ? 32 : 20;
  const headerSize = 8 + sliceCount * entrySize;
  assert(headerSize <= buffer.length, `${label} has a truncated universal header`);
  const entries = [];
  for (let index = 0; index < sliceCount; index += 1) {
    const entryOffset = 8 + index * entrySize;
    const cpuType = buffer.readUInt32BE(entryOffset);
    const architecture = cpuType === 0x01000007
      ? "x86_64"
      : cpuType === 0x0100000c
        ? "arm64"
        : `cpu-0x${cpuType.toString(16)}`;
    const sliceOffset = is64BitFat
      ? toSafeNumber(buffer.readBigUInt64BE(entryOffset + 8), `${label} slice offset`)
      : buffer.readUInt32BE(entryOffset + 8);
    const sliceSize = is64BitFat
      ? toSafeNumber(buffer.readBigUInt64BE(entryOffset + 16), `${label} slice size`)
      : buffer.readUInt32BE(entryOffset + 12);
    assert(sliceSize > 0, `${label} has an empty ${architecture} slice`);
    assert(sliceOffset >= headerSize, `${label} ${architecture} slice overlaps the universal header`);
    assert(sliceOffset + sliceSize <= buffer.length, `${label} has an out-of-range ${architecture} slice`);
    entries.push({ architecture, cpuType, sliceOffset, sliceSize });
  }
  const byOffset = [...entries].sort((left, right) => left.sliceOffset - right.sliceOffset);
  for (let index = 1; index < byOffset.length; index += 1) {
    const previous = byOffset[index - 1];
    const current = byOffset[index];
    assert(
      previous.sliceOffset + previous.sliceSize <= current.sliceOffset,
      `${label} contains overlapping Mach-O slices`,
    );
  }
  const slices = entries.map(({ architecture, cpuType, sliceOffset, sliceSize }) =>
    inspectMachOSlice(
      buffer.subarray(sliceOffset, sliceOffset + sliceSize),
      architecture,
      cpuType,
      label,
    ));
  slices.sort((left, right) => compareText(left.architecture, right.architecture));
  const architectures = slices.map((slice) => slice.architecture);
  assert(JSON.stringify(architectures) === JSON.stringify(["arm64", "x86_64"]), `${label} must contain exactly arm64 and x86_64 slices`);
  return {
    format: "Mach-O universal",
    architectures,
    slices,
  };
}

export function inspectArm64MachO(buffer, label = "macOS provider binary") {
  assert(Buffer.isBuffer(buffer) && buffer.length >= 32, `${label} is too small to be a Mach-O 64-bit executable`);
  const slice = inspectMachOSlice(buffer, "arm64", 0x0100000c, label);
  return {
    format: "Mach-O 64-bit",
    architecture: "arm64",
    minimumOSVersion: slice.minimumOSVersion,
    sdkVersion: slice.sdkVersion,
  };
}

export function verifyVersionOutput(output, expectedVersion = "0.8.3") {
  const normalized = String(output).trim();
  assert(normalized === `cua-driver ${expectedVersion}`, `provider version output mismatch: ${normalized || "<empty>"}`);
  return normalized;
}

function inspectMachOSlice(buffer, architecture, expectedCpuType, label) {
  assert(buffer.length >= 32 && buffer.readUInt32LE(0) === MACHO_MAGIC_64, `${label} ${architecture} slice is not little-endian Mach-O 64-bit`);
  assert(buffer.readUInt32LE(4) === expectedCpuType, `${label} ${architecture} inner CPU type does not match its universal entry`);
  assert(buffer.readUInt32LE(12) === MACHO_FILETYPE_EXECUTE, `${label} ${architecture} slice is not MH_EXECUTE`);
  const commandCount = buffer.readUInt32LE(16);
  const commandBytes = buffer.readUInt32LE(20);
  assert(32 + commandBytes <= buffer.length, `${label} ${architecture} load commands are truncated`);
  let cursor = 32;
  let buildVersion;
  for (let index = 0; index < commandCount; index += 1) {
    assert(cursor + 8 <= 32 + commandBytes, `${label} ${architecture} has a truncated load command`);
    const command = buffer.readUInt32LE(cursor);
    const size = buffer.readUInt32LE(cursor + 4);
    assert(size >= 8 && cursor + size <= 32 + commandBytes, `${label} ${architecture} has an invalid load command size`);
    if (command === LC_BUILD_VERSION) {
      assert(!buildVersion, `${label} ${architecture} contains duplicate LC_BUILD_VERSION commands`);
      assert(size >= 24, `${label} ${architecture} has an invalid LC_BUILD_VERSION`);
      buildVersion = {
        platform: buffer.readUInt32LE(cursor + 8),
        minimumOSVersion: decodePackedVersion(buffer.readUInt32LE(cursor + 12)),
        sdkVersion: decodePackedVersion(buffer.readUInt32LE(cursor + 16)),
      };
    }
    cursor += size;
  }
  assert(buildVersion, `${label} ${architecture} is missing LC_BUILD_VERSION`);
  assert(buildVersion.platform === 1, `${label} ${architecture} does not target macOS`);
  return {
    architecture,
    minimumOSVersion: buildVersion.minimumOSVersion,
    sdkVersion: buildVersion.sdkVersion,
  };
}

function extractManifestResource(buffer, resourceOffset, resourceRva, sections, label) {
  const typeEntry = findResourceId(buffer, resourceOffset, resourceOffset, RT_MANIFEST, label);
  const typeDirectory = resourceSubdirectory(buffer, resourceOffset, typeEntry, label);
  const nameEntry = firstResourceIdEntry(buffer, resourceOffset, typeDirectory, label);
  const languageDirectory = resourceSubdirectory(buffer, resourceOffset, nameEntry, label);
  const languageEntry = firstResourceIdEntry(buffer, resourceOffset, languageDirectory, label);
  assert((languageEntry.offset & 0x80000000) === 0, `${label} manifest language entry does not reference data`);
  const dataEntryOffset = resourceOffset + languageEntry.offset;
  assert(dataEntryOffset + 16 <= buffer.length, `${label} manifest data entry is truncated`);
  const dataRva = buffer.readUInt32LE(dataEntryOffset);
  const dataSize = buffer.readUInt32LE(dataEntryOffset + 4);
  const dataOffset = rvaToOffset(dataRva, sections, buffer.length, label);
  assert(dataRva >= resourceRva && dataOffset + dataSize <= buffer.length, `${label} manifest bytes are out of range`);
  return buffer.subarray(dataOffset, dataOffset + dataSize);
}

function findResourceId(buffer, resourceBase, directoryOffset, id, label) {
  return resourceEntries(buffer, resourceBase, directoryOffset, label)
    .find((entry) => entry.id === id) ?? fail(`${label} is missing RT_MANIFEST/${id}`);
}

function firstResourceIdEntry(buffer, resourceBase, directoryOffset, label) {
  const entries = resourceEntries(buffer, resourceBase, directoryOffset, label).filter((entry) => entry.id !== undefined);
  assert(entries.length > 0, `${label} manifest resource directory is empty`);
  entries.sort((left, right) => left.id - right.id);
  return entries[0];
}

function resourceEntries(buffer, resourceBase, directoryOffset, label) {
  assert(directoryOffset >= resourceBase && directoryOffset + 16 <= buffer.length, `${label} resource directory is out of range`);
  const named = buffer.readUInt16LE(directoryOffset + 12);
  const ids = buffer.readUInt16LE(directoryOffset + 14);
  const count = named + ids;
  assert(count <= 256 && directoryOffset + 16 + count * 8 <= buffer.length, `${label} resource entries are truncated`);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const offset = directoryOffset + 16 + index * 8;
    const name = buffer.readUInt32LE(offset);
    entries.push({
      id: (name & 0x80000000) === 0 ? name & 0xffff : undefined,
      offset: buffer.readUInt32LE(offset + 4),
    });
  }
  return entries;
}

function resourceSubdirectory(buffer, resourceBase, entry, label) {
  assert((entry.offset & 0x80000000) !== 0, `${label} manifest resource entry is not a directory`);
  const offset = resourceBase + (entry.offset & 0x7fffffff);
  assert(offset < buffer.length, `${label} manifest resource subdirectory is out of range`);
  return offset;
}

function rvaToOffset(rva, sections, bufferLength, label) {
  for (const section of sections) {
    const length = Math.max(section.virtualSize, section.rawSize);
    if (rva < section.virtualAddress || rva >= section.virtualAddress + length) continue;
    const offset = section.rawOffset + (rva - section.virtualAddress);
    assert(offset < bufferLength, `${label} RVA resolves outside the file`);
    return offset;
  }
  fail(`${label} RVA 0x${rva.toString(16)} is outside every section`);
}

function decodeManifest(buffer, label) {
  let text;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    text = buffer.subarray(2).toString("utf16le");
  } else {
    text = buffer.toString("utf8");
  }
  text = text.replaceAll("\0", "").trim();
  assert(text.startsWith("<?xml") || text.startsWith("<assembly"), `${label} manifest is not XML`);
  return text;
}

function parseRequestedExecutionLevel(text, label) {
  const matches = [...text.matchAll(/<requestedExecutionLevel\b([^>]*)\/?\s*>/gu)];
  assert(matches.length === 1, `${label} must contain exactly one requestedExecutionLevel`);
  const attributes = Object.fromEntries(
    [...matches[0][1].matchAll(/([A-Za-z][A-Za-z0-9]*)\s*=\s*"([^"]*)"/gu)]
      .map((match) => [match[1], match[2]]),
  );
  assert(Object.keys(attributes).sort().join(",") === "level,uiAccess", `${label} requestedExecutionLevel attributes changed`);
  assert(attributes.level === "asInvoker", `${label} execution level must be asInvoker`);
  assert(attributes.uiAccess === "true" || attributes.uiAccess === "false", `${label} uiAccess must be explicit`);
  return { level: attributes.level, uiAccess: attributes.uiAccess === "true" };
}

function decodePackedVersion(value) {
  const major = value >>> 16;
  const minor = (value >>> 8) & 0xff;
  const patch = value & 0xff;
  return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

function readU16LE(buffer, offset, label) {
  assert(offset >= 0 && offset + 2 <= buffer.length, `${label} read is out of range`);
  return buffer.readUInt16LE(offset);
}

function readU32LE(buffer, offset, label) {
  assert(offset >= 0 && offset + 4 <= buffer.length, `${label} read is out of range`);
  return buffer.readUInt32LE(offset);
}

function toSafeNumber(value, label) {
  const number = Number(value);
  assert(Number.isSafeInteger(number), `${label} is outside the safe integer range`);
  return number;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}
