import {
  LING_THEME_PACKAGE_LIMITS,
  type LingThemePackageIndexEntry,
  type LingThemePackageIssue,
} from "./package-types.js";
import { normalizeThemePackagePath } from "./validate-package-index.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_ENTRY_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const UTF8_NAMES_FLAG = 0x0800;
const MAX_EOCD_SEARCH = 65_557;

export interface InspectedZipEntry extends LingThemePackageIndexEntry {
  readonly compressionMethod: 0 | 8;
  readonly dataOffset: number;
  readonly dataEnd: number;
  readonly localHeaderOffset: number;
  readonly recordEnd: number;
}

export type ZipCentralDirectoryInspection =
  | { readonly ok: true; readonly entries: readonly InspectedZipEntry[] }
  | { readonly ok: false; readonly issues: readonly LingThemePackageIssue[] };

export function inspectZipCentralDirectory(bytes: Uint8Array): ZipCentralDirectoryInspection {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEocd(view);
  if (eocdOffset < 0) return invalid("invalid-archive", "$", "Theme file is not a supported ZIP archive.");
  if (eocdOffset + 22 > view.byteLength) return invalid("invalid-archive", "$", "Theme archive footer is truncated.");
  if (eocdOffset >= 20 && read32(view, eocdOffset - 20) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
    return invalid("unsupported-archive", "$", "ZIP64 theme archives are not supported.");
  }

  const diskNumber = read16(view, eocdOffset + 4);
  const directoryDisk = read16(view, eocdOffset + 6);
  const entriesOnDisk = read16(view, eocdOffset + 8);
  const entryCount = read16(view, eocdOffset + 10);
  const directoryBytes = read32(view, eocdOffset + 12);
  const directoryOffset = read32(view, eocdOffset + 16);
  const commentBytes = read16(view, eocdOffset + 20);
  if (eocdOffset + 22 + commentBytes !== view.byteLength) {
    return invalid("invalid-archive", "$", "Theme archive has trailing or truncated data.");
  }
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    return invalid("unsupported-archive", "$", "Multi-volume theme archives are not supported.");
  }
  if (
    entryCount === ZIP64_SENTINEL_16
    || directoryBytes === ZIP64_SENTINEL_32
    || directoryOffset === ZIP64_SENTINEL_32
  ) {
    return invalid("unsupported-archive", "$", "ZIP64 theme archives are not supported.");
  }
  if (entryCount > LING_THEME_PACKAGE_LIMITS.entryCount) {
    return invalid("too-many-entries", "$", "Theme archive contains too many entries.");
  }
  if (
    directoryOffset > eocdOffset
    || directoryBytes > eocdOffset - directoryOffset
    || directoryOffset + directoryBytes !== eocdOffset
  ) {
    return invalid("invalid-archive", "$", "Theme archive directory is outside the file boundary.");
  }

  const entries: InspectedZipEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocdOffset || read32(view, offset) !== CENTRAL_ENTRY_SIGNATURE) {
      return invalid("invalid-archive", "$", "Theme archive directory entry is malformed.");
    }
    const madeBy = read16(view, offset + 4);
    const versionNeeded = read16(view, offset + 6);
    const flags = read16(view, offset + 8);
    const compression = read16(view, offset + 10);
    const modifiedTime = read16(view, offset + 12);
    const modifiedDate = read16(view, offset + 14);
    const crc32 = read32(view, offset + 16);
    const compressedBytes = read32(view, offset + 20);
    const uncompressedBytes = read32(view, offset + 24);
    const nameBytes = read16(view, offset + 28);
    const extraBytes = read16(view, offset + 30);
    const entryCommentBytes = read16(view, offset + 32);
    const startDisk = read16(view, offset + 34);
    const externalAttributes = read32(view, offset + 38);
    const localHeaderOffset = read32(view, offset + 42);
    const entryEnd = offset + 46 + nameBytes + extraBytes + entryCommentBytes;
    if (entryEnd > eocdOffset || nameBytes === 0) {
      return invalid("invalid-archive", "$", "Theme archive contains a truncated entry.");
    }
    const supportIssue = unsupportedEntryMetadata(
      view,
      offset + 46 + nameBytes,
      extraBytes,
      flags,
      compression,
      versionNeeded,
      startDisk,
      compressedBytes,
      uncompressedBytes,
      localHeaderOffset,
    );
    if (supportIssue) return supportIssue;
    if (localHeaderOffset >= directoryOffset) {
      return invalid("invalid-archive", "$", "Theme archive local entry points outside the data region.");
    }

    const originalPath = decodeAsciiPath(bytes.subarray(offset + 46, offset + 46 + nameBytes));
    if (!originalPath) return invalid("unsafe-path", "$", "Theme archive entry names must use safe ASCII paths.");
    const kind = entryKind(madeBy, externalAttributes, originalPath);
    const normalizedPath = normalizeThemePackagePath(originalPath, kind === "directory");
    if (!normalizedPath || /^[a-zA-Z]:/u.test(originalPath)) {
      return invalid("unsafe-path", originalPath, "Theme archive entry path is unsafe or not canonical.");
    }
    const local = inspectLocalEntry({
      bytes,
      compressedBytes,
      compression,
      crc32,
      dataBoundary: directoryOffset,
      flags,
      localHeaderOffset,
      modifiedDate,
      modifiedTime,
      originalPath,
      uncompressedBytes,
      versionNeeded,
      view,
    });
    if (!local.ok) return local.result;
    entries.push(Object.freeze({
      compressedBytes,
      compressionMethod: compression as 0 | 8,
      crc32,
      dataEnd: local.dataEnd,
      dataOffset: local.dataOffset,
      kind,
      localHeaderOffset,
      originalPath,
      path: normalizedPath,
      recordEnd: local.recordEnd,
      uncompressedBytes,
    }));
    offset = entryEnd;
  }
  if (offset !== directoryOffset + directoryBytes) {
    return invalid("invalid-archive", "$", "Theme archive directory length does not match its entries.");
  }
  const layoutIssue = validateLocalEntryLayout(entries, directoryOffset);
  return layoutIssue ?? { ok: true, entries: Object.freeze(entries) };
}

