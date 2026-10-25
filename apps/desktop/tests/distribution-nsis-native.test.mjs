import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyNsisPlugins } from "../../../scripts/release/verify-nsis-plugins.mjs";
import { prepareNsisExtractor } from "../../../scripts/release/nsis-extractor.mjs";
import { prepareDistributionBuilder } from "../scripts/distribution/installer-builder.mjs";

test("the pinned native NSIS compiler retains the reviewed plug-in bytes", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-native-nsis-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const desktopRequire = createRequire(new URL("../package.json", import.meta.url));
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
  const sources = JSON.parse(await readFile(new URL("../scripts/distribution/vendor-notices/nsis-plugins/sources.json", import.meta.url)));
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

test("the production NSIS overlay installs, upgrades and uninstalls long-path members", {
  skip: process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted",
}, async t => {
  const root = await realpath(await mkdtemp(join(process.env.RUNNER_TEMP, "ling-stock-installer-")));
  let completed = false;
  t.after(() => completed ? rm(root, { recursive: true, force: true }) : undefined);
  const desktopRoot = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  const metadata = JSON.parse(await readFile(join(desktopRoot, "package.json")));
  const app = join(root, "app"), payload = join(root, "payload"), output = join(root, "release");
  await mkdir(app); await mkdir(payload);
  await writeFile(join(app, "package.json"), JSON.stringify({ name: metadata.name, version: metadata.version,
    description: metadata.description, author: metadata.author, license: metadata.license, main: "main.js" }));
  // This is an installer fixture, not a claim that Node is the Desktop runtime.
  await copyFile(process.execPath, join(payload, "Ling Stack.exe"));
  await writeFile(join(payload, "fixture.txt"), "Stock installer payload\n");
  const prepared = prepareDistributionBuilder({ desktopRoot, outputRoot: join(root, "builder") });
  const require = createRequire(join(prepared.electronBuilderRoot, "package.json"));
  const builder = require(prepared.electronBuilderRoot);
  const build = () => builder.build({ projectDir: app, prepackaged: payload, publish: "never",
    targets: builder.Platform.WINDOWS.createTarget("nsis", builder.Arch.x64),
    config: { appId: metadata.build.appId, productName: metadata.build.productName,
      electronVersion: metadata.devDependencies.electron, directories: { app, output, buildResources: join(desktopRoot, "build") },
      win: { artifactName: "stock-fixture.exe", signAndEditExecutable: false },
      nsis: { ...metadata.build.nsis, include: join(desktopRoot, "build/installer.nsh") } } });
  const installer = join(output, "stock-fixture.exe"), installPath = join(root, "Ling Stack");
  const env = { ...process.env, LING_FIXTURE_INSTALLER: installer, LING_FIXTURE_ROOT: root, LING_FIXTURE_INSTALL_PATH: installPath };
  const run = code => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code],
    { env, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
  const deepPath = "resources/gstack/runtime/lib/diagram-render/node_modules/@radix-ui/react-tabs/node_modules/@radix-ui/react-primitive/node_modules/@radix-ui/react-slot/node_modules/@radix-ui/react-compose-refs/ling-upstream-license-provenance.json";
  try {
    // Build once, with the long member present from the start: a second build
    // could reuse the first payload archive and conceal the failing layer.
    await mkdir(join(payload, dirname(deepPath)), { recursive: true });
    await writeFile(join(payload, deepPath), "Long path fixture\n");
    await build();
    const extractor = await prepareNsisExtractor();
    t.after(extractor.cleanup);
    const nested = join(root, "verified-app.7z");
    await writeFile(nested, execFileSync(extractor.path, ["e", "-so", "-bd", "-bb0", installer, "$PLUGINSDIR/app-64.7z"],
      { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }));
    assert.equal(execFileSync(extractor.path, ["e", "-so", "-bd", "-bb0", nested, deepPath],
      { timeout: 30_000, encoding: "utf8" }), "Long path fixture\n", "the actual embedded archive must contain the deep member before installation");
    t.diagnostic("Verified long member bytes inside the actual installer archive");
    await mkdir(installPath);
    await writeFile(join(installPath, "fixture.txt"), "Owned locked destination\n");
    const forcedCopy = JSON.parse(run(`$ErrorActionPreference = 'Stop';
$locked = [IO.File]::Open((Join-Path $env:LING_FIXTURE_INSTALL_PATH 'fixture.txt'), 'Open', 'ReadWrite', 'None');
try {
  $p = Start-Process -FilePath $env:LING_FIXTURE_INSTALLER -ArgumentList @('/S', ('/D=' + $env:LING_FIXTURE_INSTALL_PATH)) -PassThru -Wait;
  @{ exitCode = $p.ExitCode } | ConvertTo-Json -Compress
} finally { $locked.Dispose() }`));
    const forcedUninstaller = await lstat(join(installPath, "Uninstall Ling Stack.exe")).then(() => true, error => {
      if (error.code === "ENOENT") return false; throw error;
    });
    t.diagnostic(JSON.stringify({ forcedCopyFailure: forcedCopy, registeredUninstaller: forcedUninstaller }));
    // Old failing behavior creates an uninstaller: remove that fixture normally
    // before the independent upgrade probe. No real user installation is used.
    if (forcedUninstaller) run(`$p = Start-Process -FilePath (Join-Path $env:LING_FIXTURE_INSTALL_PATH 'Uninstall Ling Stack.exe') -ArgumentList '/S' -PassThru -Wait;
if ($p.ExitCode -ne 0) { throw ('Fixture cleanup exit: ' + $p.ExitCode) }`);
    await rm(installPath, { recursive: true, force: true });
    for (let iteration = 0; iteration < 2; iteration++) {
      const started = performance.now();
      t.diagnostic(`Installing stock fixture; iteration=${iteration}; finalPathLength=${join(installPath, deepPath).length}`);
      t.diagnostic(run(`$ErrorActionPreference = 'Stop';
  $installArgs = @('/S');
  ${iteration === 0 ? "$installArgs += ('/D=' + $env:LING_FIXTURE_INSTALL_PATH);" : ""}
  $p = Start-Process -FilePath $env:LING_FIXTURE_INSTALLER -ArgumentList $installArgs -PassThru -Wait;
  if ($p.ExitCode -ne 0) { throw ('Fixture installer exit: ' + $p.ExitCode) }`));
      t.diagnostic(`Small stock installer elapsed milliseconds: ${performance.now() - started}`);
      assert.equal(await readFile(join(installPath, "fixture.txt"), "utf8"), "Stock installer payload\n");
      assert.equal(await readFile(join(installPath, deepPath), "utf8"), "Long path fixture\n");
      const registration = JSON.parse(run(`$ErrorActionPreference = 'Stop';
$entries = @(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' |
  Get-ItemProperty | Where-Object { $_.DisplayName -eq 'Ling Stack' -or $_.DisplayName -like 'Ling Stack *' });
$installKeys = @(Get-ChildItem 'HKCU:\\Software' | Get-ItemProperty -ErrorAction SilentlyContinue |
  Where-Object { $_.InstallLocation -eq $env:LING_FIXTURE_INSTALL_PATH });
$shell = New-Object -ComObject Shell.Application;
$shortcuts = @(@([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) |
  ForEach-Object { Join-Path $_ 'Ling Stack.lnk' } | Where-Object { Test-Path -LiteralPath $_ } |
  ForEach-Object {
    $folder = $shell.NameSpace([IO.Path]::GetDirectoryName($_));
    $item = $folder.ParseName([IO.Path]::GetFileName($_));
    @{ path = $_; appId = $item.ExtendedProperty('System.AppUserModel.ID') }
  });
ConvertTo-Json -Compress -Depth 4 @{ entries = @($entries | ForEach-Object {
  @{ name = $_.DisplayName; version = $_.DisplayVersion; uninstaller = $_.UninstallString }
}); installLocations = @($installKeys | ForEach-Object { $_.InstallLocation }); shortcuts = $shortcuts }`));
      t.diagnostic("Native fixture registration: " + JSON.stringify(registration));
      assert.deepEqual(registration.entries, [{ name: `${metadata.build.productName} ${metadata.version}`, version: metadata.version,
        uninstaller: `"${join(installPath, "Uninstall Ling Stack.exe")}" /currentuser` }]);
      assert.deepEqual(registration.installLocations, [installPath]);
      assert.equal(registration.shortcuts.length, 2);
      assert.ok(registration.shortcuts.every(shortcut => shortcut.appId === metadata.build.appId));
    }
    t.diagnostic(run(`$ErrorActionPreference = 'Stop';
  $p = Start-Process -FilePath (Join-Path $env:LING_FIXTURE_INSTALL_PATH 'Uninstall Ling Stack.exe') -ArgumentList '/S' -PassThru -Wait;
  if ($p.ExitCode -ne 0) { throw ('Fixture uninstaller exit: ' + $p.ExitCode) }`));
    await assert.rejects(readFile(join(installPath, "fixture.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(join(installPath, deepPath)), { code: "ENOENT" });
    await assert.rejects(lstat(installPath), { code: "ENOENT" });
    assert.notEqual(forcedCopy.exitCode, 0, "exhausted copy failures must not be reported as a successful installation");
    assert.equal(forcedUninstaller, false, "failed copy must not admit a partial installation");
    completed = true;
  } catch (error) {
    t.diagnostic(run(`Add-Type -AssemblyName UIAutomationClient;
Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -eq $env:LING_FIXTURE_INSTALLER -or ($_.CommandLine -and $_.CommandLine.Contains($env:LING_FIXTURE_ROOT))
} | ForEach-Object {
  $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  $text = @()
  if ($p.MainWindowHandle -ne 0) {
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
    $text = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
      ForEach-Object { $_.Current.Name } | Select-Object -First 30)
  }
  @{ pid = $_.ProcessId; parent = $_.ParentProcessId; command = $_.CommandLine; title = $p.MainWindowTitle; text = $text; responding = $p.Responding; cpu = $p.CPU }
} | ConvertTo-Json -Compress -Depth 4`));
    throw error;
  }
});
