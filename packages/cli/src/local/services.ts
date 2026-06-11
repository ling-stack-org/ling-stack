import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { CliError, errorMessage } from "../errors.js";

export const LOCAL_DAEMON_LABEL = "com.lingstack.local.daemon";
export const LOCAL_WEB_LABEL = "com.lingstack.local.web";
export const DEFAULT_LOCAL_WEB_URL = "http://127.0.0.1:5173";

export type LocalServiceName = "daemon" | "web";

export interface LocalEndpointStatus {
  readonly url: string;
  readonly ok: boolean;
  readonly status?: number;
  readonly service?: string;
  readonly error?: string;
  readonly elapsedMs: number;
}

export interface LocalLaunchdStatus {
  readonly manager: "launchd";
  readonly label: string;
  readonly target: string;
  readonly installed: boolean;
  readonly state?: string;
  readonly pid?: number;
  readonly plistPath?: string;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
  readonly error?: string;
}

export interface LocalServiceStatus {
  readonly name: LocalServiceName;
  readonly launchd: LocalLaunchdStatus;
  readonly endpoint: LocalEndpointStatus;
}

export interface LocalStackStatus {
  readonly ok: boolean;
  readonly daemon: LocalServiceStatus;
  readonly web: LocalServiceStatus;
}

export interface LocalRestartResult {
  readonly ok: boolean;
  readonly build: {
    readonly ran: boolean;
    readonly skippedReason?: string;
  };
  readonly daemonRestarted: boolean;
  readonly webRestarted: boolean;
  readonly status: LocalStackStatus;
}

export interface LocalServiceLog {
  readonly service: LocalServiceName;
  readonly path: string;
  readonly lines: readonly string[];
  readonly error?: string;
}

export async function restartLocalStack(input: {
  readonly cwd: string;
  readonly daemonUrl: string;
  readonly webUrl: string;
  readonly timeoutMs: number;
  readonly buildDaemon: boolean;
}): Promise<LocalRestartResult> {
  const initial = await readLocalStackStatus(input);
  if (!initial.daemon.launchd.installed || !initial.web.launchd.installed) {
    throw new CliError(
      4,
      "local_service_manager_missing",
      "Local launchd services are not installed. Use `ling-stack daemon restart` for daemon-only lifecycle or install local LaunchAgents before `ling restart`.",
    );
  }

  const build = input.buildDaemon
    ? await buildDaemonPackageIfPresent(input.cwd)
    : { ran: false, skippedReason: "skip_build_requested" };

  await kickstartLaunchdService(LOCAL_DAEMON_LABEL);
  await kickstartLaunchdService(LOCAL_WEB_LABEL);

  const [daemonReady, webReady] = await Promise.all([
    waitForEndpoint(input.daemonUrl, input.timeoutMs, "ling-stack-daemon"),
    waitForEndpoint(input.webUrl, input.timeoutMs),
  ]);
  if (!daemonReady.ok || !webReady.ok) {
    const daemonReason = daemonReady.ok ? "ok" : daemonReady.error ?? `HTTP ${daemonReady.status ?? "unknown"}`;
    const webReason = webReady.ok ? "ok" : webReady.error ?? `HTTP ${webReady.status ?? "unknown"}`;
    throw new CliError(4, "local_service_not_ready", `Local restart completed, but readiness failed. daemon=${daemonReason}; web=${webReason}`);
  }

  return {
    ok: true,
    build,
    daemonRestarted: true,
    webRestarted: true,
    status: await readLocalStackStatus(input),
  };
}

export async function readLocalStackStatus(input: {
  readonly daemonUrl: string;
  readonly webUrl: string;
  readonly timeoutMs?: number;
}): Promise<LocalStackStatus> {
  const timeoutMs = input.timeoutMs ?? 1500;
  const [daemonLaunchd, webLaunchd, daemonEndpoint, webEndpoint] = await Promise.all([
    readLaunchdStatus(LOCAL_DAEMON_LABEL),
    readLaunchdStatus(LOCAL_WEB_LABEL),
    probeEndpoint(input.daemonUrl, timeoutMs, "ling-stack-daemon"),
    probeEndpoint(input.webUrl, timeoutMs),
  ]);
  const daemon: LocalServiceStatus = { name: "daemon", launchd: daemonLaunchd, endpoint: daemonEndpoint };
  const web: LocalServiceStatus = { name: "web", launchd: webLaunchd, endpoint: webEndpoint };
  return {
    ok: daemon.endpoint.ok && web.endpoint.ok,
    daemon,
    web,
  };
}

export async function readLocalServiceLogs(input: {
  readonly cwd: string;
  readonly service: LocalServiceName | "all";
  readonly lines: number;
}): Promise<readonly LocalServiceLog[]> {
  const services: readonly LocalServiceName[] = input.service === "all" ? ["daemon", "web"] : [input.service];
  const statuses = new Map<LocalServiceName, LocalLaunchdStatus>([
    ["daemon", await readLaunchdStatus(LOCAL_DAEMON_LABEL)],
    ["web", await readLaunchdStatus(LOCAL_WEB_LABEL)],
  ]);
  return await Promise.all(services.map(async (service) => {
    const path = resolveLocalLogPath(input.cwd, service, statuses.get(service));
    try {
      const text = await readFile(path, "utf8");
      return {
        service,
        path,
        lines: tailLines(text, input.lines),
      };
    } catch (error) {
      return {
        service,
        path,
        lines: [],
        error: errorMessage(error),
      };
    }
  }));
}

