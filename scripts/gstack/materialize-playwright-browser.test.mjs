import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { inspectBrowserZip } from "./inspect-browser-zip.mjs";
import { extractVerifiedBrowserArchive } from "./materialize-playwright-browser.mjs";

// Test fixtures use the repository's dev parser; production resolves and verifies
// the parser only from the pinned upstream resource-stage inventory.
const desktop = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const playwright = createRequire(desktop.resolve("@playwright/test/package.json"));
const core = createRequire(playwright.resolve("playwright/package.json"));
const { yauzl, yazl } = core(join(dirname(core.resolve("playwright-core/package.json")), "lib/utilsBundle.js"));

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
