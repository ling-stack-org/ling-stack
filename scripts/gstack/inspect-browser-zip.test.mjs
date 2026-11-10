import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifyBrowserArchiveSource } from "./collect-browser-archives.mjs";
import { inspectBrowserZip, validateBrowserMemberGraph } from "./inspect-browser-zip.mjs";

const stage = process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE && resolve(process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE);
const skip = !stage && "Set LING_GSTACK_PLATFORM_RESOURCE_STAGE for the verified pinned ZIP parser";
const target = { platform: "darwin", arch: "arm64" };
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
let yauzl, yazl;
if (stage) {
  const source = await verifyBrowserArchiveSource({ resourceStagePath: stage, target,
    expectedResourceStageChecksum: "sha256:a6d344a6675c34486db326801d86be736ccb1a3835afd19bc871af9923b640e1" });
  ({ yauzl, yazl } = createRequire(join(source.root, "runtime/package.json"))(join(source.packagePath, "lib/utilsBundle.js")));
}

async function fixture(t, entries) {
  const root = await mkdtemp(join(tmpdir(), "ling gstack zip inspection "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const zip = new yazl.ZipFile(), chunks = [];
  const done = new Promise((resolve, reject) => {
    zip.outputStream.on("data", bytes => chunks.push(bytes));
    zip.outputStream.on("end", resolve); zip.outputStream.on("error", reject);
  });
  for (const entry of entries) zip.addBuffer(entry.bytes, entry.path, { compress: entry.compress ?? false, mode: entry.mode ?? 0o100644 });
  zip.end(); await done;
  const zipPath = join(root, "candidate.zip"); await writeFile(zipPath, Buffer.concat(chunks));
  return { root, zipPath, options: { zipPath, yauzl, target } };
}

test("ZIP inspection hashes the actual uncompressed payload without extracting it", { skip }, async t => {
  const bytes = Buffer.from("exact browser resource payload");
  const f = await fixture(t, [{ path: "resources/file.dat", bytes }]);
  const result = await inspectBrowserZip(f.options);
  assert.equal(result.members.length, 1);
  assert.equal(result.members[0].checksum, checksum(bytes));
  assert.equal(result.members[0].sizeBytes, bytes.length);
  await assert.rejects(readFile(join(f.root, "resources/file.dat")), { code: "ENOENT" });
});

test("ZIP payload CRC corruption is rejected even when the outer archive remains parseable", { skip }, async t => {
  const bytes = Buffer.from("unique payload for CRC corruption fixture");
  const f = await fixture(t, [{ path: "resources/file.dat", bytes }]);
  const archive = await readFile(f.zipPath), offset = archive.indexOf(bytes);
  assert.ok(offset >= 0); archive[offset] ^= 1; await writeFile(f.zipPath, archive);
  await assert.rejects(inspectBrowserZip(f.options), /gstack_browser_member_crc_mismatch/);
});

function mach(arch = "arm64", fileType = 2) {
  const bytes = Buffer.alloc(128); bytes.writeUInt32LE(0xfeedfacf);
  bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  bytes.writeUInt32LE(fileType, 12); return bytes;
}

function universal() {
  const bytes = Buffer.alloc(8_320); bytes.writeUInt32BE(0xcafebabe); bytes.writeUInt32BE(2, 4);
  for (const [index, arch] of ["x64", "arm64"].entries()) {
    const entry = 8 + index * 20, offset = 4_096 * (index + 1);
    bytes.writeUInt32BE(arch === "arm64" ? 0x0100000c : 0x01000007, entry);
    bytes.writeUInt32BE(offset, entry + 8); bytes.writeUInt32BE(128, entry + 12); bytes.writeUInt32BE(12, entry + 16);
    mach(arch).copy(bytes, offset);
  }
  return bytes;
}

function pe() {
  const bytes = Buffer.alloc(512); bytes.write("MZ"); bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x00004550, 64); bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(1, 70); bytes.writeUInt16LE(240, 84); bytes.writeUInt16LE(2, 86); bytes.writeUInt16LE(0x20b, 88);
  return bytes;
}

test("native inspection checks actual thin Mach-O, universal slice headers and Windows PE targets without execution", { skip }, async t => {
  const f = await fixture(t, [{ path: "native/thin", bytes: mach() }, { path: "native/universal", bytes: universal() }]);
  const result = await inspectBrowserZip(f.options);
  assert.deepEqual(result.members.map(m => m.native), [
    { format: "mach-o", architectures: ["arm64"], fileType: "executable" },
    { format: "fat-mach-o", architectures: ["arm64", "x64"], fileType: "executable" },
  ]);
  const windows = await fixture(t, [{ path: "chrome.exe", bytes: pe() }]);
  const inspected = await inspectBrowserZip({ ...windows.options, target: { platform: "win32", arch: "x64" } });
  assert.deepEqual(inspected.members[0].native, { format: "pe", architectures: ["x64"], fileType: "executable" });
  await assert.rejects(inspectBrowserZip(windows.options), /native_target_mismatch/);
  await assert.rejects(inspectBrowserZip({ ...windows.options, target: { platform: "win32", arch: "arm64" } }), /native_target_mismatch/);
});

test("wrong native CPUs, corrupt universal slice declarations and malformed native extensions are rejected", { skip }, async t => {
  const changed = universal(); mach("x64").copy(changed, 8_192);
  const bounds = universal(); bounds.writeUInt32BE(100_000, 36);
  const overlap = universal(); overlap.writeUInt32BE(4_096, 36);
  for (const bytes of [mach("x64"), changed, bounds, overlap, mach("arm64", 1), Buffer.from("not a native library")]) {
    const f = await fixture(t, [{ path: "library.dylib", bytes }]);
    await assert.rejects(inspectBrowserZip(f.options), /gstack_browser_native_/);
  }
});

test("native slice observation spans multiple stream chunks and verifies distant slice bytes", { skip }, async t => {
  const bytes = Buffer.alloc(131_200), small = universal(); small.copy(bytes);
  bytes.fill(0, 8_192, 8_320); bytes.writeUInt32BE(131_072, 36); mach().copy(bytes, 131_072);
  const f = await fixture(t, [{ path: "universal", bytes, compress: true }]);
  const result = await inspectBrowserZip(f.options);
  assert.deepEqual(result.members[0].native.architectures, ["arm64", "x64"]);
  bytes.fill(0, 131_072, 131_104);
  const bad = await fixture(t, [{ path: "universal", bytes, compress: true }]);
  await assert.rejects(inspectBrowserZip(bad.options), /native_header_invalid/);
});

test("internal framework links resolve through directory aliases while retaining their original payload hashes", { skip }, async t => {
  const f = await fixture(t, [
    { path: "framework/Versions/A/file", bytes: mach() },
    { path: "framework/Versions/Current", bytes: Buffer.from("A"), mode: 0o120755 },
    { path: "framework/file", bytes: Buffer.from("Versions/Current/file"), mode: 0o120755 },
  ]);
  const result = await inspectBrowserZip(f.options), link = result.members.find(m => m.path === "framework/file");
  assert.equal(link.kind, "link"); assert.equal(link.linkTarget, "Versions/Current/file");
  assert.equal(link.checksum, checksum(Buffer.from("Versions/Current/file")));
  assert.equal(link.resolvedTarget, "framework/Versions/A/file"); assert.equal(link.targetKind, "file");
});

test("escaping, absolute, cyclic, dangling and ancestor links cannot become materialization candidates", { skip }, async t => {
  for (const entries of [
    [{ path: "framework/link", bytes: Buffer.from("../../outside"), mode: 0o120755 }],
    [{ path: "framework/link", bytes: Buffer.from("/outside"), mode: 0o120755 }],
    [{ path: "framework/link", bytes: Buffer.from("C:\\outside"), mode: 0o120755 }],
    [{ path: "framework/a", bytes: Buffer.from("b"), mode: 0o120755 }, { path: "framework/b", bytes: Buffer.from("a"), mode: 0o120755 }],
    [{ path: "framework/link", bytes: Buffer.from("missing"), mode: 0o120755 }],
    [{ path: "framework/link", bytes: Buffer.from("real"), mode: 0o120755 }, { path: "framework/link/file", bytes: Buffer.from("data") }],
  ]) {
    const f = await fixture(t, entries);
    await assert.rejects(inspectBrowserZip(f.options), /gstack_browser_member_(?:link_|path_collision)/);
  }
});

test("path graph rejects duplicate, case-fold, normalized-Unicode and file-versus-directory aliases", () => {
  for (const paths of [["a/file", "a/file"], ["a/file", "A/file"], ["a/e\u0301.txt", "a/\u00e9.txt"], ["a", "a/file"]]) {
    assert.throws(() => validateBrowserMemberGraph(paths.map(path => ({ path, kind: "file" }))), /member_path_collision/);
  }
});

test("real ZIP path traversal, platform aliases, special files and setuid permissions are rejected", { skip }, async t => {
  const f = await fixture(t, [{ path: "safeX/file", bytes: Buffer.from("data") }]);
  const bytes = await readFile(f.zipPath), before = Buffer.from("safeX/file"), after = Buffer.from("../xx/file");
  let offset = 0, count = 0;
  while ((offset = bytes.indexOf(before, offset)) !== -1) { after.copy(bytes, offset); offset += before.length; count++; }
  assert.equal(count, 2); await writeFile(f.zipPath, bytes);
  await assert.rejects(inspectBrowserZip(f.options), /invalid relative path|member_path_invalid/);
  for (const entry of [
    { path: "resources/CON.txt", bytes: Buffer.from("data") },
    { path: "resources/file.", bytes: Buffer.from("data") },
    { path: "resources/file", bytes: Buffer.from("data"), mode: 0o104644 },
    { path: "resources/pipe", bytes: Buffer.from("data"), mode: 0o010644 },
  ]) {
    const candidate = await fixture(t, [entry]);
    await assert.rejects(inspectBrowserZip(candidate.options), /member_(?:path|type)_invalid/);
  }
});

test("member count, individual size, aggregate size and compression ratio have hard limits", { skip }, async t => {
  const f = await fixture(t, [{ path: "a", bytes: Buffer.from("1234") }, { path: "b", bytes: Buffer.from("5678") }]);
  for (const limits of [{ maxMembers: 1 }, { maxMemberBytes: 3 }, { maxTotalBytes: 7 }]) {
    await assert.rejects(inspectBrowserZip({ ...f.options, limits }), /member_(?:count|size|total_size)_invalid/);
  }
  const compressed = await fixture(t, [{ path: "data", bytes: Buffer.alloc(4_096), compress: true }]);
  await assert.rejects(inspectBrowserZip({ ...compressed.options, limits: { maxCompressionRatio: 1 } }), /member_size_invalid/);
  for (const limits of [{ maxMembers: 0 }, { maxMembers: 5_001 }, { maxDurationMs: Infinity }, { other: 1 }]) {
    await assert.rejects(inspectBrowserZip({ ...f.options, limits }), /inspection_limits_invalid/);
  }
});

test("encrypted flags, unsupported compression, wrong roots and invalid notice payloads fail closed", { skip }, async t => {
  for (const field of ["encryption", "compression"]) {
    const f = await fixture(t, [{ path: "resources/file", bytes: Buffer.from("data"), compress: field === "encryption" }]);
    const bytes = await readFile(f.zipPath), directory = bytes.indexOf(Buffer.from("504b0102", "hex"));
    assert.ok(directory > 0);
    bytes.writeUInt16LE(field === "encryption" ? 1 : 99, directory + (field === "encryption" ? 8 : 10));
    await writeFile(f.zipPath, bytes);
    await assert.rejects(inspectBrowserZip(f.options), /member_(?:encrypted|compression_invalid)/);
  }
  const f = await fixture(t, [{ path: "resources/file", bytes: Buffer.from("data") }]);
  await assert.rejects(inspectBrowserZip({ ...f.options, rootPrefix: "other" }), /member_root_invalid/);
  for (const bytes of [Buffer.from("\0"), Buffer.from([0xff]), Buffer.from("  \n")]) {
    const notice = await fixture(t, [{ path: "LICENSE", bytes }]);
    await assert.rejects(inspectBrowserZip(notice.options), /notice_invalid|encoded data/);
  }
});

test("full notice text is retained verbatim as candidate evidence, not inferred license approval", { skip }, async t => {
  const bytes = Buffer.from("Original license grant\nCopyright fixture\n");
  const f = await fixture(t, [{ path: "LICENSE.headless_shell", bytes }]);
  const result = await inspectBrowserZip(f.options);
  assert.deepEqual(result.notices, [{ path: "LICENSE.headless_shell", sizeBytes: bytes.length, checksum: checksum(bytes), text: bytes.toString() }]);
});

test("original UTF-8 notice bytes retain an initial BOM rather than silently changing the licensed text", { skip }, async t => {
  const bytes = Buffer.concat([Buffer.from("efbbbf", "hex"), Buffer.from("Original notice with BOM\n")]);
  const f = await fixture(t, [{ path: "LICENSE", bytes }]);
  const result = await inspectBrowserZip(f.options);
  assert.deepEqual(Buffer.from(result.notices[0].text, "utf8"), bytes);
  assert.equal(result.notices[0].checksum, checksum(bytes));
});

test("bounded inspection timeout closes an in-flight reader before returning and does not extract payloads", { skip }, async t => {
  const f = await fixture(t, [{ path: "resources/file", bytes: Buffer.from("data") }]);
  const delayed = { ...yauzl, fromRandomAccessReaderPromise: async (...args) => {
    const zip = await yauzl.fromRandomAccessReaderPromise(...args), original = zip.openReadStreamPromise.bind(zip);
    zip.openReadStreamPromise = async (...values) => {
      await new Promise(resolve => setTimeout(resolve, 30)); return original(...values);
    };
    return zip;
  } };
  await assert.rejects(inspectBrowserZip({ ...f.options, yauzl: delayed, limits: { maxDurationMs: 10 } }), /inspection_timeout/);
  await assert.rejects(readFile(join(f.root, "resources/file")), { code: "ENOENT" });
  assert.equal((await inspectBrowserZip(f.options)).members.length, 1);
});

test("archive input links are rejected before the parser opens them", { skip }, async t => {
  const f = await fixture(t, [{ path: "resources/file", bytes: Buffer.from("data") }]);
  const alias = join(f.root, "alias.zip"); await symlink(f.zipPath, alias);
  await assert.rejects(inspectBrowserZip({ ...f.options, zipPath: alias }), /archive_file_invalid/);
});
