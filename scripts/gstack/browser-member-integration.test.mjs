import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";
import { verifyBrowserArchiveSource } from "./collect-browser-archives.mjs";
import { inspectGstackBrowserArchives, verifyBrowserArchiveCandidates } from "./inspect-browser-archives.mjs";

const archivePath = process.env.LING_GSTACK_BROWSER_ARCHIVES && resolve(process.env.LING_GSTACK_BROWSER_ARCHIVES);
const resourceStagePath = process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE && resolve(process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE);
const inspectionPath = process.env.LING_GSTACK_BROWSER_MEMBER_INSPECTION && resolve(process.env.LING_GSTACK_BROWSER_MEMBER_INSPECTION);
const skip = !(archivePath && resourceStagePath && inspectionPath) && "Set actual archive, resource and member-inspection prerequisites";
const target = { platform: "darwin", arch: "arm64" };
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const options = { archivePath, resourceStagePath, target,
  expectedResourceStageChecksum: "sha256:a6d344a6675c34486db326801d86be736ccb1a3835afd19bc871af9923b640e1",
  expectedArchiveReceiptChecksum: "sha256:f490b664e44d18c44111b8c112916689784033c8502411f6f508f122cfc3c8dc" };

test("actual browser member evidence independently matches every streamed payload and original notice without extraction or execution", { skip }, async () => {
  const verified = await verifyBrowserArchiveCandidates(options);
  const receipt = JSON.parse(await readFile(join(inspectionPath, "browser-member-inspection.json"), "utf8"));
  const inventoryBytes = await readFile(join(inspectionPath, "browser-member-inventory.json"));
  const noticesBytes = await readFile(join(inspectionPath, "browser-license-candidates.json"));
  assert.equal(checksum(inventoryBytes), receipt.inventoryChecksum);
  assert.equal(checksum(noticesBytes), receipt.noticeCandidatesChecksum);
  assert.equal(receipt.archiveReceiptChecksum, options.expectedArchiveReceiptChecksum);
  assert.equal(receipt.releaseEligible, false); assert.equal(receipt.reviewStatus, "candidate-only");
  assert.equal(receipt.hostAcceptance, "pending"); assert.equal(receipt.packageAcceptance, "pending");
  assert.equal(receipt.memberCount, 667); assert.equal(receipt.totalUncompressedBytes, 580_144_429);
  assert.equal(receipt.nativeMemberCount, 20); assert.equal(receipt.linkCount, 5); assert.equal(receipt.noticeCount, 3);
  for (const input of receipt.inspectorInputChecksums) assert.equal(checksum(await readFile(new URL(input.path, import.meta.url))), input.checksum);
  const inventory = JSON.parse(inventoryBytes), notices = JSON.parse(noticesBytes).notices;
  assert.deepEqual(inventory.target, target);
  const source = await verifyBrowserArchiveSource({ resourceStagePath, expectedResourceStageChecksum: options.expectedResourceStageChecksum, target });
  const { yauzl } = createRequire(join(source.root, "runtime/package.json"))(join(source.packagePath, "lib/utilsBundle.js"));
  for (const archive of verified.receipt.archives) {
    const recorded = inventory.archives.find(entry => entry.name === archive.name);
    assert.equal(recorded.archiveChecksum, archive.checksum);
    const zip = await yauzl.openPromise(join(archivePath, archive.filename), { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
    let count = 0;
    try {
      await new Promise((done, fail) => {
        zip.on("error", fail); zip.on("end", done);
        zip.on("entry", entry => {
          (async () => {
            const path = entry.fileName.replace(/\/$/u, ""), member = recorded.members.find(m => m.path === path);
            assert.ok(member); const hash = createHash("sha256"), chunks = [];
            const notice = notices.find(n => n.archive === archive.name && n.path === path);
            let sizeBytes = 0, crc = 0;
            for await (const bytes of await zip.openReadStreamPromise(entry)) {
              hash.update(bytes); sizeBytes += bytes.length; crc = crc32(bytes, crc);
              if (notice) chunks.push(bytes);
            }
            assert.equal(sizeBytes, member.sizeBytes); assert.equal(crc, entry.crc32);
            assert.equal(crc.toString(16).padStart(8, "0"), member.crc32);
            assert.equal(`sha256:${hash.digest("hex")}`, member.checksum);
            if (notice) {
              assert.equal(sizeBytes, notice.sizeBytes); assert.equal(member.checksum, notice.checksum);
              assert.deepEqual(Buffer.concat(chunks), Buffer.from(notice.text, "utf8"));
            }
            count++; zip.readEntry();
          })().catch(fail);
        });
        zip.readEntry();
      });
    } finally { zip.close(); }
    assert.equal(count, recorded.memberCount);
    for (const member of recorded.members.filter(m => m.native)) assert.ok(member.native.architectures.includes("arm64"));
  }
  const ffmpeg = notices.find(n => n.archive === "ffmpeg"), shell = notices.find(n => n.archive === "chromium-headless-shell");
  const widevine = notices.find(n => n.archive === "chromium");
  assert.equal(ffmpeg.checksum, "sha256:b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe");
  assert.equal(shell.checksum, "sha256:8e19f44970a51cb101004127a567f78f8efada271dcb2a16b4b5c4d0cc76a4cd");
  assert.equal(widevine.checksum, "sha256:20de375707692099b3132084695377ce5fec0aec05813dedcce094b8eda44386");
  assert.match(ffmpeg.text, /GNU LESSER GENERAL PUBLIC LICENSE/u);
  assert.ok(receipt.pendingGates.includes("exact-archive-license-review"));
  await assert.rejects(lstat(join(archivePath, "chrome-mac-arm64")), { code: "ENOENT" });
  assert.deepEqual((await readdir(inspectionPath)).sort(), ["browser-license-candidates.json", "browser-member-inspection.json", "browser-member-inventory.json"]);
});

test("real browser member inspection is reproducible after relocation and cannot promote candidates to an executable bundle", { skip }, async t => {
  const home = await mkdtemp(join(tmpdir(), "ling actual browser member replay "));
  t.after(() => rm(home, { recursive: true, force: true }));
  const outputPath = join(home, "unrelated directory with spaces", "output");
  const receipt = await inspectGstackBrowserArchives({ ...options, outputPath });
  assert.deepEqual(receipt, JSON.parse(await readFile(join(inspectionPath, "browser-member-inspection.json"), "utf8")));
  for (const path of await readdir(inspectionPath)) assert.deepEqual(await readFile(join(outputPath, path)), await readFile(join(inspectionPath, path)));
  await assert.rejects(readFile(join(outputPath, "manifest.json")), { code: "ENOENT" });
});
