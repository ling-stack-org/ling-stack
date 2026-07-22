import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ARCHIVE_MAGIC = "!<arch>\n";
const ARCHIVE_HEADER_BYTES = 60;
const ARCHIVE_TRAILER = "`\n";
const MACHO_64_MAGIC = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;
const MACHO_64_HEADER_BYTES = 32;
const SEGMENT_64_BYTES = 72;
const SECTION_64_BYTES = 80;
const SWIFT_MODULE_HASH_SEGMENT = "__LLVM";
const SWIFT_MODULE_HASH_SECTION = "__swift_modhash";
const SWIFT_MODULE_HASH_BYTES = 16;
const SWIFT_ARCHIVE_PATTERN = /^lib(?:apple_cf|screencapturekit)-[0-9a-f]+\.rlib$/u;

/**
 * Remove Swift's non-runtime module hash from the two locked macOS bridge
 * archives. Swift 6.3 emits a different 16-byte hash for otherwise identical
 * object files; leaving it in the linker inputs changes stub ordering, LC_UUID,
 * and the arm64 linker signature across clean builds.
 */
export async function normalizeCuaDriverSwiftArchives(dependencyRoot) {
  const entries = (await readdir(dependencyRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && SWIFT_ARCHIVE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (entries.length !== 2
    || !entries.some((name) => name.startsWith("libapple_cf-"))
    || !entries.some((name) => name.startsWith("libscreencapturekit-"))) {
    throw new Error(`locked Swift bridge archive inventory mismatch: ${JSON.stringify(entries)}`);
  }

  const evidence = [];
  for (const name of entries) {
    const path = join(dependencyRoot, name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Swift bridge archive is not a regular file: ${name}`);
    }
    const normalized = normalizeSwiftModuleHashesInArchive(await readFile(path));
    await writeFile(path, normalized.bytes);
    evidence.push(Object.freeze({
      archive: name.replace(/-[0-9a-f]+\.rlib$/u, ".rlib"),
      machoMembers: normalized.machoMembers,
      normalizedSections: normalized.normalizedSections,
    }));
  }
  return Object.freeze(evidence);
}

/** Pure archive transformer used by the build and deterministic fixtures. */
export function normalizeSwiftModuleHashesInArchive(input) {
  const bytes = Buffer.from(input);
  if (bytes.subarray(0, ARCHIVE_MAGIC.length).toString("ascii") !== ARCHIVE_MAGIC) {
    throw new Error("Swift bridge archive magic mismatch");
  }
  let cursor = ARCHIVE_MAGIC.length;
  let members = 0;
  let machoMembers = 0;
  let normalizedSections = 0;
  while (cursor < bytes.length) {
    if (cursor + ARCHIVE_HEADER_BYTES > bytes.length) {
      throw new Error("Swift bridge archive has a truncated member header");
    }
    const header = bytes.subarray(cursor, cursor + ARCHIVE_HEADER_BYTES);
    if (header.subarray(58, 60).toString("ascii") !== ARCHIVE_TRAILER) {
      throw new Error("Swift bridge archive member trailer mismatch");
    }
    const memberSize = parseArchiveDecimal(header.subarray(48, 58), "member size");
    const rawName = header.subarray(0, 16).toString("ascii").trim();
    const memberStart = cursor + ARCHIVE_HEADER_BYTES;
    const memberEnd = memberStart + memberSize;
    if (memberEnd > bytes.length) {
      throw new Error("Swift bridge archive has a truncated member payload");
    }
    let payloadStart = memberStart;
    if (rawName.startsWith("#1/")) {
      const nameBytes = Number.parseInt(rawName.slice(3), 10);
      if (!Number.isSafeInteger(nameBytes) || nameBytes < 1 || nameBytes > memberSize) {
        throw new Error("Swift bridge archive has an invalid BSD member name");
      }
      payloadStart += nameBytes;
    }
    const payloadSize = memberEnd - payloadStart;
    members += 1;
    if (payloadSize >= MACHO_64_HEADER_BYTES
      && bytes.readUInt32LE(payloadStart) === MACHO_64_MAGIC) {
      machoMembers += 1;
      normalizedSections += normalizeMachOSwiftModuleHash(bytes, payloadStart, payloadSize);
    }
    cursor = memberEnd + (memberSize % 2);
  }
  if (cursor !== bytes.length) {
    throw new Error("Swift bridge archive alignment mismatch");
  }
  if (members < 1 || machoMembers < 1 || normalizedSections < 1) {
    throw new Error("Swift bridge archive contained no module hashes to normalize");
  }
  return Object.freeze({ bytes, machoMembers, normalizedSections });
}

function normalizeMachOSwiftModuleHash(bytes, payloadStart, payloadSize) {
  const payloadEnd = payloadStart + payloadSize;
  const commandCount = bytes.readUInt32LE(payloadStart + 16);
  const commandBytes = bytes.readUInt32LE(payloadStart + 20);
  let command = payloadStart + MACHO_64_HEADER_BYTES;
  const commandEnd = command + commandBytes;
  if (commandEnd > payloadEnd) throw new Error("Mach-O load commands exceed archive member");
  let normalized = 0;
  for (let index = 0; index < commandCount; index += 1) {
    if (command + 8 > commandEnd) throw new Error("Mach-O load command is truncated");
    const type = bytes.readUInt32LE(command);
    const size = bytes.readUInt32LE(command + 4);
    if (size < 8 || command + size > commandEnd) {
      throw new Error("Mach-O load command size is invalid");
    }
    if (type === LC_SEGMENT_64) {
      if (size < SEGMENT_64_BYTES) throw new Error("Mach-O segment command is truncated");
      const sectionCount = bytes.readUInt32LE(command + 64);
      if (SEGMENT_64_BYTES + sectionCount * SECTION_64_BYTES > size) {
        throw new Error("Mach-O section table exceeds segment command");
      }
      for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
        const section = command + SEGMENT_64_BYTES + sectionIndex * SECTION_64_BYTES;
        const sectionName = readMachOName(bytes, section);
        const segmentName = readMachOName(bytes, section + 16);
        if (sectionName !== SWIFT_MODULE_HASH_SECTION
          || segmentName !== SWIFT_MODULE_HASH_SEGMENT) continue;
        const sectionSize = bytes.readBigUInt64LE(section + 40);
        const sectionOffset = bytes.readUInt32LE(section + 48);
        if (sectionSize !== BigInt(SWIFT_MODULE_HASH_BYTES)) {
          throw new Error(`Swift module hash size changed: ${sectionSize}`);
        }
        const hashStart = payloadStart + sectionOffset;
        const hashEnd = hashStart + SWIFT_MODULE_HASH_BYTES;
        if (hashStart < payloadStart || hashEnd > payloadEnd) {
          throw new Error("Swift module hash exceeds archive member");
        }
        bytes.fill(0, hashStart, hashEnd);
        normalized += 1;
      }
    }
    command += size;
  }
  if (command !== commandEnd) throw new Error("Mach-O load command byte count mismatch");
  return normalized;
}

function parseArchiveDecimal(value, label) {
  const text = value.toString("ascii").trim();
  if (!/^[0-9]+$/u.test(text)) throw new Error(`Swift bridge archive ${label} is invalid`);
  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Swift bridge archive ${label} is out of range`);
  }
  return parsed;
}

function readMachOName(bytes, offset) {
  const field = bytes.subarray(offset, offset + 16);
  const zero = field.indexOf(0);
  return field.subarray(0, zero < 0 ? field.length : zero).toString("ascii");
}
