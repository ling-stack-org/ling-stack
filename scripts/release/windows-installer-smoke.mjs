import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runOwnedWindowsProcess } from "../../apps/desktop/scripts/cua-driver-package-atomic-publish.mjs";
import { inventoryApplicationTree } from "./desktop-payload.mjs";

const product = "Ling Stack", uninstallerName = "Uninstall Ling Stack.exe";
const registryProbe = `
$ErrorActionPreference = 'Stop'
$keys = @(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue |
  Get-ItemProperty | Where-Object { $_.DisplayName -eq 'Ling Stack' -or $_.DisplayName -like 'Ling Stack *' })
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
  @{ path = $_.PSPath; name = $_.DisplayName; version = $_.DisplayVersion; uninstaller = $_.UninstallString }
}); installKeys = @($installKeys | ForEach-Object {
  @{ path = $_.PSPath; location = $_.InstallLocation }
}); shortcuts = @($shortcutDetails) }
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
  const powershell = (code, extraEnv = {}, timeout = 240_000) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code],
    { env: { ...env, ...extraEnv }, timeout, encoding: "utf8", maxBuffer: 1024 * 1024 }).trim();
  const inspect = () => JSON.parse(powershell(registryProbe));
  const runInstaller = customPath => powershell(`$ErrorActionPreference = 'Stop';
$installArgs = @('/S'); if ($env:LING_INSTALL_SMOKE_CUSTOM_PATH -eq 'true') { $installArgs += ('/D=' + $env:LING_INSTALL_SMOKE_PATH) }
$p = Start-Process -FilePath $env:LING_INSTALL_SMOKE_EXE -ArgumentList $installArgs -PassThru -Wait;
if ($p.ExitCode -ne 0) { throw ('Installer failed: ' + $p.ExitCode) }`,
  { LING_INSTALL_SMOKE_EXE: resolve(installer), LING_INSTALL_SMOKE_CUSTOM_PATH: String(customPath) }, 420_000);
  const runUninstaller = () => powershell(`$ErrorActionPreference = 'Stop';
$p = Start-Process -FilePath (Join-Path $env:LING_INSTALL_SMOKE_PATH 'Uninstall Ling Stack.exe') -ArgumentList '/S' -PassThru -Wait;
if ($p.ExitCode -ne 0) { throw ('Uninstaller failed: ' + $p.ExitCode) }`);
  const baseline = await inventoryApplicationTree(unpacked);
  let installed = false;
  let installedStartup;
  try {
    const before = inspect();
    if (before.entries.length || before.installKeys.length || before.shortcuts.length) throw new Error("Refusing installer smoke over an existing Ling installation or shortcut");
    for (let iteration = 0; iteration < 2; iteration++) {
      installed = true; // A partially failed installation still needs its own cleanup.
      const started = performance.now();
      console.log(`Windows installer smoke: ${iteration === 0 ? "custom-path install" : "registered-path upgrade"} started`);
      runInstaller(iteration === 0); // Upgrade must rediscover the registered custom path itself.
      console.log(`Windows installer smoke: installer exited after ${Math.round(performance.now() - started)} ms; comparing complete payload`);
      const payload = await inventoryApplicationTree(installPath);
      const uninstaller = payload.find(file => file.name === uninstallerName);
      if (!uninstaller || uninstaller.type !== "file" || uninstaller.sizeBytes === 0
        || !isDeepStrictEqual(payload.filter(file => file.name !== uninstallerName), baseline)) {
        throw new Error("Installed or upgraded payload differs from the verified complete application");
      }
      const registration = inspect();
      console.log("Windows installer registration: " + JSON.stringify(registration));
      // The pinned stock installer uses a versioned DisplayName and a separate
      // installation key for InstallLocation; the uninstall key has no such field.
      if (registration.entries.length !== 1 || registration.entries[0].name !== `${product} ${candidate.version}`
        || registration.entries[0].version !== candidate.version
        || registration.entries[0].uninstaller !== `"${join(installPath, uninstallerName)}" /currentuser`
        || registration.installKeys.length !== 1 || registration.installKeys[0].location !== installPath
        || registration.shortcuts.length !== 2 || registration.shortcuts.some(shortcut => shortcut.appId !== "com.lingstack.desktop")) {
        throw new Error("Installer registration or per-user shortcuts are incomplete");
      }
      const runtime = execFileSync(join(installPath, "Ling Stack.exe"), ["-e", 'console.log("LING_INSTALL_RUNTIME="+JSON.stringify(process.versions))'],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000, encoding: "utf8" });
      if (!runtime.split(/\r?\n/u).some(line => line.startsWith("LING_INSTALL_RUNTIME=") && JSON.parse(line.slice(21)).electron)) {
        throw new Error("Installed Electron runtime failed to start");
      }
      if (iteration === 0) installedStartup = await smokeInstalledDesktopStartup(join(installPath, "Ling Stack.exe"), temporary);
    }
    runUninstaller();
    installed = false;
    const after = inspect();
    if (after.entries.length || after.installKeys.length || after.shortcuts.length) throw new Error("Uninstaller left its application registration or shortcuts behind");
    await lstat(installPath).then(() => { throw new Error("Uninstaller left its application directory behind"); }, error => { if (error.code !== "ENOENT") throw error; });
    return { status: "passed", environment: "github-hosted-windows-x64", install: "passed", sameVersionUpgrade: "passed",
      installedStartup, uninstall: "passed", installedPayloadFiles: baseline.length, guiAndModelAcceptance: "not_run" };
  } catch (error) {
    // Diagnose only this invocation's new directory and its installer process
    // tree. Preserve the original failure and the unchanged acceptance limits.
    try {
      const files = await inventoryApplicationTree(installPath);
      const names = new Set(files.map(file => file.name));
      console.error("Windows installer payload diagnostics: " + JSON.stringify({ entries: files.length,
        sizeBytes: files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
        uninstallerPresent: names.has(uninstallerName), missingMembers: baseline.filter(file => !names.has(file.name)).slice(0, 12).map(file => file.name) }));
    } catch (diagnosticError) { console.error(`Windows installer payload diagnostics failed: ${diagnosticError.message}`); }
    try {
      console.error("Windows installer process diagnostics: " + powershell(`$all = @(Get-CimInstance Win32_Process);
