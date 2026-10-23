import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { bundleInventory, digest, readExecutableBundle } from "../../../scripts/gstack/executable-bundle.mjs";

async function fixture(t, { builderSkippedFiles = false, additionalSkippedPaths = [], rootName = "bundle" } = {}) {
  const work = await realpath(await mkdtemp(join(tmpdir(), "ling-desktop-gs-")));
  t.after(() => rm(work, { recursive: true, force: true }));
  const root = join(work, rootName); await mkdir(root);
  const lock = JSON.parse(await readFile(new URL("../../../scripts/gstack/upstream-lock.json", import.meta.url)));
  const skills = lock.skillIds.map(id => ({ id, entryPath: `skills/${id}/SKILL.md`, resourcePaths: [] }));
  for (const skill of skills) {
    await mkdir(dirname(join(root, skill.entryPath)), { recursive: true });
    await writeFile(join(root, skill.entryPath), `# ${skill.id}\nFull instructions.\n`);
  }
  await writeFile(join(root, "LICENSE"), "MIT fixture\n");
  if (builderSkippedFiles) {
    await mkdir(join(root, "runtime/node_modules/tr46/lib"), { recursive: true });
    await writeFile(join(root, "runtime/node_modules/tr46/lib/.gitkeep"), "authenticated placeholder\n");
    await writeFile(join(root, "runtime/.DS_Store"), "authenticated inert fixture\n");
  }
  for (const path of additionalSkippedPaths) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "authenticated literal path fixture\n");
  }
  const browserRoot = join(work, "gstack-browser"), framework = "Chromium.app/Contents/Frameworks/Chromium Framework.framework";
  const browserEntry = "Chromium.app/Contents/MacOS/Chromium";
  await mkdir(join(browserRoot, framework, "Versions/A"), { recursive: true });
  await writeFile(join(browserRoot, framework, "Versions/A/framework.bin"), "inert framework fixture");
  await mkdir(dirname(join(browserRoot, browserEntry)), { recursive: true });
  await writeFile(join(browserRoot, browserEntry), "browser fixture, never executed");
  const browserFiles = await bundleInventory(browserRoot);
  const links = [];
  for (let i = 0; i < 5; i++) {
    const path = `${framework}/alias-${i}`;
    await symlink("Versions/A", join(browserRoot, path));
    links.push({ path, linkTarget: "Versions/A", resolvedTarget: `${framework}/Versions/A` });
  }
  const browserBytes = JSON.stringify({ schemaVersion: 1, target: { platform: process.platform, arch: process.arch },
    entryPath: browserEntry, files: browserFiles, links });
  await writeFile(join(browserRoot, "browser-component.json"), browserBytes);
  await writeFile(join(root, "executable-build.json"), JSON.stringify({ scope: "isolated-local-client", releaseEligible: false,
    upstreamRevision: lock.revision, browser: { activation: "package-relative-only", componentChecksum: digest(Buffer.from(browserBytes)) } }));
  const manifest = { schemaVersion: 1, packId: "gstack-default", deliveryStage: "executable",
    upstream: { repository: "https://github.com/garrytan/gstack", revision: lock.revision, version: lock.version },
    adaptationRevision: "ling-fixture", target: { platform: process.platform, arch: process.arch },
    licensePath: "LICENSE", skills, files: await bundleInventory(root) };
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  const bundle = await readExecutableBundle(root);
  const selectionPath = join(work, "selection.json");
  await writeFile(selectionPath, JSON.stringify({ root, identity: bundle.identity }));
  const module = await import(`../scripts/packaged-gstack-resources.mjs?fixture=${encodeURIComponent(work)}`);
  return { ...bundle, work, selectionPath, module };
}
test("build-owned selection copies one complete resource tree and verifies it after pack/sign", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.module.preparePackagedGstackBuild({ required: true, selectionPath: f.selectionPath }), f.identity);
  const config = f.module.packagedGstackBuilderConfig();
  assert.equal(config.extraResources.length, 2);
  assert.equal(config.extraResources[0].from, f.root);
  assert.equal(config.extraResources[0].to, "gstack");
  assert.deepEqual(config.extraMetadata.lingPackagedGstack, f.identity);
  const context = { electronPlatformName: "darwin", appOutDir: join(f.work, "out"),
    packager: { appInfo: { productFilename: "Ling" }, config } };
  const copied = join(context.appOutDir, "Ling.app/Contents/Resources/gstack");
  await cp(f.root, copied, { recursive: true });
  await cp(f.browser.root, join(context.appOutDir, "Ling.app/Contents/Resources/gstack-browser"), { recursive: true, verbatimSymlinks: true });
  await f.module.verifyPackagedGstack(context);
  await writeFile(join(copied, "LICENSE"), "changed");
  await assert.rejects(f.module.verifyPackagedGstack(context), /bundle_resource_checksum_mismatch/);
  await rm(f.selectionPath);
  await assert.rejects(f.module.preparePackagedGstackBuild({ selectionPath: f.selectionPath }), { code: "ENOENT" });
});
test("package declarations without a selected build fail instead of silently skipping verification", async t => {
  const f = await fixture(t);
  await assert.rejects(f.module.verifyPackagedGstack({ packager: { config: { extraMetadata: { lingPackagedGstack: f.identity } } } }), /selection_missing/);
});
test("actual Builder copy preserves manifest-authenticated files omitted by its directory walker", async t => {
  const f = await fixture(t, { builderSkippedFiles: true });
  await f.module.preparePackagedGstackBuild({ required: true, selectionPath: f.selectionPath });
  const config = f.module.packagedGstackBuilderConfig();
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const { FileMatcher, copyFiles } = builderRequire("app-builder-lib/out/fileMatcher.js");
  const { expandMacro } = builderRequire("app-builder-lib/out/util/macroExpander.js");
  const context = { electronPlatformName: "darwin", appOutDir: join(f.work, "actual-builder"),
    packager: { appInfo: { productFilename: "Ling" }, config } };
  const resources = join(context.appOutDir, "Ling.app/Contents/Resources");
  await copyFiles(config.extraResources.map(item => new FileMatcher(item.from,
    join(resources, item.to), value => expandMacro(value, process.arch, context.packager.appInfo), item.filter)), undefined, false);
  for (const path of ["runtime/node_modules/tr46/lib/.gitkeep", "runtime/.DS_Store"]) {
    assert.deepEqual(await readFile(join(resources, "gstack", path)), await readFile(join(f.root, path)));
  }
  await f.module.verifyPackagedGstack(context);
  await writeFile(join(resources, "gstack/runtime/node_modules/tr46/lib/.gitkeep"), "changed");
  await assert.rejects(f.module.verifyPackagedGstack(context), /bundle_resource_checksum_mismatch/);
});
test("Builder paths reject macro syntax before copying authenticated literal files", async t => {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const { FileMatcher } = builderRequire("app-builder-lib/out/fileMatcher.js");
  const { expandMacro } = builderRequire("app-builder-lib/out/util/macroExpander.js");
  const prior = process.env.GSTACK_BUILDER_ROUTE;
  process.env.GSTACK_BUILDER_ROUTE = "../../../outside";
  t.after(() => {
    if (prior === undefined) delete process.env.GSTACK_BUILDER_ROUTE;
    else process.env.GSTACK_BUILDER_ROUTE = prior;
  });
  for (const path of ["runtime/${platform}/.gitkeep", "runtime/${arch}/.DS_Store",
    "runtime/${env.GSTACK_BUILDER_ROUTE}/.gitkeep", "runtime/${missing}/.gitkeep"]) {
    await t.test(path, async t => {
      const f = await fixture(t, { additionalSkippedPaths: [path] });
      await f.module.preparePackagedGstackBuild({ required: true, selectionPath: f.selectionPath });
      const resources = join(f.work, "package/Resources");
      const literalFrom = join(f.root, path), literalTo = join(resources, "gstack", path);
      const matcher = () => new FileMatcher(literalFrom, literalTo,
        value => expandMacro(value, process.arch, {}));
      if (path.includes("${missing}")) assert.throws(matcher, /macro missing is not defined/);
      else {
        const expanded = matcher();
        assert.notEqual(expanded.from, literalFrom);
        assert.notEqual(expanded.to, literalTo);
      }
      // A valid authenticated manifest must not turn literal bytes into Builder
      // instructions. Reject before handing any mapping to the copy boundary.
      assert.throws(() => f.module.packagedGstackBuilderConfig(), /packaged_gstack_builder_path_macro_unsupported/);
      await assert.rejects(readFile(join(f.work, "outside/.gitkeep")), { code: "ENOENT" });
    });
  }
  await t.test("selected root is also a Builder path field", async t => {
    const f = await fixture(t, { rootName: "bundle-${platform}" });
    await f.module.preparePackagedGstackBuild({ required: true, selectionPath: f.selectionPath });
    assert.throws(() => f.module.packagedGstackBuilderConfig(), /packaged_gstack_builder_path_macro_unsupported/);
  });
});
test("actual esbuild embeds exactly the authenticated identity module", async t => {
  const f = await fixture(t);
  const entry = fileURLToPath(new URL("../../../packages/daemon/dist/features/skills/packaged-identity.js", import.meta.url));
  const injection = f.module.packagedGstackIdentityPlugin({ identity: f.identity });
  const built = await build({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm", plugins: [injection.plugin] });
  injection.assertIncluded();
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`);
  assert.deepEqual(loaded.readPackagedGstackIdentity(), f.identity);
  assert.throws(() => f.module.packagedGstackIdentityPlugin({ identity: f.identity }).assertIncluded(), /not_bundled/);
});
