import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downloadUngoogledChromium, verifyUngoogledSourceRecords, verifyUngoogledReleaseIdentity, validateUngoogledChromiumPin } from "./collect-ungoogled-chromium.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const originalPin = JSON.parse(await readFile(new URL("./ungoogled-chromium-candidate.json", import.meta.url), "utf8"));
const archive = Buffer.alloc(1024, 65);
archive.write("koly", archive.length - 512);
const pin = { ...originalPin, asset: { ...originalPin.asset, sizeBytes: archive.length, checksum: checksum(archive) } };
const assetUrl = `https://github.com/${pin.repository}/releases/download/${pin.tag}/${pin.asset.name}`;
const releaseUrl = "https://release-assets.githubusercontent.com/github-production-release-asset/123/fixture?signature=private";
const response = (bytes = archive, headers = {}) => new Response(bytes, { headers: { "content-length": String(pin.asset.sizeBytes), ...headers } });

async function destination(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-ungoogled-candidate-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, pin.asset.name);
}

test("alternative browser pin cannot become executable approval or a mutable release input", () => {
  assert.equal(validateUngoogledChromiumPin(originalPin), `https://github.com/${originalPin.repository}/releases/download/${originalPin.tag}/${originalPin.asset.name}`);
  for (const changed of [{ ...pin, releaseEligible: true }, { ...pin, reviewStatus: "accepted" },
    { ...pin, revision: "master" }, { ...pin, tag: "latest" }, { ...pin, repository: "attacker/browser" },
    { ...pin, target: { platform: "win32", arch: "x64" } }, { ...pin, asset: { ...pin.asset, name: "../browser.dmg" } },
    { ...pin, asset: { ...pin.asset, sizeBytes: 512 * 1024 * 1024 + 1 } },
    { ...pin, references: [...pin.references, pin.references[0]] },
    { ...pin, references: pin.references.map((r, i) => i ? r : { ...r, revision: "a".repeat(40) }) }]) {
    assert.throws(() => validateUngoogledChromiumPin(changed), /pin_invalid/);
  }
});

test("download retains pinned DMG bytes, independently checks SHA256 and never overwrites a file", async t => {
  const path = await destination(t), calls = [];
  const result = await downloadUngoogledChromium(pin, path, async (url, options) => {
    calls.push({ url, options });
    return url === assetUrl ? new Response(null, { status: 302, headers: { location: releaseUrl } }) : response();
  });
  assert.equal(result.checksum, pin.asset.checksum);
  assert.equal(result.sizeBytes, archive.length);
  assert.equal(result.endpoint, "https://release-assets.githubusercontent.com/github-production-release-asset/123/fixture");
  assert.deepEqual(await readFile(path), archive);
  assert.equal(calls.every(call => call.options.redirect === "manual" && call.options.signal), true);
  assert.equal(calls.length, 2);
  await assert.rejects(downloadUngoogledChromium(pin, path, async () => response()), { code: "EEXIST" });
  assert.deepEqual(await readFile(path), archive);
});

test("foreign redirects, credentials, insecure endpoints, loops and encoded payloads reject", async t => {
  for (const location of ["https://example.com/browser.dmg", "http://release-assets.githubusercontent.com/file",
    "https://user:secret@release-assets.githubusercontent.com/file", "https://release-assets.githubusercontent.com:444/file",
    "https://github.com/other/repo/releases/download/tag/file", "https://release-assets.githubusercontent.com/"]) {
    const path = await destination(t);
    await assert.rejects(downloadUngoogledChromium(pin, path, async () => new Response(null,
      { status: 302, headers: { location } })), /download_endpoint_invalid/);
    await assert.rejects(readFile(path), { code: "ENOENT" });
  }
  for (const request of [async () => new Response(null, { status: 307, headers: { location: assetUrl } }),
    async () => new Response(null, { status: 302 }), async () => response(archive, { "content-encoding": "gzip" }),
    async () => response(archive, { "content-length": "garbage" }), async () => new Response(null, { status: 404 })]) {
    const path = await destination(t);
    await assert.rejects(downloadUngoogledChromium(pin, path, request), /gstack_ungoogled_/);
    await assert.rejects(readFile(path), { code: "ENOENT" });
  }
});

