import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { collectGstackBrowserArchives } from "./collect-browser-archives.mjs";
import { digest } from "./executable-bundle.mjs";
import { inspectGstackBrowserArchives, validateRequiredBrowserArtifacts } from "./inspect-browser-archives.mjs";
import { inspectBrowserZip } from "./inspect-browser-zip.mjs";
import { materializePlaywrightBrowser } from "./materialize-playwright-browser.mjs";
import { requireResourceLease, within } from "./resource-workspace.mjs";

const target = { platform: process.platform, arch: process.arch };
const slug = { "darwin-arm64": "mac-arm64", "darwin-x64": "mac-x64", "win32-x64": "win64" }[`${target.platform}-${target.arch}`];
const skip = !process.env.LING_GSTACK_RESOURCE_ROOT && !process.env.LING_GSTACK_RESOURCE_TOKEN
  ? "Use runManagedNode with a resource lease; synthetic pipeline fixtures stay in managed scratch"
  : !slug && "Browser publication requires a supported native macOS or Windows host";
const browsers = [{ name: "chromium", revision: "1234", browserVersion: "151.0.7922.34" },
  { name: "ffmpeg", revision: "1011" }, { name: "chromium-headless-shell", revision: "1234", browserVersion: "151.0.7922.34" }];
const notice = Buffer.from("Synthetic original notice; no browser is downloaded or executed.\n");
const about = Buffer.from("Google Chrome\r\n\r\nCopyright 2026 Google LLC. All rights reserved.\r\n\r\nChrome is made possible by the Chromium open source project\r\n(https://www.chromium.org/) and other open source software\r\n(chrome://credits).\r\n\r\nSee the Terms of Service at chrome://terms.\r\n");

function nativeBytes(library = false, fixtureTarget = target) {
  const bytes = Buffer.alloc(128);
  if (fixtureTarget.platform === "darwin") {
    bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(fixtureTarget.arch === "arm64" ? 0x0100000c : 0x01000007, 4);
    bytes.writeUInt32LE(library ? 6 : 2, 12);
  } else {
    bytes.write("MZ"); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x00004550, 64);
    bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(2, 84);
    bytes.writeUInt16LE(library ? 0x2002 : 2, 86); bytes.writeUInt16LE(0x20b, 88);
  }
  return bytes;
}

function devZipTools() {
  const desktop = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
  const playwright = createRequire(desktop.resolve("@playwright/test/package.json"));
  const core = createRequire(playwright.resolve("playwright/package.json"));
  const parserPath = join(dirname(core.resolve("playwright-core/package.json")), "lib/utilsBundle.js");
  return { parserPath, ...core(parserPath) };
}

async function zipBytes(yazl, entries) {
  const zip = new yazl.ZipFile(), chunks = [];
  const done = new Promise((resolve, reject) => {
    zip.outputStream.on("data", bytes => chunks.push(bytes));
    zip.outputStream.on("end", resolve); zip.outputStream.on("error", reject);
  });
  for (const [path, bytes, mode = 0o100644] of entries) zip.addBuffer(bytes, path, { mode, compress: false });
  zip.end(); await done;
  return Buffer.concat(chunks);
}

