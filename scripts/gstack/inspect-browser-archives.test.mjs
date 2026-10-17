import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifyBrowserArchiveSource } from "./collect-browser-archives.mjs";
import { inspectGstackBrowserArchives, verifyBrowserArchiveCandidates } from "./inspect-browser-archives.mjs";

const stage = process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE && resolve(process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE);
const root = process.env.LING_GSTACK_BROWSER_ARCHIVES && resolve(process.env.LING_GSTACK_BROWSER_ARCHIVES);
const skip = !(stage && root) && "Set actual resource and browser archive prerequisites for verified ZIP-parser fixtures";
const target = { platform: "darwin", arch: "arm64" };
const resourceDigest = "sha256:a6d344a6675c34486db326801d86be736ccb1a3835afd19bc871af9923b640e1";
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
let yazl, acquisition;
if (!skip) {
  const source = await verifyBrowserArchiveSource({ resourceStagePath: stage, expectedResourceStageChecksum: resourceDigest, target });
  ({ yazl } = createRequire(join(source.root, "runtime/package.json"))(join(source.packagePath, "lib/utilsBundle.js")));
  acquisition = JSON.parse(await readFile(join(root, "browser-archives.json"), "utf8"));
}

function mach(fileType = 2) {
  const bytes = Buffer.alloc(128); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(fileType, 12);
  return bytes;
}
async function zipBytes(entries) {
  const zip = new yazl.ZipFile(), chunks = [];
  const done = new Promise((resolve, reject) => {
    zip.outputStream.on("data", bytes => chunks.push(bytes)); zip.outputStream.on("end", resolve); zip.outputStream.on("error", reject);
  });
  for (const entry of entries) zip.addBuffer(entry.bytes, entry.path, { mode: entry.mode ?? 0o100644, compress: true });
  zip.end(); await done; return Buffer.concat(chunks);
}
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "ling gstack member fixture "));
  t.after(() => rm(home, { recursive: true, force: true }));
  const archives = join(home, "archives"), output = join(home, "output"); await mkdir(archives);
  const receipt = structuredClone(acquisition), version = receipt.archives[0].browserVersion;
  const framework = "chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework";
  const copyright = Buffer.from("Original fixture notice; this is not license approval.\n");
  const entries = {
    chromium: [
      { path: "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", bytes: mach(), mode: 0o100755 },
      { path: `${framework}/Versions/${version}/Google Chrome for Testing Framework`, bytes: mach(6), mode: 0o100755 },
      { path: `${framework}/Versions/${version}/Libraries/WidevineCdm/LICENSE`, bytes: copyright },
      { path: `${framework}/Versions/Current`, bytes: Buffer.from(version), mode: 0o120755 },
    ],
    ffmpeg: [{ path: "ffmpeg-mac", bytes: mach(), mode: 0o100755 }, { path: "COPYING.LGPLv2.1", bytes: copyright }],
    "chromium-headless-shell": [
      { path: "chrome-headless-shell-mac-arm64/chrome-headless-shell", bytes: mach(), mode: 0o100755 },
      { path: "chrome-headless-shell-mac-arm64/LICENSE.headless_shell", bytes: copyright },
    ],
  };
  for (const archive of receipt.archives) {
    const bytes = await zipBytes(entries[archive.name]); await writeFile(join(archives, archive.filename), bytes);
    archive.checksum = checksum(bytes); archive.sizeBytes = bytes.length;
  }
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(join(archives, "browser-archives.json"), receiptBytes);
  return { home, archives, output, receipt, receiptBytes, options: { resourceStagePath: stage, archivePath: archives, outputPath: output,
    expectedResourceStageChecksum: resourceDigest, expectedArchiveReceiptChecksum: checksum(receiptBytes), target } };
}
async function changeReceipt(f, mutate) {
  mutate(f.receipt); const bytes = Buffer.from(JSON.stringify(f.receipt));
  await writeFile(join(f.archives, "browser-archives.json"), bytes); f.options.expectedArchiveReceiptChecksum = checksum(bytes);
}