$owned = @($all | Where-Object { $_.ExecutablePath -eq $env:LING_INSTALL_SMOKE_EXE });
for ($i = 0; $i -lt 8; $i++) {
  $children = @($all | Where-Object { $_.ParentProcessId -in $owned.ProcessId -and $_.ProcessId -notin $owned.ProcessId });
  if ($children.Count -eq 0) { break }; $owned += $children
}
@($owned | Select-Object -First 20 | ForEach-Object {
  $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue;
  @{ pid = $_.ProcessId; parent = $_.ParentProcessId; command = $_.CommandLine; title = $p.MainWindowTitle; responding = $p.Responding; cpu = $p.CPU }
}) | ConvertTo-Json -Compress -Depth 3`, { LING_INSTALL_SMOKE_EXE: resolve(installer) }, 30_000));
    } catch (diagnosticError) { console.error(`Windows installer process diagnostics failed: ${diagnosticError.message}`); }
    throw error;
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

/** Exercise the installed packaged shell with isolated state before uninstalling it. */
async function smokeInstalledDesktopStartup(executable, temporary) {
  const profile = join(temporary, "desktop-startup");
  const userData = join(profile, "user-data");
  const workspace = join(profile, "workspace");
  await mkdir(workspace, { recursive: true });
  const port = await availableLoopbackPort();
  const env = { ...process.env,
    LING_STACK_HOME: join(profile, "ling-home"),
    LING_STACK_DEFAULT_WORKSPACE_CWD: workspace,
    LING_STACK_DAEMON_URL: `http://127.0.0.1:${port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  console.log("Windows installer smoke: starting the installed Desktop with an empty profile");
  const started = performance.now();
  let launchError;
  try {
    await runOwnedWindowsProcess(executable, ["--ling-desktop-smoke-headless", `--user-data-dir=${userData}`], {
      cwd: workspace, env, timeout: 240_000, maxBuffer: 1024 * 1024,
    });
  } catch (error) { launchError = error; }
  const startupLog = await readFile(join(userData, "desktop-startup.log"), "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const events = startupLog.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  const eventNames = events.map(event => event.event);
  console.log("Windows installed Desktop startup events: " + eventNames.join(", "));
  if (launchError) {
    throw new Error(`Installed Desktop failed to start and exit normally (${launchError.signal ?? launchError.code ?? "unknown"})`);
  }
  const appReady = events.findIndex(event => event.event === "app.ready" && event.packaged === true && event.smokeHeadless === true);
  const daemonConnected = events.findIndex(event => event.event === "daemon.connected" && event.ownedByDesktop === true);
  const rendererLoaded = eventNames.indexOf("main_window.loaded");
  if (appReady < 0 || daemonConnected <= appReady || rendererLoaded <= daemonConnected
    || eventNames.includes("app.startup_failed") || eventNames.includes("app.shutdown_failed")) {
    throw new Error("Installed Desktop did not complete an owned startup and exit");
  }
  const preparing = events.find(event => event.event === "daemon.resources_preparing");
  const ready = events.find(event => event.event === "daemon.resources_ready");
  const resourcePreparationMs = Date.parse(ready?.ts) - Date.parse(preparing?.ts);
  if (!Number.isFinite(resourcePreparationMs) || resourcePreparationMs < 0) {
    throw new Error("Installed Desktop did not record packaged resource preparation");
  }
  return { status: "passed", durationMs: Math.round(performance.now() - started),
    resourcePreparationMs, desktopOwnedDaemon: true, normalExit: true };
}

async function availableLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback port for installed Desktop startup");
  }
  const port = address.port;
  await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
  return port;
}