interface LocalInspectionInput {
  readonly bytes: Uint8Array;
  readonly compressedBytes: number;
  readonly compression: number;
  readonly crc32: number;
  readonly dataBoundary: number;
  readonly flags: number;
  readonly localHeaderOffset: number;
  readonly modifiedDate: number;
  readonly modifiedTime: number;
  readonly originalPath: string;
  readonly uncompressedBytes: number;
  readonly versionNeeded: number;
  readonly view: DataView;
}

type LocalInspection =
  | { readonly ok: true; readonly dataEnd: number; readonly dataOffset: number; readonly recordEnd: number }
  | { readonly ok: false; readonly result: ZipCentralDirectoryInspection };

function inspectLocalEntry(input: LocalInspectionInput): LocalInspection {
  const { view, localHeaderOffset: offset } = input;
  if (offset + 30 > input.dataBoundary || read32(view, offset) !== LOCAL_ENTRY_SIGNATURE) {
    return localInvalid(input.originalPath);
  }
  if (
    read16(view, offset + 4) !== input.versionNeeded
    || read16(view, offset + 6) !== input.flags
    || read16(view, offset + 8) !== input.compression
    || read16(view, offset + 10) !== input.modifiedTime
    || read16(view, offset + 12) !== input.modifiedDate
  ) return localInvalid(input.originalPath);
  const nameBytes = read16(view, offset + 26);
  const extraBytes = read16(view, offset + 28);
  const dataOffset = offset + 30 + nameBytes + extraBytes;
  if (dataOffset > input.dataBoundary) return localInvalid(input.originalPath);
  const localName = decodeAsciiPath(input.bytes.subarray(offset + 30, offset + 30 + nameBytes));
  if (localName !== input.originalPath) return localInvalid(input.originalPath);
  const localExtra = inspectExtraFields(view, offset + 30 + nameBytes, extraBytes);
  if (!localExtra.ok || localExtra.hasZip64) return localInvalid(input.originalPath, "unsupported-archive");

  const usesDescriptor = (input.flags & DATA_DESCRIPTOR_FLAG) !== 0;
  if (!usesDescriptor && (
    read32(view, offset + 14) !== input.crc32
    || read32(view, offset + 18) !== input.compressedBytes
    || read32(view, offset + 22) !== input.uncompressedBytes
  )) return localInvalid(input.originalPath);
  if (usesDescriptor && !localDescriptorPlaceholdersMatch(view, offset, input)) {
    return localInvalid(input.originalPath);
  }
  const dataEnd = dataOffset + input.compressedBytes;
  if (dataEnd > input.dataBoundary) return localInvalid(input.originalPath);
  const recordEnd = usesDescriptor ? inspectDataDescriptor(view, dataEnd, input) : dataEnd;
  if (recordEnd < 0 || recordEnd > input.dataBoundary) return localInvalid(input.originalPath);
  return { ok: true, dataEnd, dataOffset, recordEnd };
}

function localDescriptorPlaceholdersMatch(view: DataView, offset: number, input: LocalInspectionInput): boolean {
  const crc = read32(view, offset + 14);
  const compressed = read32(view, offset + 18);
  const uncompressed = read32(view, offset + 22);
  return (crc === 0 || crc === input.crc32)
    && (compressed === 0 || compressed === input.compressedBytes)
    && (uncompressed === 0 || uncompressed === input.uncompressedBytes);
}

