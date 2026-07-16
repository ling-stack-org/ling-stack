import electronPath from "electron";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseExactWindowsProviderTarget,
  parseWindowsProviderHealthReport,
} from "./windows-provider-smoke-support.mjs";

const TARGET_CLOSE_REQUEST_MARKER = "Ling Stack Desktop Windows provider current target close requested";
const DESKTOP_REVISION_A_LIVE_MARKER = "Ling Stack Desktop Windows provider descriptor A live";
const DESKTOP_REVISION_B_LIVE_MARKER = "Ling Stack Desktop Windows provider descriptor B live";
const OLD_TARGET_ISOLATED_MARKER = "Ling Stack Desktop Windows provider old target close isolated";
const RESTART_REQUESTED_MARKER = "Ling Stack Desktop Windows provider restart requested";
const DESCRIPTOR_REPLAY_LIVE_MARKER = "Ling Stack Desktop Windows provider descriptor replay live";
const STALLED_RUNTIME_RUNNING_MARKER = "Ling Stack Desktop Windows provider stalled runtime still running";
const SUCCESS_MARKER = "Ling Stack Desktop Windows provider capture lifecycle passed";
const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));

if (process.platform !== "win32") {
  console.log(
    "SKIP: Windows provider Computer Use smoke requires an unlocked interactive win32 desktop; " +
    "the direct electronSourceId smoke is separate evidence.",
  );
} else {
  try {
    await runWindowsProviderSmoke();
  } catch (error) {
    console.error(
      "Windows provider Computer Use smoke failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }
}

async function runWindowsProviderSmoke() {
  const targetAUserDataDirectory = await mkdtemp(join(tmpdir(), "ling-windows-provider-target-a-"));
  const targetBUserDataDirectory = await mkdtemp(join(tmpdir(), "ling-windows-provider-target-b-"));
  const desktopUserDataDirectory = await mkdtemp(join(tmpdir(), "ling-windows-provider-desktop-"));
  let targetA;
  let targetB;
  let desktop;
  try {
    const providerCommand = await resolveProviderCommand();
    const health = await readProviderHealth(providerCommand);
    process.stdout.write(`Windows provider health passed (${health.driverVersion})\n`);

    targetA = await startTarget("A", targetAUserDataDirectory);
    targetB = await startTarget("B", targetBUserDataDirectory);
    const [targetAIdentity, targetBIdentity] = await Promise.all([
      waitForExactProviderTarget(providerCommand, targetA.child.pid, 15_000),
      waitForExactProviderTarget(providerCommand, targetB.child.pid, 15_000),
    ]);
    assertIndependentProviderTargets(targetAIdentity, targetBIdentity);
    const daemonPort = await availablePort();
    const packagedExecutable = process.env.LING_DESKTOP_SMOKE_EXECUTABLE?.trim();
    const startDesktop = (descriptor, restartPhase = false) => observeChild(spawn(
      packagedExecutable || electronPath,
      [
        ...(packagedExecutable ? [] : [desktopRoot]),
        "--ling-desktop-smoke-headless",
        "--ling-desktop-windows-provider-capture-smoke",
        ...(restartPhase ? ["--ling-desktop-windows-provider-capture-restart-phase"] : [
          "--ling-desktop-windows-provider-capture-restart-smoke",
        ]),
        `--user-data-dir=${desktopUserDataDirectory}`,
      ],
      {
        cwd: desktopRoot,
        env: {
          ...process.env,
          LING_DESKTOP_WINDOWS_PROVIDER_DESCRIPTOR: JSON.stringify(descriptor),
          LING_STACK_DAEMON_URL: `http://127.0.0.1:${daemonPort}`,
          LING_STACK_DEFAULT_WORKSPACE_CWD: dirname(dirname(desktopRoot)),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    ));
    desktop = startDesktop(targetAIdentity);

    await waitForMarker(desktop, DESKTOP_REVISION_A_LIVE_MARKER, 30_000);
    sendDesktopCommand(desktop, {
      type: "replace_descriptor",
      descriptor: targetBIdentity,
    });
    await waitForMarker(desktop, DESKTOP_REVISION_B_LIVE_MARKER, 30_000);
    await requestTargetClose(targetA, "A");
    sendDesktopCommand(desktop, { type: "old_target_closed" });
    await waitForMarker(desktop, OLD_TARGET_ISOLATED_MARKER, 30_000);
    sendDesktopCommand(desktop, { type: "restart_desktop" });
    await waitForMarker(desktop, RESTART_REQUESTED_MARKER, 30_000);
    const firstDesktop = desktop;
    const firstResult = await waitForExit(firstDesktop, positiveInteger(process.env.LING_DESKTOP_SMOKE_TIMEOUT_MS, 45_000));
    const firstOutput = `${firstDesktop.stdout}\n${firstDesktop.stderr}`;
    if (firstResult.exitCode !== 0) {
      throw new Error(`desktop_restart_exit:${firstResult.exitCode ?? firstResult.signal ?? "unknown"}\n${firstOutput}`);
    }
    desktop = startDesktop({ ...targetBIdentity, revision: 2 }, true);
    await waitForMarker(desktop, DESCRIPTOR_REPLAY_LIVE_MARKER, 30_000);
    await waitForMarker(desktop, TARGET_CLOSE_REQUEST_MARKER, 30_000);
    await requestTargetClose(targetB, "B");
    await waitForMarker(desktop, STALLED_RUNTIME_RUNNING_MARKER, 30_000);
    const result = await waitForExit(desktop, positiveInteger(process.env.LING_DESKTOP_SMOKE_TIMEOUT_MS, 45_000));
    const output = `${firstOutput}\n${desktop.stdout}\n${desktop.stderr}`;
    if (result.exitCode !== 0) {
      throw new Error(`desktop_exit:${result.exitCode ?? result.signal ?? "unknown"}\n${output}`);
    }
    if (!output.includes(SUCCESS_MARKER)) {
      throw new Error(`desktop_success_marker_missing\n${output}`);
    }
    process.stdout.write(
      "Desktop Windows provider health/A-B descriptor/revision/restart/target-close smoke passed\n",
    );
  } finally {
    if (desktop) {
      await terminateObservedChild(desktop);
    }
    if (targetA) {
      await terminateObservedChild(targetA, true);
    }
    if (targetB) {
      await terminateObservedChild(targetB, true);
    }
    await Promise.all([
      rm(targetAUserDataDirectory, { recursive: true, force: true }),
      rm(targetBUserDataDirectory, { recursive: true, force: true }),
      rm(desktopUserDataDirectory, { recursive: true, force: true }),
    ]);
  }
}

async function readProviderHealth(command) {
  const result = await runFiniteProcess(command, ["call", "health_report"], 10_000);
  if (result.exitCode !== 0) {
    throw new Error(`windows_provider_smoke_health_failed:${result.exitCode ?? result.signal ?? "unknown"}\n${result.stderr}`);
  }
  return parseWindowsProviderHealthReport(result.stdout);
}

async function startTarget(label, userDataDirectory) {
  const target = observeChild(spawn(electronPath, [
    join(desktopRoot, "tests", "windows-provider-target"),
    `--user-data-dir=${userDataDirectory}`,
    `--ling-windows-provider-target-label=${label}`,
  ], {
    cwd: desktopRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  }));
  if (!target.child.pid) {
    throw new Error(`windows_provider_smoke_target_${label.toLowerCase()}_pid_missing`);
  }
  await waitForMarker(target, `Ling Windows provider smoke target ${label} ready`, 15_000);
  return target;
}

function assertIndependentProviderTargets(targetA, targetB) {
  if (
    targetA.processId === targetB.processId
    || targetA.nativeWindowId === targetB.nativeWindowId
  ) {
    throw new Error("windows_provider_smoke_targets_not_independent");
  }
}

async function resolveProviderCommand() {
  const { resolveCuaDriverCommand } = await import(
    "../../../packages/daemon/dist/features/plugins/presets.js"
  );
  const explicitCommand = process.env.LING_CUA_DRIVER_COMMAND?.trim();
  const resolution = resolveCuaDriverCommand(explicitCommand ? { command: explicitCommand } : {});
  if (!resolution.ok || !resolution.command) {
    throw new Error("windows_provider_smoke_cua_driver_not_found");
  }
  return resolution.command;
}

async function waitForExactProviderTarget(command, targetPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await runFiniteProcess(
      command,
      ["call", "list_windows", JSON.stringify({ pid: targetPid })],
      10_000,
    );
    if (result.exitCode !== 0) {
      throw new Error(`windows_provider_smoke_list_windows_failed:${result.exitCode ?? result.signal ?? "unknown"}`);
    }
    try {
      return parseExactWindowsProviderTarget(result.stdout, targetPid);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "windows_provider_smoke_target_not_found") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw error;
      }
      await delay(100);
    }
  }
}

async function requestTargetClose(target, label) {
  if (target.child.exitCode !== null || target.child.signalCode !== null) {
    throw new Error(`windows_provider_smoke_target_${label.toLowerCase()}_closed_early`);
  }
  target.child.stdin.write("close\n");
  target.child.stdin.end();
  await waitForMarker(
    target,
    `Ling Windows provider smoke target ${label} close accepted`,
    5_000,
  );
  const result = await waitForExit(target, 5_000);
  if (result.exitCode !== 0) {
    throw new Error(`windows_provider_smoke_target_${label.toLowerCase()}_close_failed:${result.exitCode ?? result.signal ?? "unknown"}`);
  }
  if (!target.stdout.includes(`Ling Windows provider smoke target ${label} closed`)) {
    throw new Error(`windows_provider_smoke_target_${label.toLowerCase()}_close_ack_missing`);
  }
}

function sendDesktopCommand(desktop, command) {
  if (!desktop.child.stdin?.writable) {
    throw new Error("windows_provider_smoke_desktop_stdin_unavailable");
  }
  desktop.child.stdin.write(`${JSON.stringify(command)}\n`);
}

function observeChild(child) {
  const observed = {
    child,
    stdout: "",
    stderr: "",
    result: undefined,
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    observed.stdout = boundedAppend(observed.stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    observed.stderr = boundedAppend(observed.stderr, chunk);
  });
  child.once("close", (exitCode, signal) => {
    observed.result = { exitCode, signal };
  });
  return observed;
}

async function waitForMarker(observed, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!observed.stdout.includes(marker)) {
    if (observed.result) {
      throw new Error(
        `process_exited_before_marker:${marker}:${observed.result.exitCode ?? observed.result.signal ?? "unknown"}\n` +
        `${observed.stdout}\n${observed.stderr}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`process_marker_timeout:${marker}\n${observed.stdout}\n${observed.stderr}`);
    }
    await delay(20);
  }
}

async function waitForExit(observed, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!observed.result) {
    if (Date.now() >= deadline) {
      throw new Error(`process_exit_timeout\n${observed.stdout}\n${observed.stderr}`);
    }
    await delay(20);
  }
  return observed.result;
}

async function terminateObservedChild(observed, requestGracefulClose = false) {
  if (observed.result) {
    return;
  }
  if (requestGracefulClose && observed.child.stdin.writable) {
    observed.child.stdin.write("close\n");
    observed.child.stdin.end();
    try {
      await waitForExit(observed, 1_000);
      return;
    } catch {
      // Fall through to process termination for failed smoke cleanup.
    }
  }
  observed.child.kill();
  try {
    await waitForExit(observed, 2_000);
  } catch {
    // The parent process is already terminating; keep cleanup bounded.
  }
}

async function runFiniteProcess(executable, args, timeoutMs) {
  const observed = observeChild(spawn(executable, args, {
    cwd: desktopRoot,
    env: {
      ...process.env,
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  try {
    const result = await waitForExit(observed, timeoutMs);
    return { ...result, stdout: observed.stdout, stderr: observed.stderr };
  } catch (error) {
    observed.child.kill();
    throw error;
  }
}

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) {
          reject(error);
        } else if (!port) {
          reject(new Error("windows_provider_smoke_port_unavailable"));
        } else {
          resolvePort(port);
        }
      });
    });
  });
}

function boundedAppend(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return next.length <= 100_000 ? next : next.slice(-100_000);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
