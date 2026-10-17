import assert from "node:assert/strict";
import { brotliCompressSync, gzipSync } from "node:zlib";
import test from "node:test";
import { decodeChromiumResource, parseChromiumDataPack } from "./chromium-data-pack.mjs";

export function packFixture({ version = 5, resources = [[7, Buffer.from("first")], [21, Buffer.from("second")]],
  aliases = version === 5 ? [[30, 0]] : [] } = {}) {
  const headerSize = version === 4 ? 9 : 12;
  const tableEnd = headerSize + (resources.length + 1) * 6 + aliases.length * 4;
  const bytes = Buffer.alloc(tableEnd + resources.reduce((total, [, payload]) => total + payload.length, 0));
  bytes.writeUInt32LE(version);
  if (version === 4) { bytes.writeUInt32LE(resources.length, 4); bytes[8] = 1; }
  else { bytes[4] = 1; bytes.writeUInt16LE(resources.length, 8); bytes.writeUInt16LE(aliases.length, 10); }
  let offset = tableEnd;
  for (const [index, [id, payload]] of resources.entries()) {
    bytes.writeUInt16LE(id, headerSize + index * 6); bytes.writeUInt32LE(offset, headerSize + index * 6 + 2);
    payload.copy(bytes, offset); offset += payload.length;
  }
  bytes.writeUInt32LE(offset, headerSize + resources.length * 6 + 2);
  for (const [index, [id, target]] of aliases.entries()) {
    const position = headerSize + (resources.length + 1) * 6 + index * 4;
    bytes.writeUInt16LE(id, position); bytes.writeUInt16LE(target, position + 2);
  }
  return bytes;
}

function brotli(bytes) {
  const header = Buffer.alloc(8); header[0] = 0x1e; header[1] = 0x9b; header.writeUIntLE(bytes.length, 2, 6);
  return Buffer.concat([header, brotliCompressSync(bytes)]);
}

test("Chromium v4/v5 index parsing preserves original resource bytes, empty resources and canonical aliases", () => {
  for (const version of [4, 5]) {
    const parsed = parseChromiumDataPack(packFixture({ version }));
    assert.equal(parsed.version, version); assert.equal(parsed.encoding, 1);
    assert.deepEqual(parsed.resources.map(r => [r.id, r.bytes.toString()]), [[7, "first"], [21, "second"]]);
    assert.deepEqual(parsed.aliases, version === 4 ? [] : [{ id: 30, resourceId: 7 }]);
  }
  assert.equal(parseChromiumDataPack(packFixture({ resources: [[7, Buffer.alloc(0)]], aliases: [] })).resources[0].bytes.length, 0);
  assert.equal(parseChromiumDataPack(packFixture({ resources: [], aliases: [] })).resources.length, 0);
});

test("Chromium resource decoder validates plain, gzip, GRIT Brotli and whole gzip-compressed packs", () => {
  const bytes = Buffer.from("original license\nwith complete notice bytes\n");
  for (const [format, payload] of [["plain", bytes], ["gzip", gzipSync(bytes)], ["brotli", brotli(bytes)]]) {
    const decoded = decodeChromiumResource(payload);
    assert.equal(decoded.format, format); assert.deepEqual(decoded.bytes, bytes);
  }
  const parsed = parseChromiumDataPack(gzipSync(packFixture()));
  assert.equal(parsed.containerCompression, "gzip");
  assert.equal(parsed.resources[0].bytes.toString(), "first");
});

test("legitimate compressed empty resources preserve zero bytes without accepting a false zero-length claim", () => {
  for (const bytes of [gzipSync(Buffer.alloc(0)), brotli(Buffer.alloc(0))]) {
    assert.equal(decodeChromiumResource(bytes).bytes.length, 0);
  }
  const changed = brotli(Buffer.from("nonempty")); changed.writeUIntLE(0, 2, 6);
  assert.throws(() => decodeChromiumResource(changed), /compression_size_mismatch/);
});

test("invalid versions, encoding, tables, sentinels, overlapping offsets and hidden trailing bytes fail closed", () => {
  const alterations = [
    b => b.writeUInt32LE(6), b => b[4] = 3, b => b[5] = 1,
    b => b.writeUInt16LE(65535, 8), b => b.writeUInt16LE(65535, 10),
    b => b.writeUInt16LE(0, 12), b => b.writeUInt16LE(7, 18), b => b.writeUInt16LE(6, 18),
    b => b.writeUInt32LE(12, 14), b => b.writeUInt32LE(b.length + 1, 20),
    b => b.writeUInt32LE(b.readUInt32LE(14) - 1, 20),
    b => b.writeUInt16LE(1, 24), b => b.writeUInt32LE(b.length - 1, 26),
  ];
  for (const change of alterations) { const bytes = packFixture(); change(bytes); assert.throws(() => parseChromiumDataPack(bytes), /gstack_chromium_pack_/); }
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(3), packFixture().subarray(0, 15), Buffer.concat([packFixture(), Buffer.from("unindexed")])]) {
    assert.throws(() => parseChromiumDataPack(bytes), /gstack_chromium_pack_/);
  }
  assert.throws(() => parseChromiumDataPack(packFixture(), { maxResources: 1 }), /resource_count_invalid/);
  assert.throws(() => parseChromiumDataPack(packFixture(), { maxPackBytes: 1 }), /size_invalid/);
  assert.throws(() => parseChromiumDataPack(packFixture(), { maxPackBytes: Infinity }), /limits_invalid/);
});

test("aliases cannot collide with canonical IDs, point to EOF, repeat or arrive unsorted", () => {
  for (const aliases of [[[7, 0]], [[30, 2]], [[30, 65535]], [[30, 0], [30, 1]], [[31, 0], [30, 1]]]) {
    assert.throws(() => parseChromiumDataPack(packFixture({ aliases })), /alias_invalid/);
  }
  assert.throws(() => parseChromiumDataPack(packFixture(), { maxAliases: 0 }), /limits_invalid/);
});

test("compressed resource sizes, corruption and trailing Brotli bytes cannot evade output bounds", () => {
  const bytes = Buffer.alloc(8192, 65), gzip = gzipSync(bytes), compressed = brotli(bytes);
  for (const input of [bytes, gzip, compressed]) assert.throws(() => decodeChromiumResource(input, { maxOutputBytes: 1024 }), /size_invalid/);
  const mismatch = Buffer.from(compressed); mismatch.writeUIntLE(bytes.length - 1, 2, 6);
  const zero = Buffer.from(compressed); zero.writeUIntLE(0, 2, 6);
  const enormous = Buffer.from(compressed); enormous.fill(255, 2, 8);
  const corruptGzip = Buffer.from(gzip); corruptGzip[corruptGzip.length - 8] ^= 1;
  for (const input of [mismatch, zero, enormous, corruptGzip, gzip.subarray(0, 12), compressed.subarray(0, 5),
    Buffer.concat([compressed, Buffer.from("trailing")]), Buffer.concat([gzipSync(Buffer.from("a")), gzipSync(Buffer.from("b"))])]) {
    assert.throws(() => decodeChromiumResource(input), /gstack_chromium_pack_/);
  }
  assert.throws(() => decodeChromiumResource(bytes, { maxOutputBytes: -1 }), /limits_invalid/);
});
