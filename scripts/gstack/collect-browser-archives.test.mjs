import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { collectGstackBrowserArchives, downloadBrowserArchive, validateBrowserArchivePlan,
  verifyBrowserArchiveSource } from "./collect-browser-archives.mjs";
import { acquireResourceLease, initResourceWorkspace } from "./resource-workspace.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url), "utf8"));
const target = { platform: process.platform, arch: process.arch };
const packagePrefix = "runtime/node_modules/playwright-core/";
const nodePath = `runtime/tools/node${target.platform === "win32" ? ".exe" : ""}`;
const badBytes = Buffer.from("HTTP 200 error page, not a browser ZIP", "utf8");
const zipBytes = Buffer.concat([Buffer.from("504b0304", "hex"), Buffer.from("non-executed test archive")]);
const slug = { "darwin-arm64": "mac-arm64", "darwin-x64": "mac-x64", "win32-x64": "win64" }[`${target.platform}-${target.arch}`];
const browsers = [{ name: "chromium", revision: "1234", browserVersion: "151.0.7922.34" },
  { name: "ffmpeg", revision: "1011" }, { name: "chromium-headless-shell", revision: "1234", browserVersion: "151.0.7922.34" }];

function plan() {
  return browsers.map(browser => ({ name: browser.name, downloadURLs: [browser.name === "ffmpeg"
    ? `https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/${browser.revision}/ffmpeg-${slug}.zip`
    : `https://cdn.playwright.dev/builds/cft/${browser.browserVersion}/${slug}/${browser.name === "chromium" ? "chrome" : "chrome-headless-shell"}-${slug}.zip`] }));
}

function binary() {
  const bytes = Buffer.alloc(128);
  if (target.platform === "darwin") {
    bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(target.arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  } else {
    bytes.write("MZ"); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x00004550, 64);
    bytes.writeUInt16LE(target.arch === "arm64" ? 0xaa64 : 0x8664, 68);
  }
  return bytes;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-gstack-browser-acquisition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "source"), output = join(root, "output");
  const files = new Map([[nodePath, binary()],
    [`${packagePrefix}package.json`, Buffer.from(JSON.stringify({ name: "playwright-core", version: "1.62.1" }))],
    [`${packagePrefix}browsers.json`, Buffer.from(JSON.stringify({ browsers }))],
    [`${packagePrefix}lib/coreBundle.js`, Buffer.from("// fixture registry; never executed\n")],
    [`${packagePrefix}lib/utilsBundle.js`, Buffer.from("// fixture utility; never executed\n")]]);
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(stage, path)), { recursive: true }); await writeFile(join(stage, path), bytes);
  }
  const inventory = Buffer.from(JSON.stringify({ schemaVersion: 1,
    files: [...files].map(([path, bytes]) => ({ path, checksum: checksum(bytes), sizeBytes: bytes.length })) }));
  await writeFile(join(stage, "resource-inventory.json"), inventory);
  const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, deliveryStage: "resource-prerequisites", releaseEligible: false,
    upstreamRevision: lock.revision, upstreamVersion: lock.version, target,
    adaptationRevision: "ling-fixture", inventoryChecksum: checksum(inventory) }));
  await writeFile(join(stage, "resource-stage.json"), receipt);
  let registryCalls = 0, downloadCalls = 0;
  const options = { resourceStagePath: stage, outputPath: output, expectedResourceStageChecksum: checksum(receipt), target,
    registryReader: async () => { registryCalls++; return plan(); },
    downloader: async (archive, path) => { downloadCalls++; await writeFile(path, zipBytes, { flag: "wx" });
      return { checksum: checksum(zipBytes), sizeBytes: zipBytes.length, endpoint: archive.url }; } };
  return { root, stage, output, files, receipt, inventory, options,
    calls: () => ({ registryCalls, downloadCalls }) };
}

test("browser plans require all three exact pinned platform assets, never system Chrome or mutable latest", () => {
  const source = { browsers };
  assert.deepEqual(validateBrowserArchivePlan(plan(), source, target).map(p => p.name), browsers.map(b => b.name));
  for (const value of [[], plan().slice(0, 2), [plan()[0], plan()[0], plan()[2]],
    plan().map((p, i) => i ? p : { ...p, downloadURLs: [p.downloadURLs[0].replace("151.0.7922.34", "latest")] }),
    plan().map((p, i) => i ? p : { ...p, downloadURLs: [p.downloadURLs[0].replace("https:", "http:")] }),
    plan().map((p, i) => i ? p : { ...p, downloadURLs: [p.downloadURLs[0].replace("cdn.playwright.dev", "127.0.0.1")] })]) {
    assert.throws(() => validateBrowserArchivePlan(value, source, target), /gstack_browser_archive_/);
  }
  assert.throws(() => validateBrowserArchivePlan(plan(), source, { platform: "win32", arch: "arm64" }), /plan_invalid/);
});

