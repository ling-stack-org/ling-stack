import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { runOwnedWindowsProcess } from "../../apps/desktop/scripts/cua-driver-package-atomic-publish.mjs";
import { inventoryApplicationTree } from "./desktop-payload.mjs";
import { fileRecord } from "./desktop-release.mjs";

const [bundledDirectory, slimDirectory, upgradeDirectory, outputPath] = process.argv.slice(2);
assert(process.platform === "win32" && process.arch === "x64"
  && process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted"
  && process.env.RUNNER_TEMP && process.env.SystemRoot, "A fresh hosted Windows x64 runner is required.");
assert(bundledDirectory && slimDirectory && upgradeDirectory && outputPath, "Three candidate directories and an output path are required.");

const bundledPin = {
  mode: "bundled", source: "14be1bdebd3d295a4f822981ae8cc18a32b9dd51",
  digest: "246318c9b999c82b448144a35a26963228bc2f3aaa39dfb602662074674feee8",
};
const slimPin = {
  mode: "on-demand", source: "b60f0c396c6f1dad3023018a1f14f8e793d2d406",
  digest: "167d3f090e4556b0561b5ced253b634d8a326a1e6b45b9a5999cc9a1695d73d4",
};
const upgradePin = {
  mode: "on-demand", source: "97ec6701d9147afbd22b222bc7d285c1e3ece45d",
  digest: "f326ec39e94f62095bc667a1b5577658a9caf700607c54b40e80826dc7956d72",
};
const [bundled, slim, upgrade] = await Promise.all([
  readCandidate(bundledDirectory, bundledPin),
  readCandidate(slimDirectory, slimPin),
  readCandidate(upgradeDirectory, upgradePin),
]);
assert.equal(new Set([bundled.gstack, slim.gstack, upgrade.gstack]).size, 3, "Each installer must contain a different GStack generation.");
const root = await realpath(await mkdtemp(join(process.env.RUNNER_TEMP, "ling-plugin-profile-")));
const install = join(root, "install");
const executable = join(install, "Ling Stack.exe");
const uninstaller = join(install, "Uninstall Ling Stack.exe");
const workspace = join(root, "workspace");
const otherWorkspace = join(root, "other-workspace");
const userData = join(root, "user-data");
const home = join(root, "ling-home");
await Promise.all([workspace, otherWorkspace, userData, home].map(path => mkdir(path)));
const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const officeRoute = "/plugins/" + encodeURIComponent("official:office-documents");
const chromeRoute = "/plugins/" + encodeURIComponent("official:chrome-browser");
const startupLog = join(userData, "desktop-startup.log");

await runPowerShell(String.raw`
$ErrorActionPreference = 'Stop'
$keys = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
  Get-ItemProperty | Where-Object { $_.DisplayName -eq 'Ling Stack' -or $_.DisplayName -like 'Ling Stack *' })
$shortcuts = @(@([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) |
  ForEach-Object { Join-Path $_ 'Ling Stack.lnk' } | Where-Object { Test-Path -LiteralPath $_ })
if ($keys.Count -or $shortcuts.Count) { throw 'The runner already has a Ling installation or shortcut.' }
`);

let installationStarted = false;
let before;
let after;
let retained;
try {
  installationStarted = true;
  await installCandidate(bundled, true);
  before = await readFromInstalledDesktop("bundled", true);
  assert.deepEqual(before.states, { office: "enabled", chrome: "enabled", otherOffice: "disabled" });
  assert.deepEqual(before.approvals, { primary: "deny", secondary: "ask" });
  assert(before.events.every(events => events.some(event => typeof event.id === "string")));
  assert.deepEqual(before.bindings.map(binding => [binding.server_id, binding.enabled]), [
    ["mcp_chrome_browser", 1], ["mcp_office_documents", 1],
  ]);
  assert.deepEqual(await retainedGstack(), [bundled.gstack]);
  await installCandidate(slim, false);
  after = await readFromInstalledDesktop("on-demand", false);
  assert.deepEqual(after, before, "Plugin settings or audit history changed after the upgrade.");
  retained = await retainedGstack();
  assert.deepEqual(retained, [bundled.gstack, slim.gstack].sort());
  const snapshotsBefore = [workspace, otherWorkspace].map(readGstackSnapshots);
  for (const snapshots of snapshotsBefore) {
    assert(snapshots.some(snapshot => snapshot.review_status === "archived"
      && snapshot.referenced_files_json.includes(bundled.gstack)));
    assert(snapshots.some(snapshot => snapshot.review_status === "published"
      && snapshot.referenced_files_json.includes(slim.gstack)));
  }
  await installCandidate(upgrade, false);
  const fullHistory = await readFromInstalledDesktop("on-demand with two retained GStack generations", false);
  assert.deepEqual(fullHistory, before, "Plugin settings or audit history changed after the third installation.");
  assert.deepEqual(await retainedGstack(), retained, "The cache changed while both GStack generations had snapshot references.");
  assert.deepEqual([workspace, otherWorkspace].map(readGstackSnapshots), snapshotsBefore, "GStack snapshots changed during deferral.");
} finally {
  if (installationStarted && await exists(uninstaller)) await runSetup(uninstaller);
}
assert.equal(await exists(install), false, "Uninstall left its owned application directory.");

