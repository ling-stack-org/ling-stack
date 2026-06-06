import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface DaemonLifecyclePaths {
  readonly cwd: string;
  readonly rootDir: string;
  readonly daemonDir: string;
  readonly logsDir: string;
  readonly pidPath: string;
  readonly statePath: string;
  readonly logPath: string;
}

export interface DaemonLifecycleState {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly cwd: string;
  readonly defaultWorkspaceCwd: string;
  readonly startedAt: string;
  readonly pidPath: string;
  readonly statePath: string;
  readonly logPath: string;
  readonly nodePath: string;
  readonly nodeVersion: string;
  readonly daemonCliPath: string;
  readonly createdByPid: number;
}

export interface DaemonStateSnapshot {
  readonly paths: DaemonLifecyclePaths;
  readonly pid?: number;
  readonly state?: DaemonLifecycleState;
  readonly pidError?: string;
  readonly stateError?: string;
  readonly pidAlive?: boolean;
}

export function resolveDaemonLifecyclePaths(cwd: string): DaemonLifecyclePaths {
  const resolvedCwd = resolve(cwd);
  const rootDir = join(resolvedCwd, ".ling-stack");
  const daemonDir = join(rootDir, "daemon");
  const logsDir = join(rootDir, "logs");
  return {
    cwd: resolvedCwd,
    rootDir,
    daemonDir,
    logsDir,
    pidPath: join(daemonDir, "daemon.pid"),
    statePath: join(daemonDir, "daemon.json"),
    logPath: join(logsDir, "daemon.log"),
  };
}

export async function ensureDaemonLifecycleDirs(paths: DaemonLifecyclePaths): Promise<void> {
  await mkdir(paths.daemonDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
}

export async function readDaemonStateSnapshot(cwd: string): Promise<DaemonStateSnapshot> {
  const paths = resolveDaemonLifecyclePaths(cwd);
  const [pidResult, stateResult] = await Promise.all([
    readDaemonPid(paths.pidPath),
    readDaemonState(paths.statePath),
  ]);
  const pid = pidResult.pid ?? stateResult.state?.pid;
  return {
    paths,
    pid,
    state: stateResult.state,
    pidError: pidResult.error,
    stateError: stateResult.error,
    pidAlive: pid === undefined ? undefined : isPidAlive(pid),
  };
}

export async function writeDaemonLifecycleState(paths: DaemonLifecyclePaths, state: DaemonLifecycleState): Promise<void> {
  await ensureDaemonLifecycleDirs(paths);
  await writeFile(paths.pidPath, `${state.pid}\n`, "utf8");
  await writeFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function removeDaemonLifecycleState(paths: DaemonLifecyclePaths): Promise<void> {
  await Promise.all([
    rm(paths.pidPath, { force: true }),
    rm(paths.statePath, { force: true }),
  ]);
}

export async function removeDaemonLifecycleStateIfMatches(paths: DaemonLifecyclePaths, pid: number): Promise<void> {
  const current = await readDaemonStateSnapshot(paths.cwd);
  if (current.pid === pid) {
    await removeDaemonLifecycleState(paths);
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    if (isNodeError(error) && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

async function readDaemonPid(pidPath: string): Promise<{ readonly pid?: number; readonly error?: string }> {
  let text: string;
  try {
    text = await readFile(pidPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const trimmed = text.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return { error: "daemon.pid must contain a positive base-10 pid" };
  }
  const pid = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(pid)) {
    return { error: "daemon.pid is outside the safe integer range" };
  }
  return { pid };
}

async function readDaemonState(statePath: string): Promise<{ readonly state?: DaemonLifecycleState; readonly error?: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const error = validateDaemonLifecycleState(parsed);
  if (error) {
    return { error };
  }
  return { state: parsed as DaemonLifecycleState };
}

function validateDaemonLifecycleState(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return "daemon.json must contain an object";
  }
  if (value.schemaVersion !== 1) {
    return "daemon.json schemaVersion must be 1";
  }
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) {
    return "daemon.json pid must be a positive integer";
  }
  for (const key of ["host", "url", "cwd", "defaultWorkspaceCwd", "startedAt", "pidPath", "statePath", "logPath", "nodePath", "nodeVersion", "daemonCliPath"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      return `daemon.json ${key} must be a non-empty string`;
    }
  }
  if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    return "daemon.json port must be a TCP port";
  }
  if (typeof value.createdByPid !== "number" || !Number.isInteger(value.createdByPid) || value.createdByPid <= 0) {
    return "daemon.json createdByPid must be a positive integer";
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
