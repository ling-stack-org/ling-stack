import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { cp, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { collectGstackBrowserArchives, verifyBrowserArchiveSource } from "./collect-browser-archives.mjs";

const root = process.env.LING_GSTACK_BROWSER_ARCHIVES ? resolve(process.env.LING_GSTACK_BROWSER_ARCHIVES) : undefined;
const stage = process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE ? resolve(process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE) : undefined;
const skip = !(root && stage) && "Set LING_GSTACK_BROWSER_ARCHIVES and LING_GSTACK_PLATFORM_RESOURCE_STAGE for actual archive prerequisites";
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function fileChecksum(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return `sha256:${hash.digest("hex")}`;
}

test("actual browser acquisition retains all three exact archives with independent hashes and no execution approval", { skip }, async () => {
  const receipt = JSON.parse(await readFile(join(root, "browser-archives.json"), "utf8"));
  assert.equal(receipt.reviewStatus, "candidate-only");
  assert.equal(receipt.deliveryStage, "browser-archive-candidates");
  assert.equal(receipt.releaseEligible, false);
  assert.equal(receipt.hostAcceptance, "pending");
  assert.equal(receipt.packageAcceptance, "pending");
  assert.deepEqual(receipt.target, { platform: process.platform, arch: process.arch });
  assert.deepEqual(receipt.archives.map(archive => archive.name), ["chromium", "ffmpeg", "chromium-headless-shell"]);
  assert.equal(receipt.source.playwrightVersion, "1.62.1");
  assert.equal(receipt.source.resourceStageChecksum, await fileChecksum(join(stage, "resource-stage.json")));
  assert.equal(receipt.source.inventoryChecksum, await fileChecksum(join(stage, "resource-inventory.json")));
  for (const archive of receipt.archives) {
    const path = join(root, archive.filename), stat = await lstat(path);
    assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.size, archive.sizeBytes); assert.ok(stat.size > 1024 * 1024);
    assert.equal(await fileChecksum(path), archive.checksum);
    assert.equal(new URL(archive.endpoint).search, "");
    assert.match(archive.url, /^https:\/\/cdn\.playwright\.dev\//);
  }
  for (const input of receipt.collectorInputChecksums) {
    assert.equal(checksum(await readFile(new URL(input.path, import.meta.url))), input.checksum);
  }
  assert.deepEqual((await readdir(root)).sort(), ["browser-archives.json", ...receipt.archives.map(archive => archive.filename)].sort());
  await assert.rejects(readFile(join(root, "manifest.json")), { code: "ENOENT" });
});

test("actual archive bytes replay reproducibly in an unrelated directory with spaces, without another download", { skip }, async t => {
  const home = await mkdtemp(join(tmpdir(), "ling gstack browser archive replay "));
  t.after(() => rm(home, { recursive: true, force: true }));
  const receipt = JSON.parse(await readFile(join(root, "browser-archives.json"), "utf8"));
  const output = join(home, "candidate");
  const collected = await collectGstackBrowserArchives({ resourceStagePath: stage, outputPath: output,
    expectedResourceStageChecksum: receipt.source.resourceStageChecksum,
    downloader: async (archive, path) => {
      const original = receipt.archives.find(entry => entry.name === archive.name);
      assert.equal(archive.url, original.url); assert.equal(archive.filename, original.filename);
      assert.equal(await fileChecksum(join(root, archive.filename)), original.checksum);
      await cp(join(root, archive.filename), path, { force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE });
      return { checksum: original.checksum, sizeBytes: original.sizeBytes, endpoint: original.endpoint };
    } });
  assert.deepEqual(collected, receipt);
  assert.deepEqual(await readFile(join(output, "browser-archives.json")), await readFile(join(root, "browser-archives.json")));
});

test("real archive directory inspection preserves executable sources, notices and known internal links without extracting or accepting them", { skip }, async () => {
  const receipt = JSON.parse(await readFile(join(root, "browser-archives.json"), "utf8"));
  const source = await verifyBrowserArchiveSource({ resourceStagePath: stage,
    expectedResourceStageChecksum: receipt.source.resourceStageChecksum, target: receipt.target });
  const require = createRequire(join(source.root, "runtime/package.json"));
  const { yauzl } = require(join(source.packagePath, "lib/utilsBundle.js"));
  const observations = [];
  for (const archive of receipt.archives) {
    assert.equal(await fileChecksum(join(root, archive.filename)), archive.checksum);
    const zip = await yauzl.openPromise(join(root, archive.filename), {
      lazyEntries: true, strictFileNames: true, validateEntrySizes: true,
    });
    const entries = [];
    try {
      await new Promise((resolve, reject) => {
        zip.on("error", reject); zip.on("end", resolve);
        zip.on("entry", entry => {
          entries.push({ path: entry.fileName, sizeBytes: entry.uncompressedSize,
            linked: ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000 });
          zip.readEntry();
        });
        zip.readEntry();
      });
    } finally { zip.close(); }
    assert.ok(entries.length > 1);
    assert.equal(entries.some(entry => entry.path.startsWith("/") || entry.path.includes("\\") || entry.path.split("/").includes("..")), false);
    observations.push({ name: archive.name, entries });
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    const chrome = observations.find(archive => archive.name === "chromium").entries;
    const ffmpeg = observations.find(archive => archive.name === "ffmpeg").entries;
    const shell = observations.find(archive => archive.name === "chromium-headless-shell").entries;
    assert.equal(chrome.length, 647); assert.equal(chrome.filter(entry => entry.linked).length, 5);
    assert.ok(chrome.some(entry => entry.path.endsWith("/Contents/MacOS/Google Chrome for Testing")));
    assert.ok(chrome.some(entry => entry.path.endsWith("/WidevineCdm/LICENSE")));
    assert.equal(ffmpeg.length, 2); assert.ok(ffmpeg.some(entry => entry.path === "COPYING.LGPLv2.1"));
    assert.equal(shell.length, 18); assert.ok(shell.some(entry => entry.path.endsWith("/LICENSE.headless_shell")));
    assert.ok(shell.some(entry => entry.path.endsWith("/chrome-headless-shell")));
  }
  assert.ok(receipt.pendingGates.includes("archive-member-and-native-target-review"));
  assert.ok(receipt.pendingGates.includes("exact-archive-license-review"));
  await assert.rejects(lstat(join(root, "chrome-mac-arm64")), { code: "ENOENT" });
});
