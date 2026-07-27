#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  chmod,
  createReadStream,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs";
import { availableParallelism, arch, platform, release, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const accessAsync = promisify(access);
const appendFileAsync = promisify(appendFile);
const chmodAsync = promisify(chmod);
const lstatAsync = promisify(lstat);
const mkdirAsync = promisify(mkdir);
const mkdtempAsync = promisify(mkdtemp);
const readFileAsync = promisify(readFile);
const readdirAsync = promisify(readdir);
const rmAsync = promisify(rm);
const statAsync = promisify(stat);
const writeFileAsync = promisify(writeFile);

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "../../..");
const defaultAppExecutable = join(
  repositoryRoot,
  "apps/desktop/release/mac-arm64/Ling Stack.app/Contents/MacOS/Ling Stack",
);
const defaultArtifact = join(repositoryRoot, "apps/desktop/release/Ling Stack-0.0.0-arm64-mac.zip");
const supportedModes = new Set(["all", "install-restart", "lifecycle", "permissions", "recovery"]);
const MAC_WINDOW_DISCOVERY_INTERVAL_MS = 100;
const MAC_WINDOW_DISCOVERY_TIMEOUT_MS = 5_000;
const previewPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

class UncoveredError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "UncoveredError";
    this.details = details;
  }
}

class EvidenceError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "EvidenceError";
    this.details = details;
  }
}

