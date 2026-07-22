import { createHash } from "node:crypto";

const MACHO_MAGIC_64 = 0xfeedfacf;
const MACHO_HEADER_BYTES = 32;
const MACHO_EXECUTE = 0x2;
const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;
const LC_CODE_SIGNATURE = 0x1d;
const SEGMENT_COMMAND_BYTES = 72;
const SECTION_COMMAND_BYTES = 80;
const UUID_COMMAND_BYTES = 24;
const CODE_SIGNATURE_COMMAND_BYTES = 16;
const ZERO_FILL_SECTION_TYPES = new Set([0x1, 0xc, 0x12]);

/**
 * Replace linker-selected Mach-O identity with a digest of the runtime bytes.
 * The existing UUID and ad-hoc signature are excluded from that digest because
 * both are derived identity, not runtime content. The caller must re-sign the
 * returned bytes before execution.
 */
export function normalizeCuaDriverMachOIdentity(input) {
  const inspected = inspectCuaDriverMachOIdentity(input);
  const identityNeutral = Buffer.from(input);
  identityNeutral.fill(0, inspected.uuidOffset, inspected.uuidOffset + 16);
  if (inspected.codeSignature) {
    identityNeutral.fill(
      0,
      inspected.codeSignature.offset,
      inspected.codeSignature.offset + inspected.codeSignature.size,
    );
  }
  const sourceDigest = createHash("sha256").update(identityNeutral).digest();
  const uuidBytes = Buffer.from(sourceDigest.subarray(0, 16));
  // Match Apple's content UUID convention: RFC 4122 variant with version 3.
  uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x30;
  uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80;

  // Preserve the structurally valid linker signature until codesign replaces
  // it. Its hashes are invalid after the UUID write, but zeroing the blob on
  // disk makes codesign reject the file before --force can replace it.
  const bytes = Buffer.from(input);
  uuidBytes.copy(bytes, inspected.uuidOffset);
  return Object.freeze({
    bytes,
    sourceSha256: sourceDigest.toString("hex"),
    uuid: formatUuid(uuidBytes),
  });
}

/** Parse only the fixed identity commands required by the source-build step. */
export function inspectCuaDriverMachOIdentity(input) {
  if (!Buffer.isBuffer(input)
    || input.length < MACHO_HEADER_BYTES
    || input.readUInt32LE(0) !== MACHO_MAGIC_64
    || input.readUInt32LE(12) !== MACHO_EXECUTE) {
    throw new Error("Cua Driver post-link input must be a little-endian Mach-O 64 executable");
  }
  const commandCount = input.readUInt32LE(16);
  const commandBytes = input.readUInt32LE(20);
  const commandEnd = MACHO_HEADER_BYTES + commandBytes;
  if (commandCount < 1 || commandCount > 256 || commandEnd > input.length) {
    throw new Error("Cua Driver post-link load commands are invalid");
  }

  let cursor = MACHO_HEADER_BYTES;
  let uuidOffset;
  let codeSignature;
  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > commandEnd) {
      throw new Error("Cua Driver post-link load command is truncated");
    }
    const command = input.readUInt32LE(cursor);
    const size = input.readUInt32LE(cursor + 4);
    if (size < 8 || cursor + size > commandEnd) {
      throw new Error("Cua Driver post-link load command size is invalid");
    }
    if (command === LC_UUID) {
      if (uuidOffset !== undefined || size !== UUID_COMMAND_BYTES) {
        throw new Error("Cua Driver post-link LC_UUID inventory is invalid");
      }
      uuidOffset = cursor + 8;
    } else if (command === LC_CODE_SIGNATURE) {
      if (codeSignature || size !== CODE_SIGNATURE_COMMAND_BYTES) {
        throw new Error("Cua Driver post-link LC_CODE_SIGNATURE inventory is invalid");
      }
      const offset = input.readUInt32LE(cursor + 8);
      const signatureSize = input.readUInt32LE(cursor + 12);
      if (offset < commandEnd || signatureSize < 1 || offset + signatureSize !== input.length) {
        throw new Error("Cua Driver post-link code signature range is invalid");
      }
      codeSignature = Object.freeze({ offset, size: signatureSize });
    }
    cursor += size;
  }
  if (cursor !== commandEnd || uuidOffset === undefined) {
    throw new Error("Cua Driver post-link LC_UUID is missing or load commands are misaligned");
  }
  return Object.freeze({
    codeSignature,
    uuid: formatUuid(input.subarray(uuidOffset, uuidOffset + 16)),
    uuidOffset,
  });
}

