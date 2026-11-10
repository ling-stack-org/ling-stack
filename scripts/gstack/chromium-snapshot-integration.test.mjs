import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifyBrowserArchiveSource } from "./collect-browser-archives.mjs";
import { inspectBrowserZip } from "./inspect-browser-zip.mjs";

const root = process.env.LING_GSTACK_CHROMIUM_SNAPSHOT && resolve(process.env.LING_GSTACK_CHROMIUM_SNAPSHOT);
const stage = process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE && resolve(process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE);
const skip = !(root && stage) && "Set real Chromium snapshot and platform resource paths for candidate-only integration evidence";
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const pin = JSON.parse(await readFile(new URL("./chromium-snapshot-candidate.json", import.meta.url), "utf8"));

test("real generation-pinned Chromium is independently rehashed and all payloads re-inspected without extraction or execution", { skip }, async () => {
  const receipt = JSON.parse(await readFile(join(root, "snapshot-candidate.json"), "utf8"));
  const source = await verifyBrowserArchiveSource({ resourceStagePath: stage,
    expectedResourceStageChecksum: receipt.source.resourceStageChecksum, target: receipt.target });
  assert.deepEqual(receipt.source, source.provenance);
  assert.equal(receipt.pinChecksum, checksum(await readFile(new URL("./chromium-snapshot-candidate.json", import.meta.url))));
  for (const input of receipt.inputChecksums) assert.equal(checksum(await readFile(new URL(input.path, import.meta.url))), input.checksum);
  const archivePath = join(root, "chrome-mac.zip"), hash = createHash("sha256");
  for await (const bytes of createReadStream(archivePath)) hash.update(bytes);
  assert.equal(receipt.archive.checksum, "sha256:c17f3d106bb3a0df4f7be5cae04f3f18b20649a3e8b34882301f1e40e896285e");
  assert.equal(`sha256:${hash.digest("hex")}`, receipt.archive.checksum);
  assert.equal((await lstat(archivePath)).size, 167624451);
  const require = createRequire(join(source.root, "runtime/package.json"));
  const { yauzl } = require(join(source.packagePath, "lib/utilsBundle.js"));
  const actual = await inspectBrowserZip({ zipPath: archivePath, yauzl, target: receipt.target, rootPrefix: "chrome-mac" });
  const inventoryBytes = await readFile(join(root, "snapshot-members.json"));
  assert.equal(checksum(inventoryBytes), receipt.inventoryChecksum);
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  assert.deepEqual(actual.members, inventory.members);
  assert.deepEqual(actual.notices, inventory.notices);
  assert.equal(actual.totalBytes, 364874583);
  assert.equal(actual.members.length, 653);
  assert.equal(actual.members.filter(member => member.native).length, 11);
  assert.deepEqual(actual.members.filter(member => /widevine/i.test(member.path)).map(member => member.path), []);
});

test("real snapshot retains source proof bytes but zero separate notices and patch differences remain explicit acceptance gates", { skip }, async () => {
  const receipt = JSON.parse(await readFile(join(root, "snapshot-candidate.json"), "utf8"));
  assert.equal(receipt.reviewStatus, "candidate-only"); assert.equal(receipt.releaseEligible, false);
  assert.equal(receipt.hostAcceptance, "pending"); assert.equal(receipt.packageAcceptance, "pending");
  assert.equal(receipt.sourceRevision, pin.revision); assert.equal(receipt.sourceVersion, "151.0.7922.0");
  assert.equal(receipt.noticeCount, 0);
  assert.ok(receipt.pendingGates.includes("compiled-version-and-third-party-notice-review"));
  assert.ok(receipt.pendingGates.includes("patch-level-security-review"));
  assert.ok(receipt.pendingGates.includes("headed-headless-extension-recording-equivalence"));
  for (const [name, expected] of [["REVISIONS", pin.revisionsChecksum], ["SOURCE-VERSION", pin.versionChecksum],
    ["SOURCE-LICENSE", pin.sourceLicenseChecksum]]) assert.equal(checksum(await readFile(join(root, name))), expected);
  assert.deepEqual((await readdir(root)).sort(), ["REVISIONS", "SOURCE-LICENSE", "SOURCE-VERSION", "chrome-mac.zip",
    "snapshot-candidate.json", "snapshot-members.json"].sort());
  assert.equal((await lstat(join(root, "chrome-mac.zip"))).mode & 0o111, 0);
  await assert.rejects(readFile(join(root, "manifest.json")), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, "chrome-mac")), { code: "ENOENT" });
});
