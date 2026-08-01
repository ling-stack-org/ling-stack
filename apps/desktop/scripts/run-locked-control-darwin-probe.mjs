import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  EmbeddedCuaDriverClient,
  LockedControlProbeFailure,
  assertPngToolResult,
  createFeasibilityEvidence,
  createInputFenceConfiguration,
  createManagedProviderEnvironment,
  extractStructuredContent,
  fenceProviderInput,
  hasProbeStatus,
  parseProbeAppEvent,
  readScreenshotCenter,
  readNativeSession,
  selectProbeButton,
  selectProbeWindow,
  sha256File,
} from "./locked-control-darwin-probe-core.mjs";

const execFile = promisify(execFileCallback);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultHelper = resolve(desktopRoot, "build/native/darwin-arm64/ling-locked-control-helper");
const defaultProbeExecutable = resolve(
  desktopRoot,
  "build/native/darwin-arm64/LingLockedControlProbe.app/Contents/MacOS/LingLockedControlProbe",
);
const DEFAULT_TRANSITION_TIMEOUT_MS = 180_000;
const TOOL_TIMEOUT_MS = 30_000;
const TARGET_SESSION = "ling-locked-control-attended-probe";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("locked_control_darwin_probe_requires_apple_silicon");
}

const options = parseOptions(process.argv.slice(2));
await assertExecutable(options.providerPath, "provider");
await assertExecutable(options.helperPath, "helper");
await assertExecutable(options.probeExecutable, "probe executable");

const temporaryRoot = await mkdtemp(resolve(
  desktopRoot,
  "build/native/darwin-arm64/locked-control-probe-",
));
const stateHome = join(temporaryRoot, "provider-state");
await mkdir(stateHome, { recursive: true, mode: 0o700 });
const probeNonce = randomBytes(32).toString("hex");
const childNonce = randomBytes(24).toString("hex");
const inputFence = await createInputFenceConfiguration(1);
const proofs = {
  sameUserSessionBound: false,
  captureReadyWhileLocked: false,
  inputAcknowledgedWhileLocked: false,
  secureSurfaceExcluded: false,
};
let lockObserved = false;
let provider;
let app;
let appObserver;
let startSession;
let evidence;
let failure;

