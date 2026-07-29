import { deflateRawSync } from "node:zlib";
import { lingLightTheme } from "../../dist/index.js";

const textEncoder = new TextEncoder();

export const IMAGE_BYTES = Object.freeze({
  jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  webp: Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
});

export function importedManifest(overrides = {}) {
  return {
    ...structuredClone(lingLightTheme),
    id: "quiet-focus",
    name: "Quiet Focus",
    source: "local-import",
    ...overrides,
  };
}

export function themePackageFixture({
  extraEntries = [],
  license,
  manifest = importedManifest(),
  preview,
} = {}) {
  const entries = [
    { name: "theme.json", bytes: textEncoder.encode(JSON.stringify(manifest)), compression: "deflate" },
  ];
  if (license !== undefined) entries.push({ name: "LICENSE.txt", bytes: textEncoder.encode(license) });
  if (preview) entries.push({ name: preview.path, bytes: preview.bytes, compression: preview.compression });
  entries.push(...extraEntries);
  return createZip(entries);
}

export function createZip(entries, options = {}) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const source of entries) {
    const nameBytes = textEncoder.encode(source.name);
    const rawBytes = toBytes(source.bytes ?? new Uint8Array());
    const compression = source.compression === "deflate" ? 8 : 0;
    const compressed = compression === 8 ? new Uint8Array(deflateRawSync(rawBytes)) : rawBytes;
    const checksum = crc32(rawBytes);
    const flags = source.flags ?? 0;
    const localExtra = source.localExtra ?? new Uint8Array();
    const centralExtra = source.centralExtra ?? localExtra;
    const descriptor = Boolean(source.dataDescriptor);
    const effectiveFlags = descriptor ? flags | 0x0008 : flags;
    const mode = source.mode ?? (source.name.endsWith("/") ? 0o040755 : 0o100644);
    const externalAttributes = source.externalAttributes ?? ((mode << 16) >>> 0);
    const madeBy = source.madeBy ?? 0x0314;

    const local = new Uint8Array(30 + nameBytes.length + localExtra.length);
    const localView = new DataView(local.buffer);
    write32(localView, 0, 0x04034b50);
    write16(localView, 4, 20);
    write16(localView, 6, effectiveFlags);
    write16(localView, 8, compression);
    if (!descriptor) {
      write32(localView, 14, checksum);
      write32(localView, 18, compressed.length);
      write32(localView, 22, rawBytes.length);
    }
    write16(localView, 26, nameBytes.length);
    write16(localView, 28, localExtra.length);
    local.set(nameBytes, 30);
    local.set(localExtra, 30 + nameBytes.length);
    localParts.push(local, compressed);

    let descriptorBytes = new Uint8Array();
    if (descriptor) {
      descriptorBytes = new Uint8Array(16);
      const descriptorView = new DataView(descriptorBytes.buffer);
      write32(descriptorView, 0, 0x08074b50);
      write32(descriptorView, 4, checksum);
      write32(descriptorView, 8, compressed.length);
      write32(descriptorView, 12, rawBytes.length);
      localParts.push(descriptorBytes);
    }

    const central = new Uint8Array(46 + nameBytes.length + centralExtra.length);
    const centralView = new DataView(central.buffer);
    write32(centralView, 0, 0x02014b50);
    write16(centralView, 4, madeBy);
    write16(centralView, 6, 20);
    write16(centralView, 8, effectiveFlags);
    write16(centralView, 10, compression);
    write32(centralView, 16, checksum);
    write32(centralView, 20, compressed.length);
    write32(centralView, 24, rawBytes.length);
    write16(centralView, 28, nameBytes.length);
    write16(centralView, 30, centralExtra.length);
    write16(centralView, 34, 0);
    write32(centralView, 38, externalAttributes);
    write32(centralView, 42, localOffset);
    central.set(nameBytes, 46);
    central.set(centralExtra, 46 + nameBytes.length);
    centralParts.push(central);

    localOffset += local.length + compressed.length + descriptorBytes.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const comment = toBytes(options.comment ?? new Uint8Array());
  const eocd = new Uint8Array(22 + comment.length);
  const eocdView = new DataView(eocd.buffer);
  write32(eocdView, 0, 0x06054b50);
  write16(eocdView, 8, entries.length);
  write16(eocdView, 10, entries.length);
  write32(eocdView, 12, centralDirectory.length);
  write32(eocdView, 16, localOffset);
  write16(eocdView, 20, comment.length);
  eocd.set(comment, 22);
  return concatBytes([...localParts, centralDirectory, eocd]);
}

export function cloneBytes(bytes) {
  return bytes.slice();
}

export function zipOffsets(bytes) {
  const view = dataView(bytes);
  const eocd = findSignature(view, 0x06054b50, true);
  if (eocd < 0) throw new Error("Fixture has no EOCD.");
  const central = view.getUint32(eocd + 16, true);
  const local = view.getUint32(central + 42, true);
  return { central, eocd, local };
}

export function set16(bytes, offset, value) {
  dataView(bytes).setUint16(offset, value, true);
  return bytes;
}

export function set32(bytes, offset, value) {
  dataView(bytes).setUint32(offset, value >>> 0, true);
  return bytes;
}

export function appendBytes(bytes, suffix) {
  return concatBytes([bytes, toBytes(suffix)]);
}

function concatBytes(parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return textEncoder.encode(value);
  return Uint8Array.from(value);
}

function dataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findSignature(view, signature, reverse = false) {
  if (reverse) {
    for (let offset = view.byteLength - 4; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) === signature) return offset;
    }
    return -1;
  }
  for (let offset = 0; offset <= view.byteLength - 4; offset += 1) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  return -1;
}

function write16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function write32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}