const evidence = {
  status: "passed", target: "windows-x64", version: bundled.version,
  bundledSourceSha: bundled.source, slimSourceSha: slim.source,
  bundledInstallerSha256: bundled.digest, slimInstallerSha256: slim.digest,
  thirdInstaller: {
    sourceSha: upgrade.source, installerSha256: upgrade.digest,
    installedStartup: "passed", pluginProfilePreserved: true,
    incomingGstack: upgrade.gstack, retainedGstack: retained, snapshotLineagePreserved: true,
    gstackPublication: "deferred",
  },
  customPathInstall: "passed", registeredPathUpgrade: "passed", uninstall: "passed",
  installedPayloadsMatch: true, desktopOwnedDaemonStartupAndExit: true,
  pluginStates: after.states, workspaceWriteApprovals: after.approvals,
  teammateMcpBindingsRetained: true, pluginEventIdentitiesRetained: true,
};
await writeFile(resolve(outputPath), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(evidence));

async function readCandidate(directory, pin) {
  const report = JSON.parse(await readFile(join(directory, "desktop-windows-x64-package-verification.json"), "utf8"));
  assert.equal(report.sourceSha, pin.source);
  assert.equal(report.pluginMode, pin.mode);
  assert.equal(report.target, "windows-x64");
  assert.equal(report.signingTier, "unsigned_dev");
  assert.equal(report.status, "passed");
  assert.equal(report.version, "0.6.1");
  assert(Array.isArray(report.payload) && report.payload.length > 0);
  const archive = report.archives.find(record => record.name === "Ling-Stack-0.6.1-windows-x64-setup.exe");
  assert.equal(archive?.sha256, pin.digest);
  const installer = resolve(directory, archive.name);
  assert.deepEqual(await fileRecord(installer), archive);
  assert.match(report.gstack?.manifestChecksum, /^sha256:[a-f0-9]{64}$/u);
  return { ...pin, installer, version: report.version, payload: report.payload, gstack: report.gstack.manifestChecksum };
}

async function retainedGstack() {
  const names = await readdir(join(home, "sources", "bundled-gstack"));
  return names.map(name => {
    assert.match(name, /^[a-f0-9]{64}$/u);
    return "sha256:" + name;
  }).sort();
}

function readGstackSnapshots(cwd) {
  const database = new DatabaseSync(join(cwd, ".ling-stack", "ling-stack.sqlite"), { readOnly: true });
  try {
    return database.prepare(`SELECT id, skill_id, review_status, referenced_files_json
      FROM skill_source_snapshots WHERE source_kind = 'gstack-skill-directory' ORDER BY id`).all();
  } finally {
    database.close();
  }
}

async function installCandidate(candidate, customPath) {
  console.log("Installing " + candidate.mode + " package");
  await runSetup(candidate.installer, customPath);
  const files = await inventoryApplicationTree(install);
  assert.equal(await exists(uninstaller), true, "Installed uninstaller is missing.");
  const payload = files.filter(file => file.name !== "Uninstall Ling Stack.exe");
  if (!isDeepStrictEqual(payload, candidate.payload)) {
    const expected = new Map(candidate.payload.map(file => [file.name, file]));
    const observed = new Set(payload.map(file => file.name));
    const unexpected = payload.filter(file => !isDeepStrictEqual(file, expected.get(file.name))).map(file => file.name);
    const missing = candidate.payload.filter(file => !observed.has(file.name)).map(file => file.name);
    console.error(JSON.stringify({ mode: candidate.mode, unexpected: unexpected.slice(0, 10), missing: missing.slice(0, 10) }));
    throw new Error("The installed payload differs from the verified " + candidate.mode + " package.");
  }
}

async function runSetup(installer, customPath = false) {
  await runPowerShell(String.raw`
$ErrorActionPreference = 'Stop'
$installArgs = @('/S')
if ($env:LING_FIXTURE_INSTALL_DIR) { $installArgs += ('/D=' + $env:LING_FIXTURE_INSTALL_DIR) }
$p = Start-Process -FilePath $env:LING_FIXTURE_SETUP -ArgumentList $installArgs -PassThru -Wait
if ($p.ExitCode -ne 0) { throw ('Setup process exited with ' + $p.ExitCode) }
`, { LING_FIXTURE_SETUP: installer, LING_FIXTURE_INSTALL_DIR: customPath ? install : "" });
}

