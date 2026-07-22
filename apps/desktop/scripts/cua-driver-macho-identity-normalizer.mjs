import { createHash } from "node:crypto";

const MACHO_MAGIC_64 = 0xfeedfacf;
const MACHO_HEADER_BYTES = 32;
const MACHO_EXECUTE = 0x2;
const LC_UUID = 0x1b;
const LC_CODE_SIGNATURE = 0x1d;
const UUID_COMMAND_BYTES = 24;
const CODE_SIGNATURE_COMMAND_BYTES = 16;

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