function resolveLocalLogPath(cwd: string, service: LocalServiceName, launchd?: LocalLaunchdStatus): string {
  const launchdPath = launchd?.stdoutPath ?? launchd?.stderrPath;
  if (launchdPath) {
    return launchdPath;
  }
  return join(cwd, "logs", service === "daemon" ? "local-daemon.log" : "local-web.log");
}

async function buildDaemonPackageIfPresent(cwd: string): Promise<{ readonly ran: boolean; readonly skippedReason?: string }> {
  try {
    await stat(join(cwd, "packages", "daemon", "package.json"));
  } catch {
    return { ran: false, skippedReason: "daemon_package_not_found" };
  }
  await execFileText("corepack", ["pnpm", "--filter", "@ling-stack/daemon", "build"], { cwd }).catch((error: unknown) => {
    throw new CliError(4, "local_daemon_build_failed", errorMessage(error));
  });
  return { ran: true };
}

async function kickstartLaunchdService(label: string): Promise<void> {
  const target = launchdTarget(label);
  await execFileText("launchctl", ["kickstart", "-k", target]).catch((error: unknown) => {
    throw new CliError(4, "local_service_restart_failed", `Failed to restart ${label}: ${errorMessage(error)}`);
  });
}

async function readLaunchdStatus(label: string): Promise<LocalLaunchdStatus> {
  const target = launchdTarget(label);
  if (!isLaunchdAvailable()) {
    return {
      manager: "launchd",
      label,
      target,
      installed: false,
      error: "launchd is only available on macOS",
    };
  }
  try {
    const result = await execFileText("launchctl", ["print", target]);
    return parseLaunchdPrint(label, target, result.stdout);
  } catch (error) {
    return {
      manager: "launchd",
      label,
      target,
      installed: false,
      error: errorMessage(error),
    };
  }
}

function parseLaunchdPrint(label: string, target: string, stdout: string): LocalLaunchdStatus {
  return {
    manager: "launchd",
    label,
    target,
    installed: true,
    state: matchLaunchdField(stdout, "state"),
    pid: readLaunchdPid(stdout),
    plistPath: matchLaunchdField(stdout, "path"),
    stdoutPath: matchLaunchdField(stdout, "stdout path"),
    stderrPath: matchLaunchdField(stdout, "stderr path"),
  };
}

function matchLaunchdField(stdout: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${escaped} = (.+)$`, "m").exec(stdout)?.[1]?.trim();
}

function readLaunchdPid(stdout: string): number | undefined {
  const raw = matchLaunchdField(stdout, "pid");
  if (!raw || !/^[1-9]\d*$/.test(raw)) {
    return undefined;
  }
  const pid = Number.parseInt(raw, 10);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

function launchdTarget(label: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) {
    return `gui/501/${label}`;
  }
  return `gui/${uid}/${label}`;
}

function isLaunchdAvailable(): boolean {
  return process.platform === "darwin";
}

async function waitForEndpoint(url: string, timeoutMs: number, expectedService?: string): Promise<LocalEndpointStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: LocalEndpointStatus | undefined;
  while (Date.now() <= deadline) {
    last = await probeEndpoint(url, Math.min(1000, Math.max(100, deadline - Date.now())), expectedService);
    if (last.ok) {
      return last;
    }
    await delay(100);
  }
  return last ?? {
    url,
    ok: false,
    error: "readiness timeout",
    elapsedMs: timeoutMs,
  };
}

async function probeEndpoint(url: string, timeoutMs: number, expectedService?: string): Promise<LocalEndpointStatus> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(expectedService ? new URL("/health", `${url}/`) : url, { signal: controller.signal });
    const elapsedMs = Date.now() - startedAt;
    if (expectedService) {
      const body = await response.json().catch(() => ({})) as unknown;
      const service = isRecord(body) && typeof body.service === "string" ? body.service : undefined;
      return {
        url,
        ok: response.ok && service === expectedService,
        status: response.status,
        service,
        elapsedMs,
        error: response.ok && service !== expectedService ? `unexpected service: ${service ?? "unknown"}` : undefined,
      };
    }
    return {
      url,
      ok: response.ok,
      status: response.status,
      elapsedMs,
      error: response.ok ? undefined : `${response.status} ${response.statusText}`,
    };
  } catch (error) {
    return {
      url,
      ok: false,
      error: errorMessage(error),
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

function tailLines(text: string, count: number): readonly string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.slice(Math.max(0, lines.length - count));
}

function execFileText(
  file: string,
  args: readonly string[],
  options: { readonly cwd?: string } = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveExec, rejectExec) => {
    execFile(file, [...args], {
      cwd: options.cwd,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = [error.message, stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        rejectExec(new Error(detail));
        return;
      }
      resolveExec({ stdout, stderr });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