async function runPowerShell(command, overrides = {}) {
  await runOwnedWindowsProcess(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, ...overrides }, timeout: 420_000, maxBuffer: 1024 * 1024,
  });
}

async function readFromInstalledDesktop(mode, configure) {
  console.log("Launching " + mode + " Desktop with its own daemon");
  const listener = createServer();
  await new Promise((ready, fail) => {
    listener.once("error", fail);
    listener.listen(0, "127.0.0.1", ready);
  });
  const port = listener.address().port;
  await new Promise((done, fail) => listener.close(error => error ? fail(error) : done()));
  const baseUrl = "http://127.0.0.1:" + port;
  const env = { ...process.env, LING_STACK_HOME: home, LING_STACK_DEFAULT_WORKSPACE_CWD: workspace,
    LING_STACK_DAEMON_URL: baseUrl };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const prior = await readStartupLog();
  const finished = new AbortController();
  const run = runOwnedWindowsProcess(executable, ["--ling-desktop-smoke-headless", "--user-data-dir=" + userData], {
    cwd: workspace, env, timeout: 240_000, maxBuffer: 1024 * 1024,
  }).finally(() => finished.abort());
  const probe = observeProfile(baseUrl, finished.signal, configure);
  const [launch, observation] = await Promise.allSettled([run, probe]);
  const log = await readStartupLog();
  assert(log.startsWith(prior), "The previous startup log changed.");
  const events = log.slice(prior.length).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  const names = events.map(event => event.event);
  console.log(mode + " startup events: " + names.join(", "));
  if (launch.status === "rejected") throw launch.reason;
  assert(events.some(event => event.event === "app.ready" && event.packaged && event.smokeHeadless));
  assert(events.some(event => event.event === "daemon.connected" && event.ownedByDesktop));
  assert(names.includes("main_window.loaded") && !names.includes("app.startup_failed") && !names.includes("app.shutdown_failed"));
  if (observation.status === "rejected") throw observation.reason;

  const database = new DatabaseSync(join(workspace, ".ling-stack", "ling-stack.sqlite"), { readOnly: true });
  try {
    const bindings = database.prepare("SELECT server_id, mode, enabled, selected_tool_names_json, approval_overrides_json " +
      "FROM teammate_mcp_bindings WHERE teammate_id = ? AND server_id IN (?, ?) ORDER BY server_id")
      .all("ling_agent", "mcp_chrome_browser", "mcp_office_documents");
    return { ...observation.value, bindings };
  } finally {
    database.close();
  }
}

async function observeProfile(baseUrl, signal, configure) {
  for (;;) {
    signal.throwIfAborted();
    const ready = await fetch(baseUrl + "/health", { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) })
      .then(response => response.ok, () => false);
    if (ready) break;
    await delay(75, undefined, { signal });
  }
  const request = async (path, { cwd = workspace, method = "GET", body } = {}) => {
    const url = new URL(path, baseUrl);
    url.searchParams.set("cwd", cwd);
    const response = await fetch(url, {
      method, headers: { Origin: baseUrl, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    assert.equal(response.status, 200, method + " " + path + " " + (result.message ?? result.error ?? ""));
    return result;
  };
  if (configure) {
    await Promise.all([
      request(officeRoute + "/enable", { method: "POST" }),
      request(chromeRoute + "/enable", { method: "POST" }),
      request(officeRoute + "/disable", { cwd: otherWorkspace, method: "POST", body: { reason: "profile fixture" } }),
      request("/approval-policy", { method: "PATCH", body: { toolDecisions: { write: "deny" } } }),
    ]);
  }
  const [office, chrome, otherOffice, primary, secondary] = await Promise.all([
    request(officeRoute), request(chromeRoute), request(officeRoute, { cwd: otherWorkspace }),
    request("/approval-policy"), request("/approval-policy", { cwd: otherWorkspace }),
  ]);
  return {
    states: { office: office.plugin.status, chrome: chrome.plugin.status, otherOffice: otherOffice.plugin.status },
    events: [office, chrome, otherOffice].map(({ plugin }) => plugin.events
      .filter(event => event.type === "enabled" || event.type === "disabled")
      .map(({ id, type }) => ({ id, type }))),
    approvals: { primary: primary.policy.toolDecisions.write, secondary: secondary.policy.toolDecisions.write },
  };
}

function readStartupLog() {
  return readFile(startupLog, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