/**
 * Produce bounded, content-addressed diagnostics for a linked thin Mach-O.
 * UUID and code-signature bytes are neutralized, but every runtime section and
 * the remaining __LINKEDIT bytes stay covered. This is diagnostic evidence;
 * it never relaxes the repeated-build equality gate.
 */
export function summarizeCuaDriverMachOReproducibility(input) {
  const inspected = inspectCuaDriverMachOIdentity(input);
  const identityNeutral = Buffer.from(input);
  identityNeutral.fill(0, inspected.uuidOffset, inspected.uuidOffset + 16);
  if (inspected.codeSignature) {
    identityNeutral.fill(
      0,
      inspected.codeSignature.offset,
      inspected.codeSignature.offset + inspected.codeSignature.size,
    );
  }

  const commandCount = input.readUInt32LE(16);
  const commandBytes = input.readUInt32LE(20);
  const commandEnd = MACHO_HEADER_BYTES + commandBytes;
  const sections = [];
  const segments = [];
  let cursor = MACHO_HEADER_BYTES;
  for (let index = 0; index < commandCount; index += 1) {
    const command = input.readUInt32LE(cursor);
    const size = input.readUInt32LE(cursor + 4);
    if (command === LC_SEGMENT_64) {
      if (size < SEGMENT_COMMAND_BYTES) {
        throw new Error("Cua Driver diagnostic segment command is truncated");
      }
      const segmentName = readMachOName(input, cursor + 8);
      const fileOffset = toSafeNumber(
        input.readBigUInt64LE(cursor + 40),
        `${segmentName || "<anonymous>"} segment offset`,
      );
      const fileSize = toSafeNumber(
        input.readBigUInt64LE(cursor + 48),
        `${segmentName || "<anonymous>"} segment size`,
      );
      const sectionCount = input.readUInt32LE(cursor + 64);
      if (SEGMENT_COMMAND_BYTES + sectionCount * SECTION_COMMAND_BYTES > size) {
        throw new Error("Cua Driver diagnostic section table exceeds its segment command");
      }
      assertFileRange(input, fileOffset, fileSize, `${segmentName || "<anonymous>"} segment`);
      if (fileSize > 0) {
        segments.push(Object.freeze({
          name: segmentName,
          offset: fileOffset,
          size: fileSize,
          sha256: sha256(identityNeutral.subarray(fileOffset, fileOffset + fileSize)),
        }));
      }
      for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
        const section = cursor + SEGMENT_COMMAND_BYTES + sectionIndex * SECTION_COMMAND_BYTES;
        const sectionName = readMachOName(input, section);
        const sectionSegmentName = readMachOName(input, section + 16);
        const sectionSize = toSafeNumber(
          input.readBigUInt64LE(section + 40),
          `${sectionSegmentName},${sectionName} section size`,
        );
        const sectionOffset = input.readUInt32LE(section + 48);
        const sectionType = input.readUInt32LE(section + 64) & 0xff;
        if (sectionSize === 0 || ZERO_FILL_SECTION_TYPES.has(sectionType)) continue;
        assertFileRange(
          input,
          sectionOffset,
          sectionSize,
          `${sectionSegmentName},${sectionName} section`,
        );
        sections.push(Object.freeze({
          name: `${sectionSegmentName},${sectionName}`,
          offset: sectionOffset,
          size: sectionSize,
          sha256: sha256(input.subarray(sectionOffset, sectionOffset + sectionSize)),
        }));
      }
    }
    cursor += size;
  }
  if (cursor !== commandEnd) {
    throw new Error("Cua Driver diagnostic load commands are misaligned");
  }
  return Object.freeze({
    sourceSha256: sha256(identityNeutral),
    loadCommandsSha256: sha256(
      identityNeutral.subarray(MACHO_HEADER_BYTES, commandEnd),
    ),
    segments: Object.freeze(segments),
    sections: Object.freeze(sections),
  });
}

function formatUuid(bytes) {
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-").toUpperCase();
}

function readMachOName(bytes, offset) {
  const field = bytes.subarray(offset, offset + 16);
  const zero = field.indexOf(0);
  return field.subarray(0, zero < 0 ? field.length : zero).toString("ascii");
}

function assertFileRange(bytes, offset, size, label) {
  if (!Number.isSafeInteger(offset)
    || !Number.isSafeInteger(size)
    || offset < 0
    || size < 0
    || offset + size > bytes.length) {
    throw new Error(`Cua Driver diagnostic ${label} is out of range`);
  }
}

function toSafeNumber(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Cua Driver diagnostic ${label} is outside the safe integer range`);
  }
  return number;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
