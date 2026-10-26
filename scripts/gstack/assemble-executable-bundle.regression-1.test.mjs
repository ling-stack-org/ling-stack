import assert from "node:assert/strict";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bundleInventory, digest } from "./executable-bundle.mjs";
import { acquireResourceLease, initResourceWorkspace, resourceCheckpoint } from "./resource-workspace.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));

// Regression: assembly admission must reflect the selected mode's real phases.
// Found by /qa on 2026-10-26.
// Report: output/e6-20260928/p5-merged-input-review-20261026/assembly-capacity-failure-20261026.md
// Value: protects=download assembly compiles before its measured copy admission;
// fails_when=the unconditional 4GiB reservation or copy-before-compile returns;
// why_new=existing assembly tests stop at input/publication guards; seam=none;
// no_claim=real source/browser/compiler/package acceptance (only these are fixtures).
async function fixture(t, pressure, complete = false) {
  const parent = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "gstack-assembly-capacity-")));
  const root = join(parent, "managed");
  await initResourceWorkspace({ root, storageMode: "local-bounded" });
  const lease = await acquireResourceLease(root);
  const previousEnvironment = process.env;
  process.env = { ...lease.env };
  t.after(async () => {
    process.env = previousEnvironment;
    await lease.release();
    await fs.rm(parent, { recursive: true });
  });
  if (pressure) {
    // Only a fixture-owned sparse file: logical accounting must not use APFS
    // sharing or allocated-block size to waive the existing 12GiB limit.
    const padding = await fs.open(join(root, "cache", "fixture-logical-pressure"), "wx", 0o600);
    try { await padding.truncate(10 * 1024 ** 3); } finally { await padding.close(); }
  }
  const stageRoot = join(lease.scratchPath, "stage");
  await fs.mkdir(stageRoot);
  const sourceBytes = Buffer.from(JSON.stringify({ upstream: { revision: "fixture-revision" }, adaptationRevision: "fixture-recipe" }));
  const nativeBytes = Buffer.from("{}");
  await fs.writeFile(join(stageRoot, "source-manifest.json"), sourceBytes);
  await fs.writeFile(join(stageRoot, "native-build.json"), nativeBytes);
  if (complete) {
    await fs.mkdir(join(stageRoot, "runtime/tools"), { recursive: true });
    await fs.mkdir(join(stageRoot, "runtime/browse/dist"), { recursive: true });
    await fs.writeFile(join(stageRoot, "runtime/tools/node"), "fixture node only");
    await fs.writeFile(join(stageRoot, "runtime/browse/dist/browse"), "old fixture browse");
  }
  const inventoryBytes = Buffer.from(JSON.stringify({ files: await bundleInventory(stageRoot) }));
  await fs.writeFile(join(stageRoot, "resource-inventory.json"), inventoryBytes);
  const stageBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, deliveryStage: "resource-prerequisites", releaseEligible: false,
    target: { platform: process.platform, arch: process.arch }, inventoryChecksum: digest(inventoryBytes),
    inputNativeBuildChecksum: digest(nativeBytes) }));
  await fs.writeFile(join(stageRoot, "resource-stage.json"), stageBytes);
  const reviewed = Buffer.from(JSON.stringify({ manifestChecksum: digest(sourceBytes), upstreamRevision: "fixture-revision", adaptationRevision: "fixture-recipe" }));
  const key = `assemblyCapacity${Math.random().toString(36).slice(2)}`;
  const enteredCompiler = new Error("fixture compiler entered after real capacity admission");
  const copies = [], moves = [];
  const probe = globalThis[key] = {
    fs: { ...fs, readFile: (path, ...args) => String(path) === join(scripts, "reviewed-source-bundle.json")
      ? Promise.resolve(reviewed) : fs.readFile(path, ...args),
    cp: (...args) => { copies.push(args.slice(0, 2)); return fs.cp(...args); },
    rename: (...args) => { moves.push(args); if (probe.moveError) throw probe.moveError; return fs.rename(...args); } },
    execFileSync: (_, args) => {
      if (!complete) throw enteredCompiler;
      const compiled = args[5], native = args[2].endsWith("build-bun-native-resource.mjs");
      const rows = native ? ["browse", "browse.build-provenance.json"] : ["server-node.mjs", "bun-polyfill.cjs",
        "node-server-build-provenance.json", "testsavant-component.json", "testsavant-sidecar.mjs"];
      syncFs.mkdirSync(join(compiled, "browse/dist"), { recursive: true });
      for (const path of rows) syncFs.writeFileSync(join(compiled, "browse/dist", path), `fresh fixture ${path}`);
      if (native) probe.afterNative?.();
    },
    materializePlaywrightBrowser: async ({ browserOutputRoot, cacheOutputRoot }) => {
      await fs.mkdir(browserOutputRoot);
      await fs.writeFile(join(browserOutputRoot, "browser-acquisition.json"), "fixture descriptor");
      await fs.mkdir(cacheOutputRoot);
      await fs.writeFile(join(cacheOutputRoot, "ffmpeg"), "fixture ffmpeg");
      return { activation: "download-required", fixtureOnly: true };
    },
    readExecutableBundle: async path => ({ identity: { fixtureOnly: true, manifest: JSON.parse(await fs.readFile(join(path, "manifest.json"))) } }),
    verifyBrowserArchiveSource: async () => {},
  };
  t.after(() => { delete globalThis[key]; });
  let code = await fs.readFile(new URL("./assemble-executable-bundle.mjs", import.meta.url), "utf8");
  code = code.slice(0, code.indexOf('\nif (process.argv[1]'))
    .replace('import { execFileSync } from "node:child_process";', `const { execFileSync } = globalThis[${JSON.stringify(key)}];`)
    .replace(/import \{([^}]+)\} from "node:fs\/promises";/u, `const {$1} = globalThis[${JSON.stringify(key)}].fs;`)
    .replace(/import \{ verifyBrowserArchiveSource \} from "\.\/collect-browser-archives\.mjs";/u,
      `const { verifyBrowserArchiveSource } = globalThis[${JSON.stringify(key)}];`)
    .replace('import { materializePlaywrightBrowser } from "./materialize-playwright-browser.mjs";',
      `const { materializePlaywrightBrowser } = globalThis[${JSON.stringify(key)}];`)
    .replace('import { bundleFile, bundleInventory, digest, readExecutableBundle } from "./executable-bundle.mjs";',
      `import { bundleFile, bundleInventory, digest } from "./executable-bundle.mjs"; const { readExecutableBundle } = globalThis[${JSON.stringify(key)}];`)
    .replace('const scripts = dirname(fileURLToPath(import.meta.url));', `const scripts = ${JSON.stringify(scripts)};`)
    .replace(/from "(\.\/[^"]+)"/gu, (_, path) => `from ${JSON.stringify(new URL(path, import.meta.url).href)}`);
  const { assembleExecutableBundle } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return { assembleExecutableBundle, enteredCompiler, copies, moves, root, probe, options: { stageRoot,
    browserInspectionRoot: join(lease.scratchPath, "inspection"), browserArchivesRoot: join(lease.scratchPath, "archives"),
    outputRoot: join(lease.scratchPath, "executable"), expectedResourceStageChecksum: digest(stageBytes),
    modelMode: "download-required", browserMode: "download-required" } };
}