class CdpClient {
  static async connect(url, timeoutMs) {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    await new Promise((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(() => rejectOpen(new Error(`CDP WebSocket open timed out after ${timeoutMs}ms`)), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolveOpen();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        rejectOpen(new Error("CDP WebSocket failed to open"));
      }, { once: true });
    });
    return new CdpClient(socket, timeoutMs);
  }

  constructor(socket, defaultTimeoutMs) {
    this.socket = socket;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => this.handleClose());
    socket.addEventListener("error", () => this.handleClose());
  }

  call(method, params = {}, timeoutMs = this.defaultTimeoutMs) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`CDP socket is not open for ${method}`));
    const id = this.nextId++;
    return new Promise((resolveCall, rejectCall) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolveCall, reject: rejectCall, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close();
  }

  handleMessage(data) {
    let message;
    try {
      const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`CDP ${pending.method} failed: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) {
      try {
        listener(message.params);
      } catch {
        // Evidence listeners must not break the CDP command channel.
      }
    }
  }

  handleClose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`CDP socket closed while waiting for ${pending.method}`));
    }
    this.pending.clear();
  }
}

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(helpText());
  process.exit(0);
}

const runRoot = await createRunRoot(options.outputRoot);
const userDataDirectory = join(runRoot, "user-data");
const inputDirectory = join(runRoot, "inputs");
const screenshotDirectory = join(runRoot, "screenshots");
const logDirectory = join(runRoot, "logs");
const reportPath = join(runRoot, "report.json");
const eventsPath = join(runRoot, "events.ndjson");
const workspaceDirectory = join(runRoot, "workspace");
const themesRoot = join(userDataDirectory, "themes");

await Promise.all([
  mkdirAsync(userDataDirectory, { recursive: true, mode: 0o700 }),
  mkdirAsync(inputDirectory, { recursive: true, mode: 0o700 }),
  mkdirAsync(screenshotDirectory, { recursive: true, mode: 0o700 }),
  mkdirAsync(logDirectory, { recursive: true, mode: 0o700 }),
  mkdirAsync(workspaceDirectory, { recursive: true, mode: 0o700 }),
]);

const startedAt = new Date().toISOString();
const report = {
  schemaVersion: 1,
  harness: "P7CD-T09",
  status: "running",
  mode: options.mode,
  dryRun: options.dryRun,
  startedAt,
  endedAt: undefined,
  durationMs: undefined,
  repositoryRoot,
  runRoot,
  userDataDirectory,
  app: {},
  host: {},
  fixtures: {},
  launches: [],
  steps: [],
  runtimeErrors: [],
  summary: {},
};
let eventWrite = Promise.resolve();
let activeSession;

await emit({
  type: "run-start",
  harness: report.harness,
  mode: options.mode,
  dryRun: options.dryRun,
  runRoot,
  userDataDirectory,
});

try {
  await runStep("T09-00", "Inspect packaged candidate and isolated runtime", async () => {
    report.app = await inspectApplication(options.appExecutable, options.artifact);
    report.host = await inspectHost();
    assert(report.app.executableArch === "arm64", `Expected an arm64 executable, received ${report.app.executableArch}`);
    assert(platform() === "darwin" && arch() === "arm64", "The P7CD-T09 gate requires real Apple Silicon macOS");
    return {
      executable: report.app.executable,
      version: report.app.version,
      executableSha256: report.app.executableSha256,
      artifact: report.app.artifact,
      artifactSha256: report.app.artifactSha256,
      os: report.host.osVersion,
      architecture: report.host.architecture,
    };
  });

  await runStep("T09-01", "Generate deterministic theme package fixtures", async () => {
    report.fixtures = await createFixtures();
    return report.fixtures;
  });

  if (options.dryRun) {
    await runStep("T09-DRY", "Validate dry-run plan without launching the app", async () => ({
      mode: options.mode,
      plannedStages: plannedStages(options.mode),
      ports: "allocated per launch",
      profilePolicy: "isolated temporary userData only",
      productionWrites: false,
    }));
  } else {
    await executeMode(options.mode);
  }
} catch (error) {
  report.runtimeErrors.push(serializeError(error));
  await emit({ type: "run-error", error: serializeError(error) });
} finally {
  if (activeSession) {
    await closeApplication(activeSession, { requiredGraceful: false }).catch(async (error) => {
      report.runtimeErrors.push(serializeError(error));
      await emit({ type: "cleanup-error", error: serializeError(error) });
    });
    activeSession = undefined;
  }
  await restoreRepositoryPermissions().catch(async (error) => {
    report.runtimeErrors.push(serializeError(error));
    await emit({ type: "permission-restore-error", error: serializeError(error) });
  });
  const endedAt = new Date().toISOString();
  const counts = countStepStatuses(report.steps);
  const launchRuntimeErrors = report.launches.flatMap((launch) => launch.runtimeErrors ?? []);
  const blockingLaunchRuntimeErrors = launchRuntimeErrors.filter(isBlockingLaunchRuntimeError);
  report.endedAt = endedAt;
  report.durationMs = Date.parse(endedAt) - Date.parse(startedAt);
  report.summary = {
    ...counts,
    total: report.steps.length,
    runtimeErrorCount: report.runtimeErrors.length + launchRuntimeErrors.length,
    blockingRuntimeErrorCount: report.runtimeErrors.length + blockingLaunchRuntimeErrors.length,
    nonBlockingRuntimeErrorCount: launchRuntimeErrors.length - blockingLaunchRuntimeErrors.length,
    gatePassed: counts.failed === 0
      && counts.uncovered === 0
      && report.runtimeErrors.length === 0
      && blockingLaunchRuntimeErrors.length === 0,
    typedUncovered: report.steps
      .filter((step) => step.status === "uncovered")
      .map((step) => ({ id: step.id, reason: step.error?.message ?? "uncovered" })),
  };
  report.status = report.summary.gatePassed
    ? "passed"
    : counts.failed > 0 || report.summary.blockingRuntimeErrorCount > 0
      ? "failed"
      : "uncovered";
  await writeFileAsync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await emit({
    type: "run-complete",
    status: report.status,
    summary: report.summary,
    reportPath,
  });
  await eventWrite;
}

process.stdout.write(`${JSON.stringify({
  type: "result",
  status: report.status,
  reportPath,
  runRoot,
  summary: report.summary,
})}\n`);

if (report.status === "failed") process.exitCode = 1;
if (report.status === "uncovered" && !options.allowUncovered) process.exitCode = 2;

async function executeMode(mode) {
  const needsLifecycle = mode === "all" || mode === "install-restart" || mode === "lifecycle";
  const needsPermissions = mode === "all" || mode === "permissions";
  const needsRecovery = mode === "all" || mode === "recovery";

  const setup = await runStep("T09-02", "Launch packaged app with isolated userData and initialize deterministic locale", async () => {
    activeSession = await launchApplication("initial");
    await initializeFreshProfile(activeSession);
    await openInterfacePreferences(activeSession);
    return {
      launchId: activeSession.launchId,
      targetUrl: activeSession.target.url,
      cdpPort: activeSession.cdpPort,
      daemonPort: activeSession.daemonPort,
      theme: await readThemeState(activeSession),
    };
  });
  if (setup.status !== "passed") {
    await recordSkipped("T09-RUNTIME", "Packaged lifecycle stages", "Initial packaged app setup failed");
    return;
  }

  let primaryInstalled = false;
  if (needsLifecycle) {
    primaryInstalled = await lifecycleInstallRestart(mode);
  }

  if (needsPermissions) {
    await permissionFailureMatrix();
  }

  if (needsRecovery) {
    await recoveryMatrix();
  }

  if (mode === "all" || mode === "lifecycle") {
    if (primaryInstalled) {
      await activeDeleteLifecycle();
    } else {
      await recordSkipped("T09-13", "Active delete fallback and restart", "Primary lifecycle did not complete");
    }
  }

  await runStep("T09-99", "Gracefully close final packaged app session", async () => {
    if (!activeSession) return { alreadyClosed: true };
    const closed = await closeApplication(activeSession, { requiredGraceful: true });
    activeSession = undefined;
    return closed;
  });
}

async function lifecycleInstallRestart(mode) {
  const installed = await runStep("T09-03", "Install and activate local theme through Settings UI", async () => {
    await openInterfacePreferences(activeSession);
    await importThemeThroughUi(activeSession, report.fixtures.primaryInitial.path, {
      expectedName: report.fixtures.primaryInitial.name,
      useAfterImport: true,
    });
    await waitForTheme(activeSession, report.fixtures.primaryInitial.id);
    await waitForPersistedSelection(activeSession, report.fixtures.primaryInitial.id);
    const native = await inspectNativePackage(report.fixtures.primaryInitial.id);
    const bootstrap = await desktopBootstrap(activeSession);
    assertReadyDescriptor(bootstrap, report.fixtures.primaryInitial.id, report.fixtures.primaryInitial.name);
    return { native, bootstrap, theme: await readThemeState(activeSession) };
  });
  if (installed.status !== "passed") return false;

  const restarted = await restartAndVerify({
    id: "T09-04",
    label: "Graceful quit and restart preserves active theme on the first observed frames",
    launchLabel: "after-install",
    expectedThemeId: report.fixtures.primaryInitial.id,
    expectedPackageName: report.fixtures.primaryInitial.name,
  });
  if (restarted.status !== "passed") return false;

  await runStep("T09-05", "Read and preview installed package through Settings UI", async () => {
    await openInterfacePreferences(activeSession);
    const preview = await previewInstalledTheme(activeSession, report.fixtures.primaryInitial.name, "installed-primary");
    const read = await desktopRead(activeSession, report.fixtures.primaryInitial.id);
    assert(read.ok === true, `Desktop read failed: ${JSON.stringify(read)}`);
    assert(read.previewByteLength > 0, "Desktop read did not return preview bytes");
    return { preview, read };
  });

  if (mode === "install-restart") return true;

  const reimported = await runStep("T09-06", "Same-ID reimport preserves installation identity through Settings UI", async () => {
    const before = await inspectNativePackage(report.fixtures.primaryInitial.id);
    await reimportThemeThroughUi(
      activeSession,
      report.fixtures.primaryInitial.name,
      report.fixtures.primaryUpdated.path,
      report.fixtures.primaryUpdated.name,
    );
    const after = await inspectNativePackage(report.fixtures.primaryUpdated.id);
    assert(after.installation.installedAt === before.installation.installedAt, "same-ID reimport changed installedAt");
    assert(after.installation.updatedAt !== before.installation.updatedAt, "same-ID reimport did not change updatedAt");
    assert(after.manifest.name === report.fixtures.primaryUpdated.name, "same-ID reimport did not publish the new manifest");
    await waitForPersistedSelection(activeSession, report.fixtures.primaryUpdated.id);
    return { before, after };
  });
  if (reimported.status !== "passed") return false;

  const reimportRestart = await restartAndVerify({
    id: "T09-07",
    label: "Restart restores the same-ID reimported theme and first-frame tokens",
    launchLabel: "after-reimport",
    expectedThemeId: report.fixtures.primaryUpdated.id,
    expectedPackageName: report.fixtures.primaryUpdated.name,
  });
  if (reimportRestart.status !== "passed") return false;

  const inactiveDeleted = await runStep("T09-08", "Install then permanently delete an inactive theme through Settings UI", async () => {
    await openInterfacePreferences(activeSession);
    await importThemeThroughUi(activeSession, report.fixtures.inactive.path, {
      expectedName: report.fixtures.inactive.name,
      useAfterImport: false,
    });
    assert((await readThemeState(activeSession)).themeId === report.fixtures.primaryUpdated.id, "Inactive install changed the active theme");
    const installedNative = await inspectNativePackage(report.fixtures.inactive.id);
    await deleteThemeThroughUi(activeSession, report.fixtures.inactive.name);
    await expectPathAbsent(join(themesRoot, report.fixtures.inactive.id));
    const bootstrap = await desktopBootstrap(activeSession);
    assert(!findDescriptor(bootstrap, report.fixtures.inactive.id), "Deleted inactive theme remains in native bootstrap");
    return { installedNative, bootstrap };
  });
  if (inactiveDeleted.status !== "passed") return false;

  const inactiveRestart = await restartAndVerify({
    id: "T09-09",
    label: "Restart keeps the inactive theme deleted",
    launchLabel: "after-inactive-delete",
    expectedThemeId: report.fixtures.primaryUpdated.id,
    expectedPackageName: report.fixtures.primaryUpdated.name,
    absentThemeId: report.fixtures.inactive.id,
  });
  return inactiveRestart.status === "passed";
}

async function permissionFailureMatrix() {
  await runStep("T09-10A", "Controlled candidate write permission failure returns a typed result", async () => {
    await ensureRepositoryRoots();
    const stagingRoot = join(themesRoot, ".staging");
    await chmodAsync(stagingRoot, 0o500);
    let result;
    try {
      result = await desktopInstall(activeSession, report.fixtures.writeFailure);
    } finally {
      await chmodAsync(stagingRoot, 0o700);
    }
    if (result?.ok === true) {
      await deleteInstalledFaultTheme(report.fixtures.writeFailure.id);
      throw new UncoveredError("POSIX mode injection did not block staging writes", { result });
    }
    assert(result?.error?.code === "permission_denied", `Expected permission_denied, received ${JSON.stringify(result)}`);
    await expectPathAbsent(join(themesRoot, report.fixtures.writeFailure.id));
    return { injection: { path: ".staging", mode: "0500" }, result };
  });

  await runStep("T09-10B", "Controlled final rename permission failure returns a typed result", async () => {
    await ensureRepositoryRoots();
    await chmodAsync(themesRoot, 0o500);
    let result;
    try {
      result = await desktopInstall(activeSession, report.fixtures.renameFailure);
    } finally {
      await chmodAsync(themesRoot, 0o700);
    }
    if (result?.ok === true) {
      await deleteInstalledFaultTheme(report.fixtures.renameFailure.id);
      throw new UncoveredError("POSIX mode injection did not block final publication rename", { result });
    }
    assert(result?.error?.code === "permission_denied", `Expected permission_denied, received ${JSON.stringify(result)}`);
    await expectPathAbsent(join(themesRoot, report.fixtures.renameFailure.id));
    const stagingEntries = await listNames(join(themesRoot, ".staging"));
    return { injection: { path: ".", mode: "0500", stagingMode: "0700" }, result, stagingEntries };
  });
}

async function recoveryMatrix() {
  await runStep("T09-11A", "Inject abandoned staging only while the packaged app is closed", async () => {
    if (activeSession) {
      const closed = await closeApplication(activeSession, { requiredGraceful: true });
      activeSession = undefined;
      assert(closed.graceful, "App did not close gracefully before staging injection");
    }
    await ensureRepositoryRoots();
    const abandonedPath = join(themesRoot, ".staging", "harness-abandoned-staging");
    await mkdirAsync(abandonedPath, { recursive: true, mode: 0o700 });
    await writeFileAsync(join(abandonedPath, "partial.bin"), "partial", { mode: 0o600 });
    return { abandonedPath, existsBeforeRestart: await pathExists(abandonedPath) };
  });

  const stagingRestart = await runStep("T09-11B", "Startup removes abandoned staging without exposing a package", async () => {
    activeSession = await launchApplication("after-abandoned-staging");
    const launchEvidence = await captureLaunchEvidence(activeSession, "after-abandoned-staging", currentExpectedThemeId());
    await openInterfacePreferences(activeSession);
    const abandonedPath = join(themesRoot, ".staging", "harness-abandoned-staging");
    await expectPathAbsent(abandonedPath);
    const bootstrap = await desktopBootstrap(activeSession);
    return { launchEvidence, bootstrap, abandonedRemoved: true };
  });
  if (stagingRestart.status !== "passed") return;

  const installedCorrupt = await runStep("T09-12A", "Install and persist the future corrupt-theme selection through Settings UI", async () => {
    await openInterfacePreferences(activeSession);
    await importThemeThroughUi(activeSession, report.fixtures.corrupt.path, {
      expectedName: report.fixtures.corrupt.name,
      useAfterImport: true,
    });
    await waitForTheme(activeSession, report.fixtures.corrupt.id);
    await waitForPersistedSelection(activeSession, report.fixtures.corrupt.id);
    const native = await inspectNativePackage(report.fixtures.corrupt.id);
    return { native, theme: await readThemeState(activeSession) };
  });
  if (installedCorrupt.status !== "passed") {
    await recordSkipped("T09-12B", "Corrupt final startup recovery and first-frame fallback", "Corrupt fixture setup failed");
    return;
  }

  await runStep("T09-12B", "Corrupt final is retained for repair and falls back without a stale first frame", async () => {
    const closed = await closeApplication(activeSession, { requiredGraceful: true });
    activeSession = undefined;
    assert(closed.graceful, "App did not close gracefully before corrupt-final injection");
    const manifestPath = join(themesRoot, report.fixtures.corrupt.id, "theme.json");
    await writeFileAsync(manifestPath, "{}\n", { mode: 0o600 });
    const corruptHash = await sha256File(manifestPath);
    activeSession = await launchApplication("after-corrupt-final");
    const launchEvidence = await captureLaunchEvidence(activeSession, "after-corrupt-final", "ling-light");
    await waitForTheme(activeSession, "ling-light");
    await openInterfacePreferences(activeSession);
    const repairVisible = await waitForExpression(
      activeSession,
      `Boolean(document.querySelector('[data-theme-repair-kind="corrupt"]')) && document.querySelector('[data-theme-repair-kind="corrupt"]').textContent.includes(${json(report.fixtures.corrupt.id)})`,
      "corrupt repair owner",
    );
    const bootstrap = await desktopBootstrap(activeSession);
    const descriptor = findDescriptor(bootstrap, report.fixtures.corrupt.id);
    assert(descriptor?.health === "corrupt", `Expected corrupt descriptor, received ${JSON.stringify(descriptor)}`);
    assert(await pathExists(join(themesRoot, report.fixtures.corrupt.id)), "Corrupt final was deleted instead of retained");
    if (!launchEvidence.stable) {
      throw new EvidenceError(
        `First-frame theme transitioned: ${JSON.stringify(launchEvidence.transitions)}`,
        { closed, corruptHash, launchEvidence, repairVisible, descriptor, corruptFinalRetained: true },
      );
    }
    return { closed, corruptHash, launchEvidence, repairVisible, descriptor };
  });
}

async function activeDeleteLifecycle() {
  await runStep("T09-13A", "Active theme delete switches to built-in before native deletion", async () => {
    await openInterfacePreferences(activeSession);
    await selectTheme(activeSession, report.fixtures.primaryUpdated.id);
    await waitForPersistedSelection(activeSession, report.fixtures.primaryUpdated.id);
    await deleteThemeThroughUi(activeSession, report.fixtures.primaryUpdated.name);
    await waitForTheme(activeSession, "ling-light");
    await waitForPersistedSelection(activeSession, "ling-light");
    await expectPathAbsent(join(themesRoot, report.fixtures.primaryUpdated.id));
    const bootstrap = await desktopBootstrap(activeSession);
    assert(!findDescriptor(bootstrap, report.fixtures.primaryUpdated.id), "Active theme remains in repository after UI delete");
    return { bootstrap, theme: await readThemeState(activeSession) };
  });

  await restartAndVerify({
    id: "T09-13B",
    label: "Restart preserves built-in fallback after active theme deletion",
    launchLabel: "after-active-delete",
    expectedThemeId: "ling-light",
    absentThemeId: report.fixtures.primaryUpdated.id,
  });
}

async function restartAndVerify({
  id,
  label,
  launchLabel,
  expectedThemeId,
  expectedPackageName,
  absentThemeId,
}) {
  return runStep(id, label, async () => {
    const closed = await closeApplication(activeSession, { requiredGraceful: true });
    activeSession = undefined;
    assert(closed.graceful, "Packaged app did not complete graceful shutdown");
    activeSession = await launchApplication(launchLabel);
    const launchEvidence = await captureLaunchEvidence(activeSession, launchLabel, expectedThemeId);
    assert(launchEvidence.stable, `First observed theme was not stable: ${JSON.stringify(launchEvidence.transitions)}`);
    await waitForTheme(activeSession, expectedThemeId);
    await openInterfacePreferences(activeSession);
    const bootstrap = await desktopBootstrap(activeSession);
    if (expectedPackageName) assertReadyDescriptor(bootstrap, expectedThemeId, expectedPackageName);
    if (absentThemeId) assert(!findDescriptor(bootstrap, absentThemeId), `${absentThemeId} returned after restart`);
    return { closed, launchEvidence, bootstrap };
  });
}

async function launchApplication(label) {
  const cdpPort = await availablePort();
  const daemonPort = await availablePort();
  const launchId = `${String(report.launches.length + 1).padStart(2, "0")}-${safeName(label)}`;
  const stdoutPath = join(logDirectory, `${launchId}.stdout.log`);
  const stderrPath = join(logDirectory, `${launchId}.stderr.log`);
  await Promise.all([
    writeFileAsync(stdoutPath, "", { mode: 0o600 }),
    writeFileAsync(stderrPath, "", { mode: 0o600 }),
  ]);
  const args = [
    `--user-data-dir=${userDataDirectory}`,
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${cdpPort}`,
    "--no-first-run",
  ];
  const child = spawn(options.appExecutable, args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      LING_STACK_DAEMON_URL: `http://127.0.0.1:${daemonPort}`,
      LING_STACK_DEFAULT_WORKSPACE_CWD: workspaceDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const launchedAtMs = Date.now();
  const exit = deferred();
  const runtimeErrors = [];
  const logWrites = [];
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = boundedAppend(stdout, chunk);
    logWrites.push(appendFileAsync(stdoutPath, String(chunk), { mode: 0o600 }).catch((error) => {
      runtimeErrors.push({ type: "harness-log-write", value: serializeError(error) });
    }));
  });
  child.stderr.on("data", (chunk) => {
    stderr = boundedAppend(stderr, chunk);
    logWrites.push(appendFileAsync(stderrPath, String(chunk), { mode: 0o600 }).catch((error) => {
      runtimeErrors.push({ type: "harness-log-write", value: serializeError(error) });
    }));
  });
  child.once("error", (error) => exit.reject(error));
  child.once("close", (exitCode, signal) => exit.resolve({ exitCode, signal, exitedAt: new Date().toISOString() }));

  let target;
  let cdp;
  try {
    target = await waitForPageTarget(cdpPort, options.launchTimeoutMs, child, exit.promise);
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl, options.commandTimeoutMs);
    await Promise.all([
      cdp.call("Page.enable"),
      cdp.call("Runtime.enable"),
      cdp.call("DOM.enable"),
      cdp.call("Log.enable").catch(() => undefined),
    ]);
  } catch (error) {
    child.kill("SIGTERM");
    await Promise.race([exit.promise.catch(() => undefined), delay(2_000)]);
    await Promise.all(logWrites);
    throw new Error(`Packaged app launch failed for ${label}: ${serializeError(error).message}\n${stdout}\n${stderr}`);
  }

  cdp.on("Runtime.exceptionThrown", (event) => runtimeErrors.push({ type: "exception", value: event }));
  cdp.on("Log.entryAdded", (event) => {
    if (event?.entry?.level === "error") runtimeErrors.push({ type: "log", value: event.entry });
  });
  const launchRecord = {
    launchId,
    label,
    pid: child.pid,
    args,
    cdpPort,
    daemonPort,
    startedAt: new Date(launchedAtMs).toISOString(),
    target: { id: target.id, title: target.title, type: target.type, url: target.url },
    stdoutPath,
    stderrPath,
    exit: undefined,
    runtimeErrors,
  };
  report.launches.push(launchRecord);
  await emit({ type: "launch", ...launchRecord, args: undefined, runtimeErrors: undefined });
  return {
    launchId,
    child,
    cdp,
    cdpPort,
    daemonPort,
    exit,
    launchRecord,
    launchedAtMs,
    logWrites,
    target,
    runtimeErrors,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function closeApplication(session, { requiredGraceful }) {
  if (!session || session.exit.settled) return { alreadyExited: true, graceful: true, exit: session?.exit.value };
  const requestedAt = Date.now();
  let browserCloseAccepted = false;
  try {
    await session.cdp.call("Browser.close", {}, Math.min(options.commandTimeoutMs, 5_000));
    browserCloseAccepted = true;
  } catch (error) {
    if (!isSocketCloseError(error)) throw error;
    browserCloseAccepted = true;
  }
  let exitResult = await Promise.race([
    session.exit.promise,
    delay(options.shutdownTimeoutMs).then(() => undefined),
  ]);
  let forcedSignal;
  if (!exitResult) {
    forcedSignal = "SIGTERM";
    session.child.kill("SIGTERM");
    exitResult = await Promise.race([
      session.exit.promise,
      delay(5_000).then(() => undefined),
    ]);
  }
  if (!exitResult) {
    forcedSignal = "SIGKILL";
    session.child.kill("SIGKILL");
    exitResult = await session.exit.promise;
  }
  session.cdp.close();
  await Promise.all(session.logWrites);
  session.launchRecord.exit = exitResult;
  session.launchRecord.runtimeErrors = session.runtimeErrors;
  const graceful = browserCloseAccepted && !forcedSignal && exitResult?.exitCode === 0;
  const result = {
    graceful,
    browserCloseAccepted,
    forcedSignal,
    shutdownMs: Date.now() - requestedAt,
    exit: exitResult,
  };
  await emit({ type: "launch-exit", launchId: session.launchId, ...result });
  if (requiredGraceful && !graceful) throw new Error(`Graceful packaged shutdown failed: ${JSON.stringify(result)}`);
  return result;
}

async function captureLaunchEvidence(session, label, expectedThemeId) {
  const sampling = sampleThemeTransitions(session, options.firstFrameSampleMs);
  const first = await captureScreenshot(session, `${label}-first-observed`);
  await waitForExpression(session, "document.querySelector('#root')?.childElementCount > 0", `${label} React root`);
  const reactReady = await captureScreenshot(session, `${label}-react-ready`);
  const transitions = await sampling;
  const firstThemeId = transitions[0]?.themeId ?? first.theme.themeId;
  const stable = transitions.length === 1
    && firstThemeId === expectedThemeId
    && transitions[0]?.themeId === expectedThemeId;
  const result = {
    expectedThemeId,
    firstThemeId,
    stable,
    transitions,
    screenshot: first,
    reactReadyScreenshot: reactReady,
    spawnToCaptureMs: Date.now() - session.launchedAtMs,
  };
  await emit({ type: "first-frame", launchId: session.launchId, label, ...result });
  return result;
}

async function sampleThemeTransitions(session, durationMs) {
  const started = Date.now();
  const samples = [];
  while (Date.now() - started < durationMs) {
    let state;
    try {
      state = await readThemeState(session);
    } catch {
      await delay(20);
      continue;
    }
    const previous = samples.at(-1);
    if (!previous || previous.themeId !== state.themeId || previous.appBackground !== state.appBackground) {
      samples.push({
        offsetMs: Date.now() - started,
        themeId: state.themeId,
        appBackground: state.appBackground,
        rootChildCount: state.rootChildCount,
      });
    }
    await delay(25);
  }
  return samples;
}

async function captureScreenshot(session, name) {
  const safe = safeName(name);
  const contentPath = join(screenshotDirectory, `${safe}-content.png`);
  const data = await session.cdp.call("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFileAsync(contentPath, Buffer.from(data.data, "base64"), { mode: 0o600 });
  const theme = await readThemeState(session);
  const result = {
    contentPath,
    contentSha256: await sha256File(contentPath),
    theme,
    windowPath: undefined,
    windowSha256: undefined,
    windowCapture: "failed",
    windowIdentity: undefined,
  };
  if (platform() !== "darwin") {
    throw new EvidenceError("Window-level evidence requires macOS CoreGraphics", result);
  }
  try {
    const windowIdentity = await resolvePackagedMacWindow(session);
    const windowPath = join(screenshotDirectory, `${safe}-window.png`);
    const command = await runCommand("screencapture", [
      "-x",
      "-o",
      `-l${windowIdentity.windowId}`,
      windowPath,
    ], { timeoutMs: 15_000 });
    assert(command.exitCode === 0, `screencapture failed: ${command.stderr.trim() || `exit-${command.exitCode}`}`);
    assert(await pathExists(windowPath), "screencapture did not create the Ling Stack window image");
    const dimensions = await readPngDimensions(windowPath);
    assertWindowScreenshotDimensions(dimensions, windowIdentity.bounds);
    const confirmedIdentity = await resolvePackagedMacWindow(session, { refresh: true });
    assert(
      confirmedIdentity.windowId === windowIdentity.windowId,
      `Ling Stack window identity changed during capture: ${windowIdentity.windowId} -> ${confirmedIdentity.windowId}`,
    );
    result.windowPath = windowPath;
    result.windowSha256 = await sha256File(windowPath);
    result.windowCapture = "passed";
    result.windowIdentity = { ...windowIdentity, pngDimensions: dimensions };
  } catch (error) {
    result.windowCapture = "failed";
    throw new EvidenceError(
      `Precise Ling Stack window capture failed for PID ${session.child.pid}: ${serializeError(error).message}`,
      { ...result, ownerPid: session.child.pid, cause: serializeError(error) },
    );
  }
  return result;
}

async function resolvePackagedMacWindow(session, { refresh = false } = {}) {
  if (!refresh && session.macWindowIdentity) return session.macWindowIdentity;
  const expectedPid = Number(session.child.pid);
  assert(Number.isSafeInteger(expectedPid) && expectedPid > 0, `Invalid packaged app PID: ${session.child.pid}`);
  const startedAt = Date.now();
  const timeoutMs = Math.min(options.commandTimeoutMs, MAC_WINDOW_DISCOVERY_TIMEOUT_MS);
  let windows = [];
  let candidates = [];
  const jxaSource = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
const expectedPid = ${expectedPid};
const raw = $.CGWindowListCopyWindowInfo(17, 0);
const count = Number($.CFArrayGetCount(raw));
const windows = [];
for (let index = 0; index < count; index += 1) {
  const item = ObjC.deepUnwrap(ObjC.castRefToObject($.CFArrayGetValueAtIndex(raw, index)));
  if (Number(item.kCGWindowOwnerPID) !== expectedPid) continue;
  const bounds = item.kCGWindowBounds || {};
  windows.push({
    windowId: Number(item.kCGWindowNumber ?? -1),
    ownerPid: Number(item.kCGWindowOwnerPID ?? -1),
    ownerName: String(item.kCGWindowOwnerName || ''),
    title: String(item.kCGWindowName || ''),
    layer: Number(item.kCGWindowLayer ?? -1),
    onScreen: item.kCGWindowIsOnscreen === true,
    alpha: Number(item.kCGWindowAlpha ?? 0),
    bounds: {
      x: Number(bounds.X ?? -1),
      y: Number(bounds.Y ?? -1),
      width: Number(bounds.Width ?? -1),
      height: Number(bounds.Height ?? -1),
    },
  });
}
JSON.stringify(windows);
`;
  do {
    const command = await runCommand("osascript", ["-l", "JavaScript", "-e", jxaSource], { timeoutMs: 10_000 });
    assert(command.exitCode === 0, `CoreGraphics window query failed: ${command.stderr.trim() || `exit-${command.exitCode}`}`);
    try {
      windows = JSON.parse(command.stdout || "[]");
    } catch (error) {
      throw new Error(`CoreGraphics window query returned invalid JSON: ${serializeError(error).message}`);
    }
    candidates = windows.filter((window) => (
      window.windowId > 0
      && window.ownerPid === expectedPid
      && window.ownerName === "Ling Stack"
      && window.title === "Ling Stack"
      && window.layer === 0
      && window.onScreen === true
      && window.alpha > 0
      && window.bounds?.width >= 980
      && window.bounds?.height >= 680
      && [window.bounds.x, window.bounds.y, window.bounds.width, window.bounds.height].every(Number.isFinite)
    ));
    if (candidates.length === 1) break;
    if (session.exit.settled || Date.now() - startedAt >= timeoutMs) break;
    await delay(MAC_WINDOW_DISCOVERY_INTERVAL_MS);
  } while (true);
  assert(
    candidates.length === 1,
    `Expected exactly one confirmed Ling Stack window for PID ${expectedPid} within ${Date.now() - startedAt}ms, found ${candidates.length}: ${JSON.stringify(windows)}`,
  );
  const identity = Object.freeze(candidates[0]);
  if (!refresh) session.macWindowIdentity = identity;
  return identity;
}

async function readPngDimensions(path) {
  const bytes = await readFileAsync(path);
  assert(bytes.byteLength >= 24, `PNG evidence is truncated: ${path}`);
  assert(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `Evidence is not PNG: ${path}`);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function assertWindowScreenshotDimensions(dimensions, bounds) {
  assert(dimensions.width >= bounds.width && dimensions.height >= bounds.height, (
    `Window screenshot is smaller than CoreGraphics bounds: ${JSON.stringify({ dimensions, bounds })}`
  ));
  const pngRatio = dimensions.width / dimensions.height;
  const boundsRatio = bounds.width / bounds.height;
  assert(Math.abs(pngRatio - boundsRatio) <= 0.03, (
    `Window screenshot aspect ratio does not match CoreGraphics bounds: ${JSON.stringify({ dimensions, bounds })}`
  ));
}

async function initializeFreshProfile(session) {
  await waitForExpression(session, "document.readyState === 'complete' && Boolean(document.documentElement)", "initial document");
  await evaluate(session, `(() => {
    localStorage.setItem('ling-stack.locale', 'en-US');
    const selection = { mode: 'fixed', themeId: 'ling-light' };
    localStorage.setItem('ling-stack.themeSelection', JSON.stringify(selection));
    localStorage.setItem('ling-stack.themeBootstrapSelection', JSON.stringify(selection));
    localStorage.removeItem('ling-stack.themeBootstrapSnapshot');
    localStorage.setItem('ling-stack.themeBootstrapPreference', 'light');
    return true;
  })()`);
  await session.cdp.call("Page.reload", { ignoreCache: true });
  await waitForExpression(session, "document.readyState === 'complete' && document.documentElement.dataset.uiTheme === 'ling-light'", "fresh profile reload");
  await waitForDesktopRepository(session);
}

async function openInterfacePreferences(session) {
  if (await evaluate(session, "Boolean(document.querySelector('[data-ui2-interface-preferences]'))")) return;
  await clickLabeled(session, ["Settings", "设置"], { selector: "button,[role='button']" });
  await waitForExpression(
    session,
    "Boolean(document.querySelector('[aria-label=\"Settings sections\"], [aria-label=\"设置分组\"]'))",
    "Settings sections navigation",
  );
  await clickLabeled(session, ["Interface preferences", "界面偏好"], {
    rootSelector: "[aria-label='Settings sections'],[aria-label='设置分组']",
    selector: "button,[role='button']",
  });
  await waitForExpression(session, "Boolean(document.querySelector('[data-ui2-interface-preferences]'))", "Interface preferences panel");
  await waitForExpression(
    session,
    "Boolean(document.querySelector('[data-ui2-interface-preferences] button:not([disabled])'))",
    "Interface preferences controls",
  );
}

async function importThemeThroughUi(session, archivePath, { expectedName, useAfterImport }) {
  await waitForLabeledControlReady(session, ["Import theme", "导入主题"], {
    rootSelector: "[data-ui2-interface-preferences]",
    selector: "button",
  });
  await clickLabeled(session, ["Import theme", "导入主题"], {
    rootSelector: "[data-ui2-interface-preferences]",
    selector: "button",
  });
  await waitForExpression(session, "Boolean(document.querySelector('[data-ui2-theme-import-dialog]'))", "Import theme dialog");
  await setDialogFile(session, archivePath);
  await waitForExpression(
    session,
    `document.querySelector('[data-ui2-theme-import-dialog]')?.textContent.includes(${json(expectedName)}) === true`,
    `theme review ${expectedName}`,
  );
  if (useAfterImport) {
    await evaluate(session, `(() => {
      const input = document.querySelector('[data-ui2-theme-import-dialog] input[type="checkbox"]');
      if (!input) throw new Error('use-after-import checkbox missing');
      if (!input.checked) input.click();
      return input.checked;
    })()`);
  }
  await clickLabeled(session, ["Import theme", "导入主题"], {
    rootSelector: "[data-ui2-theme-import-dialog]",
    selector: "button",
  });
  await waitForExpression(session, "!document.querySelector('[data-ui2-theme-import-dialog]')", "Import dialog close");
  await waitForExpression(
    session,
    `Boolean([...document.querySelectorAll('[data-theme-option-id]')].find((node) => node.textContent.includes(${json(expectedName)})))`,
    `installed option ${expectedName}`,
  );
}

async function reimportThemeThroughUi(session, currentName, archivePath, expectedName) {
  await openThemeActions(session, currentName);
  await clickLabeled(session, ["Reimport", "重新导入"], { selector: "[role='menuitem']" });
  await waitForExpression(session, "Boolean(document.querySelector('[data-ui2-theme-import-dialog]'))", "Reimport dialog");
  await setDialogFile(session, archivePath);
  await waitForExpression(
    session,
    `document.querySelector('[data-ui2-theme-import-dialog]')?.textContent.includes(${json(expectedName)}) === true`,
    `reimport review ${expectedName}`,
  );
  await clickLabeled(session, ["Reimport theme", "重新导入主题"], {
    rootSelector: "[data-ui2-theme-import-dialog]",
    selector: "button",
  });
  await waitForExpression(session, "!document.querySelector('[data-ui2-theme-import-dialog]')", "Reimport dialog close");
  await waitForExpression(
    session,
    `Boolean([...document.querySelectorAll('[data-theme-option-id]')].find((node) => node.textContent.includes(${json(expectedName)})))`,
    `reimported option ${expectedName}`,
  );
}

async function previewInstalledTheme(session, themeName, evidenceName) {
  await openThemeActions(session, themeName);
  await clickLabeled(session, ["Preview", "预览"], { selector: "[role='menuitem']" });
  await waitForExpression(
    session,
    "Boolean(document.querySelector('[data-ui2-theme-preview-dialog] [data-theme-preview-fixture]'))",
    "installed theme preview",
  );
  const hasArtwork = await evaluate(
    session,
    "Boolean(document.querySelector('[data-ui2-theme-preview-dialog] img.ling-ui-theme-preview-artwork'))",
  );
  assert(hasArtwork, "Installed preview did not render the native preview image");
  const screenshot = await captureScreenshot(session, evidenceName);
  await clickLabeled(session, ["Close", "关闭"], {
    rootSelector: "[data-ui2-theme-preview-dialog] .ling-ui-dialog-footer",
    selector: "button",
  });
  await waitForExpression(session, "!document.querySelector('[data-ui2-theme-preview-dialog]')", "Preview dialog close");
  return { hasArtwork, screenshot };
}

async function deleteThemeThroughUi(session, themeName) {
  await openThemeActions(session, themeName);
  await clickLabeled(session, ["Delete", "删除"], { selector: "[role='menuitem']" });
  await waitForExpression(session, "Boolean(document.querySelector('[data-ui2-theme-delete-dialog]'))", "Delete theme dialog");
  await clickLabeled(session, ["Delete theme", "删除主题"], {
    rootSelector: "[data-ui2-theme-delete-dialog]",
    selector: "button",
  });
  await waitForExpression(session, "!document.querySelector('[data-ui2-theme-delete-dialog]')", "Delete theme dialog close");
  await waitForExpression(
    session,
    `![...document.querySelectorAll('[data-theme-option-id]')].some((node) => node.textContent.includes(${json(themeName)}))`,
    `theme removal ${themeName}`,
  );
}

async function selectTheme(session, themeId) {
  await clickSelector(session, `[data-theme-option-id=${cssString(themeId)}]`);
  await waitForTheme(session, themeId);
}

async function openThemeActions(session, themeName) {
  const exact = `Theme actions for ${themeName}`;
  const target = await evaluate(session, `(() => {
    const candidates = [...document.querySelectorAll('button[aria-label]')];
    const target = candidates.find((node) => node.getAttribute('aria-label') === ${json(exact)})
      || candidates.find((node) => node.getAttribute('aria-label')?.includes(${json(themeName)}));
    if (!target) return undefined;
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert(target, `Theme action trigger missing for ${themeName}`);
  await session.cdp.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: target.x,
    y: target.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await session.cdp.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: target.x,
    y: target.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await waitForExpression(session, "Boolean(document.querySelector('[role=menu]'))", `theme actions menu ${themeName}`);
}

async function setDialogFile(session, archivePath) {
  const document = await session.cdp.call("DOM.getDocument", { depth: 2, pierce: true });
  const query = await session.cdp.call("DOM.querySelector", {
    nodeId: document.root.nodeId,
    selector: "[data-ui2-theme-import-dialog] input[type=file]",
  });
  assert(query.nodeId, "Theme package file input was not found");
  await session.cdp.call("DOM.setFileInputFiles", { files: [archivePath], nodeId: query.nodeId });
}

async function clickLabeled(session, labels, { selector, rootSelector = "" }) {
  await waitForLabeledControlReady(session, labels, { rootSelector, selector });
  const result = await evaluate(session, `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const labels = ${json(labels)};
    const root = ${rootSelector ? `document.querySelector(${json(rootSelector)})` : "document"};
    if (!root) return { ok: false, reason: 'root-missing' };
    const candidates = [...root.querySelectorAll(${json(selector)})];
    const target = candidates.find((node) => {
      const aria = normalize(node.getAttribute('aria-label'));
      const text = normalize(node.textContent);
      return labels.includes(aria) || labels.includes(text);
    });
    if (!target) return { ok: false, reason: 'target-missing', candidates: candidates.slice(0, 30).map((node) => ({ aria: node.getAttribute('aria-label'), text: normalize(node.textContent) })) };
    if (target.disabled || target.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled' };
    target.click();
    return { ok: true, aria: target.getAttribute('aria-label'), text: normalize(target.textContent) };
  })()`);
  assert(result?.ok, `Unable to click ${labels.join("/")}: ${JSON.stringify(result)}`);
  return result;
}

async function waitForLabeledControlReady(
  session,
  labels,
  { selector, rootSelector = "", timeoutMs = options.operationTimeoutMs },
) {
  const started = Date.now();
  let lastSnapshot;
  while (Date.now() - started < timeoutMs) {
    lastSnapshot = await evaluate(session, `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const labels = ${json(labels)};
      const root = ${rootSelector ? `document.querySelector(${json(rootSelector)})` : "document"};
      if (!root) return { ready: false, reason: 'root-missing' };
      const describe = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const aria = normalize(node.getAttribute('aria-label'));
        const text = normalize(node.textContent);
        const disabled = Boolean(node.disabled) || node.getAttribute('aria-disabled') === 'true';
        const busy = node.getAttribute('aria-busy') === 'true';
        const visible = node.isConnected
          && rect.width > 0
          && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
        return {
          aria,
          text,
          disabled,
          busy,
          visible,
          connected: node.isConnected,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      };
      const candidates = [...root.querySelectorAll(${json(selector)})];
      const target = candidates.find((node) => {
        const aria = normalize(node.getAttribute('aria-label'));
        const text = normalize(node.textContent);
        return labels.includes(aria) || labels.includes(text);
      });
      if (!target) {
        return {
          ready: false,
          reason: 'target-missing',
          candidates: candidates.slice(0, 30).map(describe),
        };
      }
      const targetState = describe(target);
      return {
        ready: targetState.visible && !targetState.disabled && !targetState.busy,
        reason: !targetState.visible ? 'not-visible' : targetState.disabled ? 'disabled' : targetState.busy ? 'busy' : 'ready',
        target: targetState,
        candidates: candidates.slice(0, 30).map(describe),
      };
    })()`);
    if (lastSnapshot?.ready) return lastSnapshot;
    await delay(25);
  }
  throw new Error(
    `Timed out waiting for enabled control ${labels.join("/")} after ${Date.now() - started}ms: `
      + `${JSON.stringify({ rootSelector: rootSelector || "document", selector, lastSnapshot })}`,
  );
}

async function clickSelector(session, selector) {
  const result = await evaluate(session, `(() => {
    const target = document.querySelector(${json(selector)});
    if (!target) return { ok: false, reason: 'target-missing' };
    if (target.disabled || target.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled' };
    target.click();
    return { ok: true };
  })()`);
  assert(result?.ok, `Unable to click selector ${selector}: ${JSON.stringify(result)}`);
}

async function waitForTheme(session, expectedThemeId) {
  await waitForExpression(
    session,
    `document.documentElement.dataset.uiTheme === ${json(expectedThemeId)}`,
    `theme ${expectedThemeId}`,
  );
  return readThemeState(session);
}

async function waitForPersistedSelection(session, themeId) {
  await waitForExpression(session, `(() => {
    const selection = JSON.parse(localStorage.getItem('ling-stack.themeSelection') || 'null');
    const bootstrapSelection = JSON.parse(localStorage.getItem('ling-stack.themeBootstrapSelection') || 'null');
    const snapshot = JSON.parse(localStorage.getItem('ling-stack.themeBootstrapSnapshot') || 'null');
    return selection?.mode === 'fixed' && selection.themeId === ${json(themeId)}
      && bootstrapSelection?.mode === 'fixed' && bootstrapSelection.themeId === ${json(themeId)}
      && (${json(themeId)}.startsWith('ling-') || snapshot?.themeId === ${json(themeId)});
  })()`, `persisted theme selection ${themeId}`);
  await delay(options.persistenceSettleMs);
}

async function readThemeState(session) {
  return evaluate(session, `(() => ({
    themeId: document.documentElement.dataset.uiTheme,
    colorScheme: document.documentElement.dataset.colorScheme,
    presentation: document.documentElement.dataset.uiPresentation,
    appBackground: getComputedStyle(document.documentElement).getPropertyValue('--ling-bg-app').trim(),
    rootChildCount: document.querySelector('#root')?.childElementCount || 0,
    readyState: document.readyState,
    selection: (() => { try { return JSON.parse(localStorage.getItem('ling-stack.themeSelection') || 'null'); } catch { return null; } })(),
    bootstrapSelection: (() => { try { return JSON.parse(localStorage.getItem('ling-stack.themeBootstrapSelection') || 'null'); } catch { return null; } })(),
    bootstrapSnapshotThemeId: (() => { try { return JSON.parse(localStorage.getItem('ling-stack.themeBootstrapSnapshot') || 'null')?.themeId; } catch { return undefined; } })(),
  }))()`);
}

async function waitForDesktopRepository(session) {
  await waitForExpression(
    session,
    "Boolean(window.lingDesktop?.themePackages?.bootstrap)",
    "Desktop Theme Package capability",
  );
  await waitForExpression(session, `window.lingDesktop.themePackages.bootstrap().then((result) => result.ok)`, "Desktop repository bootstrap");
}

async function desktopBootstrap(session) {
  return evaluate(session, `window.lingDesktop.themePackages.bootstrap()`);
}

async function desktopRead(session, themeId) {
  return evaluate(session, `window.lingDesktop.themePackages.read({ themeId: ${json(themeId)}, includePreviewBytes: true }).then((result) => result.ok ? ({
    ok: true,
    descriptor: result.value.descriptor,
    licenseText: result.value.licenseText,
    previewByteLength: result.value.previewBytes?.byteLength || 0,
    warnings: result.warnings,
  }) : result)`);
}

async function desktopInstall(session, fixture) {
  const bytes = await readFileAsync(fixture.path);
  const base64 = bytes.toString("base64");
  const checksum = sha256Bytes(bytes);
  return evaluate(session, `(() => {
    const raw = atob(${json(base64)});
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return window.lingDesktop.themePackages.install({
      requestId: ${json(`harness-${fixture.id}-${randomUUID()}`)},
      originalFileName: ${json(basename(fixture.path))},
      archiveBytes: bytes.buffer,
      rendererPackageChecksumSha256: ${json(checksum)},
    });
  })()`, { timeoutMs: options.operationTimeoutMs });
}

async function deleteInstalledFaultTheme(themeId) {
  const bootstrap = await desktopBootstrap(activeSession);
  const descriptor = findDescriptor(bootstrap, themeId);
  if (!descriptor) return;
  await evaluate(activeSession, `window.lingDesktop.themePackages.delete({
    requestId: ${json(`harness-cleanup-${randomUUID()}`)},
    themeId: ${json(themeId)},
    expectedCurrentChecksumSha256: ${json(descriptor.packageChecksumSha256)},
    expectedRecordRevision: ${Number(descriptor.recordRevision)},
  })`);
}

async function inspectNativePackage(themeId) {
  const packagePath = join(themesRoot, themeId);
  const info = await lstatAsync(packagePath);
  assert(info.isDirectory() && !info.isSymbolicLink(), `${themeId} native path is not a safe directory`);
  const installationPath = join(packagePath, "installation.json");
  const manifestPath = join(packagePath, "theme.json");
  const installation = JSON.parse(await readFileAsync(installationPath, "utf8"));
  const manifest = JSON.parse(await readFileAsync(manifestPath, "utf8"));
  assert(installation.themeId === themeId, `installation theme ID mismatch for ${themeId}`);
  assert(manifest.id === themeId, `manifest theme ID mismatch for ${themeId}`);
  const files = await listTree(packagePath);
  return {
    themeId,
    packagePath,
    directoryMode: `0${(info.mode & 0o777).toString(8)}`,
    installation,
    manifest,
    files,
    installationSha256: await sha256File(installationPath),
    manifestSha256: await sha256File(manifestPath),
  };
}

async function ensureRepositoryRoots() {
  for (const path of [themesRoot, join(themesRoot, ".staging"), join(themesRoot, ".rollback"), join(themesRoot, ".trash")]) {
    const info = await lstatAsync(path);
    assert(info.isDirectory() && !info.isSymbolicLink(), `Unsafe or missing repository root ${path}`);
  }
}

async function restoreRepositoryPermissions() {
  for (const path of [themesRoot, join(themesRoot, ".staging"), join(themesRoot, ".rollback"), join(themesRoot, ".trash")]) {
    if (await pathExists(path)) await chmodAsync(path, 0o700);
  }
}

async function createFixtures() {
  const {
    importedManifest,
    themePackageFixture,
  } = await import("../../../packages/ui-react/test/fixtures/theme-package-fixtures.mjs");
  const definitions = [
    { key: "primaryInitial", id: "packaged-smoke", name: "Packaged Smoke", appBackground: "#edf5f1" },
    { key: "primaryUpdated", id: "packaged-smoke", name: "Packaged Smoke Refined", appBackground: "#e1efe8" },
    { key: "inactive", id: "inactive-smoke", name: "Inactive Smoke", appBackground: "#f3f0e8" },
    { key: "corrupt", id: "corrupt-smoke", name: "Corrupt Smoke", appBackground: "#ece8f3" },
    { key: "writeFailure", id: "write-failure-smoke", name: "Write Failure Smoke", appBackground: "#f2ece8" },
    { key: "renameFailure", id: "rename-failure-smoke", name: "Rename Failure Smoke", appBackground: "#e8edf2" },
  ];
  const result = {};
  for (const definition of definitions) {
    const manifest = importedManifest({
      id: definition.id,
      familyId: definition.id,
      name: definition.name,
      author: "Ling P7CD Harness",
      license: "MIT",
      preview: "assets/preview.png",
    });
    manifest.tokens.background.app = definition.appBackground;
    const bytes = themePackageFixture({
      manifest,
      license: "MIT License",
      preview: { path: "assets/preview.png", bytes: previewPng, compression: "deflate" },
    });
    const path = join(inputDirectory, `${definition.id}-${definition.key}.ling-theme`);
    await writeFileAsync(path, bytes, { mode: 0o600 });
    result[definition.key] = {
      id: definition.id,
      name: definition.name,
      path,
      byteLength: bytes.byteLength,
      sha256: sha256Bytes(bytes),
      appBackground: definition.appBackground,
    };
  }
  return result;
}

async function inspectApplication(executable, artifact) {
  const executableInfo = await statAsync(executable);
  assert(executableInfo.isFile(), `Packaged executable is missing: ${executable}`);
  const appRoot = resolve(executable, "../../..");
  const plistPath = join(appRoot, "Contents/Info.plist");
  const asarPath = join(appRoot, "Contents/Resources/app.asar");
  const fileResult = await runCommand("file", [executable], { timeoutMs: 10_000 });
  assert(fileResult.exitCode === 0, `Unable to inspect executable architecture: ${fileResult.stderr}`);
  const executableArch = fileResult.stdout.includes("arm64") ? "arm64" : fileResult.stdout.includes("x86_64") ? "x64" : "unknown";
  const versionResult = await runCommand("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plistPath], { timeoutMs: 10_000 });
  const bundleIdResult = await runCommand("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plistPath], { timeoutMs: 10_000 });
  const commitResult = await runCommand("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, timeoutMs: 10_000 });
  const dirtyResult = await runCommand("git", ["status", "--short"], { cwd: repositoryRoot, timeoutMs: 10_000 });
  const artifactExists = await pathExists(artifact);
  return {
    executable,
    appRoot,
    version: versionResult.exitCode === 0 ? versionResult.stdout.trim() : "unknown",
    bundleId: bundleIdResult.exitCode === 0 ? bundleIdResult.stdout.trim() : "unknown",
    executableArch,
    executableByteLength: executableInfo.size,
    executableSha256: await sha256File(executable),
    appAsarSha256: await sha256File(asarPath),
    artifact: artifactExists ? artifact : undefined,
    artifactByteLength: artifactExists ? (await statAsync(artifact)).size : undefined,
    artifactSha256: artifactExists ? await sha256File(artifact) : undefined,
    commit: commitResult.exitCode === 0 ? commitResult.stdout.trim() : "unknown",
    worktreeDirty: dirtyResult.stdout.trim().length > 0,
    worktreeChangeCount: dirtyResult.stdout.trim() ? dirtyResult.stdout.trim().split(/\r?\n/u).length : 0,
    fileDescription: fileResult.stdout.trim(),
  };
}

async function inspectHost() {
  const swVers = platform() === "darwin"
    ? await runCommand("sw_vers", [], { timeoutMs: 10_000 })
    : { exitCode: 1, stdout: "", stderr: "not macOS" };
  return {
    platform: platform(),
    architecture: arch(),
    kernelRelease: release(),
    cpuParallelism: availableParallelism(),
    osVersion: swVers.exitCode === 0 ? swVers.stdout.trim().replace(/\r?\n/gu, "; ") : "unknown",
    nodeVersion: process.version,
  };
}

async function runStep(id, name, operation) {
  const startedAt = new Date().toISOString();
  const step = { id, name, status: "running", startedAt, endedAt: undefined, durationMs: undefined, details: undefined, error: undefined };
  report.steps.push(step);
  await emit({ type: "step-start", id, name, startedAt });
  try {
    step.details = await operation();
    step.status = "passed";
  } catch (error) {
    step.status = error instanceof UncoveredError ? "uncovered" : "failed";
    step.error = serializeError(error);
    if (error && typeof error === "object" && "details" in error) step.details = error.details;
  }
  step.endedAt = new Date().toISOString();
  step.durationMs = Date.parse(step.endedAt) - Date.parse(step.startedAt);
  await emit({ type: "step-complete", ...step });
  return step;
}

async function recordSkipped(id, name, reason) {
  const now = new Date().toISOString();
  const step = { id, name, status: "skipped", startedAt: now, endedAt: now, durationMs: 0, details: { reason } };
  report.steps.push(step);
  await emit({ type: "step-complete", ...step });
  return step;
}

async function emit(event) {
  const record = { at: new Date().toISOString(), ...event };
  const line = `${JSON.stringify(record)}\n`;
  process.stdout.write(line);
  eventWrite = eventWrite.then(() => appendFileAsync(eventsPath, line, { mode: 0o600 }));
  await eventWrite;
}

async function evaluate(session, expression, { timeoutMs = options.commandTimeoutMs } = {}) {
  const result = await session.cdp.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? "CDP Runtime.evaluate failed";
    throw new Error(description);
  }
  return result.result?.value;
}

async function waitForExpression(session, expression, label, timeoutMs = options.operationTimeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await evaluate(session, expression, { timeoutMs: Math.min(options.commandTimeoutMs, 5_000) });
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${serializeError(lastError).message}` : ""}`);
}

async function waitForPageTarget(port, timeoutMs, child, exitPromise) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    const exited = await Promise.race([exitPromise.then((value) => ({ exited: true, value })), delay(0).then(() => ({ exited: false }))]);
    if (exited.exited) throw new Error(`Packaged app exited before CDP target: ${JSON.stringify(exited.value)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        headers: { connection: "close" },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
        if (target) return target;
      }
    } catch (error) {
      lastError = error;
    }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Packaged app exited before CDP target (${child.exitCode ?? child.signalCode})`);
    await delay(50);
  }
  throw new Error(`Timed out waiting for CDP page target on ${port}: ${serializeError(lastError).message}`);
}

async function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) rejectPort(error);
        else if (!port) rejectPort(new Error("Unable to allocate a local port"));
        else resolvePort(port);
      });
    });
  });
}

