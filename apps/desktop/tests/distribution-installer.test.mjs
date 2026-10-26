import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { originalTemplates, patchInstallerTemplate, prepareDistributionBuilder } from "../scripts/distribution/installer-builder.mjs";
import { collectInstallerMaterials, inspectInstallerTemplates } from "../scripts/distribution/materials.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(desktopRoot, "package.json"));
const builderRoot = dirname(require.resolve("electron-builder/package.json"));
const originalLibrary = dirname(createRequire(join(builderRoot, "package.json")).resolve("app-builder-lib/package.json"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("private tooling retains original builder modules and stock install/upgrade safety logic", t => {
  const outputRoot = mkdtempSync(join(tmpdir(), "ling-installer-overlay-test-"));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  const original = new Map(Object.keys(originalTemplates).map(file => [file, readFileSync(join(originalLibrary, file), "utf8")]));
  const result = prepareDistributionBuilder({ desktopRoot, outputRoot });
  assert.equal(result.compression, "Unchanged stock 7z payload and original extractor");
  const privateRequire = createRequire(join(result.electronBuilderRoot, "package.json"));
  assert.equal(privateRequire.resolve("app-builder-lib/package.json"), realpathSync(join(result.appBuilderLibRoot, "package.json")));
  assert.equal(typeof privateRequire("electron-builder").build, "function");
  for (const [file, before] of original) {
    assert.equal(readFileSync(join(originalLibrary, file), "utf8"), before, "shared original must stay unchanged");
    assert.equal(hash(before), originalTemplates[file]);
    const after = readFileSync(join(result.appBuilderLibRoot, file), "utf8");
    assert.equal(after.includes("WinShell::"), false);
    assert.equal(after.includes("SpiderBanner::"), false);
    if (file.endsWith("/extractAppPackage.nsh")) {
      assert.equal(after.split("!macro extractUsing7za FILE")[0], before.split("!macro extractUsing7za FILE")[0],
        "compression and architecture/package selection remain unchanged");
      assert.ok(after.includes('"$SYSDIR\\robocopy.exe"'));
      assert.ok(after.includes("/E /COPY:DAT /DCOPY:DAT /R:0 /W:0"));
      assert.equal(after.includes("CopyFiles /SILENT"), false);
      assert.equal([...after.matchAll(/Nsis7z::Extract/gu)].length, 1, "failed copies cannot use the unchecked direct-extraction fallback");
      continue;
    }
    // Every other original line stays byte-identical: atomic rename/rollback,
    // existing-install discovery, file cleanup, shortcuts and registry lifecycle.
    let expected = file.endsWith("/installSection.nsh")
      ? before.replace(/^\s*SpiderBanner::Show[^\r\n]*$/gmu, "    ; Ling development distribution: keep the stock MUI progress page.")
      : '; Ling shell replacements; original electron-builder MIT terms retained.\n!include "LingShell.nsh"\n' + before.replaceAll("WinShell::SetLnkAUMI", "!insertmacro Ling_SetShortcutAUMI").replaceAll("WinShell::UninstShortcut", "!insertmacro Ling_UnpinShortcut").replaceAll("WinShell::UninstAppUserModelId", "!insertmacro Ling_RemoveAppDestinations");
    if (file.endsWith("/uninstaller.nsh")) expected = expected.replaceAll('"$INSTDIR$R0\\', '"\\\\?\\$INSTDIR$R0\\')
      .replaceAll('"$PLUGINSDIR\\old-install', '"\\\\?\\$PLUGINSDIR\\old-install')
      .replace("RMDir /r $INSTDIR", 'RMDir /r "\\\\?\\$INSTDIR"');
    assert.equal(after, expected);
  }
  assert.ok(readFileSync(join(result.appBuilderLibRoot, "templates/nsis/uninstaller.nsh"), "utf8").includes("Call un.atomicRMDir"));
  assert.ok(readFileSync(join(result.appBuilderLibRoot, "templates/nsis/uninstaller.nsh"), "utf8").includes("Call un.restoreFiles"));
  assert.ok(result.copy.includes("long-path members"));
  assert.equal(result.sharedToolchainModified, false);
  assert.ok(existsSync(result.receiptPath));
  assert.throws(() => prepareDistributionBuilder({ desktopRoot, outputRoot }), /must_be_empty/u);
});

test("an upstream template change fails closed before transformations", () => {
  for (const file of Object.keys(originalTemplates)) {
    const original = readFileSync(join(originalLibrary, file), "utf8");
    assert.throws(() => patchInstallerTemplate(file, `${original}\n; upstream changed\n`), /template_changed/u);
  }
  assert.throws(() => patchInstallerTemplate("templates/nsis/new-safety-path.nsh", ""), /template_changed/u);
});

test("installer materials include original plug-in grants and complete paired sources", () => {
  const material = new Map(), components = [], gaps = [];
  collectInstallerMaterials(resolve(desktopRoot, "../.."), (path, bytes) => { material.set(path, Buffer.from(bytes)); return path; }, components, gaps);
  assert.deepEqual(gaps, []);
  assert.equal(inspectInstallerTemplates(resolve(desktopRoot, "../..")).status, "checked");
  for (const name of ["StdUtils", "nsis7z", "LZMA SDK"]) {
    const component = components.find(component => component.name === name);
    assert.ok(component.licenseFiles.length > 0, name);
    assert.equal(hash(material.get(component.sourceArchive)), component.sourceArchiveSha256);
    assert.ok(component.licenseFiles.every(file => material.has(file)));
  }
  const clarification = [...material].find(([path]) => path.endsWith("/LGPL_CLARIFICATION.txt"))[1].toString("utf8");
  assert.ok(clarification.includes("verbatim"));
  const nsis7zReadme = [...material].find(([path]) => path.endsWith("/nsis7z.txt"))[1].toString("utf8");
  assert.ok(nsis7zReadme.includes("LGPL license"));
  assert.ok(nsis7zReadme.includes("lzma1900.7z"));
});