try {
  startSession = await readNativeSession(options.helperPath);
  if (!startSession.sessionActive || startSession.sessionLocked) {
    throw new Error("locked_control_probe_requires_unlocked_active_session");
  }

  app = spawn(options.probeExecutable, [`--nonce=${probeNonce}`], {
    cwd: dirname(options.probeExecutable),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  appObserver = createProbeAppObserver(app, probeNonce);
  await appObserver.waitFor("ready", 10_000);

  provider = new EmbeddedCuaDriverClient({
    binaryPath: options.providerPath,
    cwd: stateHome,
    timeoutMs: TOOL_TIMEOUT_MS,
    environment: createManagedProviderEnvironment({
      baseEnvironment: process.env,
      stateHome,
      hostPid: process.pid,
      childNonce,
      inputFence,
    }),
  });
  await provider.start();
  await assertProviderPermissions(provider);
  await assertProviderToolSurface(provider);

  const window = await waitForProbeWindow(provider, app.pid, 10_000);
  const windowId = window.window_id;
  const preflight = await snapshotProbeWindow(
    provider,
    app.pid,
    windowId,
  );
  if (!selectProbeButton(preflight)) {
    const value = extractStructuredContent(preflight);
    const elementShape = Array.isArray(value?.elements)
      ? value.elements.map((element) => ({
          element_index: element?.element_index,
          role: element?.role,
          label: element?.label,
          title: element?.title,
          value: element?.value,
        }))
      : [];
    throw new Error(
      `locked_control_probe_target_accessibility_contract_missing:${JSON.stringify(elementShape)}`,
    );
  }

  emit({
    event: "awaiting_lock",
    instruction: "Press Control+Command+Q, keep the Mac locked for 30-60 seconds, then unlock it yourself.",
    timeoutSeconds: Math.floor(options.transitionTimeoutMs / 1_000),
  });

  const lockedSession = await waitForSessionState({
    helperPath: options.helperPath,
    expectedLocked: true,
    timeoutMs: options.transitionTimeoutMs,
  });
  lockObserved = true;
  emit({ event: "lock_observed" });

  if (lockedSession.sessionBindingDigest !== startSession.sessionBindingDigest) {
    throw new LockedControlProbeFailure(
      "locked_control_session_mismatch",
      "locked_control_probe_session_changed_at_lock",
    );
  }
  proofs.sameUserSessionBound = true;

  const lockedWindows = await provider.callTool("list_windows", { pid: app.pid });
  const lockedWindow = selectProbeWindow(lockedWindows, app.pid);
  if (!lockedWindow || lockedWindow.window_id !== windowId) {
    throw new LockedControlProbeFailure(
      "locked_control_secure_surface",
      "locked_control_probe_target_window_not_bound_while_locked",
    );
  }
  proofs.secureSurfaceExcluded = true;

  let lockedSnapshot;
  try {
    lockedSnapshot = await snapshotProbeWindow(
      provider,
      app.pid,
      windowId,
    );
  } catch (error) {
    throw new LockedControlProbeFailure(
      "locked_control_capture_unavailable",
      `locked_control_probe_locked_capture_failed:${error.message}`,
    );
  }
  proofs.captureReadyWhileLocked = true;

  const button = selectProbeButton(lockedSnapshot);
  const pixelCenter = button ? undefined : readScreenshotCenter(lockedSnapshot);
  if (!button && !pixelCenter) {
    throw new LockedControlProbeFailure(
      "locked_control_input_unavailable",
      "locked_control_probe_locked_input_target_missing",
    );
  }
  let actionError;
  try {
    await provider.callTool("click", {
      pid: app.pid,
      window_id: windowId,
      session: TARGET_SESSION,
      ...(button
        ? button.elementToken
          ? { element_token: button.elementToken }
          : { element_index: button.elementIndex }
          : { x: pixelCenter.x, y: pixelCenter.y }),
    });
  } catch (error) {
    actionError = error;
  }
  let receiptError;
  if (!actionError) {
    try {
      await appObserver.waitFor("input_acknowledged", 10_000, 1);
    } catch (error) {
      receiptError = error;
    }
  }
  let lockedAfterInput;
  let postSnapshotError;
  try {
    // The mandatory post-action snapshot runs even when dispatch or the app
    // receipt fails. A failed input attempt must not skip target-state proof.
    lockedAfterInput = await snapshotProbeWindow(
      provider,
      app.pid,
      windowId,
    );
  } catch (error) {
    postSnapshotError = error;
  }
  if (actionError || receiptError || postSnapshotError) {
    const diagnostic = actionError?.message
      ?? receiptError?.message
      ?? postSnapshotError?.message
      ?? "unknown";
    throw new LockedControlProbeFailure(
      "locked_control_input_unavailable",
      `locked_control_probe_locked_input_failed:${diagnostic}`,
    );
  }
  if (!hasProbeStatus(lockedAfterInput, "Acknowledged 1")) {
    throw new LockedControlProbeFailure(
      "locked_control_input_unavailable",
      "locked_control_probe_locked_input_not_visible_after_action",
    );
  }
  proofs.inputAcknowledgedWhileLocked = true;
  emit({ event: "locked_probe_complete", instruction: "Unlock the Mac yourself; no password input is automated." });

  const unlockedSession = await waitForSessionState({
    helperPath: options.helperPath,
    expectedLocked: false,
    expectedActive: true,
    timeoutMs: options.transitionTimeoutMs,
  });
  if (unlockedSession.sessionBindingDigest !== startSession.sessionBindingDigest) {
    throw new LockedControlProbeFailure(
      "locked_control_session_mismatch",
      "locked_control_probe_session_changed_at_unlock",
    );
  }

  const unlockedSnapshot = await snapshotProbeWindow(
    provider,
    app.pid,
    windowId,
  );
  if (!hasProbeStatus(unlockedSnapshot, "Acknowledged 1")) {
    throw new LockedControlProbeFailure(
      "locked_control_input_unavailable",
      "locked_control_probe_acknowledgement_not_retained_after_unlock",
    );
  }

  await fenceProviderInput(inputFence);
  const preDeniedSnapshot = await snapshotProbeWindow(
    provider,
    app.pid,
    windowId,
  );
  const deniedButton = selectProbeButton(preDeniedSnapshot);
  if (!deniedButton) throw new Error("locked_control_probe_post_fence_button_missing");
  const deniedResult = await provider.request("tools/call", {
    name: "click",
    arguments: {
      pid: app.pid,
      window_id: windowId,
      session: TARGET_SESSION,
      ...(deniedButton.elementToken
        ? { element_token: deniedButton.elementToken }
        : { element_index: deniedButton.elementIndex }),
    },
  });
  await delay(300);
  const postDeniedSnapshot = await snapshotProbeWindow(
    provider,
    app.pid,
    windowId,
  );
  if (deniedResult?.isError !== true
    || appObserver.latestSequence !== 1
    || !hasProbeStatus(postDeniedSnapshot, "Acknowledged 1")) {
    throw new Error("locked_control_probe_post_fence_input_not_denied");
  }

  evidence = await buildEvidence({ options, proofs });
  const evidencePath = await writeEvidence(options.evidenceDirectory, evidence);
  emit({ event: "probe_complete", result: evidence.result, evidencePath });
} catch (error) {
  failure = error;
  if (lockObserved) {
    if ((await readNativeSession(options.helperPath).catch(() => undefined))?.sessionLocked === true) {
      emit({
        event: "unlock_required_for_cleanup",
        instruction: "Unlock the Mac yourself; the probe never enters credentials.",
      });
      await waitForSessionState({
        helperPath: options.helperPath,
        expectedLocked: false,
        timeoutMs: options.transitionTimeoutMs,
      }).catch(() => undefined);
    }
    const reason = error instanceof LockedControlProbeFailure
      ? error.reason
      : inferFailureReason(proofs);
    evidence = await buildEvidence({ options, proofs, reason });
    const evidencePath = await writeEvidence(options.evidenceDirectory, evidence);
    emit({ event: "probe_complete", result: evidence.result, reason, evidencePath });
  }
} finally {
  await provider?.close().catch(() => undefined);
  await stopChild(app);
  await rm(temporaryRoot, { recursive: true, force: true });
}

if (failure) {
  const message = failure instanceof Error ? failure.message : String(failure);
  process.stderr.write(`Locked-control attended probe failed: ${message}\n`);
  process.exitCode = 1;
}

function parseOptions(args) {
  const values = new Map();
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(arg);
    if (!match) throw new Error(`locked_control_probe_argument_invalid:${arg}`);
    values.set(match[1], match[2]);
  }
  const providerPath = values.get("provider");
  if (!providerPath || !isAbsolute(providerPath)) {
    throw new Error("locked_control_probe_absolute_provider_required");
  }
  const helperPath = values.get("helper") ?? defaultHelper;
  const probeExecutable = values.get("probe-executable") ?? defaultProbeExecutable;
  const evidenceDirectory = values.get("evidence-directory")
    ?? resolve(desktopRoot, "test-results/locked-control-feasibility");
  const transitionTimeoutSeconds = Number(values.get("transition-timeout-seconds") ?? "180");
  if (!isAbsolute(helperPath) || !isAbsolute(probeExecutable) || !isAbsolute(evidenceDirectory)
    || !Number.isSafeInteger(transitionTimeoutSeconds)
    || transitionTimeoutSeconds < 30
    || transitionTimeoutSeconds > 600) {
    throw new Error("locked_control_probe_options_invalid");
  }
  return Object.freeze({
    providerPath,
    helperPath,
    probeExecutable,
    evidenceDirectory,
    transitionTimeoutMs: transitionTimeoutSeconds * 1_000,
  });
}

async function assertExecutable(path, label) {
  try {
    await access(path, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    throw new Error(`locked_control_probe_${label.replaceAll(" ", "_")}_not_executable:${path}`);
  }
}

async function assertProviderToolSurface(provider) {
  const result = await provider.request("tools/list", {});
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  const names = new Set(tools.map((tool) => tool?.name));
  for (const required of ["check_permissions", "list_windows", "get_window_state", "click"]) {
    if (!names.has(required)) {
      throw new Error(
        `locked_control_probe_provider_tool_missing:${required}:available=${JSON.stringify([...names].sort())}`
          + `:captureSchemas=${JSON.stringify(tools.filter((tool) =>
            tool?.name === "get_window_state" || tool?.name === "get_desktop_state"
          ).map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })))}`,
      );
    }
  }
}

async function assertProviderPermissions(provider) {
  const result = await provider.callTool("check_permissions", { prompt: false });
  const value = extractStructuredContent(result);
  if (value?.accessibility !== true
    || value?.screen_recording !== true
    || value?.screen_recording_capturable !== true) {
    throw new Error("locked_control_probe_embedded_provider_permissions_missing");
  }
}

async function waitForProbeWindow(provider, pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const window = selectProbeWindow(await provider.callTool("list_windows", { pid }), pid);
    if (window) return window;
    await delay(250);
  }
  throw new Error("locked_control_probe_window_not_found");
}

async function snapshotProbeWindow(provider, pid, windowId) {
  const state = await provider.callTool("get_window_state", {
    pid,
    window_id: windowId,
    session: TARGET_SESSION,
    include_screenshot: true,
  });
  assertPngToolResult(state);
  return state;
}

async function waitForSessionState({
  helperPath,
  expectedLocked,
  expectedActive,
  timeoutMs = DEFAULT_TRANSITION_TIMEOUT_MS,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await readNativeSession(helperPath);
    if (session.sessionLocked === expectedLocked
      && (expectedActive === undefined || session.sessionActive === expectedActive)) {
      return session;
    }
    await delay(1_000);
  }
  throw new Error(`locked_control_probe_session_transition_timeout:locked=${expectedLocked}`);
}

function createProbeAppObserver(child, expectedNonce) {
  let stdout = "";
  let stderr = "";
  const events = [];
  const waiters = new Set();
  let terminalError;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) {
        const event = parseProbeAppEvent(line, expectedNonce);
        if (event) events.push(event);
        else terminalError = new Error("locked_control_probe_app_output_invalid");
        notifyWaiters();
      }
      newline = stdout.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });
  child.once("error", (error) => {
    terminalError = error;
    notifyWaiters();
  });
  child.once("exit", (code, signal) => {
    if (!terminalError) {
      terminalError = new Error(
        `locked_control_probe_app_exited:code=${code ?? "none"}:signal=${signal ?? "none"}:${stderr}`,
      );
    }
    notifyWaiters();
  });

  function notifyWaiters() {
    for (const notify of waiters) notify();
  }

  return Object.freeze({
    get latestSequence() {
      return events.filter((event) => event.event === "input_acknowledged")
        .reduce((highest, event) => Math.max(highest, event.sequence), 0);
    },
    async waitFor(eventName, timeoutMs, sequence) {
      const find = () => events.find((event) => event.event === eventName
        && (sequence === undefined || event.sequence === sequence));
      const existing = find();
      if (existing) return existing;
      if (terminalError) throw terminalError;
      return await new Promise((resolveEvent, rejectEvent) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiters.delete(check);
          if (error) rejectEvent(error);
          else resolveEvent(value);
        };
        const check = () => {
          const event = find();
          if (event) finish(undefined, event);
          else if (terminalError) finish(terminalError);
        };
        const timer = setTimeout(
          () => finish(new Error(`locked_control_probe_app_event_timeout:${eventName}`)),
          timeoutMs,
        );
        timer.unref?.();
        waiters.add(check);
      });
    },
  });
}

async function buildEvidence({ options, proofs, reason }) {
  const [{ stdout: osVersion }, helperSha256, providerSha256] = await Promise.all([
    execFile("sw_vers", ["-productVersion"], { encoding: "utf8" }),
    sha256File(options.helperPath),
    sha256File(options.providerPath),
  ]);
  return createFeasibilityEvidence({
    proofs,
    ...(reason ? { reason } : {}),
    helperSha256,
    providerSha256,
    osVersion: osVersion.trim(),
  });
}

async function writeEvidence(directory, evidence) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const suffix = evidence.observedAt.replaceAll(":", "-");
  const path = join(directory, `darwin-${suffix}.json`);
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return path;
}

function inferFailureReason(proofs) {
  if (!proofs.sameUserSessionBound) return "locked_control_session_mismatch";
  if (!proofs.secureSurfaceExcluded) return "locked_control_secure_surface";
  if (!proofs.captureReadyWhileLocked) return "locked_control_capture_unavailable";
  return "locked_control_input_unavailable";
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    new Promise((resolveExit) => setTimeout(() => resolveExit(false), 1_000)),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
