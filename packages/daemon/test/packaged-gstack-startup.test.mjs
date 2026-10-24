import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPackagedGstackIdentity } from "../dist/features/skills/packaged-identity.js";
import { preparePackagedGstackStartup } from "../dist/features/skills/packaged-startup.js";
import { browserAcquisitionFixture } from "../../core/test/support/browser-acquisition-fixture.mjs";

test("an ordinary development daemon has no implicitly selected package", async () => {
  assert.equal(readPackagedGstackIdentity(), undefined);
  assert.equal(await preparePackagedGstackStartup(), undefined);
});

test("packaged desktop intent cannot silently fall back to old builtins without an embedded identity", async () => {
  const previous = process.env.LING_STACK_PACKAGED_DESKTOP;
  process.env.LING_STACK_PACKAGED_DESKTOP = "1";
  try { await assert.rejects(preparePackagedGstackStartup(), /packaged_gstack_identity_missing/); }
  finally {
    if (previous === undefined) delete process.env.LING_STACK_PACKAGED_DESKTOP;
    else process.env.LING_STACK_PACKAGED_DESKTOP = previous;
  }
});

test("build literal parser rejects unpinned, incomplete, duplicate and nonportable selections", async () => {
  const source = await readFile(new URL("../dist/features/skills/packaged-identity.js", import.meta.url), "utf8");
  const marker = 'const embeddedBundledGstackJson = "NO_PACKAGED_GSTACK_IDENTITY";';
  assert.equal(source.split(marker).length, 2);
  const valid = { manifestChecksum: `sha256:${"1".repeat(64)}`, upstreamRevision: "2".repeat(40),
    adaptationRevision: "ling-v1", target: { platform: "darwin", arch: "arm64" },
    skillIds: Array.from({ length: 57 }, (_, i) => `skill-${i}`) };
  const load = async value => {
    const code = source.replace(marker, `const embeddedBundledGstackJson = ${JSON.stringify(JSON.stringify(value))};`);
    return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  };
  const identity = (await load(valid)).readPackagedGstackIdentity();
  assert.ok(Object.isFrozen(identity) && Object.isFrozen(identity.skillIds) && Object.isFrozen(identity.target));
  for (const changes of [{ manifestChecksum: "untrusted" }, { adaptationRevision: "../escape" },
    { upstreamRevision: "main" }, { target: { platform: "darwin", arch: "unknown" } },
    { skillIds: [] }, { skillIds: new Array(57).fill("same") }, { skillIds: [...valid.skillIds.slice(1), "../escape"] }]) {
    assert.throws((await load({ ...valid, ...changes })).readPackagedGstackIdentity, /packaged_gstack_identity_invalid/);
  }
});

test("packaged startup admits and retains a descriptor without downloading the browser", {
  skip: !["darwin", "win32"].includes(process.platform),
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-gstack-descriptor-startup-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = process.platform === "darwin" ? join(root, "Ling.app/Contents/MacOS/Ling") : join(root, "app/Ling.exe");
  const resources = process.platform === "darwin" ? join(root, "Ling.app/Contents/Resources") : join(root, "app/resources");
  const gstack = join(resources, "gstack"), browserRoot = join(resources, "gstack-browser");
  await mkdir(join(gstack, "runtime"), { recursive: true }); await mkdir(browserRoot);
  await mkdir(join(executable, ".."), { recursive: true }); await writeFile(executable, "test-only; never executed");
  const target = { platform: process.platform, arch: process.arch }, descriptor = browserAcquisitionFixture(target);
  await writeFile(join(browserRoot, "browser-acquisition.json"), descriptor.bytes);
  const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const receipt = JSON.stringify({ browser: descriptor.selection }), body = "# qa\n";
  const files = new Map([["LICENSE", "MIT\n"], ["runtime/SKILL.md", body], ["executable-build.json", receipt]]);
  for (const [path, bytes] of files) await writeFile(join(gstack, path), bytes);
  const manifest = { schemaVersion: 1, packId: "gstack-default", deliveryStage: "executable",
    upstream: { repository: "https://github.com/garrytan/gstack", revision: "1".repeat(40), version: "1.0.0.0" },
    adaptationRevision: "ling-descriptor-startup", target, licensePath: "LICENSE",
    skills: [{ id: "qa", entryPath: "runtime/SKILL.md", resourcePaths: [] }],
    files: [...files].map(([path, bytes]) => ({ path, checksum: hash(bytes), sizeBytes: Buffer.byteLength(bytes) })) };
  const bytes = JSON.stringify(manifest); await writeFile(join(gstack, "manifest.json"), bytes);
  const identity = { manifestChecksum: hash(bytes), upstreamRevision: manifest.upstream.revision,
    adaptationRevision: manifest.adaptationRevision, target, skillIds: ["qa"] };
  const priorExec = Object.getOwnPropertyDescriptor(process, "execPath"), priorElectron = Object.getOwnPropertyDescriptor(process.versions, "electron");
  Object.defineProperty(process, "execPath", { ...priorExec, value: executable });
  Object.defineProperty(process.versions, "electron", { configurable: true, value: "44.8.0" });
  t.after(() => {
    Object.defineProperty(process, "execPath", priorExec);
    if (priorElectron) Object.defineProperty(process.versions, "electron", priorElectron); else delete process.versions.electron;
  });
  t.mock.method(globalThis, "fetch", () => assert.fail("startup must not acquire browser bytes"));
  const module = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  const installedModule = module("export let installed; export function installPackagedSkillRuntime(current,retained){installed={current,retained};}");
  // Only desktop discovery and the unrelated loader/install singleton are test
  // substitutes. Descriptor admission and generation publication remain real.
  const replacements = new Map([
    ["@ling-stack/core/bundled-skill-browser", new URL("../../core/dist/bundled-skill-browser.js", import.meta.url).href],
    ["@ling-stack/core", module(`export function resolveUserConfigPaths(){return {sourcesDir:${JSON.stringify(join(root, "sources"))}};}`)],
    ["./packaged-identity.js", module(`export function readPackagedGstackIdentity(){return ${JSON.stringify(identity)};}`)],
    ["./bundled-startup.js", module(`export async function prepareBundledSkillStartup(selection, callback){return callback({manifestChecksum:selection.expectedManifestChecksum,readResource:async()=>${JSON.stringify(receipt)}});}`)],
    ["./packaged-runtime.js", installedModule],
    ["./packaged-history.js", new URL("../dist/features/skills/packaged-history.js", import.meta.url).href],
  ]);
  let source = await readFile(new URL("../dist/features/skills/packaged-startup.js", import.meta.url), "utf8");
  for (const [name, url] of replacements) {
    const marker = `from ${JSON.stringify(name)}`; assert.equal(source.split(marker).length, 2);
    source = source.replace(marker, `from ${JSON.stringify(url)}`);
  }
  await (await import(module(source))).preparePackagedGstackStartup();
  const { installed } = await import(installedModule);
  assert.equal(installed.current.manifestChecksum, identity.manifestChecksum);
  assert.deepEqual(await readdir(installed.current.browser.root), ["browser-acquisition.json"]);
  installed.current.assertCurrent();
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});
