import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { verifyBrowserAcquisitionDescriptor, verifyBundledBrowser, verifyPackagedBrowser } from "../dist/bundled-skill-browser.js";
import { browserAcquisitionFixture } from "./support/browser-acquisition-fixture.mjs";

const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-browser-verifier-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entryPath = "Chromium.app/Contents/MacOS/Chromium", framework = "Chromium.app/Contents/Frameworks/Chromium Framework.framework";
  await mkdir(dirname(join(root, entryPath)), { recursive: true });
  await mkdir(join(root, framework, "Versions/A"), { recursive: true });
  const bytes = Buffer.from("fixture data; never executed");
  await writeFile(join(root, entryPath), bytes);
  const links = [];
  for (let i = 0; i < 5; i++) {
    const path = `${framework}/alias-${i}`;
    await symlink("Versions/A", join(root, path));
    links.push({ path, linkTarget: "Versions/A", resolvedTarget: `${framework}/Versions/A` });
  }
  const target = { platform: "darwin", arch: "arm64" };
  const manifest = { schemaVersion: 1, target, entryPath, files: [{ path: entryPath, sizeBytes: bytes.length, checksum: digest(bytes) }], links };
  const manifestBytes = JSON.stringify(manifest);
  await writeFile(join(root, "browser-component.json"), manifestBytes);
  const checksum = digest(manifestBytes);
  return { root, entryPath, target, manifest, checksum, verify: () => verifyBundledBrowser(root, checksum, target) };
}
test("authenticated framework aliases are admitted; file and manifest mutations reject", async t => {
  const f = await fixture(t), admitted = f.verify();
  admitted.assertCurrent();
  await writeFile(join(f.root, f.entryPath), Buffer.alloc((await readFile(join(f.root, f.entryPath))).length));
  assert.throws(() => admitted.assertCurrent(), /component_invalid/);
  assert.throws(f.verify, /component_invalid/);
});
test("unlisted files, escaping or retargeted aliases and modified manifests reject", async t => {
  for (const mutation of ["extra-file", "escape-alias", "retarget-alias", "manifest"]) await t.test(mutation, async t => {
    const f = await fixture(t), admitted = f.verify();
    const link = join(f.root, f.manifest.links[0].path);
    if (mutation === "extra-file") await writeFile(join(f.root, "unlisted"), "not authenticated");
    if (mutation.endsWith("alias")) {
      await unlink(link);
      await symlink(mutation === "escape-alias" ? tmpdir() : "Versions", link);
    }
    if (mutation === "manifest") await writeFile(join(f.root, "browser-component.json"), "{}");
    assert.throws(f.verify, /component_invalid/);
    assert.throws(() => admitted.assertCurrent(), /component_invalid/);
  });
});

test("Playwright Windows components require the exact package entry and zero links", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-browser-win-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entryPath = "chrome-win64/chrome.exe", bytes = Buffer.from("fixture only; never executed");
  await mkdir(join(root, "chrome-win64"));
  await writeFile(join(root, entryPath), bytes);
  const target = { platform: "win32", arch: "x64" };
  const base = { schemaVersion: 1, source: "playwright-registry", target, entryPath,
    files: [{ path: entryPath, checksum: digest(bytes), sizeBytes: bytes.length }], links: [] };
  async function verify(manifest, expected = target) {
    const data = JSON.stringify(manifest); await writeFile(join(root, "browser-component.json"), data);
    return () => verifyBundledBrowser(root, digest(data), expected);
  }
  const admitted = (await verify(base))();
  admitted.assertCurrent();
  for (const mutation of [{ source: "download" }, { entryPath: "chrome-win64/other.exe" },
    { links: [{ path: "chrome-win64/alias", linkTarget: "chrome.exe", resolvedTarget: entryPath }] }]) {
    assert.throws(await verify({ ...base, ...mutation }), /component_invalid/);
  }
  assert.throws(await verify(base, { platform: "win32", arch: "arm64" }), /component_invalid/);
});

