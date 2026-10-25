import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

export const builderVersion = "26.15.3";
export const originalTemplates = Object.freeze({
  "templates/nsis/installSection.nsh": "74c4dbb4163cdd90ca4850b75d304e916235c882d6af7b5cdad63bffbc977072",
  "templates/nsis/include/installer.nsh": "0e319437dd01dcbf911f3f48f664fde0cefbaef704f1cdb1739f63d563f5d4a0",
  "templates/nsis/include/extractAppPackage.nsh": "e4174388a0f7a1df0b85a0742aa1ea7a4b2b18f9f29dccd6ef10a66212f68148",
  "templates/nsis/uninstaller.nsh": "9ee2dac4593478083e8aa6f8487287ce9401006ccd50ecc538871d133ea4a42c",
});
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const replacements = Object.freeze({ SetLnkAUMI: "Ling_SetShortcutAUMI", UninstShortcut: "Ling_UnpinShortcut", UninstAppUserModelId: "Ling_RemoveAppDestinations" });

export function patchInstallerTemplate(file, before) {
  if (!Object.hasOwn(originalTemplates, file) || hash(before) !== originalTemplates[file]) throw new Error(`distribution_installer_template_changed:${file}`);
  let after = before;
  if (file.endsWith("/installSection.nsh")) {
    if ([...before.matchAll(/SpiderBanner::Show/gu)].length !== 2) throw new Error("distribution_installer_banner_sites_changed");
    after = before.replace(/^\s*SpiderBanner::Show[^\r\n]*$/gmu, "    ; Ling development distribution: keep the stock MUI progress page.");
  } else if (file.endsWith("/extractAppPackage.nsh")) {
    // The original plug-in silently omits deep members without this prefix.
    // NSIS CopyFiles uses SHFileOperation, which drops members beyond MAX_PATH.
    // Robocopy is an OS tool with long-path support. Keep the stock retries,
    // but never fall back to an extractor that ignores copy/extraction errors.
    after = before.replace('  SetOutPath "$PLUGINSDIR\\7z-out"', '  SetOutPath "\\\\?\\$PLUGINSDIR\\7z-out"');
    after = after.replace('    CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR', `    Push $R2
    Push $R3
    nsExec::ExecToStack '"$SYSDIR\\robocopy.exe" "$PLUGINSDIR\\7z-out" "$OUTDIR" /E /COPY:DAT /DCOPY:DAT /R:0 /W:0 /NFL /NDL /NJH /NJS /NP'
    Pop $R2
    Pop $R3
    ClearErrors
    \${if} $R2 == "error"
    \${orIf} $R2 == "timeout"
      SetErrors
    \${elseIf} $R2 >= 8
      SetErrors
    \${endIf}
    Pop $R3
    Pop $R2`);
    if (after === before) throw new Error("distribution_installer_copy_site_changed");
    const fallbackStart = after.indexOf("    # As an absolutely last resort"), fallbackEnd = after.indexOf("  AbortExtract7za:");
    if (fallbackStart < 0 || fallbackEnd <= fallbackStart) throw new Error("distribution_installer_fallback_site_changed");
    after = after.slice(0, fallbackStart) + "    Goto AbortExtract7za\n\n" + after.slice(fallbackEnd);
    after = after.replace("/SD IDRETRY IDCANCEL AbortExtract7za", "/SD IDCANCEL IDRETRY RetryExtract7za")
      .replace("  AbortExtract7za:\n    Quit", "  AbortExtract7za:\n    SetErrorLevel 2\n    Quit");
  } else {
    if (file.endsWith("/uninstaller.nsh")) {
      // Both the installed tree and the rollback tree can exceed MAX_PATH.
      // Preserve the original traversal/rename/restore algorithm and OS calls.
      after = after.replaceAll('"$INSTDIR$R0\\', '"\\\\?\\$INSTDIR$R0\\')
        .replaceAll('"$PLUGINSDIR\\old-install', '"\\\\?\\$PLUGINSDIR\\old-install')
        .replace("RMDir /r $INSTDIR", 'RMDir /r "\\\\?\\$INSTDIR"');
    }
    for (const [call, macro] of Object.entries(replacements)) after = after.replaceAll(`WinShell::${call}`, `!insertmacro ${macro}`);
    if (after.includes("WinShell::")) throw new Error("distribution_installer_shell_sites_unconverted");
    after = '; Ling shell replacements; original electron-builder MIT terms retained.\n!include "LingShell.nsh"\n' + after;
  }
  return after;
}