test("collection verifies the detached receipt, complete Playwright inventory and native Node before registry execution", async t => {
  for (const change of ["receipt", "inventory", "core", "extra", "link", "node"]) {
    const f = await fixture(t);
    if (change === "receipt") f.options.expectedResourceStageChecksum = `sha256:${"a".repeat(64)}`;
    if (change === "inventory") await writeFile(join(f.stage, "resource-inventory.json"), "{}");
    if (change === "core") await writeFile(join(f.stage, `${packagePrefix}lib/coreBundle.js`), "changed registry");
    if (change === "extra") await writeFile(join(f.stage, `${packagePrefix}lib/extra.js`), "unreviewed module");
    if (change === "link") {
      await rm(join(f.stage, `${packagePrefix}lib/utilsBundle.js`));
      await symlink(join(f.root, "outside.js"), join(f.stage, `${packagePrefix}lib/utilsBundle.js`));
    }
    if (change === "node") await writeFile(join(f.stage, nodePath), "unreviewed executable");
    await assert.rejects(collectGstackBrowserArchives(f.options), /gstack_browser_source_/);
    assert.deepEqual(f.calls(), { registryCalls: 0, downloadCalls: 0 });
    await assert.rejects(readFile(join(f.output, "browser-archives.json")), { code: "ENOENT" });
  }
});

test("source review rejects foreign upstream identities even with refreshed local receipt hashes", async t => {
  const f = await fixture(t);
  const receipt = JSON.parse(f.receipt.toString()); receipt.upstreamRevision = "a".repeat(40);
  const bytes = Buffer.from(JSON.stringify(receipt));
  await writeFile(join(f.stage, "resource-stage.json"), bytes);
  await assert.rejects(verifyBrowserArchiveSource({ ...f.options, expectedResourceStageChecksum: checksum(bytes) }), /source_identity_mismatch/);
});

test("an invalid native target does not become approved by self-refreshing inventory and receipt hashes", async t => {
  const f = await fixture(t), bytes = Buffer.from("not a target Node executable");
  await writeFile(join(f.stage, nodePath), bytes);
  const inventory = JSON.parse(f.inventory.toString());
  Object.assign(inventory.files.find(file => file.path === nodePath), { checksum: checksum(bytes), sizeBytes: bytes.length });
  const inventoryBytes = Buffer.from(JSON.stringify(inventory));
  const receipt = { ...JSON.parse(f.receipt.toString()), inventoryChecksum: checksum(inventoryBytes) };
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  await writeFile(join(f.stage, "resource-inventory.json"), inventoryBytes);
  await writeFile(join(f.stage, "resource-stage.json"), receiptBytes);
  await assert.rejects(verifyBrowserArchiveSource({ ...f.options, expectedResourceStageChecksum: checksum(receiptBytes) }), /node_target_mismatch/);
});

test("all exact archives are independently hashed and remain non-executable candidates with explicit pending gates", async t => {
  const f = await fixture(t);
  let home;
  const registryReader = f.options.registryReader;
  f.options.registryReader = (...args) => { home = args[1]; return registryReader(...args); };
  const receipt = await collectGstackBrowserArchives(f.options);
  assert.deepEqual(f.calls(), { registryCalls: 1, downloadCalls: 3 });
  assert.equal(receipt.reviewStatus, "candidate-only");
  assert.equal(receipt.deliveryStage, "browser-archive-candidates");
  assert.equal(receipt.releaseEligible, false);
  assert.equal(receipt.hostAcceptance, "pending");
  assert.equal(receipt.packageAcceptance, "pending");
  assert.ok(receipt.pendingGates.includes("real-browser-execution"));
  for (const archive of receipt.archives) assert.deepEqual(await readFile(join(f.output, archive.filename)), zipBytes);
  assert.deepEqual(JSON.parse(await readFile(join(f.output, "browser-archives.json"), "utf8")), receipt);
  await assert.rejects(readFile(join(f.output, "manifest.json")), { code: "ENOENT" });
  await assert.rejects(collectGstackBrowserArchives(f.options), /gstack_browser_output_exists/);
  assert.deepEqual(await readFile(join(f.stage, "resource-stage.json")), f.receipt);
  assert.equal((await readdir(f.root)).some(path => path.startsWith(".gstack-browser-acquisition-")), false);
  await assert.rejects(lstat(home), { code: "ENOENT" });
});