async function runCommand(command, args, { cwd = repositoryRoot, timeoutMs = 30_000 } = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = boundedAppend(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk); });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectCommand(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolveCommand({ exitCode, signal, stdout, stderr });
    });
  });
}

async function listTree(root, prefix = "") {
  const entries = [];
  for (const name of (await readdirAsync(root)).sort()) {
    const absolute = join(root, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const info = await lstatAsync(absolute);
    if (info.isSymbolicLink()) {
      entries.push({ path: relative, type: "symlink" });
    } else if (info.isDirectory()) {
      entries.push({ path: `${relative}/`, type: "directory", mode: `0${(info.mode & 0o777).toString(8)}` });
      entries.push(...await listTree(absolute, relative));
    } else {
      entries.push({
        path: relative,
        type: "file",
        byteLength: info.size,
        mode: `0${(info.mode & 0o777).toString(8)}`,
        sha256: await sha256File(absolute),
      });
    }
  }
  return entries;
}

async function listNames(path) {
  try {
    return (await readdirAsync(path)).sort();
  } catch (error) {
    if (readCode(error) === "ENOENT") return [];
    throw error;
  }
}

async function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertReadyDescriptor(bootstrap, themeId, expectedName) {
  assert(bootstrap?.ok === true, `Desktop bootstrap failed: ${JSON.stringify(bootstrap)}`);
  const descriptor = findDescriptor(bootstrap, themeId);
  assert(descriptor?.health === "ready", `Theme ${themeId} is not ready: ${JSON.stringify(descriptor)}`);
  assert(descriptor?.manifest?.name === expectedName, `Theme ${themeId} expected name ${expectedName}, received ${descriptor?.manifest?.name}`);
}

function findDescriptor(bootstrap, themeId) {
  return bootstrap?.ok ? bootstrap.value.packages.find((entry) => entry.themeId === themeId) : undefined;
}

function currentExpectedThemeId() {
  const primaryStep = report.steps.find((step) => step.id === "T09-03" && step.status === "passed");
  return primaryStep ? report.fixtures.primaryUpdated.id : "ling-light";
}

function plannedStages(mode) {
  return {
    base: ["packaged candidate", "fixture generation", "isolated app launch", "locale/theme setup"],
    lifecycle: mode === "all" || mode === "install-restart" || mode === "lifecycle",
    permissions: mode === "all" || mode === "permissions",
    recovery: mode === "all" || mode === "recovery",
    activeDelete: mode === "all" || mode === "lifecycle",
  };
}

function countStepStatuses(steps) {
  const counts = { passed: 0, failed: 0, uncovered: 0, skipped: 0 };
  for (const step of steps) {
    if (step.status in counts) counts[step.status] += 1;
  }
  return counts;
}

function isBlockingLaunchRuntimeError(entry) {
  const value = entry?.value;
  const knownUnrelatedPackagedAsset = entry?.type === "log"
    && value?.source === "network"
    && value?.level === "error"
    && value?.text === "Failed to load resource: net::ERR_FILE_NOT_FOUND"
    && typeof value?.url === "string"
    && /^file:\/\/(?:\/)?(?:avatars\/|icons\/)/u.test(value.url);
  return !knownUnrelatedPackagedAsset;
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const state = { settled: false, value: undefined };
  const promise = new Promise((resolveDeferred, rejectDeferred) => {
    resolvePromise = (value) => {
      state.settled = true;
      state.value = value;
      resolveDeferred(value);
    };
    rejectPromise = (error) => {
      state.settled = true;
      rejectDeferred(error);
    };
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    get settled() { return state.settled; },
    get value() { return state.value; },
  };
}

function parseArguments(args) {
  const parsed = {
    allowUncovered: false,
    appExecutable: defaultAppExecutable,
    artifact: defaultArtifact,
    commandTimeoutMs: 15_000,
    dryRun: false,
    firstFrameSampleMs: 2_000,
    help: false,
    launchTimeoutMs: 60_000,
    mode: "all",
    operationTimeoutMs: 30_000,
    outputRoot: undefined,
    persistenceSettleMs: 1_500,
    shutdownTimeoutMs: 30_000,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const [flag, inlineValue] = argument.split("=", 2);
    const value = () => inlineValue ?? args[++index];
    if (flag === "--help" || flag === "-h") parsed.help = true;
    else if (flag === "--dry-run") parsed.dryRun = true;
    else if (flag === "--allow-uncovered") parsed.allowUncovered = true;
    else if (flag === "--app") parsed.appExecutable = resolve(requiredValue(flag, value()));
    else if (flag === "--artifact") parsed.artifact = resolve(requiredValue(flag, value()));
    else if (flag === "--output") parsed.outputRoot = resolve(requiredValue(flag, value()));
    else if (flag === "--mode" || flag === "--only") parsed.mode = requiredValue(flag, value());
    else if (flag === "--launch-timeout-ms") parsed.launchTimeoutMs = positiveInteger(flag, value());
    else if (flag === "--operation-timeout-ms") parsed.operationTimeoutMs = positiveInteger(flag, value());
    else if (flag === "--shutdown-timeout-ms") parsed.shutdownTimeoutMs = positiveInteger(flag, value());
    else if (flag === "--persistence-settle-ms") parsed.persistenceSettleMs = positiveInteger(flag, value());
    else if (flag === "--first-frame-sample-ms") parsed.firstFrameSampleMs = positiveInteger(flag, value());
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!supportedModes.has(parsed.mode)) throw new Error(`Unsupported mode ${parsed.mode}. Expected ${[...supportedModes].join(", ")}`);
  return parsed;
}

function helpText() {
  return `P7CD-T09 packaged macOS Theme Package persistence smoke\n\nUsage:\n  node apps/desktop/tests/run-theme-package-persistence-smoke.mjs [options]\n\nOptions:\n  --mode <all|install-restart|lifecycle|permissions|recovery>\n  --only <mode>                 Alias for --mode\n  --app <path>                  Packaged arm64 executable\n  --artifact <path>             ZIP/DMG candidate whose SHA-256 is recorded\n  --output <directory>          Parent for a new isolated run directory\n  --dry-run                     Inspect/generate fixtures without launching\n  --allow-uncovered             Exit 0 when only typed uncovered steps remain\n  --launch-timeout-ms <number>\n  --operation-timeout-ms <number>\n  --shutdown-timeout-ms <number>\n  --persistence-settle-ms <number>\n  --first-frame-sample-ms <number>\n  --help\n\nThe harness always creates a fresh userData directory under its run directory.\nIt never accepts or reuses a real Electron profile. Reports, logs, inputs, and\nscreenshots remain in the run directory for audit.\n`;
}

async function createRunRoot(outputRoot) {
  const parent = outputRoot ?? tmpdir();
  await mkdirAsync(parent, { recursive: true, mode: 0o700 });
  return mkdtempAsync(join(parent, "ling-theme-package-persistence-"));
}

function positiveInteger(flag, value) {
  const parsed = Number(requiredValue(flag, value));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

function requiredValue(flag, value) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function serializeError(error) {
  if (!error) return { name: "Error", message: "Unknown error" };
  if (error instanceof Error) return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(readCode(error) ? { code: readCode(error) } : {}),
  };
  return { name: "Error", message: String(error) };
}

function readCode(error) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function pathExists(path) {
  try {
    await accessAsync(path);
    return true;
  } catch (error) {
    if (readCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function expectPathAbsent(path) {
  assert(!await pathExists(path), `Expected path to be absent: ${path}`);
}

function boundedAppend(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return next.length <= 200_000 ? next : next.slice(-200_000);
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 100) || "evidence";
}

function json(value) {
  return JSON.stringify(value);
}

function cssString(value) {
  return JSON.stringify(value);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isSocketCloseError(error) {
  return /socket (?:closed|is not open)|WebSocket|Target closed/iu.test(serializeError(error).message);
}