function copyPackage(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) copyPackage(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
    else throw new Error(`distribution_installer_source_symlink:${entry.name}`);
  }
}

/** Adapt pinned stock templates in private tooling copies. */
export function prepareDistributionBuilder({ desktopRoot, outputRoot }) {
  desktopRoot = realpathSync(desktopRoot); outputRoot = resolve(outputRoot);
  if (existsSync(outputRoot) && readdirSync(outputRoot).length) throw new Error("distribution_installer_output_must_be_empty");
  const desktopRequire = createRequire(join(desktopRoot, "package.json"));
  const originalBuilder = dirname(desktopRequire.resolve("electron-builder/package.json"));
  const builderRequire = createRequire(join(originalBuilder, "package.json"));
  const originalLibrary = dirname(builderRequire.resolve("app-builder-lib/package.json"));
  for (const source of [originalBuilder, originalLibrary]) {
    if (JSON.parse(readFileSync(join(source, "package.json"))).version !== builderVersion) throw new Error("distribution_installer_builder_version_changed");
  }
  // Check all expected originals before creating any private tooling.
  for (const [file, digest] of Object.entries(originalTemplates)) {
    if (hash(readFileSync(join(originalLibrary, file))) !== digest) throw new Error(`distribution_installer_template_changed:${file}`);
  }
  const modules = join(outputRoot, "tooling/node_modules");
  for (const [name, source] of [["electron-builder", originalBuilder], ["app-builder-lib", originalLibrary]]) {
    const destination = join(modules, name);
    copyPackage(source, destination);
    mkdirSync(join(destination, "node_modules"), { recursive: true });
    // Match pnpm's already installed dependency set; no package install or lock rewrite.
    for (const entry of readdirSync(dirname(source), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ["electron-builder", "app-builder-lib"].includes(entry.name)) continue;
      symlinkSync(realpathSync(join(dirname(source), entry.name)), join(destination, "node_modules", entry.name), "junction");
    }
    const peer = name === "electron-builder" ? "app-builder-lib" : "electron-builder";
    symlinkSync(join(modules, peer), join(destination, "node_modules", peer), "junction");
  }
  const appBuilderLibRoot = join(modules, "app-builder-lib"), changes = [];
  for (const [file, originalSha256] of Object.entries(originalTemplates)) {
    const before = readFileSync(join(appBuilderLibRoot, file), "utf8"), after = patchInstallerTemplate(file, before);
    writeFileSync(join(appBuilderLibRoot, file), after);
    changes.push({ file, originalSha256, modifiedSha256: hash(after) });
  }
  const shell = readFileSync(new URL("./LingShell.nsh", import.meta.url));
  writeFileSync(join(appBuilderLibRoot, "templates/nsis/include/LingShell.nsh"), shell);
  const receipt = { schemaVersion: 1, kind: "desktop-installer-template-overlay", builderVersion, changes, shellSha256: hash(shell),
    compression: "Unchanged stock 7z payload and original extractor", copy: "Extended-length extraction/rollback paths and system robocopy retain long-path members; exhausted copy retries exit with failure", progress: "Unchanged stock progress page; SpiderBanner call sites removed", shell: "MIT LingShell macros using the NSIS System plug-in and the same Windows COM interfaces", sharedToolchainModified: false };
  const receiptPath = join(outputRoot, "installer-template-overlay.json");
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  return { electronBuilderRoot: join(modules, "electron-builder"), appBuilderLibRoot, receiptPath, ...receipt };
}