test("candidate inspection requires detached receipts and rejects a foreign identity even with refreshed local hashes", { skip }, async t => {
  const f = await fixture(t);
  await assert.rejects(verifyBrowserArchiveCandidates({ ...f.options, expectedArchiveReceiptChecksum: undefined }), /inspection_receipt_required/);
  await assert.rejects(verifyBrowserArchiveCandidates({ ...f.options, expectedArchiveReceiptChecksum: `sha256:${"a".repeat(64)}` }), /inspection_receipt_mismatch/);
  for (const mutate of [r => { r.upstreamRevision = "a".repeat(40); }, r => { r.releaseEligible = true; },
    r => { r.target.arch = "x64"; }, r => { r.source.playwrightVersion = "0.0.0"; },
    r => { r.source.resourceStageChecksum = `sha256:${"a".repeat(64)}`; }]) {
    const changed = await fixture(t); await changeReceipt(changed, mutate);
    await assert.rejects(inspectGstackBrowserArchives(changed.options), /inspection_(?:identity|source)_mismatch/);
    await assert.rejects(readFile(join(changed.output, "browser-member-inspection.json")), { code: "ENOENT" });
  }
});

test("all exact archive identities and acquisition-input hashes remain mandatory", { skip }, async t => {
  for (const mutate of [r => { r.collectorInputChecksums.pop(); }, r => { r.collectorInputChecksums[0].checksum = `sha256:${"a".repeat(64)}`; },
    r => { r.archives[0].revision = "999"; }, r => { r.archives[0].url = r.archives[0].url.replace("151.0.7922.34", "latest"); },
    r => { r.archives.pop(); }]) {
    const f = await fixture(t); await changeReceipt(f, mutate);
    await assert.rejects(inspectGstackBrowserArchives(f.options), /gstack_browser_(?:inspection_|archive_)/);
    await assert.rejects(readFile(join(f.output, "browser-member-inspection.json")), { code: "ENOENT" });
  }
});

test("changed archive bytes, linked archives and unlisted files fail before report publication", { skip }, async t => {
  for (const change of ["bytes", "link", "extra"]) {
    const f = await fixture(t), path = join(f.archives, f.receipt.archives[0].filename);
    if (change === "bytes") await writeFile(path, "modified archive");
    if (change === "extra") await writeFile(join(f.archives, "unlisted.zip"), "unlisted data");
    if (change === "link") { await rm(path); await symlink(join(f.home, "outside.zip"), path); }
    await assert.rejects(inspectGstackBrowserArchives(f.options), /inspection_(?:archive_changed|input_invalid|extra_artifacts)/);
    await assert.rejects(readFile(join(f.output, "browser-member-inspection.json")), { code: "ENOENT" });
  }
});

test("complete payload inspection emits only hashed inventories and original notice candidates with all release gates pending", { skip }, async t => {
  const f = await fixture(t), progress = [];
  const receipt = await inspectGstackBrowserArchives({ ...f.options, onProgress: message => progress.push(message) });
  assert.equal(progress.length, 3); assert.equal(receipt.memberCount, 8); assert.equal(receipt.nativeMemberCount, 4);
  assert.equal(receipt.linkCount, 1); assert.equal(receipt.noticeCount, 3);
  assert.equal(receipt.releaseEligible, false); assert.equal(receipt.reviewStatus, "candidate-only");
  assert.equal(receipt.hostAcceptance, "pending"); assert.equal(receipt.packageAcceptance, "pending");
  const inventory = await readFile(join(f.output, "browser-member-inventory.json"));
  const notices = await readFile(join(f.output, "browser-license-candidates.json"));
  assert.equal(checksum(inventory), receipt.inventoryChecksum); assert.equal(checksum(notices), receipt.noticeCandidatesChecksum);
  assert.ok(receipt.pendingGates.includes("exact-archive-license-review"));
  assert.deepEqual((await readdir(f.output)).sort(), ["browser-license-candidates.json", "browser-member-inspection.json", "browser-member-inventory.json"]);
  await assert.rejects(readFile(join(f.output, "manifest.json")), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(f.archives, "browser-archives.json")), f.receiptBytes);
  await assert.rejects(inspectGstackBrowserArchives(f.options), /inspection_output_exists/);
  const relocated = join(f.home, "unrelated location with spaces", "output");
  assert.deepEqual(await inspectGstackBrowserArchives({ ...f.options, outputPath: relocated }), receipt);
  for (const path of await readdir(f.output)) assert.deepEqual(await readFile(join(relocated, path)), await readFile(join(f.output, path)));
});

