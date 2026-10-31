// Owned QA topology only. Import actual packaged lifecycle/resource/profile checks.
// No production listener, HTTP control endpoint, CDP, permission override or token creation.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createQaSseFaultRelay } from "./qa-sse-fault-relay.mjs";
import { buildQaGuiEnvironment, readExistingPrivateToken } from "./qa-sse-supervisor-support.mjs";

const root = resolve(import.meta.dirname, "../../..");
const app = resolve(root, "apps/desktop/release/human-qa/mac-arm64/Ling Stack Human QA.app");
const executable = resolve(app, "Contents/MacOS/Ling Stack Human QA");
const resourcesRoot = resolve(app, "Contents/Resources");
const appPath = resolve(resourcesRoot, "app.asar");
const profilePath = resolve(root, "output/e6-20260928/h09-packaged-human-qa-20261010/profile");
const expectedSha = "4db75650e50300c45fdc033f715ef231fa41dc1db0d670eaf1f34c1dfeb70c35";
assert.equal(realpathSync(process.execPath), realpathSync(executable), "Run with the frozen packaged Electron runtime");
assert.ok(process.versions.electron, "Packaged Electron ASAR support is required");
// Electron's patched fs treats app.asar itself as a virtual directory. Hash the
// raw archive with original-fs; keep normal ASAR support for all packaged imports.
const originalFs = (await import("original-fs")).default;
assert.equal(createHash("sha256").update(await originalFs.promises.readFile(appPath)).digest("hex"), expectedSha, "Frozen QA package changed");
await promisify(execFile)("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { timeout: 20000 });
const mainArgs = [`--ling-desktop-owned-qa-profile=${profilePath}`, `--user-data-dir=${resolve(profilePath, "user-data")}`];
const packaged = async name => import(pathToFileURL(resolve(appPath, `dist/main/${name}.js`)).href);
const { initializeDesktopQaLaunchProfile, readDesktopLaunchPackageMetadata } = await packaged("qa-launch-profile");
let userData;
const profile = initializeDesktopQaLaunchProfile({ argv: [executable, ...mainArgs], environment: process.env,
  packaged: true, packageMetadata: readDesktopLaunchPackageMetadata(appPath), applicationPath: appPath,
  userId: process.getuid(), getUserDataPath: () => userData, setUserDataPath: path => { userData = path; } });
assert.ok(profile);
const { resolveDesktopResourcePaths } = await packaged("resource-paths");
const { resolveDesktopCuaDriverPackagedStartupAuthority } = await packaged("cua-driver/packaged-startup");
const { DesktopDaemonLifecycle } = await packaged("daemon-lifecycle");
const resources = await resolveDesktopResourcePaths({ isPackaged: true, getAppPath: () => appPath }, resourcesRoot);
const authority = await resolveDesktopCuaDriverPackagedStartupAuthority({ packaged: true, appPath, resourcesPath: resourcesRoot, platform: process.platform });
assert.equal(authority.failure, undefined, "Actual package feature authority must validate; never disable its gate");
const bridgeToken = await readExistingPrivateToken(resolve(profile.userDataDir, "desktop-bridge-token"));
for (const port of [17928, 17930]) assert.equal(await listening(port), false, `QA port ${port} must be free; normally Quit the existing QA App first`);
const output = await mkdtemp(resolve(root, "output/e6-20260928/r02-dual-stream-transport-20261026/topology-"));
const records = [];
const state = { kind: "owned-packaged-backend-with-loopback-transport-relay", output,
  asarSha256: expectedSha, backendPort: 17930, relayPort: 17928,
  workspaceCwd: profile.workspaceCwd, profilePath, mainArgs,
  ownership: "QA supervisor owns backend; Main reuses authenticated relay; not Main-owned shutdown evidence",
  gateSource: "actual packaged authority", engineFdValidated: false, bridgeAuthenticated: false,
  bridgeTokenCreatedOrRotated: false, status: "starting", backendPid: null, desktopPid: null };
let relay, desktop, desktopExited = false, snapshot = 0;
const lifecycle = new DesktopDaemonLifecycle({ baseUrl: "http://127.0.0.1:17930", daemonEntryPath: resources.daemonEntryPath,
  defaultWorkspaceCwd: profile.workspaceCwd, desktopBridgeToken: bridgeToken, browserHostPath: resources.browserHostPath,
  packaged: true, executablePath: executable, engineSupervisorPath: resources.engineSupervisorPath,
  imageSanitizerPath: resources.imageSanitizerPath, cuaDriverFeatureFlags: authority.featureFlags,
  onDiagnostic(event, details = {}) {
    const entry = { at: new Date().toISOString(), event };
    for (const name of ["pid", "baseUrl", "code", "signal"]) if (details[name] !== undefined) entry[name] = details[name];
    records.push(entry);
    if (event === "daemon.spawned") state.backendPid = details.pid;
  },
});
const input = createInterface({ input: process.stdin });
try {
  const status = await lifecycle.ensureStarted();
  assert.equal(status.state, "connected"); assert.equal(status.ownedByDesktop, true);
  await lifecycle.getExecutionEngineAuthority(); // Consume the production FD3-bound receipt, never print it.
  state.engineFdValidated = true;
  relay = await createQaSseFaultRelay({ upstreamPort: 17930, port: 17928 });
  const handshake = await fetch("http://127.0.0.1:17928/computer-use/desktop-bridge/handshake", {
    headers: { "X-Ling-Desktop-Bridge-Token": bridgeToken }, signal: AbortSignal.timeout(5000) });
  assert.equal(handshake.status, 200);
  const response = await handshake.json();
  assert.equal(response.routeTokenAccepted, true);
  assert.equal(response.defaultWorkspaceCwd, profile.workspaceCwd);
  state.bridgeAuthenticated = true;
  desktop = spawn(executable, mainArgs, { cwd: profile.workspaceCwd, env: buildQaGuiEnvironment(process.env), stdio: "ignore" });
  state.desktopPid = desktop.pid;
  desktop.once("exit", (code, signal) => {
    desktopExited = true;
    state.desktopExit = { code, signal };
    records.push({ event: "qa-main-exited", code, signal, at: new Date().toISOString() });
  });
  desktop.once("error", () => { desktopExited = true; state.status = "main-spawn-failed"; });
  state.status = "backend-and-relay-ready-main-spawned-GUI-not-yet-observed";
  await save("startup");
  console.log(JSON.stringify({ ...state }));
  for await (const line of input) {
    const command = line.trim();
    try {
      if (command === "fault") { const cut = relay.disconnect(); await save("fault"); console.log(JSON.stringify({ command, cut, output })); }
      else if (command === "restore") { relay.restore(); await save("restore"); console.log(JSON.stringify({ command, output })); }
      else if (command === "inspect") { await save("inspect"); console.log(JSON.stringify({ command, desktopExited, backend: lifecycle.status,
        streams: relay.liveStreams(), recentTransport: relay.records.slice(-12), output })); }
      else if (command === "close") {
        assert.equal(desktopExited, true, "Normally Quit exact QA Main before closing its independently owned backend");
        break;
      } else throw new Error("Only inspect/fault/restore/close commands are supported");
    } catch (error) { console.log(JSON.stringify({ status: "command-rejected", message: error.message })); }
  }
  assert.equal(desktopExited, true, "Supervisor stdin closed while QA Main remains live; leave owned topology intact, do not kill Main");
  await relay.close();
  await lifecycle.stopOwnedDaemon();
  // An exit event is not proof of GUI Quit; keep code/signal and neutral wording.
  state.status = "main-exited-and-supervisor-owned-backend-stopped";
  await save("closed");
  console.log(JSON.stringify({ status: state.status, output }));
} catch (error) {
  process.exitCode = 1;
  state.status = "incomplete";
  state.error = { name: error.name, message: String(error.message).replace(/\bsk-[\w-]+/gu, "[redacted]") };
  if (!desktop || desktopExited) { await relay?.close(); await lifecycle.stopOwnedDaemon(); }
  await save("incomplete");
  console.log(JSON.stringify({ status: state.status, error: state.error, output, mainStillLive: !!desktop && !desktopExited }));
} finally { input.close(); }

async function save(label) {
  const body = JSON.stringify({ ...state, capturedAt: new Date().toISOString(), lifecycle: records, transport: relay?.records ?? [] }, null, 2) + "\n";
  if (/\bsk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9_.-]{12,}/u.test(body)) throw new Error("Private data refused");
  await writeFile(resolve(output, `${String(++snapshot).padStart(3, "0")}-${label}.json`), body, { flag: "wx", mode: 0o600 });
}
async function listening(port) {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1500);
    socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
    socket.once("error", error => { socket.destroy(); error.code === "ECONNREFUSED" ? resolvePromise(false) : reject(error); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error(`QA port ${port} state unknown`)); });
  });
}
