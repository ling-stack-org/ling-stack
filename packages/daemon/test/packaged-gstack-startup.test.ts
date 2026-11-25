import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { createSqliteRunStore, resolveSkillSourceRuntimeView } from "@ling-stack/core";
import { prepareBundledSkillStartup } from "../dist/features/skills/bundled-startup.js";
import { retainPackagedSkillGeneration } from "../dist/features/skills/packaged-history.js";
import { readPackagedGstackIdentity, type PackagedGstackIdentity } from "../dist/features/skills/packaged-identity.js";
import { PackagedSkillRuntimeCatalog, type installPackagedSkillRuntime } from "../dist/features/skills/packaged-runtime.js";
import { preparePackagedGstackStartup } from "../dist/features/skills/packaged-startup.js";
import { browserAcquisitionFixture } from "../../core/test/support/browser-acquisition-fixture.mjs";

const desktopPlatform = process.platform === "darwin" || process.platform === "win32";
const digest = (bytes: string) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const asModule = (code: string) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");

async function writeSelection(rootPath: string, target: PackagedGstackIdentity["target"], revision: number,
  browser?: ReturnType<typeof browserAcquisitionFixture>) {
  await mkdir(join(rootPath, "runtime"), { recursive: true });
  const body = "# qa " + revision + "\n";
  const files = new Map([["LICENSE", "MIT\n"], ["runtime/SKILL.md", body]]);
  if (browser) files.set("executable-build.json", JSON.stringify({ browser: browser.selection }));
  for (const [path, bytes] of files) await writeFile(join(rootPath, path), bytes);
  const manifest = { schemaVersion: 1, packId: "gstack-default", deliveryStage: "executable",
    upstream: { repository: "https://github.com/garrytan/gstack", revision: String(revision).repeat(40), version: "1.0." + revision + ".0" },
    adaptationRevision: "ling-startup-" + revision, target, licensePath: "LICENSE",
    skills: [{ id: "qa", entryPath: "runtime/SKILL.md", resourcePaths: [] }],
    files: [...files].map(([path, bytes]) => ({ path, checksum: digest(bytes), sizeBytes: Buffer.byteLength(bytes) })) };
  const bytes = JSON.stringify(manifest);
  await writeFile(join(rootPath, "manifest.json"), bytes);
  return { rootPath, expectedManifestChecksum: digest(bytes), expectedUpstreamRevision: manifest.upstream.revision,
    expectedAdaptationRevision: manifest.adaptationRevision, expectedTarget: target, expectedSkillIds: ["qa"] };
}

async function desktopFixture(t: TestContext, revision: number) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-gstack-startup-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = process.platform === "darwin" ? join(root, "Ling.app/Contents/MacOS/Ling") : join(root, "app/Ling.exe");
  const resources = process.platform === "darwin" ? join(root, "Ling.app/Contents/Resources") : join(root, "app/resources");
  const browserRoot = join(resources, "gstack-browser");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, "test-only; never executed");
  const target: PackagedGstackIdentity["target"] = process.platform === "darwin"
    ? { platform: "darwin", arch: process.arch === "arm64" ? "arm64" : "x64" }
    : { platform: "win32", arch: "x64" };
  const descriptor = browserAcquisitionFixture(target);
  await mkdir(browserRoot, { recursive: true });
  await writeFile(join(browserRoot, "browser-acquisition.json"), descriptor.bytes);
  const selection = await writeSelection(join(resources, "gstack"), target, revision, descriptor);
  const identity: PackagedGstackIdentity = {
    manifestChecksum: selection.expectedManifestChecksum, upstreamRevision: selection.expectedUpstreamRevision,
    adaptationRevision: selection.expectedAdaptationRevision, target, skillIds: selection.expectedSkillIds,
  };
  const sourcesDir = join(root, "sources");
  const priorExec = Object.getOwnPropertyDescriptor(process, "execPath")!;
  const priorElectron = Object.getOwnPropertyDescriptor(process.versions, "electron");
  Object.defineProperty(process, "execPath", { ...priorExec, value: executable });
  Object.defineProperty(process.versions, "electron", { configurable: true, value: "45.3.1" });
  t.after(() => {
    Object.defineProperty(process, "execPath", priorExec);
    if (priorElectron) Object.defineProperty(process.versions, "electron", priorElectron);
    else Reflect.deleteProperty(process.versions, "electron");
  });
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("startup must not acquire browser bytes"));
  const discovery = asModule("export const resolveUserConfigPaths = () => (" + JSON.stringify({ sourcesDir })
    + "); export const readPackagedGstackIdentity = () => (" + JSON.stringify(identity) + ");");
  const runtime = asModule("export let admitted; export function installPackagedSkillRuntime(...args) { admitted = args; }\n// " + identity.manifestChecksum);
  const replacements = new Map([
    ["@ling-stack/core/bundled-skill-browser", new URL("../../core/dist/bundled-skill-browser.js", import.meta.url).href],
    ["@ling-stack/core", discovery],
    ["./packaged-identity.js", discovery],
    ["./bundled-startup.js", new URL("../dist/features/skills/bundled-startup.js", import.meta.url).href],
    ["./packaged-runtime.js", runtime],
    ["./packaged-history.js", new URL("../dist/features/skills/packaged-history.js", import.meta.url).href],
  ]);
  let source = await readFile(new URL("../dist/features/skills/packaged-startup.js", import.meta.url), "utf8");
  for (const [name, url] of replacements) {
    const marker = "from " + JSON.stringify(name);
    assert.equal(source.split(marker).length, 2);
    source = source.replace(marker, "from " + JSON.stringify(url));
  }
  const startup: typeof import("../dist/features/skills/packaged-startup.js") = await import(asModule(source));
  return {
    root, cache: join(sourcesDir, "bundled-gstack"), selection, start: startup.preparePackagedGstackStartup, fetch,
    async admitted() {
      const module: { admitted?: Parameters<typeof installPackagedSkillRuntime> } = await import(runtime);
      assert.ok(module.admitted);
      return module.admitted;
    },
    priorSelection: (version: number) => writeSelection(join(root, "source-" + version), target, version),
  };
}

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
  const valid: PackagedGstackIdentity = { manifestChecksum: "sha256:" + "1".repeat(64), upstreamRevision: "2".repeat(40),
    adaptationRevision: "ling-v1", target: { platform: "darwin", arch: "arm64" },
    skillIds: Array.from({ length: 57 }, (_, i) => "skill-" + i) };
  const load = async (value: unknown): Promise<typeof import("../dist/features/skills/packaged-identity.js")> => {
    const code = source.replace(marker, "const embeddedBundledGstackJson = " + JSON.stringify(JSON.stringify(value)) + ";");
    return import(asModule(code));
  };
  const identity = (await load(valid)).readPackagedGstackIdentity();
  assert.ok(identity && Object.isFrozen(identity) && Object.isFrozen(identity.skillIds) && Object.isFrozen(identity.target));
  for (const changes of [{ manifestChecksum: "untrusted" }, { adaptationRevision: "../escape" },
    { upstreamRevision: "main" }, { target: { platform: "darwin", arch: "unknown" } },
    { skillIds: [] }, { skillIds: new Array(57).fill("same") }, { skillIds: [...valid.skillIds.slice(1), "../escape"] }]) {
    assert.throws((await load({ ...valid, ...changes })).readPackagedGstackIdentity, /packaged_gstack_identity_invalid/);
  }
});

