import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downloadChromiumSnapshot, readChromiumSnapshotMetadata, validateChromiumSnapshotPin } from "./collect-chromium-snapshot.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const archive = Buffer.concat([Buffer.from("504b0304", "hex"), Buffer.from("non-executed fixture archive")]);
const basePin = JSON.parse(await readFile(new URL("./chromium-snapshot-candidate.json", import.meta.url), "utf8"));
const version = Buffer.from("MAJOR=151\nMINOR=0\nBUILD=7922\nPATCH=0\n");
const license = Buffer.from("Original source license fixture, not redistribution approval.\n");
const revisions = Buffer.from(JSON.stringify({ chromium_revision: basePin.position, got_revision: basePin.revision,
  got_revision_cp: `refs/heads/main@{#${basePin.position}}` }));
const pin = { ...basePin, revisionsChecksum: checksum(revisions), versionChecksum: checksum(version), sourceLicenseChecksum: checksum(license),
  archive: { ...basePin.archive, sizeBytes: archive.length, etag: createHash("md5").update(archive).digest("hex") } };
const metadataRequest = async url => new Response(url.endsWith("REVISIONS") ? revisions
  : (url.includes("/VERSION?") ? version : license).toString("base64"));
function archiveResponse(bytes = archive, changed = {}) {
  return new Response(bytes, { headers: { "content-length": String(pin.archive.sizeBytes),
    "x-goog-generation": pin.archive.generation, etag: `"${pin.archive.etag}"`, ...changed } });
}
async function destination(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-chromium-snapshot-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "browser.zip");
}

test("snapshot candidate pins a fixed official generation and exact source, never mutable latest or a release", () => {
  const urls = validateChromiumSnapshotPin(basePin);
  assert.equal(urls.archive, "https://storage.googleapis.com/chromium-browser-snapshots/Mac_Arm/1654411/chrome-mac.zip?generation=1782773095386936");
  assert.ok(urls.version.includes(basePin.revision));
  for (const changed of [{ ...basePin, position: "LAST_CHANGE" }, { ...basePin, position: "../1654411" },
    { ...basePin, revision: "main" }, { ...basePin, releaseEligible: true }, { ...basePin, reviewStatus: "reviewed" },
    { ...basePin, version: "151.0.7922.34" }, { ...basePin, target: { platform: "win32", arch: "x64" } },
    { ...basePin, archive: { ...basePin.archive, generation: "latest" } }]) {
    assert.throws(() => validateChromiumSnapshotPin(changed), /pin_invalid/);
  }
});

test("snapshot metadata preserves full original bytes and independently freezes decoded and transport hashes", async () => {
  const calls = [];
  const result = await readChromiumSnapshotMetadata(pin, async (url, options) => {
    calls.push({ url, options }); return metadataRequest(url);
  });
  assert.deepEqual(result.revisions.bytes, revisions);
  assert.deepEqual(result.version.bytes, version);
  assert.deepEqual(result.license.bytes, license);
  assert.equal(result.license.wireChecksum, checksum(license.toString("base64")));
  assert.equal(calls.length, 3);
  assert.equal(calls.every(call => call.options.redirect === "error" && call.options.signal), true);
});

test("wrong exact source hashes, changed version and refreshed mismatched revision identities reject", async () => {
  for (const changed of [{ ...pin, revisionsChecksum: checksum("wrong") }, { ...pin, versionChecksum: checksum("wrong") },
    { ...pin, sourceLicenseChecksum: checksum("wrong") }]) {
    await assert.rejects(readChromiumSnapshotMetadata(changed, metadataRequest), /changed/);
  }
  for (const changedBytes of [Buffer.from(JSON.stringify({ chromium_revision: pin.position, got_revision: "a".repeat(40),
    got_revision_cp: `refs/heads/main@{#${pin.position}}` })), Buffer.from(JSON.stringify({ chromium_revision: "1654412",
    got_revision: pin.revision, got_revision_cp: `refs/heads/main@{#${pin.position}}` }))]) {
    const changed = { ...pin, revisionsChecksum: checksum(changedBytes) };
    await assert.rejects(readChromiumSnapshotMetadata(changed, url => url.endsWith("REVISIONS")
      ? new Response(changedBytes) : metadataRequest(url)), /source_revision_mismatch/);
  }
  const changedVersion = Buffer.from("MAJOR=151\nMINOR=0\nBUILD=7922\nPATCH=34\n");
  await assert.rejects(readChromiumSnapshotMetadata({ ...pin, versionChecksum: checksum(changedVersion) }, url => url.includes("/VERSION?")
    ? new Response(changedVersion.toString("base64")) : metadataRequest(url)), /source_version_mismatch/);
});

