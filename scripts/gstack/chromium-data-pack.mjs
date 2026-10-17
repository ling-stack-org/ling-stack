import { brotliDecompressSync, gunzipSync } from "node:zlib";

const fail = reason => { throw new Error(`gstack_chromium_pack_${reason}`); };
const defaults = { maxPackBytes: 64 * 1024 * 1024, maxResources: 20_000, maxAliases: 20_000 };
const resourceMaximum = 8 * 1024 * 1024;

function bounded(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail("limits_invalid");
  return value;
}

// GRIT prepends a two-byte Brotli marker and six-byte little-endian length.
// Preserve bytes; decoding is inspection only and never renders resource HTML.
export function decodeChromiumResource(bytes, { maxOutputBytes = resourceMaximum } = {}) {
  bounded(maxOutputBytes, defaults.maxPackBytes);
  if (!Buffer.isBuffer(bytes)) fail("input_invalid");
  let format = "plain", payload = bytes, expected = bytes.length;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (bytes.length < 18) fail("compression_invalid");
    format = "gzip"; expected = bytes.readUInt32LE(bytes.length - 4);
  } else if (bytes[0] === 0x1e && bytes[1] === 0x9b) {
    if (bytes.length < 9) fail("compression_invalid");
    format = "brotli"; expected = bytes.readUIntLE(2, 6); payload = bytes.subarray(8);
  }
  if (expected > maxOutputBytes) fail("size_invalid");
  if (format === "plain") return { format, bytes };
  let result;
  try {
    result = (format === "gzip" ? gunzipSync : brotliDecompressSync)(payload, { maxOutputLength: maxOutputBytes, info: true });
  } catch { fail("compression_invalid"); }
  if (result.buffer.length !== expected || result.engine.bytesWritten !== payload.length) fail("compression_size_mismatch");
  return { format, bytes: result.buffer };
}

export function parseChromiumDataPack(input, overrides = {}) {
  const limits = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(defaults, key)) fail("limits_invalid");
    limits[key] = bounded(value, defaults[key]);
  }
  if (!Buffer.isBuffer(input)) fail("input_invalid");
  if (input.length < 4 || input.length > limits.maxPackBytes) fail("size_invalid");
  const decoded = input[0] === 0x1f && input[1] === 0x8b
    ? decodeChromiumResource(input, { maxOutputBytes: limits.maxPackBytes }) : { format: "plain", bytes: input };
  const bytes = decoded.bytes;
  if (bytes.length < 4) fail("header_invalid");
  const version = bytes.readUInt32LE(0), headerSize = version === 4 ? 9 : version === 5 ? 12 : 0;
  if (!headerSize || bytes.length < headerSize) fail("header_invalid");
  const encoding = bytes[version === 4 ? 8 : 4];
  if (encoding > 2 || version === 5 && (bytes[5] || bytes[6] || bytes[7])) fail("encoding_invalid");
  const count = version === 4 ? bytes.readUInt32LE(4) : bytes.readUInt16LE(8);
  const aliasCount = version === 4 ? 0 : bytes.readUInt16LE(10);
  if (count > limits.maxResources || aliasCount > limits.maxAliases) fail("resource_count_invalid");
  const aliasStart = headerSize + (count + 1) * 6, tableEnd = aliasStart + aliasCount * 4;
  if (tableEnd > bytes.length) fail("table_invalid");
  const entry = index => ({ id: bytes.readUInt16LE(headerSize + index * 6), offset: bytes.readUInt32LE(headerSize + index * 6 + 2) });
  if (entry(0).offset !== tableEnd || entry(count).offset !== bytes.length || entry(count).id !== 0) fail("sentinel_invalid");
  const resources = [], ids = new Set(), aliases = [];
  let previousId = 0;
  for (let index = 0; index < count; index++) {
    const current = entry(index), next = entry(index + 1);
    if (current.id <= previousId || current.offset < tableEnd || next.offset < current.offset || next.offset > bytes.length) fail("index_invalid");
    resources.push({ id: current.id, offset: current.offset, bytes: bytes.subarray(current.offset, next.offset) });
    ids.add(current.id); previousId = current.id;
  }
  previousId = 0;
  for (let index = 0; index < aliasCount; index++) {
    const position = aliasStart + index * 4, id = bytes.readUInt16LE(position), target = bytes.readUInt16LE(position + 2);
    if (id <= previousId || ids.has(id) || target >= count) fail("alias_invalid");
    aliases.push({ id, resourceId: resources[target].id }); previousId = id;
  }
  return { version, encoding, containerCompression: decoded.format, resources, aliases };
}
