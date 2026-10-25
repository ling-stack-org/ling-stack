import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyNsisPlugins } from "../release/verify-nsis-plugins.mjs";
import { prepareNsisExtractor } from "../release/nsis-extractor.mjs";

test("the pinned native NSIS compiler retains the reviewed plug-in bytes", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-native-nsis-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const desktopRequire = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
  const builderRequire = createRequire(desktopRequire.resolve("electron-builder/package.json"));
  const toolset = builderRequire("app-builder-lib/out/toolsets/windows.js");
  const compiler = await toolset.getMakeNsisPath("0.0.0");
  const plugins = join(await toolset.getNsisPluginsPath("0.0.0"), "x86-unicode");
  const bootstrap = await builderRequire("app-builder-lib/out/toolsets/7zip.js").getPath7za();
  const extractor = await prepareNsisExtractor();
  t.after(extractor.cleanup);
  const sevenZipPath = extractor.path;
  const formats = tool => execFileSync(tool, ["i"], { encoding: "utf8", timeout: 30_000 });
  t.diagnostic(JSON.stringify({ builderSupportsNsis: /\bNsis\b/u.test(formats(bootstrap)), verifierSupportsNsis: /\bNsis\b/u.test(formats(sevenZipPath)) }));
  await writeFile(join(root, "payload.txt"), "Exact nested payload bytes\n");
  const payload = join(root, "app-64.7z");
  execFileSync(bootstrap, ["a", "-bd", payload, "payload.txt"], { cwd: root, timeout: 30_000 });
  const sources = JSON.parse(await readFile(new URL("../../apps/desktop/scripts/distribution/vendor-notices/nsis-plugins/sources.json", import.meta.url)));
  const installer = join(root, "plugin-fixture.exe"), script = join(root, "plugin-fixture.nsi");
  await writeFile(script, `Unicode true
Name "Ling plug-in fixture"
OutFile "${installer}"
!addplugindir "${plugins}"
Section
  InitPluginsDir
  File /oname=$PLUGINSDIR\\app-64.7z "${payload}"
  StdUtils::GetParameter "test" ""
  Pop $0
  nsis7z::Extract "$TEMP\\fixture.7z"
  WriteUninstaller "$TEMP\\ling-fixture-uninstall.exe"
SectionEnd
Section "Uninstall"
  StdUtils::GetParameter "test" ""
  Pop $0
SectionEnd
`);
  execFileSync(compiler.path, ["-V2", script], { env: { ...process.env, ...compiler.env }, timeout: 120_000 });
  for (const plugin of sources.entries.filter(entry => entry.binarySha256)) {
    const actual = await readFile(join(plugins, `${plugin.name}.dll`));
    assert.equal(createHash("sha256").update(actual).digest("hex"), plugin.binarySha256);
    for (const separator of ["/", "\\"]) {
      const member = `$PLUGINSDIR${separator}${plugin.name}.dll`;
      const bytes = execFileSync(sevenZipPath, ["e", "-so", "-bd", "-bb0", installer, member], { timeout: 120_000 });
      t.diagnostic(JSON.stringify({ member, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
    }
  }
  const result = await verifyNsisPlugins({ installer, sevenZipPath, sources });
  assert.deepEqual(result.map(file => file.sha256), sources.entries.filter(entry => entry.binarySha256).map(entry => entry.binarySha256));
  const outer = join(root, "outer"), app = join(root, "app");
  execFileSync(sevenZipPath, ["x", "-tNsis", "-bd", "-bb0", "-y", `-o${outer}`, installer], { timeout: 30_000 });
  const nested = join(outer, "$PLUGINSDIR", "app-64.7z");
  assert.deepEqual(await readFile(nested), await readFile(payload));
  execFileSync(sevenZipPath, ["x", "-bd", "-bb0", "-y", `-o${app}`, nested], { timeout: 30_000 });
  assert.equal(await readFile(join(app, "payload.txt"), "utf8"), "Exact nested payload bytes\n");
});

test("native installer verification rejects extractor overrides before acquisition", async t => {
  const previous = process.env.ELECTRON_BUILDER_7ZIP_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.ELECTRON_BUILDER_7ZIP_PATH;
    else process.env.ELECTRON_BUILDER_7ZIP_PATH = previous;
  });
  process.env.ELECTRON_BUILDER_7ZIP_PATH = "unreviewed-extractor";
  await assert.rejects(prepareNsisExtractor(), /final_artifact_7zip_override_forbidden/u);
});

for (const [size, message] of [[1663507, /exceeds its pinned size/u], [1663506, /download digest mismatch/u], [8, /download digest mismatch/u]]) {
  test(`Windows refuses an invalid ${size}-byte extractor and removes its private staging`, { skip: process.platform !== "win32" }, async t => {
    const roots = async () => (await readdir(tmpdir())).filter(name => name.startsWith("ling-nsis-extractor-")).sort();
    const before = await roots();
    t.mock.method(globalThis, "fetch", async () => new Response(Buffer.alloc(size)));
    await assert.rejects(prepareNsisExtractor(), message);
    assert.deepEqual(await roots(), before);
  });
}
