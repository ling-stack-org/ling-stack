import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { retainPackagedSkillGeneration } from "../dist/features/skills/packaged-history.js";
import { PackagedSkillRuntimeCatalog } from "../dist/features/skills/packaged-runtime.js";
import { browserAcquisitionFixture } from "../../core/test/support/browser-acquisition-fixture.mjs";

const hash = text => `sha256:${createHash("sha256").update(text).digest("hex")}`;
async function fixture(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-gstack-history-")));
  const cache = join(cwd, "cache"); await mkdir(cache);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const selection = async version => {
    const root = join(cwd, `source-${version}`), body = `# qa ${version}\n`;
    await mkdir(join(root, "runtime"), { recursive: true });
    await writeFile(join(root, "runtime/SKILL.md"), body);
    await writeFile(join(root, "LICENSE"), "MIT\n");
    const manifest = { schemaVersion: 1, packId: "gstack-default", deliveryStage: "executable",
      upstream: { repository: "https://github.com/garrytan/gstack", revision: `${version}`.repeat(40), version: `1.0.${version}.0` },
      adaptationRevision: `ling-${version}`, target: { platform: "darwin", arch: "arm64" }, licensePath: "LICENSE",
      skills: [{ id: "qa", entryPath: "runtime/SKILL.md", resourcePaths: [] }],
      files: [{ path: "runtime/SKILL.md", checksum: hash(body), sizeBytes: body.length }, { path: "LICENSE", checksum: hash("MIT\n"), sizeBytes: 4 }] };
    const bytes = JSON.stringify(manifest); await writeFile(join(root, "manifest.json"), bytes);
    return { rootPath: root, expectedManifestChecksum: hash(bytes), expectedUpstreamRevision: manifest.upstream.revision,
      expectedAdaptationRevision: manifest.adaptationRevision, expectedTarget: manifest.target, expectedSkillIds: ["qa"] };
  };
  return { cwd, cache, selection };
}
test("two generations survive original-app removal; retry reuses bytes and old contexts recover", async t => {
  const { cwd, cache, selection } = await fixture(t);
  const first = await selection(1), second = await selection(2);
  const old = await retainPackagedSkillGeneration(cache, first);
  const initial = old.current.bind({ skillId: "qa", sourceKind: "gstack-skill-directory", loaded: true, truncated: false,
    sourceChecksum: hash("# qa 1\n"), referencedFiles: [{ path: "manifest.json", checksum: first.expectedManifestChecksum }] });
  const next = await retainPackagedSkillGeneration(cache, second);
  assert.equal(next.retained.length, 1);
  const before = await readdir(cache);
  const retry = await retainPackagedSkillGeneration(cache, second);
  assert.deepEqual(await readdir(cache), before);
  await rm(first.rootPath, { recursive: true }); await rm(second.rootPath, { recursive: true });
  const catalog = new PackagedSkillRuntimeCatalog(retry.current, retry.retained);
  assert.deepEqual(catalog.restore(initial, "qa"), initial);
  assert.equal(await readFile(join(catalog.environment(initial, cwd).GSTACK_ROOT, "SKILL.md"), "utf8"), "# qa 1\n");
});
test("retention is bounded and never deletes a pinned old generation to admit a third", async t => {
  const { cache, selection } = await fixture(t);
  await retainPackagedSkillGeneration(cache, await selection(1));
  await retainPackagedSkillGeneration(cache, await selection(2));
  const before = await readdir(cache);
  await assert.rejects(retainPackagedSkillGeneration(cache, await selection(3)), /retention_limit/);
  assert.deepEqual(await readdir(cache), before);
});
test("tampering, aliases and private in-progress stages cannot become active", async t => {
  const { cwd, cache, selection } = await fixture(t);
  const first = await selection(1);
  const result = await retainPackagedSkillGeneration(cache, first);
  const root = join(cache, first.expectedManifestChecksum.slice(7), "gstack");
  await writeFile(join(root, "runtime/SKILL.md"), "corrupt");
  await assert.rejects(retainPackagedSkillGeneration(cache, first), /checksum_mismatch/);
  assert.throws(() => result.current.bind({ skillId: "qa", sourceKind: "gstack-skill-directory", loaded: true,
    sourceChecksum: hash("# qa 1\n"), referencedFiles: [{ path: "manifest.json", checksum: first.expectedManifestChecksum }] }), /runtime_changed/);
  const alias = join(cwd, "alias"); await symlink(cache, alias);
  await assert.rejects(retainPackagedSkillGeneration(alias, first), /history_path_invalid/);
  await mkdir(join(cache, ".staging-interrupted"));
  await assert.rejects(retainPackagedSkillGeneration(cache, first), /history_requires_review/);
});

