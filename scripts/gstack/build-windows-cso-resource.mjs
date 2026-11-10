import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNativeTarget } from "./build-native-runtime.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";

const fail = reason => { throw new Error(`gstack_windows_cso_${reason}`); };
const toolDiscovery = `$ErrorActionPreference='Stop';
  $v=Join-Path \${env:ProgramFiles(x86)} 'Microsoft Visual Studio\\Installer\\vswhere.exe';
  $i=& $v -latest -products '*' -version '[17.0,)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath;
  if($LASTEXITCODE -ne 0 -or -not $i){throw 'MSVC installation missing'};
  $d=Join-Path ([string]$i) 'Common7\\Tools\\Launch-VsDevShell.ps1';
  & $d -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null;
  @{vswhere=$v;devShell=$d;compiler=(Get-Command cl.exe).Source;linker=(Get-Command link.exe).Source;
    sdk=$env:WindowsSdkDir;sdkVersion=$env:WindowsSDKVersion}|ConvertTo-Json -Compress`;

/** Run the pinned, unmodified upstream Windows build and bind its source/tool/output bytes.
 * Upstream Windows comprehensive execution and complete SDK dependency closure remain pending. */
export async function buildWindowsCsoResource({ runtimeRoot, shellPath, env }) {
  if (process.platform !== "win32" || process.arch !== "x64") fail("matching_host_required");
  const root = resolve(runtimeRoot), manifest = JSON.parse(await readFile(join(root, "../manifest.json")));
  const expected = new Map(manifest.files.filter(row => row.path.startsWith("runtime/")).map(row => [row.path.slice(8), row]));
  const names = [...expected.keys()].filter(path => path === "VERSION" || path === "scripts/build-cso.sh" ||
    path === "scripts/build-cso-windows.ps1" || path.startsWith("lib/") && !path.startsWith("lib/diagram-render/") && /\.(?:ts|js|json|c|h)$/.test(path));
  for (const path of ["scripts/build-cso.sh", "scripts/build-cso-windows.ps1", "lib/cso/cli.ts", "lib/cso/launcher-windows.c", "lib/cso/publish-lock.c"]) {
    if (!names.includes(path)) fail("required_source_missing");
  }
  const sourceInputs = [];
  for (const path of names.sort()) {
    const file = await readGstackClosureFileRecord(join(root, path)), pin = expected.get(path);
    if (file.checksum !== pin.checksum || file.sizeBytes !== pin.sizeBytes) fail("source_changed");
    sourceInputs.push({ path, ...file });
  }
  const resolveCommand = async name => realpath(execFileSync("where.exe", [name], { env, encoding: "utf8" }).trim().split(/\r?\n/)[0]);
  const powershell = await resolveCommand("pwsh.exe"), shell = await realpath(shellPath);
  const discovered = JSON.parse(execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", toolDiscovery],
    { env, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 ** 2 }));
  const toolPaths = { shell, powershell, git: await resolveCommand("git.exe"),
    vswhere: discovered.vswhere, devShell: discovered.devShell, compiler: discovered.compiler, linker: discovered.linker };
  const nativeTools = [];
  for (const [name, path] of Object.entries(toolPaths)) nativeTools.push({ name,
    ...await readGstackClosureFileRecord(await realpath(path), { maximumBytes: 512 * 1024 ** 2 }) });
  execFileSync(shell, ["scripts/build-cso.sh"], { cwd: root, env, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 4 * 1024 ** 2 });
  const artifacts = [];
  for (const path of ["bin/gstack-cso-core.exe", "bin/gstack-cso-launcher.exe", "bin/.gstack-cso-generation"]) {
    const file = await readGstackClosureFileRecord(join(root, path));
    if ((await lstat(join(root, path))).nlink !== 1) fail("artifact_hardlinked");
    if (path.endsWith(".exe")) assertNativeTarget(await readFile(join(root, path)), { platform: "win32", arch: "x64" });
    artifacts.push({ path, ...file });
  }
  const coreChecksum = artifacts[0].checksum;
  if (await readFile(join(root, "bin/.gstack-cso-generation"), "utf8") !== `${coreChecksum.slice(7)}\n` ||
    !(await readFile(join(root, "bin/.gstack-cso-build-result"), "utf8")).includes("result=ok\nstage=publish\nreason=committed\n")) fail("upstream_publication_incomplete");
  for (const input of sourceInputs) if ((await readGstackClosureFileRecord(join(root, input.path))).checksum !== input.checksum) fail("source_changed");
  for (const tool of nativeTools) if ((await readGstackClosureFileRecord(await realpath(toolPaths[tool.name]), { maximumBytes: 512 * 1024 ** 2 })).checksum !== tool.checksum) fail("tool_changed");
  const tooling = "scripts/gstack/build-windows-cso-resource.mjs";
  const report = { schemaVersion: 1, releaseEligible: false, deliveryStage: "compiled-resource-prerequisites",
    compiledArtifactBinding: "unmodified-upstream-windows-build-with-source-tool-and-output-byte-binding",
    upstreamRevision: manifest.upstream.revision, sourceInputs, nativeTools, artifacts, coreChecksum,
    toolInputs: [{ path: tooling, ...await readGstackClosureFileRecord(fileURLToPath(import.meta.url)) }],
    target: { platform: "win32", arch: "x64" }, sdkVersion: discovered.sdkVersion,
    upstreamPublication: "native-publisher-lock-and-launcher-last-commit",
    comprehensiveWindowsExecution: "unavailable-in-pinned-upstream",
    pendingGates: ["full-msvc-sdk-dependency-closure", "repeated-native-byte-identity", "installed-client-acceptance", "redistribution-review"] };
  await writeFile(join(root, "bin/cso-build-provenance.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return report;
}
