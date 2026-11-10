/**
 * Fail-closed roster for the bounded, single-volume 32-bit OOXML ZIP subset.
 * JSZip folds duplicate names and discards directory/declared-empty payloads;
 * reject those ambiguities before its public stream objects are used for budgets.
 * No SDK-private ZIP structures or claimed uncompressed sizes establish a budget.
 */
export function assertOfficePackageRoster(bytes: Buffer): void {
  const eocd = findEnd(bytes);
  const count = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0
    || bytes.readUInt16LE(eocd + 8) !== count || count === 0 || count > 5000
    || count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff
    || directoryOffset + directorySize !== eocd) invalid();
  const names = new Set<string>();
  let offset = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) invalid();
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20);
    const expanded = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const attributes = bytes.readUInt32LE(offset + 38);
    const local = bytes.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || (flags & 1) !== 0 || (method !== 0 && method !== 8)
      || bytes.readUInt16LE(offset + 34) !== 0 || local === 0xffffffff
      || compressed === 0xffffffff || expanded === 0xffffffff) invalid();
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBytes.toString("utf8");
    if (!Buffer.from(name, "utf8").equals(nameBytes) || unsafeName(name)) invalid();
    validateExtras(bytes, offset + 46 + nameLength, extraLength, flags);
    const madeBy = bytes.readUInt16LE(offset + 4) >>> 8;
    const unixDirectory = madeBy === 3 && ((attributes >>> 16) & 0x4000) !== 0;
    const directory = (attributes & 0x10) !== 0 || unixDirectory || name.endsWith("/");
    const key = directory && !name.endsWith("/") ? `${name}/` : name;
    if (names.has(key) || (expanded === 0 && compressed !== 0)
      || (directory && (expanded !== 0 || compressed !== 0 || crc !== 0))) invalid();
    names.add(key);
    // JSZip takes the name from the local header. It must not differ from the
    // central roster whose cardinality, flags and payloads we just checked.
    if (local + 30 > directoryOffset || bytes.readUInt32LE(local) !== 0x04034b50
      || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) invalid();
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    const dataOffset = local + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressed > directoryOffset
      || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) invalid();
    validateExtras(bytes, local + 30 + localNameLength, localExtraLength, flags);
    if ((flags & 8) === 0 && (bytes.readUInt32LE(local + 14) !== crc
      || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== expanded)) invalid();
    offset = end;
  }
  if (offset !== eocd) invalid();
}

function findEnd(bytes: Buffer): number {
  if (bytes.length < 22) return invalid();
  // Match JSZip's last-signature selection exactly. Do not validate an earlier
  // footer while the SDK will instead interpret a signature inside its comment.
  const offset = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (offset < 0 || offset + 22 > bytes.length || offset + 22 + bytes.readUInt16LE(offset + 20) !== bytes.length) return invalid();
  return offset;
}

function validateExtras(bytes: Buffer, offset: number, length: number, flags: number): void {
  const end = offset + length;
  if (end > bytes.length) invalid();
  while (offset < end) {
    if (offset + 4 > end) invalid();
    const kind = bytes.readUInt16LE(offset);
    const size = bytes.readUInt16LE(offset + 2);
    // ZIP64 is outside the fixed <=50 MiB source protocol. Without the UTF8
    // flag, a Unicode path extra can rename/merge entries after our roster read.
    if (kind === 0x0001 || (kind === 0x7075 && (flags & 0x800) === 0) || offset + 4 + size > end) invalid();
    offset += 4 + size;
  }
}

function unsafeName(name: string): boolean {
  if (!name || name.startsWith("/") || name.includes("\\")) return true;
  const value = name.endsWith("/") ? name.slice(0, -1) : name;
  return !value || value.split("/").some(part => !part || part === "." || part === "..");
}

function invalid(): never { throw new Error("office_document_package_invalid"); }