async function fixture(t) {
  const lease = await requireResourceLease();
  const root = await realpath(await mkdtemp(join(tmpdir(), "browser-publication-pipeline-")));
  assert.ok(within(lease.scratchPath, root));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { parserPath, yazl } = devZipTools();
  const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url), "utf8"));
  const stage = join(root, "source"), archives = join(root, "archives"), inspection = join(root, "inspection");
  const prefix = "runtime/node_modules/playwright-core/";
  // Only the test fixture bridges to the dev ZIP parser. Production verifies
  // its complete pinned parser inventory; this fixture copies no dependencies.
  const files = new Map([
    [`runtime/tools/node${target.platform === "win32" ? ".exe" : ""}`, nativeBytes()],
    [`${prefix}package.json`, Buffer.from(JSON.stringify({ name: "playwright-core", version: "1.62.1" }))],
    [`${prefix}browsers.json`, Buffer.from(JSON.stringify({ browsers }))],
    [`${prefix}lib/coreBundle.js`, Buffer.from("// Synthetic registry is injected, never executed.\n")],
    [`${prefix}lib/utilsBundle.js`, Buffer.from(`module.exports = require(${JSON.stringify(parserPath)});\n`)],
  ]);
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await writeFile(join(stage, path), bytes, { flag: "wx" });
  }
  const inventory = Buffer.from(JSON.stringify({ schemaVersion: 1,
    files: [...files].map(([path, bytes]) => ({ path, checksum: digest(bytes), sizeBytes: bytes.length })) }));
  await writeFile(join(stage, "resource-inventory.json"), inventory, { flag: "wx" });
  const stageReceipt = Buffer.from(JSON.stringify({ schemaVersion: 1, deliveryStage: "resource-prerequisites", releaseEligible: false,
    upstreamRevision: lock.revision, upstreamVersion: lock.version, target,
    adaptationRevision: "ling-synthetic-pipeline", inventoryChecksum: digest(inventory) }));
  await writeFile(join(stage, "resource-stage.json"), stageReceipt, { flag: "wx" });
  const browserPrefix = `chrome-${slug}`, headless = `chrome-headless-shell-${slug}`;
  const app = `${browserPrefix}/Google Chrome for Testing.app`;
  const framework = `${app}/Contents/Frameworks/Google Chrome for Testing Framework.framework`;
  const version = browsers[0].browserVersion, versionRoot = `${framework}/Versions/${version}`;
  const executable = target.platform === "win32" ? `${browserPrefix}/chrome.exe` : `${app}/Contents/MacOS/Google Chrome for Testing`;
  const ffmpeg = target.platform === "win32" ? "ffmpeg-win64.exe" : "ffmpeg-mac";
  const chromium = target.platform === "win32"
    ? [[executable, nativeBytes(), 0o100755], [`${browserPrefix}/ABOUT`, about]]
    : [[executable, nativeBytes(), 0o100755],
      [`${versionRoot}/Google Chrome for Testing Framework`, nativeBytes(true), 0o100755],
      [`${versionRoot}/Libraries/WidevineCdm/LICENSE`, notice],
      [`${versionRoot}/Resources/resource.txt`, Buffer.from("bound browser resource")],
      [`${versionRoot}/Helpers/helper.txt`, Buffer.from("bound helper resource")],
      ...["Google Chrome for Testing Framework", "Libraries", "Resources", "Helpers"].map(name =>
        [`${framework}/${name}`, Buffer.from(`Versions/Current/${name}`), 0o120755]),
      [`${framework}/Versions/Current`, Buffer.from(version), 0o120755]];
  const payloads = new Map();
  for (const [name, entries] of [["chromium", chromium], ["ffmpeg", [[ffmpeg, nativeBytes(), 0o100755], ["COPYING.LGPLv2.1", notice]]],
    ["chromium-headless-shell", [[`${headless}/chrome-headless-shell${target.platform === "win32" ? ".exe" : ""}`, nativeBytes(), 0o100755],
      [`${headless}/LICENSE.headless_shell`, notice]]]]) payloads.set(name, await zipBytes(yazl, entries));
  const collected = await collectGstackBrowserArchives({ resourceStagePath: stage, outputPath: archives,
    expectedResourceStageChecksum: digest(stageReceipt), target,
    registryReader: async () => browsers.map(browser => ({ name: browser.name, downloadURLs: [browser.name === "ffmpeg"
      ? `https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/${browser.revision}/ffmpeg-${slug}.zip`
      : `https://cdn.playwright.dev/builds/cft/${browser.browserVersion}/${slug}/${browser.name === "chromium" ? "chrome" : "chrome-headless-shell"}-${slug}.zip`] })),
    downloader: async (archive, path) => {
      const bytes = payloads.get(archive.name);
      await writeFile(path, bytes, { flag: "wx" });
      return { checksum: digest(bytes), sizeBytes: bytes.length, endpoint: archive.url };
    } });
  const archiveReceiptPath = join(archives, "browser-archives.json"), archiveReceipt = await readFile(archiveReceiptPath);
  const options = { resourceStagePath: stage, archivePath: archives, expectedResourceStageChecksum: digest(stageReceipt),
    expectedArchiveReceiptChecksum: digest(archiveReceipt), target };
  const inspected = await inspectGstackBrowserArchives({ ...options, outputPath: inspection });
  const inspectionReceiptPath = join(inspection, "browser-member-inspection.json");
  const materialize = { ...options, inspectionPath: inspection, expectedInspectionChecksum: digest(await readFile(inspectionReceiptPath)),
    browserOutputRoot: join(root, "gstack-browser"), cacheOutputRoot: join(root, "browser-cache"), managedRoot: lease.root };
  return { root, collected, inspected, options, archiveReceiptPath, archiveReceipt, inspectionReceiptPath, materialize, executable, ffmpeg };
}