test("partial ENOSPC lock writes are closed and removed; retry can succeed", async t => {
  const { cwd, cache, selection } = await fixture(t);
  const input = await selection(1), probe = await open(join(cwd, "probe"), "wx");
  const prototype = Object.getPrototypeOf(probe), write = prototype.writeFile;
  await probe.close();
  let interrupted = false, handle;
  t.mock.method(prototype, "writeFile", async function(...args) {
    if (!interrupted) {
      interrupted = true; handle = this;
      await write.call(this, "{");
      throw Object.assign(new Error("fixture no space"), { code: "ENOSPC" });
    }
    return write.apply(this, args);
  });
  await assert.rejects(retainPackagedSkillGeneration(cache, input), { code: "ENOSPC" });
  assert.equal(handle.fd, -1, "failed lock must not leak its descriptor");
  assert.deepEqual(await readdir(cache), []);
  const result = await retainPackagedSkillGeneration(cache, input);
  assert.equal(result.current.manifestChecksum, input.expectedManifestChecksum);
});

test("concurrent generation writers are serialized without orphan staging", async t => {
  const { cache, selection } = await fixture(t), input = await selection(1);
  const results = await Promise.allSettled([retainPackagedSkillGeneration(cache, input), retainPackagedSkillGeneration(cache, input)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(results.find(result => result.status === "rejected").reason.message, /busy_requires_review/);
  assert.deepEqual(await readdir(cache), [input.expectedManifestChecksum.slice(7)]);
});

test("reuse rejects unknown outer inventory and accounts for cache bytes without deleting evidence", async t => {
  const { cache, selection } = await fixture(t), input = await selection(1);
  await retainPackagedSkillGeneration(cache, input);
  const orphan = join(cache, input.expectedManifestChecksum.slice(7), "orphan.bin");
  await writeFile(orphan, "unknown");
  await assert.rejects(retainPackagedSkillGeneration(cache, input), /history_requires_review/);
  assert.equal(await readFile(orphan, "utf8"), "unknown");
  await rm(orphan);
  const oversized = await open(orphan, "wx");
  await oversized.truncate(6 * 1024 ** 3 + 1); await oversized.close();
  await assert.rejects(retainPackagedSkillGeneration(cache, input), /history_budget_exceeded/);
  assert.deepEqual(await readdir(cache), [input.expectedManifestChecksum.slice(7)]);
});

test("missing browser is rejected before copying any candidate bytes", async t => {
  const { cache, selection } = await fixture(t), input = await selection(1);
  // Authenticate a receipt which requires an adjacent browser, but provide none.
  const path = join(input.rootPath, "manifest.json"), manifest = JSON.parse(await readFile(path));
  const receipt = JSON.stringify({ browser: { componentChecksum: hash("browser") } });
  await writeFile(join(input.rootPath, "executable-build.json"), receipt);
  manifest.files.push({ path: "executable-build.json", checksum: hash(receipt), sizeBytes: receipt.length });
  const bytes = JSON.stringify(manifest); await writeFile(path, bytes);
  input.expectedManifestChecksum = hash(bytes);
  let copies = 0;
  const copy = fsPromises.cp;
  fsPromises.cp = async () => { copies++; throw new Error("must-not-copy-before-browser-admission"); };
  syncBuiltinESMExports();
  try { await assert.rejects(retainPackagedSkillGeneration(cache, input), /history_browser_mismatch/); }
  finally { fsPromises.cp = copy; syncBuiltinESMExports(); }
  assert.equal(copies, 0);
  assert.deepEqual(await readdir(cache), []);
});

async function addBrowserAcquisition(input, browserRoot) {
  await mkdir(browserRoot);
  const data = browserAcquisitionFixture(input.expectedTarget);
  await writeFile(join(browserRoot, "browser-acquisition.json"), data.bytes);
  const receipt = Buffer.from(JSON.stringify({ browser: data.selection }));
  await writeFile(join(input.rootPath, "executable-build.json"), receipt);
  const path = join(input.rootPath, "manifest.json"), manifest = JSON.parse(await readFile(path));
  manifest.files.push({ path: "executable-build.json", checksum: hash(receipt), sizeBytes: receipt.length });
  const bytes = JSON.stringify(manifest); await writeFile(path, bytes);
  input.expectedManifestChecksum = hash(bytes);
  return data;
}

test("download descriptors survive two retained generations without acquiring browser bytes", async t => {
  const { cwd, cache, selection } = await fixture(t), first = await selection(1), second = await selection(2);
  const firstBrowser = join(cwd, "browser-one"), secondBrowser = join(cwd, "browser-two");
  const descriptor = await addBrowserAcquisition(first, firstBrowser); await addBrowserAcquisition(second, secondBrowser);
  t.mock.method(globalThis, "fetch", () => assert.fail("generation admission must not download a browser"));
  const old = await retainPackagedSkillGeneration(cache, first, firstBrowser);
  const context = old.current.bind({ skillId: "qa", sourceKind: "gstack-skill-directory", loaded: true, truncated: false,
    sourceChecksum: hash("# qa 1\n"), referencedFiles: [{ path: "manifest.json", checksum: first.expectedManifestChecksum }] });
  const next = await retainPackagedSkillGeneration(cache, second, secondBrowser);
  const retry = await retainPackagedSkillGeneration(cache, second, secondBrowser);
  assert.equal(next.retained.length, 1); assert.equal(retry.retained.length, 1);
  for (const input of [first, second]) {
    const root = join(cache, input.expectedManifestChecksum.slice(7), "gstack-browser");
    assert.deepEqual(await readdir(root), ["browser-acquisition.json"]);
    assert.deepEqual(await readFile(join(root, "browser-acquisition.json")), descriptor.bytes);
  }
  for (const path of [first.rootPath, second.rootPath, firstBrowser, secondBrowser]) await rm(path, { recursive: true });
  const catalog = new PackagedSkillRuntimeCatalog(retry.current, retry.retained);
  assert.deepEqual(catalog.restore(context, "qa"), context);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  const retainedDescriptor = join(cache, first.expectedManifestChecksum.slice(7), "gstack-browser/browser-acquisition.json");
  await writeFile(retainedDescriptor, "{}");
  assert.throws(() => old.current.assertCurrent(), /component_invalid/);
  await assert.rejects(retainPackagedSkillGeneration(cache, second), /component_invalid/);
});

for (const phase of ["after-lock", "after-publication"]) {
  test(`killed writer ${phase} leaves ownership for review rather than automatic takeover`, { timeout: 20000 }, async t => {
    const { cwd, cache, selection } = await fixture(t), input = await selection(1);
    const path = join(cwd, "selection.json"); await writeFile(path, JSON.stringify(input));
    const child = fork(new URL("../../../scripts/gstack/history-interruption-probe.mjs", import.meta.url),
      [cwd, phase, path], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; child.stderr.on("data", bytes => stderr += bytes);
    const terminal = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    t.after(async () => { child.kill("SIGKILL"); await terminal; });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      await new Promise((resolve, reject) => {
        child.once("message", value => { assert.equal(value.phase, phase); resolve(); });
        child.once("error", reject);
        child.once("exit", () => reject(new Error(`probe exited before checkpoint: ${stderr}`)));
      });
      assert.equal(child.kill("SIGKILL"), true);
      assert.deepEqual(await terminal, { code: null, signal: "SIGKILL" });
    } finally { clearTimeout(deadline); }
    assert.equal(JSON.parse(await readFile(join(cache, ".writer.json"))).pid, child.pid);
    await assert.rejects(retainPackagedSkillGeneration(cache, input), /busy_requires_review/);
    const names = (await readdir(cache)).sort();
    assert.ok(names.includes(".writer.json"));
    assert.equal(names.includes(input.expectedManifestChecksum.slice(7)), phase === "after-publication");
  });
}