test("two-phase download fixture publishes exact replacements and moved cache under the original cap", async t => {
  const f = await fixture(t, true, true), original = await bundleInventory(f.options.stageRoot), progress = [];
  const result = await f.assembleExecutableBundle({ ...f.options, onProgress: value => progress.push(value) });
  assert.equal(result.identity.fixtureOnly, true);
  assert.deepEqual(await bundleInventory(f.options.stageRoot), original);
  assert.equal(f.copies.length, 1);
  assert.equal(f.moves.length, 1);
  assert.equal(await fs.readFile(join(f.options.outputRoot, "gstack/runtime/browse/dist/browse"), "utf8"), "fresh fixture browse");
  assert.equal(await fs.readFile(join(f.options.outputRoot, "gstack/runtime/browser-cache/ffmpeg"), "utf8"), "fixture ffmpeg");
  assert.ok(progress.some(value => value.startsWith("assembly copy admission ")));
  assert.ok(progress.some(value => value.startsWith("assembly copy measured ")));
  await resourceCheckpoint(f.root);
});

test("measured full-copy admission rejects new pressure before copying or retiring its source", async t => {
  const f = await fixture(t, false, true), original = await bundleInventory(f.options.stageRoot);
  f.probe.afterNative = () => {
    const logicalBytes = path => {
      const info = syncFs.lstatSync(path);
      return info.size + (info.isDirectory() ? syncFs.readdirSync(path).reduce((sum, name) => sum + logicalBytes(join(path, name)), 0) : 0);
    };
    const path = join(f.root, "cache", "fixture-new-pressure");
    const handle = syncFs.openSync(path, "wx");
    try { syncFs.ftruncateSync(handle, 12 * 1024 ** 3 - logicalBytes(f.root) - 64); }
    finally { syncFs.closeSync(handle); }
  };
  // Capture only a compact message, not the instrumented data-URL stack.
  let failure;
  try { await f.assembleExecutableBundle(f.options); } catch (error) { failure = error.message; }
  assert.equal(failure, "gstack_resource_workspace_budget_exceeded");
  assert.deepEqual(f.copies, []);
  assert.deepEqual(await bundleInventory(f.options.stageRoot), original);
  await assert.rejects(fs.lstat(f.options.outputRoot), { code: "ENOENT" });
});

