import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import test from "node:test";
import { verifyBrowserArchiveSource } from "./collect-browser-archives.mjs";
import { readPinnedChromiumReference, readSelectedChromiumPack } from "./inspect-chromium-credits.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const stage = process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE && resolve(process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE);
const skip = !stage && "Set the verified pinned platform resource stage for real ZIP parser checks";
let yauzl, yazl;
if (stage) {
  const source = await verifyBrowserArchiveSource({ resourceStagePath: stage, target: { platform: "darwin", arch: "arm64" },
    expectedResourceStageChecksum: "sha256:a6d344a6675c34486db326801d86be736ccb1a3835afd19bc871af9923b640e1" });
  ({ yauzl, yazl } = createRequire(join(source.root, "runtime/package.json"))(join(source.packagePath, "lib/utilsBundle.js")));
}

async function fixture(entries = [{ path: "resources/resources.pak", bytes: Buffer.from("retained resource pack") }]) {
  const zip = new yazl.ZipFile(), chunks = [];
  const done = new Promise((resolve, reject) => {
    zip.outputStream.on("data", bytes => chunks.push(bytes)); zip.outputStream.on("end", resolve); zip.outputStream.on("error", reject);
  });
  for (const entry of entries) zip.addBuffer(entry.bytes, entry.path, { compress: false, mode: entry.mode ?? 0o100644 });
  zip.end(); await done;
  const original = entries[0], bytes = original.bytes;
  return { archiveBytes: Buffer.concat(chunks), yauzl, member: { path: original.path, kind: "file", mode: 0o100644,
    sizeBytes: bytes.length, compressedSizeBytes: bytes.length, compressionMethod: 0,
    checksum: checksum(bytes), crc32: crc32(bytes).toString(16).padStart(8, "0") } };
}

test("selected resource reading preserves exact bytes while unrelated ZIP members remain unmaterialized", { skip }, async () => {
  const f = await fixture([{ path: "resources/resources.pak", bytes: Buffer.from("exact bytes") },
    { path: "do-not-extract/app", bytes: Buffer.from("never execute") }]);
  assert.equal((await readSelectedChromiumPack(f)).toString(), "exact bytes");
});

test("selected member CRC, checksum, size, file identity and missing or duplicate members are rejected", { skip }, async () => {
  const f = await fixture();
  const altered = Buffer.from(f.archiveBytes), offset = altered.indexOf(Buffer.from("retained resource pack"));
  assert.ok(offset > 0); altered[offset] ^= 1;
  await assert.rejects(readSelectedChromiumPack({ ...f, archiveBytes: altered }), /member_payload_mismatch/);
  for (const patch of [{ checksum: checksum(Buffer.from("changed")) }, { sizeBytes: 1 }, { crc32: "00000000" },
    { compressionMethod: 8 }, { mode: 0o120644 }, { path: "resources/absent.pak" }]) {
    await assert.rejects(readSelectedChromiumPack({ ...f, member: { ...f.member, ...patch } }), /gstack_chromium_credits_member_/);
  }
  const repeated = await fixture([{ path: "same.pak", bytes: Buffer.from("same") }, { path: "same.pak", bytes: Buffer.from("same") }]);
  await assert.rejects(readSelectedChromiumPack(repeated), /member_duplicate/);
  await assert.rejects(readSelectedChromiumPack({ ...f, maxDurationMs: Infinity }), /member_limits_invalid/);
  await assert.rejects(readSelectedChromiumPack({ ...f, member: { ...f.member, sizeBytes: NaN } }), /member_limits_invalid/);
});

test("exact historical Chromium references preserve original bytes and reject changed or malformed transport", async () => {
  const bytes = Buffer.from("original source\n"), record = { path: "source/test", output: "reference.txt", checksum: checksum(bytes) };
  let requested;
  const result = await readPinnedChromiumReference(record, "a".repeat(40), async (url, options) => {
    requested = { url, options }; return new Response(bytes.toString("base64"));
  });
  assert.deepEqual(result.bytes, bytes); assert.equal(requested.options.redirect, "error");
  assert.ok(requested.url.includes(`${"a".repeat(40)}/source/test?format=TEXT`));
  for (const wire of [Buffer.from("changed").toString("base64"), "invalid!", `${bytes.toString("base64")}\u00e9`, "A".repeat(256 * 1024 + 1)]) {
    await assert.rejects(readPinnedChromiumReference(record, "a".repeat(40), async () => new Response(wire)), /reference_(?:changed|encoding_invalid|too_large)/);
  }
  await assert.rejects(readPinnedChromiumReference(record, "a".repeat(40), async () => new Response(null, { status: 404 })), /reference_http_404/);
});

test("frozen credit reference explicitly identifies the upstream sample, not a redistributable license grant", async () => {
  const pin = JSON.parse(await readFile(new URL("./chromium-credits-pin.json", import.meta.url), "utf8"));
  assert.equal(pin.credits.classification, "upstream-sample-placeholder"); assert.equal(pin.credits.sizeBytes, 401);
  assert.equal(pin.references.find(r => r.path === "components/resources/sample_credits.html").checksum, pin.credits.checksum);
  assert.equal(pin.references.length, 6);
});