test("redirects, HTML metadata, oversized text, bad base64 and invalid UTF-8 cannot become source proofs", async () => {
  const nonAsciiBase64 = Buffer.from(version.toString("base64"));
  nonAsciiBase64[0] |= 0x80;
  for (const request of [async () => new Response(null, { status: 302, headers: { location: "https://example.com" } }),
    async () => new Response("<html>error</html>"), async () => new Response(Buffer.alloc(64 * 1024 + 1)),
    async url => url.endsWith("REVISIONS") ? new Response(revisions) : new Response("%%%"),
    async url => url.endsWith("REVISIONS") ? new Response(revisions) : new Response(Buffer.from([0xff]).toString("base64")),
    async url => url.includes("/VERSION?") ? new Response(nonAsciiBase64) : metadataRequest(url)]) {
    await assert.rejects(readChromiumSnapshotMetadata(pin, request), /gstack_chromium_snapshot_/);
  }
});

test("archive acquisition binds generation, storage identity, independent SHA256 and actual ZIP bytes without execution", async t => {
  const path = await destination(t), calls = [];
  const result = await downloadChromiumSnapshot(pin, path, async (url, options) => {
    calls.push({ url, options }); return archiveResponse();
  });
  assert.deepEqual(await readFile(path), archive);
  assert.equal(result.checksum, checksum(archive));
  assert.equal(result.storageMd5, pin.archive.etag);
  assert.equal(result.generation, pin.archive.generation);
  assert.equal(calls[0].options.redirect, "error");
  assert.ok(calls[0].url.endsWith(`?generation=${pin.archive.generation}`));
  await assert.rejects(downloadChromiumSnapshot(pin, path, async () => archiveResponse()), { code: "EEXIST" });
  assert.deepEqual(await readFile(path), archive);
});

test("changed generation, ETag, content length, encoded bodies and HTTP failures reject before creating files", async t => {
  for (const response of [archiveResponse(archive, { "x-goog-generation": "1782773095386937" }),
    archiveResponse(archive, { etag: `"${"a".repeat(32)}"` }), archiveResponse(archive, { "content-length": "0" }),
    archiveResponse(archive, { "content-encoding": "gzip" }), new Response(null, { status: 404 }),
    new Response(null, { status: 307, headers: { location: "https://example.com" } })]) {
    const path = await destination(t);
    await assert.rejects(downloadChromiumSnapshot(pin, path, async () => response), /gstack_chromium_snapshot_/);
    await assert.rejects(readFile(path), { code: "ENOENT" });
  }
});

test("truncated, oversized, non-ZIP and same-size corrupted archive payloads cannot pass independent verification", async t => {
  for (const bytes of [archive.subarray(0, archive.length - 1), Buffer.concat([archive, Buffer.from("extra")]),
    Buffer.alloc(archive.length, 65), Buffer.concat([archive.subarray(0, 4), Buffer.alloc(archive.length - 4, 65)])]) {
    const path = await destination(t);
    await assert.rejects(downloadChromiumSnapshot(pin, path, async () => archiveResponse(bytes)), /gstack_chromium_snapshot_archive_/);
  }
  const path = await destination(t);
  await writeFile(path, "owner file");
  await assert.rejects(downloadChromiumSnapshot(pin, path, async () => archiveResponse()), { code: "EEXIST" });
  assert.equal(await readFile(path, "utf8"), "owner file");
});