async function acquisitionFixture(t, target = { platform: "win32", arch: "x64" }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-browser-descriptor-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = browserAcquisitionFixture(target), path = join(root, "browser-acquisition.json");
  await writeFile(path, data.bytes);
  return { root, path, target, ...data };
}

test("download-required admission keeps only immutable instructions and performs no download", async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("resource admission must not download a browser"));
  for (const target of [{ platform: "win32", arch: "x64" }, { platform: "darwin", arch: "arm64" }]) {
    const f = await acquisitionFixture(t, target), browser = verifyPackagedBrowser(f.root, f.selection, target);
    assert.equal(browser.root, f.root); assert.equal(browser.entry, f.path); assert.equal(browser.checksum, f.checksum);
    assert.ok(Object.isFrozen(browser)); browser.assertCurrent();
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("descriptor mutation, extra files and substituted roots cannot remain admitted", async t => {
  for (const mutation of ["bytes", "extra", "file-link", "root-link"]) await t.test(mutation, async t => {
    const f = await acquisitionFixture(t), browser = verifyBrowserAcquisitionDescriptor(f.root, f.checksum, f.target);
    if (mutation === "bytes") await writeFile(f.path, "{}");
    if (mutation === "extra") await writeFile(join(f.root, "chrome.exe"), "unlisted executable");
    if (mutation === "file-link") {
      const original = `${f.root}-original.json`; await writeFile(original, f.bytes);
      t.after(() => rm(original, { force: true })); await unlink(f.path); await symlink(original, f.path);
    }
    if (mutation === "root-link") {
      const alias = `${f.root}-alias`; await symlink(f.root, alias); t.after(() => rm(alias, { force: true }));
      assert.throws(() => verifyBrowserAcquisitionDescriptor(alias, f.checksum, f.target), /component_invalid/);
      return;
    }
    assert.throws(() => browser.assertCurrent(), /component_invalid/);
    assert.throws(() => verifyBrowserAcquisitionDescriptor(f.root, f.checksum, f.target), /component_invalid/);
  });
});

test("self-consistent descriptor hashes do not admit wrong URLs, targets or incomplete member mappings", async t => {
  const mutations = [
    recipe => { recipe.mode = "bundled"; }, recipe => { recipe.schemaVersion = 2; },
    recipe => { recipe.archive.url = "https://untrusted.invalid/chrome.zip"; },
    recipe => { recipe.archive.url += "?override=1"; }, recipe => { recipe.archive.sizeBytes = 512 * 1024 ** 2 + 1; },
    recipe => { recipe.target.arch = "arm64"; }, recipe => { recipe.componentChecksum = digest("different"); },
    recipe => { recipe.members.pop(); }, recipe => { recipe.members.push(structuredClone(recipe.members[0])); },
    recipe => { recipe.members[1].path = "../chrome.exe"; }, recipe => { recipe.members[1].sizeBytes++; },
  ];
  for (const mutation of mutations) {
    const f = await acquisitionFixture(t), recipe = structuredClone(f.recipe); mutation(recipe);
    const bytes = JSON.stringify(recipe); await writeFile(f.path, bytes);
    assert.throws(() => verifyBrowserAcquisitionDescriptor(f.root, digest(bytes), f.target), /component_invalid/);
  }
  const f = await acquisitionFixture(t);
  for (const change of [{ activation: "arbitrary" }, { acquisitionChecksum: digest("other") },
    { entryPath: "../../gstack-browser/chrome.exe" }, { target: { platform: "win32", arch: "arm64" } }]) {
    assert.throws(() => verifyPackagedBrowser(f.root, { ...f.selection, ...change }, f.target), /component_invalid/);
  }
  await writeFile(f.path, Buffer.alloc(4 * 1024 ** 2 + 1));
  const oversizedChecksum = digest(await readFile(f.path));
  assert.throws(() => verifyBrowserAcquisitionDescriptor(f.root, oversizedChecksum, f.target), /component_invalid/);
});
