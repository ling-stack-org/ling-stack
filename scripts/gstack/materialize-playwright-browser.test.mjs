import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { inspectBrowserZip } from "./inspect-browser-zip.mjs";
import { extractVerifiedBrowserArchive, materializePlaywrightBrowser } from "./materialize-playwright-browser.mjs";
import { collectGstackBrowserArchives } from "./collect-browser-archives.mjs";
import { inspectGstackBrowserArchives } from "./inspect-browser-archives.mjs";
import { digest } from "./executable-bundle.mjs";
import { requireResourceLease, within } from "./resource-workspace.mjs";

// Test fixtures use the repository's dev parser; production resolves and verifies
// the parser only from the pinned upstream resource-stage inventory.
const desktop = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const playwright = createRequire(desktop.resolve("@playwright/test/package.json"));
const core = createRequire(playwright.resolve("playwright/package.json"));
const parserPath = join(dirname(core.resolve("playwright-core/package.json")), "lib/utilsBundle.js");
const { yauzl, yazl } = core(parserPath);

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gstack-browser-materialize-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const zip = new yazl.ZipFile(), chunks = [];
  const done = new Promise((resolve, reject) => { zip.outputStream.on("data", b => chunks.push(b)); zip.outputStream.on("end", resolve); zip.outputStream.on("error", reject); });
  zip.addBuffer(Buffer.from("exact immutable resource"), "chrome-win64/resource.txt", { compress: false, mode: 0o100644 });
  zip.end(); await done;
  const zipPath = join(root, "browser.zip"); await writeFile(zipPath, Buffer.concat(chunks));
  const target = { platform: "win32", arch: "x64" };
  const inspected = await inspectBrowserZip({ zipPath, yauzl, target });
  return { root, zipPath, inspected, target };
}

test("materialization retains exact independently inspected bytes and refuses existing output", async t => {
  const f = await fixture(t), outputRoot = join(f.root, "candidate");
  await extractVerifiedBrowserArchive({ ...f, yauzl, outputRoot });
  assert.equal(await readFile(join(outputRoot, "chrome-win64/resource.txt"), "utf8"), "exact immutable resource");
  await assert.rejects(extractVerifiedBrowserArchive({ ...f, yauzl, outputRoot }), { code: "EEXIST" });
});

test("changes between member inspection and extraction cannot receive authenticated output bytes", async t => {
  const f = await fixture(t), bytes = await readFile(f.zipPath);
  const index = bytes.indexOf(Buffer.from("exact immutable resource"));
  assert.ok(index >= 0); bytes[index] ^= 1; await writeFile(f.zipPath, bytes);
  await assert.rejects(extractVerifiedBrowserArchive({ ...f, yauzl, outputRoot: join(f.root, "candidate") }), /member_changed/);
});

test("macOS framework aliases resolve when Versions/Current follows its consumers in the archive", {
  skip: process.platform === "win32" && "Windows materialization rejects symlinks",
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gstack-framework-materialize-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const zip = new yazl.ZipFile(), chunks = [];
  const done = new Promise((resolve, reject) => { zip.outputStream.on("data", b => chunks.push(b)); zip.outputStream.on("end", resolve); zip.outputStream.on("error", reject); });
  for (const [path, text, mode] of [
    ["framework/Versions/A/resource.txt", "bound browser resource", 0o100644],
    ["framework/resource.txt", "Versions/Current/resource.txt", 0o120755],
    ["framework/Versions/Current", "A", 0o120755],
  ]) zip.addBuffer(Buffer.from(text), path, { mode, compress: false });
  zip.end(); await done;
  const zipPath = join(root, "browser.zip"); await writeFile(zipPath, Buffer.concat(chunks));
  const target = { platform: "darwin", arch: "arm64" }, inspected = await inspectBrowserZip({ zipPath, yauzl, target });
  const outputRoot = join(root, "candidate");
  await extractVerifiedBrowserArchive({ zipPath, yauzl, inspected, outputRoot, target });
  assert.equal(await readFile(join(outputRoot, "framework/resource.txt"), "utf8"), "bound browser resource");
  assert.equal(await readlink(join(outputRoot, "framework/resource.txt")), "Versions/Current/resource.txt");
});

const target = { platform: process.platform, arch: process.arch };
const slug = { "darwin-arm64": "mac-arm64", "darwin-x64": "mac-x64", "win32-x64": "win64" }[`${target.platform}-${target.arch}`];
const managedSkip = !process.env.LING_GSTACK_RESOURCE_ROOT && !process.env.LING_GSTACK_RESOURCE_TOKEN
  ? "Use runManagedNode so browser acquisition fixtures stay in managed scratch"
  : !slug && "Browser acquisition requires a supported native macOS or Windows host";

function nativeBytes(library = false) {
  const bytes = Buffer.alloc(128);
  if (target.platform === "darwin") {
    bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(target.arch === "arm64" ? 0x0100000c : 0x01000007, 4);
    bytes.writeUInt32LE(library ? 6 : 2, 12);
  } else {
    bytes.write("MZ"); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x00004550, 64);
    bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(2, 84);
    bytes.writeUInt16LE(library ? 0x2002 : 2, 86); bytes.writeUInt16LE(0x20b, 88);
  }
  return bytes;
}