test("prepared cache EXDEV is terminal without fallback copy or publication", async t => {
  const f = await fixture(t, false, true);
  f.probe.moveError = Object.assign(new Error("fixture cross-device move"), { code: "EXDEV" });
  let failure;
  try { await f.assembleExecutableBundle(f.options); } catch (error) { failure = error; }
  assert.equal(failure === f.probe.moveError, true);
  assert.equal(f.copies.length, 1, "only the admitted source copy; never a cache fallback");
  assert.equal(f.moves.length, 1);
  await assert.rejects(fs.lstat(f.options.outputRoot), { code: "ENOENT" });
});

test("input drift during preparation refuses the full copy", async t => {
  const f = await fixture(t, false, true);
  f.probe.afterNative = () => syncFs.writeFileSync(join(f.options.stageRoot, "native-build.json"), "changed");
  let failure;
  try { await f.assembleExecutableBundle(f.options); } catch (error) { failure = error.message; }
  assert.equal(failure, "gstack_executable_prerequisites_changed");
  assert.deepEqual(f.copies, []);
});

for (const modes of [{ modelMode: "bundled" }, { browserMode: "bundled" }]) {
  test(`non-dual-download mode retains the original 4GiB admission: ${JSON.stringify(modes)}`, async t => {
    const f = await fixture(t, true);
    let failure;
    try { await f.assembleExecutableBundle({ ...f.options, ...modes }); } catch (error) { failure = error.message; }
    assert.equal(failure, "gstack_resource_workspace_budget_exceeded");
    assert.deepEqual(f.copies, []);
  });
}

for (const pressure of [true, false]) {
  test(`download-required assembly compiles before copying with ${pressure ? "10GiB logical pressure" : "ample capacity"}`, async t => {
    const f = await fixture(t, pressure);
    let failure;
    try { await f.assembleExecutableBundle(f.options); } catch (error) { failure = error; }
    assert.equal(failure === f.enteredCompiler, true, `expected compiler boundary, got: ${failure?.message}`);
    assert.deepEqual(f.copies, [], "the complete retained stage must not be copied before fresh compilation");
  });
}