test("missing executable or notice resources cannot be hidden by recomputing archive checksums", { skip }, async t => {
  for (const kind of ["executable", "notice"]) {
    const f = await fixture(t), archive = f.receipt.archives.find(a => a.name === "ffmpeg");
    const bytes = await zipBytes(kind === "executable" ? [{ path: "COPYING.LGPLv2.1", bytes: Buffer.from("Original fixture notice") }]
      : [{ path: "ffmpeg-mac", bytes: mach(), mode: 0o100755 }]);
    await writeFile(join(f.archives, archive.filename), bytes);
    await changeReceipt(f, () => { archive.checksum = checksum(bytes); archive.sizeBytes = bytes.length; });
    await assert.rejects(inspectGstackBrowserArchives(f.options), new RegExp(`inspection_${kind}_missing`));
    await assert.rejects(readFile(join(f.output, "browser-member-inspection.json")), { code: "ENOENT" });
  }
});

test("canonical output aliases cannot write into archive inputs or reviewed resource staging", { skip }, async t => {
  const f = await fixture(t);
  await symlink(f.archives, join(f.home, "archive-alias"), "dir");
  await symlink(stage, join(f.home, "source-alias"), "dir");
  for (const name of ["archive-alias", "source-alias"]) {
    await assert.rejects(inspectGstackBrowserArchives({ ...f.options, outputPath: join(f.home, name, "new-output") }), /inspection_output_overlap/);
  }
  assert.equal((await readdir(f.home)).some(path => path.startsWith(".gstack-browser-inspection-")), false);
});

test("the exact verified ZIP parser must remain unchanged before it is loaded", { skip }, async t => {
  const f = await fixture(t), cloned = join(f.home, "resource clone"); await mkdir(cloned);
  const copy = { force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE };
  for (const path of ["resource-stage.json", "resource-inventory.json", "runtime/tools/node", "runtime/node_modules/playwright-core"]) {
    await mkdir(join(cloned, path, ".."), { recursive: true }); await cp(join(stage, path), join(cloned, path), { ...copy, recursive: true });
  }
  await writeFile(join(cloned, "runtime/node_modules/playwright-core/lib/utilsBundle.js"), "throw new Error('unreviewed parser');");
  await assert.rejects(inspectGstackBrowserArchives({ ...f.options, resourceStagePath: cloned }), /gstack_browser_source_changed/);
  await assert.rejects(readFile(join(f.output, "browser-member-inspection.json")), { code: "ENOENT" });
});

test("input changes during inspection are rejected while preserving the owner's changed receipt", { skip }, async t => {
  const f = await fixture(t), changed = Buffer.from("owner changed receipt"), path = join(f.archives, "browser-archives.json");
  await assert.rejects(inspectGstackBrowserArchives({ ...f.options, onProgress: () => writeFile(path, changed) }), /inspection_receipt_mismatch/);
  assert.deepEqual(await readFile(path), changed);
  await assert.rejects(readFile(join(f.output, "browser-member-inspection.json")), { code: "ENOENT" });
  assert.equal((await readdir(f.home)).some(path => path.startsWith(".gstack-browser-inspection-")), false);
});
