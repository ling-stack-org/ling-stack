import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inventoryApplicationTree } from "./desktop-payload.mjs";

const product = "Ling Stack", uninstallerName = "Uninstall Ling Stack.exe";
const registryProbe = `
$ErrorActionPreference = 'Stop'
$keys = @(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue |
  Get-ItemProperty | Where-Object { $_.DisplayName -eq 'Ling Stack' })
$installKeys = @(Get-ChildItem 'HKCU:\\Software' | Get-ItemProperty -ErrorAction SilentlyContinue |
  Where-Object { $_.InstallLocation -eq $env:LING_INSTALL_SMOKE_PATH })
$shortcuts = @(@([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) |
  ForEach-Object { Join-Path $_ 'Ling Stack.lnk' } | Where-Object { Test-Path -LiteralPath $_ })
$shell = New-Object -ComObject Shell.Application
$shortcutDetails = @($shortcuts | ForEach-Object {
  $folder = $shell.NameSpace([IO.Path]::GetDirectoryName($_))
  $item = $folder.ParseName([IO.Path]::GetFileName($_))
  @{ path = $_; appId = $item.ExtendedProperty('System.AppUserModel.ID') }
})
ConvertTo-Json -Compress -Depth 4 @{ entries = @($keys | ForEach-Object {
  @{ path = $_.PSPath; location = $_.InstallLocation; version = $_.DisplayVersion }
}); installKeys = @($installKeys | ForEach-Object { $_.PSPath }); shortcuts = @($shortcutDetails) }
`;

/** Fresh hosted runner only; this does not establish end-user GUI acceptance. */
export async function smokeWindowsInstaller({ installer, unpacked, candidate }) {
  if (process.platform !== "win32" || process.arch !== "x64" || process.env.GITHUB_ACTIONS !== "true"
    || process.env.RUNNER_ENVIRONMENT !== "github-hosted" || !process.env.RUNNER_TEMP) {
    throw new Error("Installer smoke requires a fresh GitHub-hosted Windows x64 runner");
  }
  const runnerTemp = await realpath(process.env.RUNNER_TEMP);
  const temporary = await realpath(await mkdtemp(join(runnerTemp, "ling-installer-smoke-")));
  const owner = await lstat(temporary), installPath = join(temporary, product);
  const env = { ...process.env, LING_INSTALL_SMOKE_PATH: installPath };
  const powershell = (code, extraEnv = {}) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code],
    { env: { ...env, ...extraEnv }, timeout: 240_000, encoding: "utf8", maxBuffer: 1024 * 1024 }).trim();
  const inspect = () => JSON.parse(powershell(registryProbe));
  const runInstaller = customPath => powershell(`$ErrorActionPreference = 'Stop';
$installArgs = @('/S'); if ($env:LING_INSTALL_SMOKE_CUSTOM_PATH -eq 'true') { $installArgs += ('/D=' + $env:LING_INSTALL_SMOKE_PATH) }
$p = Start-Process -FilePath $env:LING_INSTALL_SMOKE_EXE -ArgumentList $installArgs -PassThru -Wait;
if ($p.ExitCode -ne 0) { throw ('Installer failed: ' + $p.ExitCode) }`,
  { LING_INSTALL_SMOKE_EXE: resolve(installer), LING_INSTALL_SMOKE_CUSTOM_PATH: String(customPath) });
  const runUninstaller = () => powershell(`$ErrorActionPreference = 'Stop';
$p = Start-Process -FilePath (Join-Path $env:LING_INSTALL_SMOKE_PATH 'Uninstall Ling Stack.exe') -ArgumentList '/S' -PassThru -Wait;
if ($p.ExitCode -ne 0) { throw ('Uninstaller failed: ' + $p.ExitCode) }`);
  const baseline = await inventoryApplicationTree(unpacked);
  let installed = false;
  try {
    const before = inspect();
    if (before.entries.length || before.installKeys.length || before.shortcuts.length) throw new Error("Refusing installer smoke over an existing Ling installation or shortcut");
    for (let iteration = 0; iteration < 2; iteration++) {
      installed = true; // A partially failed installation still needs its own cleanup.
      runInstaller(iteration === 0); // Upgrade must rediscover the registered custom path itself.
      const payload = await inventoryApplicationTree(installPath);
      const uninstaller = payload.find(file => file.name === uninstallerName);
      if (!uninstaller || uninstaller.type !== "file" || uninstaller.sizeBytes === 0
        || !isDeepStrictEqual(payload.filter(file => file.name !== uninstallerName), baseline)) {
        throw new Error("Installed or upgraded payload differs from the verified complete application");
      }
      const registration = inspect();
      if (registration.entries.length !== 1 || registration.entries[0].location !== installPath
        || registration.entries[0].version !== candidate.version || registration.installKeys.length !== 1
        || registration.shortcuts.length !== 2 || registration.shortcuts.some(shortcut => shortcut.appId !== "com.lingstack.desktop")) {
        throw new Error("Installer registration or per-user shortcuts are incomplete");
      }
      const runtime = execFileSync(join(installPath, "Ling Stack.exe"), ["-e", 'console.log("LING_INSTALL_RUNTIME="+JSON.stringify(process.versions))'],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000, encoding: "utf8" });
      if (!runtime.split(/\r?\n/u).some(line => line.startsWith("LING_INSTALL_RUNTIME=") && JSON.parse(line.slice(21)).electron)) {
        throw new Error("Installed Electron runtime failed to start");
      }
    }
    runUninstaller();
    installed = false;
    const after = inspect();
    if (after.entries.length || after.installKeys.length || after.shortcuts.length) throw new Error("Uninstaller left its application registration or shortcuts behind");
    await lstat(installPath).then(() => { throw new Error("Uninstaller left its application directory behind"); }, error => { if (error.code !== "ENOENT") throw error; });
    return { status: "passed", environment: "github-hosted-windows-x64", install: "passed", sameVersionUpgrade: "passed",
      uninstall: "passed", installedPayloadFiles: baseline.length, guiAndModelAcceptance: "not_run" };
  } finally {
    if (installed) {
      // Only invoke the uninstaller in this invocation's new owned directory.
      const child = relative(temporary, installPath);
      if (child !== product) throw new Error("Installer smoke cleanup ownership changed");
      try {
        const stat = await lstat(join(installPath, uninstallerName));
        if (stat.isFile() && !stat.isSymbolicLink()) runUninstaller();
      } catch (error) { console.error(`Installer smoke cleanup requires inspection: ${error.message}`); }
    }
    const current = await lstat(temporary);
    if (current.isDirectory() && !current.isSymbolicLink() && current.dev === owner.dev && current.ino === owner.ino
      && await realpath(temporary) === temporary) {
      // Preserve failed installed payloads for diagnostics; never bypass uninstall by deleting them.
      const exists = await lstat(installPath).then(() => true, error => { if (error.code !== "ENOENT") throw error; return false; });
      if (!exists) await rm(temporary, { recursive: true });
    }
  }
}