test("browser publication pipeline retains producer provenance through real inspection and materialization", { skip }, async t => {
  const f = await fixture(t);
  const browser = await materializePlaywrightBrowser(f.materialize);
  assert.equal(f.collected.archives.length, 3);
  assert.equal(f.inspected.releaseEligible, false);
  assert.ok(f.inspected.pendingGates.includes("exact-archive-license-review"));
  assert.equal(browser.releaseEligible, false);
  assert.ok(browser.pendingGates.includes("installed-client-acceptance"));
  assert.deepEqual(await readFile(join(f.materialize.browserOutputRoot, f.executable)), nativeBytes());
  assert.deepEqual(await readFile(join(f.materialize.cacheOutputRoot, "ffmpeg-1011", f.ffmpeg)), nativeBytes());
  const component = JSON.parse(await readFile(join(f.materialize.browserOutputRoot, "browser-component.json"), "utf8"));
  assert.equal(component.links.length, target.platform === "darwin" ? 5 : 0);
});

test("Windows Chromium requires its exact ABOUT copyright reference without treating it as license approval", { skip }, async t => {
  const lease = await requireResourceLease();
  const root = await realpath(await mkdtemp(join(tmpdir(), "browser-original-materials-")));
  assert.ok(within(lease.scratchPath, root));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { yauzl, yazl } = devZipTools(), windows = { platform: "win32", arch: "x64" };
  let sequence = 0;
  const inspect = async (entries, inspectedTarget = windows) => {
    const zipPath = join(root, `${sequence++}.zip`);
    await writeFile(zipPath, await zipBytes(yazl, entries), { flag: "wx" });
    return inspectBrowserZip({ zipPath, yauzl, target: inspectedTarget });
  };
  const executable = ["chrome-win64/chrome.exe", nativeBytes(false, windows), 0o100755];
  const result = await inspect([executable, ["chrome-win64/ABOUT", about]]);
  assert.deepEqual(result.notices, [{ path: "chrome-win64/ABOUT", sizeBytes: about.length,
    checksum: digest(about), text: about.toString(), materialKind: "copyright-reference" }]);
  assert.equal(validateRequiredBrowserArtifacts(browsers[0], result, windows).requiredNoticePath, "chrome-win64/ABOUT");
  await assert.rejects(readFile(join(root, "chrome-win64/ABOUT")), { code: "ENOENT" });
  for (const path of [undefined, "chrome-win64/nested/ABOUT", "chrome-win64/about", "chrome-win64/WidevineCdm/LICENSE"]) {
    const changed = await inspect([executable, ...(path ? [[path, about]] : [])]);
    assert.throws(() => validateRequiredBrowserArtifacts(browsers[0], changed, windows), /inspection_notice_missing/);
  }
  for (const other of [{ platform: "darwin", arch: "arm64" }, { platform: "win32", arch: "arm64" }]) {
    assert.deepEqual((await inspect([["chrome-win64/ABOUT", about]], other)).notices, []);
  }
  for (const bytes of [Buffer.from("\0"), Buffer.from([0xff]), Buffer.from(" \r\n")]) {
    await assert.rejects(inspect([["chrome-win64/ABOUT", bytes]]), /notice_invalid|encoded data/);
  }
});

test("refreshed receipt hashes cannot hide changed publication-helper provenance", { skip }, async t => {
  const f = await fixture(t), wrong = `sha256:${"a".repeat(64)}`;
  const collection = JSON.parse(f.archiveReceipt);
  collection.collectorInputChecksums.find(input => input.path === "publish-staged-directory.mjs").checksum = wrong;
  const changedCollection = Buffer.from(JSON.stringify(collection));
  await writeFile(f.archiveReceiptPath, changedCollection);
  await assert.rejects(inspectGstackBrowserArchives({ ...f.options,
    expectedArchiveReceiptChecksum: digest(changedCollection), outputPath: join(f.root, "rejected-inspection") }), /inspection_collector_changed/);
  await writeFile(f.archiveReceiptPath, f.archiveReceipt);

  const receipt = JSON.parse(await readFile(f.inspectionReceiptPath, "utf8"));
  receipt.inspectorInputChecksums.find(input => input.path === "publish-staged-directory.mjs").checksum = wrong;
  const inventoryPath = join(f.materialize.inspectionPath, "browser-member-inventory.json");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  inventory.inspectorInputChecksums = receipt.inspectorInputChecksums;
  const changedInventory = Buffer.from(JSON.stringify(inventory));
  await writeFile(inventoryPath, changedInventory); receipt.inventoryChecksum = digest(changedInventory);
  const changedReceipt = Buffer.from(JSON.stringify(receipt));
  await writeFile(f.inspectionReceiptPath, changedReceipt);
  await assert.rejects(materializePlaywrightBrowser({ ...f.materialize, expectedInspectionChecksum: digest(changedReceipt) }), /inspector_changed/);
  await assert.rejects(readFile(join(f.materialize.browserOutputRoot, "browser-component.json")), { code: "ENOENT" });
});
