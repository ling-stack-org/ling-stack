import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { cp, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifyBrowserArchiveSource } from "./collect-browser-archives.mjs";
import { inspectBrowserZip } from "./inspect-browser-zip.mjs";
import { readSelectedChromiumPack } from "./inspect-chromium-credits.mjs";
import { inspectUngoogledDmg, summarizeUngoogledPack } from "./inspect-ungoogled-dmg.mjs";

const candidate = process.env.LING_GSTACK_UNGOOGLED_CANDIDATE && resolve(process.env.LING_GSTACK_UNGOOGLED_CANDIDATE);
const inspection = process.env.LING_GSTACK_UNGOOGLED_INSPECTION && resolve(process.env.LING_GSTACK_UNGOOGLED_INSPECTION);
const stage = process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE && resolve(process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE);
const skip = !(candidate && inspection && stage) && "Set real alternative-browser candidate, inspection and platform-resource paths";
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const candidateChecksum = "sha256:90688a1a97b3b6ff26030bc2da73da08e0546681ee96fb9127d48bf9af77bd70";
const pin = JSON.parse(await readFile(new URL("./ungoogled-chromium-candidate.json", import.meta.url), "utf8"));

async function rehash(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return `sha256:${hash.digest("hex")}`;
}

test("real alternative DMG retains exact source proofs and independently matches the original release SHA256 without browser execution", { skip }, async () => {
  const receiptBytes = await readFile(join(candidate, "ungoogled-candidate.json")), receipt = JSON.parse(receiptBytes);
  assert.equal(checksum(receiptBytes), candidateChecksum);
  assert.equal(receipt.pinChecksum, checksum(await readFile(new URL("./ungoogled-chromium-candidate.json", import.meta.url))));
  assert.equal(receipt.releaseEligible, false);
  assert.equal(receipt.hostAcceptance, "pending");
  assert.equal(receipt.identity.build.revision, pin.revision);
  assert.equal(receipt.identity.common.revision, pin.commonRevision);
  assert.deepEqual(receipt.references, pin.references);
  for (const input of receipt.inputChecksums) assert.equal(checksum(await readFile(new URL(input.path, import.meta.url))), input.checksum);
  for (const r of pin.references) {
    const bytes = await readFile(join(candidate, r.output));
    assert.equal(checksum(bytes), r.checksum);
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), r.blob);
  }
  const path = join(candidate, receipt.archive.path);
  assert.equal(await rehash(path), pin.asset.checksum);
  assert.equal((await lstat(path)).size, 147401835);
  assert.equal((await lstat(path)).mode & 0o111, 0);
  await assert.rejects(readFile(join(candidate, "manifest.json")), { code: "ENOENT" });
});

test("real alternative member and compiled-resource evidence replays independently while all execution and licensing gates remain pending", { skip }, async () => {
  const receipt = JSON.parse(await readFile(join(inspection, "ungoogled-inspection.json")));
  const source = await verifyBrowserArchiveSource({ resourceStagePath: stage,
    expectedResourceStageChecksum: receipt.source.resourceStageChecksum, target: receipt.target });
  assert.deepEqual(receipt.source, source.provenance);
  assert.equal(receipt.candidateReceiptChecksum, candidateChecksum);
  for (const input of receipt.inputChecksums) assert.equal(checksum(await readFile(new URL(input.path, import.meta.url))), input.checksum);
  const require = createRequire(join(source.root, "runtime/package.json")), { yauzl } = require(join(source.packagePath, "lib/utilsBundle.js"));
  const path = join(inspection, receipt.transport.path);
  assert.equal(await rehash(path), receipt.transport.checksum);
  const actual = await inspectBrowserZip({ zipPath: path, yauzl, target: receipt.target, rootPrefix: "Chromium.app" });
  const inventoryBytes = await readFile(join(inspection, "members.json"));
  assert.equal(checksum(inventoryBytes), receipt.inventoryChecksum);
  assert.deepEqual(actual, Object.fromEntries(Object.entries(JSON.parse(inventoryBytes)).filter(([key]) => key !== "schemaVersion")));
  assert.equal(actual.members.length, 947);
  assert.equal(actual.totalBytes, 376933251);
  assert.equal(actual.members.filter(m => m.native).length, 16);
  assert.equal(actual.members.filter(m => /widevine/i.test(m.path)).length, 0);
  const member = actual.members.find(m => m.path === receipt.pack.path);
  const bytes = await readSelectedChromiumPack({ archiveBytes: await readFile(path), yauzl, member });
  const parsed = summarizeUngoogledPack(bytes);
  assert.equal(parsed.resources.length, 5277);
  assert.equal(parsed.aliases.length, 373);
  assert.equal(parsed.credits.length, 1);
  assert.equal(parsed.credits[0].sizeBytes, 8678856);
  assert.equal(parsed.credits[0].placeholder, false);
  assert.equal(parsed.credits[0].checksum, "sha256:96b0250b727245dc868d298005cac5414668382e993c4036df4702f28ae54503");
  assert.deepEqual(await readFile(join(inspection, parsed.credits[0].output)), parsed.credits[0].bytes);
  assert.equal(checksum(await readFile(join(inspection, "compiled-resources.json"))), receipt.resourceInventoryChecksum);
  assert.equal(receipt.candidateDisposition, "compiled-credits-present-review-pending");
  assert.equal(receipt.readonlyMountDetached, true);
  assert.equal(receipt.releaseEligible, false);
  assert.equal(receipt.hostAcceptance, "pending");
  assert.equal(receipt.packageAcceptance, "pending");
  assert.ok(receipt.pendingGates.includes("headed-headless-extension-recording-equivalence"));
  assert.ok(receipt.pendingGates.includes("safe-browsing-and-patch-level-security-review"));
  await assert.rejects(readFile(join(inspection, "manifest.json")), { code: "ENOENT" });
});

test("real DMG inspection relocates offline, detaches its owned mount and rejects wrong receipts and repeated publication", { skip, timeout: 180_000 }, async t => {
  const work = await mkdtemp(join(tmpdir(), "ling-ungoogled-relocated-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const relocated = join(work, "candidate"), output = join(work, "inspection");
  await cp(candidate, relocated, { recursive: true, mode: constants.COPYFILE_FICLONE });
  await assert.rejects(inspectUngoogledDmg({ candidatePath: relocated, expectedCandidateChecksum: `sha256:${"a".repeat(64)}`,
    resourceStagePath: stage, outputPath: output }), /file_changed/);
  const result = await inspectUngoogledDmg({ candidatePath: relocated, expectedCandidateChecksum: candidateChecksum,
    resourceStagePath: stage, outputPath: output });
  assert.equal(result.readonlyMountDetached, true);
  assert.equal(result.memberCount, 947);
  assert.equal(result.resourceInventoryChecksum, checksum(await readFile(join(inspection, "compiled-resources.json"))));
  assert.deepEqual(await readFile(join(output, result.credits[0].output)), await readFile(join(inspection, result.credits[0].output)));
  const before = await rehash(join(output, "ungoogled-inspection.json"));
  await assert.rejects(inspectUngoogledDmg({ candidatePath: relocated, expectedCandidateChecksum: candidateChecksum,
    resourceStagePath: stage, outputPath: output }), /output_exists/);
  assert.equal(await rehash(join(output, "ungoogled-inspection.json")), before);
});