test("a failed registry retains artifact-output staging inside its lease until explicit owner release", async t => {
  const f = await fixture(t), managed = join(await realpath(f.root), "managed");
  await initResourceWorkspace({ root: managed, storageMode: "local-bounded" });
  const lease = await acquireResourceLease(managed);
  const keys = ["LING_GSTACK_RESOURCE_ROOT", "LING_GSTACK_RESOURCE_TOKEN", "TMPDIR", "TMP", "TEMP"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  let home;
  try {
    for (const key of keys) process.env[key] = lease.env[key];
    f.options.outputPath = join(managed, "artifacts/browser/registry-timeout");
    // No subprocess is started: force the same exception as registry timeout.
    f.options.registryReader = async (_source, registryHome) => {
      home = registryHome;
      await writeFile(join(home, "registry-input.txt"), "synthetic registry input");
      throw Object.assign(new Error("synthetic registry timed out"), { code: "ETIMEDOUT" });
    };
    await assert.rejects(collectGstackBrowserArchives(f.options), { code: "ETIMEDOUT" });
    assert.ok((await lstat(home)).isDirectory());
    assert.equal(dirname(dirname(home)), join(lease.scratchPath, "tmp"));
    assert.equal(await readFile(join(home, "registry-input.txt"), "utf8"), "synthetic registry input");
    await assert.rejects(lstat(f.options.outputPath), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(managed, "artifacts/browser")), []);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    // This fixture never executes a registry/descendant. Only its owner releases.
    await lease.release();
  }
  await assert.rejects(lstat(home), { code: "ENOENT" });
});

test("bad download hashes, non-ZIP responses and interrupted acquisition cannot publish a partial output", async t => {
  for (const failure of ["hash", "format", "interrupted"]) {
    const f = await fixture(t);
    f.options.downloader = async (_archive, path) => {
      const bytes = failure === "format" ? badBytes : zipBytes;
      await writeFile(path, bytes, { flag: "wx" });
      if (failure === "interrupted") throw new Error("download interrupted");
      return { checksum: failure === "hash" ? `sha256:${"a".repeat(64)}` : checksum(bytes), sizeBytes: bytes.length };
    };
    await assert.rejects(collectGstackBrowserArchives(f.options), /gstack_browser_download_|download interrupted/);
    await assert.rejects(readFile(join(f.output, "browser-archives.json")), { code: "ENOENT" });
    assert.equal((await readdir(f.root)).some(path => path.startsWith(".gstack-browser-acquisition-")), false);
  }
});

test("source changes during downloads are rejected without undoing the owner's changed file", async t => {
  const f = await fixture(t);
  const original = f.options.downloader;
  const path = join(f.stage, `${packagePrefix}lib/coreBundle.js`);
  f.options.downloader = async (...args) => {
    const result = await original(...args); await writeFile(path, "owner changed registry"); return result;
  };
  await assert.rejects(collectGstackBrowserArchives(f.options), /gstack_browser_source_changed/);
  assert.equal(await readFile(path, "utf8"), "owner changed registry");
  await assert.rejects(readFile(join(f.output, "browser-archives.json")), { code: "ENOENT" });
});

test("canonical output aliases and foreign-platform labels cannot modify the source or start downloads", async t => {
  const f = await fixture(t);
  await symlink(f.stage, join(f.root, "source-alias"), "dir");
  await assert.rejects(collectGstackBrowserArchives({ ...f.options, outputPath: join(f.root, "source-alias", "output") }), /source_output_overlap/);
  await assert.rejects(collectGstackBrowserArchives({ ...f.options, target: { platform: "win32", arch: "invalid" } }), /requires_matching_host/);
  assert.deepEqual(f.calls(), { registryCalls: 0, downloadCalls: 0 });
});

test("HTTP archive acquisition bounds redirects and content sizes without contacting unapproved endpoints", async t => {
  const f = await fixture(t);
  const archive = validateBrowserArchivePlan(plan(), { browsers }, target)[0];
  const calls = [];
  t.mock.method(globalThis, "fetch", async url => {
    calls.push(url.toString()); return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret.zip" } });
  });
  await assert.rejects(downloadBrowserArchive(archive, join(f.root, "download.zip")), /download_endpoint_invalid/);
  assert.deepEqual(calls, [archive.url]);
  t.mock.method(globalThis, "fetch", async () => new Response(zipBytes, { headers: { "content-length": `${512 * 1024 * 1024 + 1}` } }));
  await assert.rejects(downloadBrowserArchive(archive, join(f.root, "download.zip")), /download_size_invalid/);
  await assert.rejects(readFile(join(f.root, "download.zip")), { code: "ENOENT" });
});

test("HTTP success independently hashes exact bytes, strips public redirect query data and never extracts an archive", async t => {
  const f = await fixture(t);
  const archive = validateBrowserArchivePlan(plan(), { browsers }, target)[0];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1
    ? new Response(null, { status: 302, headers: { location: `${archive.url}?public-download=fixture` } })
    : new Response(zipBytes, { headers: { "content-length": `${zipBytes.length}` } }));
  const result = await downloadBrowserArchive(archive, join(f.root, "download.zip"));
  assert.equal(result.checksum, checksum(zipBytes)); assert.equal(result.sizeBytes, zipBytes.length);
  assert.equal(result.endpoint, archive.url);
  assert.deepEqual(await readFile(join(f.root, "download.zip")), zipBytes);
});