test("packaged startup admits and publishes a descriptor without downloading the browser", { skip: !desktopPlatform }, async t => {
  const fixture = await desktopFixture(t, 1);
  const initialize = await fixture.start();
  const [current, retained] = await fixture.admitted();
  assert.equal(current?.manifestChecksum, fixture.selection.expectedManifestChecksum);
  assert.deepEqual(retained, []);
  assert.ok(current?.browser);
  assert.deepEqual(await readdir(current.browser.root), ["browser-acquisition.json"]);
  current.assertCurrent();
  const store = createSqliteRunStore(fixture.root);
  try {
    assert.ok(initialize);
    initialize(store);
    assert.equal(store.getSkillSourceSnapshot("qa")?.referencedFiles[0]?.checksum, fixture.selection.expectedManifestChecksum);
  } finally { store.close(); }
  assert.equal(fixture.fetch.mock.callCount(), 0);
});

test("a full history preserves existing snapshots and admits the bundled update when space becomes available", {
  skip: !desktopPlatform,
}, async t => {
  const fixture = await desktopFixture(t, 3);
  const first = await fixture.priorSelection(1), second = await fixture.priorSelection(2);
  await retainPackagedSkillGeneration(fixture.cache, first);
  await retainPackagedSkillGeneration(fixture.cache, second);
  const before = [first.expectedManifestChecksum.slice(7), second.expectedManifestChecksum.slice(7)].sort();

  const store = createSqliteRunStore(fixture.root);
  try {
    (await prepareBundledSkillStartup(second))(store);
    const snapshot = store.getSkillSourceSnapshot("qa");
    assert.ok(snapshot);
    assert.equal(await fixture.start(), undefined);
    const [current, retained] = await fixture.admitted();
    assert.equal(current, undefined);
    assert.ok(retained);
    const catalog = new PackagedSkillRuntimeCatalog(current, retained);
    const { context: source } = resolveSkillSourceRuntimeView({
      skillId: "qa", snapshot, optimizationMode: "no_operation", requireCompleteSource: true,
    });
    const context = catalog.bind(source);
    assert.deepEqual(catalog.restore(context, "qa"), context);
    assert.equal(context.resourceBinding?.manifestChecksum, second.expectedManifestChecksum);
    assert.deepEqual(store.getSkillSourceSnapshot("qa"), snapshot);
    assert.deepEqual((await readdir(fixture.cache)).sort(), before);

    // Only the second generation was published to this isolated store.
    await rename(join(fixture.cache, first.expectedManifestChecksum.slice(7)), join(fixture.root, "unreferenced-generation"));
    const initialize = await fixture.start();
    assert.ok(initialize);
    initialize(store);
    assert.equal(store.getSkillSourceSnapshot("qa")?.referencedFiles[0]?.checksum, fixture.selection.expectedManifestChecksum);
    assert.equal(fixture.fetch.mock.callCount(), 0);
  } finally { store.close(); }
});