async function acquisitionFixture(t) {
  const lease = await requireResourceLease();
  const root = await realpath(await mkdtemp(join(tmpdir(), "gstack-browser-acquisition-mode-")));
  assert.ok(within(lease.scratchPath, root));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url), "utf8"));
  const browsers = [{ name: "chromium", revision: "1234", browserVersion: "151.0.7922.34" },
    { name: "ffmpeg", revision: "1011" }, { name: "chromium-headless-shell", revision: "1234", browserVersion: "151.0.7922.34" }];
  const stage = join(root, "source"), archives = join(root, "archives"), inspection = join(root, "inspection");
  const prefix = "runtime/node_modules/playwright-core/";
  const sourceFiles = new Map([
    [`runtime/tools/node${target.platform === "win32" ? ".exe" : ""}`, nativeBytes()],
    [`${prefix}package.json`, Buffer.from(JSON.stringify({ name: "playwright-core", version: "1.62.1" }))],
    [`${prefix}browsers.json`, Buffer.from(JSON.stringify({ browsers }))],
    [`${prefix}lib/coreBundle.js`, Buffer.from("// Injected fixture registry; never executed.\n")],
    [`${prefix}lib/utilsBundle.js`, Buffer.from(`module.exports = require(${JSON.stringify(parserPath)});\n`)],
  ]);
  for (const [path, bytes] of sourceFiles) {
    await mkdir(dirname(join(stage, path)), { recursive: true }); await writeFile(join(stage, path), bytes, { flag: "wx" });
  }
  const sourceInventory = Buffer.from(JSON.stringify({ schemaVersion: 1,
    files: [...sourceFiles].map(([path, bytes]) => ({ path, checksum: digest(bytes), sizeBytes: bytes.length })) }));
  await writeFile(join(stage, "resource-inventory.json"), sourceInventory);
  const stageReceipt = Buffer.from(JSON.stringify({ schemaVersion: 1, deliveryStage: "resource-prerequisites", releaseEligible: false,
    upstreamRevision: lock.revision, upstreamVersion: lock.version, adaptationRevision: "ling-fixture", target,
    inventoryChecksum: digest(sourceInventory) }));
  await writeFile(join(stage, "resource-stage.json"), stageReceipt);
  const app = `chrome-${slug}/Google Chrome for Testing.app`;
  const framework = `${app}/Contents/Frameworks/Google Chrome for Testing Framework.framework`;
  const version = browsers[0].browserVersion, versionRoot = `${framework}/Versions/${version}`;
  const executable = target.platform === "win32" ? "chrome-win64/chrome.exe" : `${app}/Contents/MacOS/Google Chrome for Testing`;
  const ffmpeg = target.platform === "win32" ? "ffmpeg-win64.exe" : "ffmpeg-mac";
  const notice = Buffer.from("Original fixture material; no redistribution approval.\n");
  const chromium = target.platform === "win32" ? [[executable, nativeBytes(), 0o100755], ["chrome-win64/ABOUT", notice]]
    : [[executable, nativeBytes(), 0o100755], [`${versionRoot}/Google Chrome for Testing Framework`, nativeBytes(true), 0o100755],
      [`${versionRoot}/Libraries/WidevineCdm/LICENSE`, notice], [`${versionRoot}/Resources/resource.txt`, notice],
      [`${versionRoot}/Helpers/helper.txt`, notice],
      ...["Google Chrome for Testing Framework", "Libraries", "Resources", "Helpers"].map(name =>
        [`${framework}/${name}`, Buffer.from(`Versions/Current/${name}`), 0o120755]),
      [`${framework}/Versions/Current`, Buffer.from(version), 0o120755]];
  const payloads = new Map();
  for (const [name, entries] of [["chromium", chromium], ["ffmpeg", [[ffmpeg, nativeBytes(), 0o100755], ["COPYING.LGPLv2.1", notice]]],
    ["chromium-headless-shell", [[`chrome-headless-shell-${slug}/chrome-headless-shell${target.platform === "win32" ? ".exe" : ""}`, nativeBytes(), 0o100755],
      [`chrome-headless-shell-${slug}/LICENSE.headless_shell`, notice]]]]) {
    const zip = new yazl.ZipFile(), chunks = [];
    const done = new Promise((resolve, reject) => {
      zip.outputStream.on("data", bytes => chunks.push(bytes)); zip.outputStream.on("end", resolve); zip.outputStream.on("error", reject);
    });
    for (const [path, bytes, mode = 0o100644] of entries) zip.addBuffer(bytes, path, { mode, compress: false });
    zip.end(); await done; payloads.set(name, Buffer.concat(chunks));
  }
  const collection = await collectGstackBrowserArchives({ resourceStagePath: stage, outputPath: archives,
    expectedResourceStageChecksum: digest(stageReceipt), target,
    registryReader: async () => browsers.map(browser => ({ name: browser.name, downloadURLs: [browser.name === "ffmpeg"
      ? `https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/${browser.revision}/ffmpeg-${slug}.zip`
      : `https://cdn.playwright.dev/builds/cft/${browser.browserVersion}/${slug}/${browser.name === "chromium" ? "chrome" : "chrome-headless-shell"}-${slug}.zip`] })),
    downloader: async (archive, path) => {
      const bytes = payloads.get(archive.name); await writeFile(path, bytes, { flag: "wx" });
      return { checksum: digest(bytes), sizeBytes: bytes.length, endpoint: archive.url };
    } });
  const options = { resourceStagePath: stage, archivePath: archives, expectedResourceStageChecksum: digest(stageReceipt),
    expectedArchiveReceiptChecksum: digest(await readFile(join(archives, "browser-archives.json"))), target };
  await inspectGstackBrowserArchives({ ...options, outputPath: inspection });
  const inventory = JSON.parse(await readFile(join(inspection, "browser-member-inventory.json"), "utf8"));
  return { root, collection, inventory, executable, ffmpeg, options: { ...options, inspectionPath: inspection,
    expectedInspectionChecksum: digest(await readFile(join(inspection, "browser-member-inspection.json"))),
    browserOutputRoot: join(root, "gstack-browser"), cacheOutputRoot: join(root, "browser-cache"), managedRoot: lease.root } };
}