test("truncation, excess bytes, same-size tampering and wrong container signatures reject", async t => {
  const nonDmg = Buffer.alloc(archive.length, 66), changed = Buffer.from(archive);
  changed[0] ^= 1;
  for (const bytes of [archive.subarray(0, archive.length - 1), Buffer.concat([archive, Buffer.from("excess")]), changed, nonDmg]) {
    const path = await destination(t);
    await assert.rejects(downloadUngoogledChromium(pin, path, async () => response(bytes)), /gstack_ungoogled_archive_/);
    await assert.rejects(readFile(path), { code: "ENOENT" });
  }
  const path = await destination(t);
  await writeFile(path, "owner data");
  await assert.rejects(downloadUngoogledChromium(pin, path, async () => response()), { code: "EEXIST" });
  assert.equal(await readFile(path, "utf8"), "owner data");
});

test("exact source records validate both Git blob and SHA256, preserve original bytes and prohibit replacements", async () => {
  const bytes = Buffer.from("Original source fixture\n"), blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const records = pin.references.map(r => ({ ...r, blob, checksum: checksum(bytes), sizeBytes: bytes.length }));
  const calls = [];
  const result = await verifyUngoogledSourceRecords({ ...pin, references: records }, async r => {
    calls.push(r); return { sha: blob, encoding: "base64", size: bytes.length, content: bytes.toString("base64") };
  });
  assert.equal(calls.length, records.length);
  assert.equal(result.every(r => r.bytes.equals(bytes)), true);
  for (const changed of [{ sha: "a".repeat(40) }, { content: Buffer.from("changed").toString("base64") },
    { encoding: "none" }, { size: bytes.length + 1 }, { content: "%%%%" }]) {
    await assert.rejects(verifyUngoogledSourceRecords({ ...pin, references: records }, async () => ({
      sha: blob, encoding: "base64", size: bytes.length, content: bytes.toString("base64"), ...changed,
    })), /source_/);
  }
});

test("release identity binds the immutable asset to the successful exact-commit build and common submodule", async () => {
  const tag = { ref: `refs/tags/${pin.tag}`, object: { type: "commit", sha: pin.revision } };
  const release = { tag_name: pin.tag, draft: false, assets: [{ ...pin.asset, size: pin.asset.sizeBytes,
    digest: pin.asset.checksum, browser_download_url: assetUrl }] };
  const run = { id: pin.buildRunId, head_sha: pin.revision, status: "completed", conclusion: "success", path: ".github/workflows/build.yml" };
  const tree = { truncated: false, tree: [{ path: "ungoogled-chromium", mode: "160000", sha: pin.commonRevision },
    ...pin.references.filter(r => r.repository === pin.repository).map(r => ({ path: r.path, sha: r.blob, type: "blob" }))] };
  const reader = changes => async endpoint => {
    const key = endpoint.includes("/git/ref/") ? "tag" : endpoint.includes("/releases/") ? "release"
      : endpoint.includes("/actions/runs/") ? "run" : "tree";
    return structuredClone(changes[key] ?? { tag, release, run, tree }[key]);
  };
  const actual = await verifyUngoogledReleaseIdentity(pin, reader({}));
  assert.equal(actual.asset.checksum, pin.asset.checksum);
  assert.equal(actual.build.revision, pin.revision);
  for (const changes of [{ tag: { ...tag, object: { type: "commit", sha: "a".repeat(40) } } },
    { release: { ...release, draft: true } }, { release: { ...release, assets: [] } },
    { release: { ...release, assets: [...release.assets, release.assets[0]] } },
    { release: { ...release, assets: [{ ...release.assets[0], digest: checksum("other") }] } },
    { release: { ...release, assets: [{ ...release.assets[0], size: archive.length + 1 }] } },
    { run: { ...run, conclusion: "failure" } }, { run: { ...run, head_sha: "a".repeat(40) } },
    { tree: { ...tree, truncated: true } }, { tree: { ...tree, tree: tree.tree.map(r => r.mode === "160000" ? { ...r, sha: "a".repeat(40) } : r) } }]) {
    await assert.rejects(verifyUngoogledReleaseIdentity(pin, reader(changes)), /release_identity_mismatch/);
  }
  const changedTree = { ...tree, tree: tree.tree.map(r => r.path === "build.sh" ? { ...r, sha: "a".repeat(40) } : r) };
  await assert.rejects(verifyUngoogledReleaseIdentity(pin, reader({ tree: changedTree })), /source_tree_mismatch/);
});
