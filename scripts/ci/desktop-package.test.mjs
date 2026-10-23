import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inventoryApplicationTree } from "../release/desktop-payload.mjs";
import { smokeWindowsInstaller } from "../release/windows-installer-smoke.mjs";
import { collectGstackEvidence } from "../release/collect-gstack-evidence.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-desktop-payload-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "app");
  await mkdir(join(app, "resources/web/assets"), { recursive: true });
  await mkdir(join(app, "resources/app.asar.unpacked"));
  for (const [path, bytes] of [["Ling Stack.exe", "PE fixture"], ["resources/app.asar", "asar fixture"],
    ["resources/web/index.html", "html"], ["resources/web/assets/main.js", "javascript"],
    ["resources/app.asar.unpacked/keyring.node", "keyring"], ["libEGL.dll", "runtime"], ["empty", ""]]) {
    await writeFile(join(app, path), bytes);
  }
  return { root, app };
}

test("installer smoke refuses a local machine before creating or installing files", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(smokeWindowsInstaller({}), /fresh GitHub-hosted Windows/u);
});

for (const path of ["resources/web/assets/main.js", "resources/app.asar.unpacked/keyring.node", "libEGL.dll"]) {
  test(`complete payload comparison detects missing or changed ${path}`, async t => {
    const f = await fixture(t), copy = join(f.root, "copy");
    await cp(f.app, copy, { recursive: true });
    const original = await inventoryApplicationTree(f.app);
    assert.deepEqual(await inventoryApplicationTree(copy), original);
    await writeFile(join(copy, path), "different bytes");
    assert.notDeepEqual(await inventoryApplicationTree(copy), original);
    await rm(join(copy, path));
    assert.notDeepEqual(await inventoryApplicationTree(copy), original);
  });
}

test("payload inventory accepts empty files and rejects extra files", async t => {
  const f = await fixture(t), before = await inventoryApplicationTree(f.app);
  assert.ok(before.some(file => file.name === "empty" && file.sizeBytes === 0));
  await writeFile(join(f.app, "unexpected.dll"), "extra runtime");
  assert.notDeepEqual(await inventoryApplicationTree(f.app), before);
});

test("payload inventory only allows contained relative macOS links", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await symlink("web", join(f.app, "resources/Current"));
  await assert.rejects(inventoryApplicationTree(f.app), /payload link/u);
  assert.ok((await inventoryApplicationTree(f.app, { allowLinks: true })).some(file => file.type === "link"));
  await symlink("../../outside", join(f.app, "resources/escape"));
  await assert.rejects(inventoryApplicationTree(f.app, { allowLinks: true }), /payload link/u);
});

test("gstack diagnostic collection keeps stage receipts without copying executable payloads", async t => {
  const f = await fixture(t), output = join(f.root, "evidence");
  const stage = join(f.root, "artifacts/resource/desktop-resources");
  await mkdir(join(stage, "runtime"), { recursive: true });
  await writeFile(join(stage, "resource-stage.json"), '{"scope":"fixture"}\n');
  await writeFile(join(stage, "runtime/private.json"), '{"not":"diagnostic"}\n');
  await writeFile(join(stage, "server.exe"), "executable payload");
  const report = await collectGstackEvidence(f.root, output);
  assert.deepEqual(report.files.map(file => file.name), ["artifacts/resource/desktop-resources/resource-stage.json"]);
  assert.equal(report.acceptance, "not_granted");
  assert.equal(report.omitted.length, 0);
  await assert.rejects(collectGstackEvidence(f.root, output), /EEXIST/u);
});