test("download-required retains a pinned recipe and FFmpeg while omitting the complete Chrome tree", { skip: managedSkip }, async t => {
  const f = await acquisitionFixture(t);
  const browser = await materializePlaywrightBrowser({ ...f.options, browserMode: "download-required" });
  assert.deepEqual(await readdir(f.options.browserOutputRoot), ["browser-acquisition.json"]);
  const bytes = await readFile(join(f.options.browserOutputRoot, "browser-acquisition.json")), recipe = JSON.parse(bytes);
  const chromium = f.collection.archives.find(archive => archive.name === "chromium");
  const inspected = f.inventory.archives.find(archive => archive.name === "chromium");
  assert.deepEqual(recipe.archive, { url: chromium.url, checksum: chromium.checksum, sizeBytes: chromium.sizeBytes });
  assert.deepEqual(recipe.members, inspected.members);
  assert.equal(recipe.component.entryPath, f.executable);
  assert.equal(recipe.componentChecksum, digest(Buffer.from(`${JSON.stringify(recipe.component, null, 2)}\n`)));
  assert.equal(browser.activation, "download-required");
  assert.equal(browser.componentChecksum, digest(bytes)); assert.equal(browser.acquisitionChecksum, digest(bytes));
  assert.equal(browser.entryPath, "../../gstack-browser/browser-acquisition.json");
  assert.equal(browser.entryChecksum, inspected.members.find(member => member.path === f.executable).checksum);
  assert.equal(browser.releaseEligible, false); assert.ok(browser.pendingGates.includes("installed-client-acceptance"));
  assert.deepEqual(await readFile(join(f.options.cacheOutputRoot, "ffmpeg-1011", f.ffmpeg)), nativeBytes());
});

test("download-required still rejects changed unused archives and forged inspected members before output", { skip: managedSkip }, async t => {
  for (const change of ["archive", "inspection"]) {
    const f = await acquisitionFixture(t);
    if (change === "archive") {
      const headless = f.collection.archives.find(archive => archive.name === "chromium-headless-shell");
      await writeFile(join(f.options.archivePath, headless.filename), "changed unused archive");
    } else {
      f.inventory.archives.find(archive => archive.name === "chromium-headless-shell").members[0].checksum = `sha256:${"a".repeat(64)}`;
      const inventoryBytes = Buffer.from(JSON.stringify(f.inventory));
      await writeFile(join(f.options.inspectionPath, "browser-member-inventory.json"), inventoryBytes);
      const receiptPath = join(f.options.inspectionPath, "browser-member-inspection.json");
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")); receipt.inventoryChecksum = digest(inventoryBytes);
      const receiptBytes = Buffer.from(JSON.stringify(receipt)); await writeFile(receiptPath, receiptBytes);
      f.options.expectedInspectionChecksum = digest(receiptBytes);
    }
    await assert.rejects(materializePlaywrightBrowser({ ...f.options, browserMode: "download-required" }),
      change === "archive" ? /inspection_archive_changed/ : /archive_members_changed/);
    await assert.rejects(readdir(f.options.browserOutputRoot), { code: "ENOENT" });
  }
});

test("download-required refuses an existing browser output without replacing it", { skip: managedSkip }, async t => {
  const f = await acquisitionFixture(t); await mkdir(f.options.browserOutputRoot);
  await writeFile(join(f.options.browserOutputRoot, "KEEP"), "existing generation");
  await assert.rejects(materializePlaywrightBrowser({ ...f.options, browserMode: "download-required" }), { code: "EEXIST" });
  assert.equal(await readFile(join(f.options.browserOutputRoot, "KEEP"), "utf8"), "existing generation");
});

test("unsupported browser materialization modes cannot silently become bundled", async () => {
  await assert.rejects(materializePlaywrightBrowser({ browserMode: "automatic-latest" }), /browser_mode_invalid/);
});
