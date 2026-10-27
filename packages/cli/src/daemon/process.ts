import { openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  ensureDaemonLifecycleDirs,
  isPidAlive,
  readDaemonStateSnapshot,
  removeDaemonLifecycleStateIfMatches,
  resolveDaemonLifecyclePaths,
  writeDaemonLifecycleState,
  type DaemonLifecycleState,
} from "./state.js";

export interface BackgroundDaemonStartInput {
  readonly cwd: string;
  readonly host: string;
  readonly port: number;
  readonly daemonUrl: string;
  readonly daemonCliPath: string;
  readonly timeoutMs: number;
}

export interface StopDaemonInput {
  readonly cwd: string;
  readonly timeoutMs: number;
}

export async function startBackgroundDaemon(input: BackgroundDaemonStartInput): Promise<DaemonLifecycleState> {
  const paths = resolveDaemonLifecyclePaths(input.cwd);
  await ensureDaemonLifecycleDirs(paths);
  const snapshot = await readDaemonStateSnapshot(input.cwd);
  if (snapshot.pidAlive && snapshot.state) {
    return snapshot.state;
  }
  if (snapshot.pid !== undefined && snapshot.pidAlive === false) {
    await removeDaemonLifecycleStateIfMatches(paths, snapshot.pid);
  }

  const logFd = openSync(paths.logPath, "a");
  let pid: number | undefined;
  try {
    const child = spawn(process.execPath, [input.daemonCliPath], {
      cwd: input.cwd,
      detached: true,
      env: {
        ...process.env,
        LING_STACK_HOST: input.host,
        LING_STACK_PORT: String(input.port),
        LING_STACK_DEFAULT_WORKSPACE_CWD: input.cwd,
        LING_STACK_DAEMON_LOG_PATH: paths.logPath,
      },
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    pid = child.pid;
  } finally {
    closeSync(logFd);
  }
  if (!pid) {
    throw new Error("daemon_start_failed: daemon process did not expose a pid");
  }

  const state: DaemonLifecycleState = {
    schemaVersion: 1,
    pid,
    host: input.host,
    port: input.port,
    url: input.daemonUrl,
    cwd: input.cwd,
    defaultWorkspaceCwd: input.cwd,
    startedAt: new Date().toISOString(),
    pidPath: paths.pidPath,
    statePath: paths.statePath,
    logPath: paths.logPath,
    nodePath: process.execPath,
    nodeVersion: process.version,
    daemonCliPath: input.daemonCliPath,
    createdByPid: process.pid,
  };
  await writeDaemonLifecycleState(paths, state);

  const ready = await waitForDaemonHealth(input.daemonUrl, input.timeoutMs);
  if (!ready) {
    throw new Error("daemon_start_timeout: daemon did not become healthy before timeout");
  }
  return state;
}

export async function stopDaemonProcess(input: StopDaemonInput): Promise<{ readonly pid: number; readonly stale: boolean }> {
  const snapshot = await readDaemonStateSnapshot(input.cwd);
  const pid = snapshot.pid;
  if (pid === undefined) {
    throw new Error("daemon_not_running: no daemon pid file or state file found");
  }
  if (!isPidAlive(pid)) {
    await removeDaemonLifecycleStateIfMatches(snapshot.paths, pid);
    return { pid, stale: true };
  }
  process.kill(pid, "SIGTERM");
  const stopped = await waitForPidExit(pid, input.timeoutMs);
  if (!stopped) {
    throw new Error("daemon_stop_timeout: daemon did not exit before timeout");
  }
  await removeDaemonLifecycleStateIfMatches(snapshot.paths, pid);
  return { pid, stale: false };
}

export async function waitForDaemonHealth(daemonUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(new URL("/health", `${daemonUrl}/`));
      if (response.ok) {
        const body = await response.json().catch(() => ({})) as unknown;
        if (isRecord(body) && body.service === "ling-stack-daemon") {
          return true;
        }
      }
    } catch {
      // Retry until timeout.
    }
    await delay(100);
  }
  return false;
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await delay(100);
  }
  return !isPidAlive(pid);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
