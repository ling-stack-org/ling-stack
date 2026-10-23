import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createPackage, extractFile, listPackage } from "@electron/asar";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const { getMainFileMatchers, getFileMatchers, copyFiles } = builderRequire("app-builder-lib/out/fileMatcher.js");
const { build: config } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("Builder keeps complete distribution materials outside app.asar", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-distribution-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "app"), packed = join(root, "packed"), resources = join(root, "resources");
  const materials = new Map([
    ["sources/repository/native/office-local/src/runtime.h", Buffer.from("fixture original native source\n")],
    ["licenses/example/LICENSE", Buffer.from("fixture original grant\n")],
    ["distribution-manifest.json", Buffer.from('{"fixture":true}\n')],
  ]);
  for (const [name, bytes] of [["package.json", '{"main":"dist/main.js"}'], ["dist/main.js", "fixture main"],
    ["dist/daemon/cli.mjs", "fixture daemon"], ...[...materials].map(([name, bytes]) => [`dist/distribution/${name}`, bytes])]) {
    const path = join(app, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  const options = { defaultSrc: app, macroExpander: value => value, customBuildOptions: {}, globalOutDir: join(root, "output") };
  const platformPackager = { info: { projectDir: app, buildResourcesDir: "build", config, debugLogger: { isEnabled: false } } };
  await copyFiles(getMainFileMatchers(app, packed, options.macroExpander, {}, platformPackager, options.globalOutDir, false));
  const archive = join(root, "app.asar");
  await createPackage(packed, archive);
  const archivePaths = listPackage(archive).map(path => path.replaceAll("\\", "/"));
  assert.ok(archivePaths.includes("/dist/daemon/cli.mjs"));
  assert.equal(extractFile(archive, join("dist", "daemon", "cli.mjs")).toString(), "fixture daemon");
  assert.ok(!archivePaths.some(path => path === "/dist/distribution" || path.startsWith("/dist/distribution/")),
    "distribution must have a single extraResources copy; its Office source must not enter the runtime ASAR");
  const distribution = config.extraResources.filter(entry => entry.from === "dist/distribution");
  assert.equal(distribution.length, 1);
  await copyFiles(getFileMatchers({ extraResources: distribution }, "extraResources", resources, options));
  for (const [name, bytes] of materials) assert.equal(hash(await readFile(join(resources, "distribution", name))), hash(bytes));
});