function inspectDataDescriptor(view: DataView, offset: number, input: LocalInspectionInput): number {
  if (offset + 12 > input.dataBoundary) return -1;
  const hasSignature = read32(view, offset) === DATA_DESCRIPTOR_SIGNATURE;
  const payloadOffset = hasSignature ? offset + 4 : offset;
  if (payloadOffset + 12 > input.dataBoundary) return -1;
  if (
    read32(view, payloadOffset) !== input.crc32
    || read32(view, payloadOffset + 4) !== input.compressedBytes
    || read32(view, payloadOffset + 8) !== input.uncompressedBytes
  ) return -1;
  return payloadOffset + 12;
}

function unsupportedEntryMetadata(
  view: DataView,
  extraOffset: number,
  extraBytes: number,
  flags: number,
  compression: number,
  versionNeeded: number,
  startDisk: number,
  compressedBytes: number,
  uncompressedBytes: number,
  localHeaderOffset: number,
): ZipCentralDirectoryInspection | undefined {
  if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
    return invalid("unsupported-archive", "$", "Encrypted theme archives are not supported.");
  }
  if (compression !== 0 && compression !== 8) {
    return invalid("unsupported-archive", "$", "Theme archive uses an unsupported compression method.");
  }
  const allowedFlags = UTF8_NAMES_FLAG | DATA_DESCRIPTOR_FLAG | (compression === 8 ? 0x0006 : 0);
  if ((flags & ~allowedFlags) !== 0 || versionNeeded > 20) {
    return invalid("unsupported-archive", "$", "Theme archive uses unsupported ZIP features.");
  }
  if (
    compressedBytes === ZIP64_SENTINEL_32
    || uncompressedBytes === ZIP64_SENTINEL_32
    || localHeaderOffset === ZIP64_SENTINEL_32
    || startDisk !== 0
  ) return invalid("unsupported-archive", "$", "Theme archive uses unsupported ZIP64 or split metadata.");
  const extras = inspectExtraFields(view, extraOffset, extraBytes);
  if (!extras.ok) return invalid("invalid-archive", "$", "Theme archive extra fields are malformed.");
  if (extras.hasZip64) return invalid("unsupported-archive", "$", "ZIP64 theme archives are not supported.");
  return undefined;
}

function inspectExtraFields(view: DataView, offset: number, byteLength: number): { readonly hasZip64: boolean; readonly ok: boolean } {
  const end = offset + byteLength;
  if (end > view.byteLength) return { hasZip64: false, ok: false };
  let cursor = offset;
  let hasZip64 = false;
  while (cursor < end) {
    if (cursor + 4 > end) return { hasZip64, ok: false };
    const id = read16(view, cursor);
    const fieldBytes = read16(view, cursor + 2);
    cursor += 4;
    if (cursor + fieldBytes > end) return { hasZip64, ok: false };
    if (id === ZIP64_EXTRA_FIELD) hasZip64 = true;
    cursor += fieldBytes;
  }
  return { hasZip64, ok: cursor === end };
}

function validateLocalEntryLayout(
  entries: readonly InspectedZipEntry[],
  directoryOffset: number,
): ZipCentralDirectoryInspection | undefined {
  const ordered = [...entries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
  let expectedOffset = 0;
  for (const entry of ordered) {
    if (entry.localHeaderOffset !== expectedOffset || entry.recordEnd < entry.dataEnd) {
      return invalid("invalid-archive", entry.path, "Theme archive contains overlapping or untracked local data.");
    }
    expectedOffset = entry.recordEnd;
  }
  if (expectedOffset !== directoryOffset) {
    return invalid("invalid-archive", "$", "Theme archive contains untracked data before its directory.");
  }
  return undefined;
}

function findEocd(view: DataView): number {
  const start = Math.max(0, view.byteLength - MAX_EOCD_SEARCH);
  for (let offset = view.byteLength - 22; offset >= start; offset -= 1) {
    if (read32(view, offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function entryKind(madeBy: number, externalAttributes: number, path: string): LingThemePackageIndexEntry["kind"] {
  const host = madeBy >>> 8;
  if (host === 3 || host === 19) {
    const fileType = (externalAttributes >>> 16) & 0xf000;
    if (fileType === 0xa000) return "symlink";
    if (fileType === 0x4000) return "directory";
    if (fileType !== 0 && fileType !== 0x8000) return "special";
  }
  if (path.endsWith("/") || (externalAttributes & 0x10) !== 0) return "directory";
  return "file";
}

function decodeAsciiPath(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0 || bytes.length > 240 || bytes.some((value) => value === 0 || value > 0x7f)) return undefined;
  return String.fromCharCode(...bytes);
}

function localInvalid(path: string, code = "invalid-archive"): LocalInspection {
  return { ok: false, result: invalid(code, path, "Theme archive local and central entry metadata do not match.") };
}

function read16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function read32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function invalid(code: string, path: string, message: string): ZipCentralDirectoryInspection {
  return { ok: false, issues: [Object.freeze({ code, path, message })] };
}
