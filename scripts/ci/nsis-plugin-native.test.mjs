import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyNsisPlugins } from "../release/verify-nsis-plugins.mjs";

test("the pinned native NSIS compiler retains the reviewed plug-in bytes", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-native-nsis-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const desktopRequire = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
  const builderRequire = createRequire(desktopRequire.resolve("electron-builder/package.json"));
  const toolset = builderRequire("app-builder-lib/out/toolsets/windows.js");
  const compiler = await toolset.getMakeNsisPath("0.0.0");
  const plugins = join(await toolset.getNsisPluginsPath("0.0.0"), "x86-unicode");
  const sevenZipPath = await builderRequire("app-builder-lib/out/toolsets/7zip.js").getPath7za();
  const sources = JSON.parse(await readFile(new URL("../../apps/desktop/scripts/distribution/vendor-notices/nsis-plugins/sources.json", import.meta.url)));
  const installer = join(root, "plugin-fixture.exe"), script = join(root, "plugin-fixture.nsi");
  await writeFile(script, `Unicode true
Name "Ling plug-in fixture"
OutFile "${installer}"
!addplugindir "${plugins}"
Section
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
});
