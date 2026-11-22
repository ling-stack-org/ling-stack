import { execFile as nodeExecFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { PC_INSPECTION_TIMEOUT_MS, type PcNetworkStatus, type PcProcessInfo, type PcServiceStatus, type PcTargetExecutor } from "./pc.js";

const execFile = promisify(nodeExecFile);

const windowsPowerShell = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const windowsQueryArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"];
const windowsServiceQuery = [
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "ConvertTo-Json -Compress -InputObject @(Get-Service -ErrorAction Stop | ForEach-Object {",
  "  @{ name = $_.ServiceName; state = $_.Status.ToString() }",
  "})",
].join("\n");
const windowsProcessQuery = [
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "ConvertTo-Json -Compress -InputObject @(Get-Process -ErrorAction Stop | ForEach-Object {",
  "  @{ pid = $_.Id; name = $_.ProcessName }",
  "})",
].join("\n");

interface PcInspection<T> {
  readonly file: string;
  readonly args: readonly string[];
  readonly parse: (output: string) => readonly T[] | undefined;
}

const serviceInspection: Partial<Record<NodeJS.Platform, PcInspection<PcServiceStatus>>> = {
  linux: {
    file: "systemctl",
    args: ["list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager", "--full"],
    parse: parseSystemdServices,
  },
  darwin: { file: "/bin/launchctl", args: ["list"], parse: parseLaunchdServices },
  win32: {
    file: windowsPowerShell,
    args: [...windowsQueryArgs, windowsServiceQuery],
    parse: parseWindowsServices,
  },
};

const processInspection: Partial<Record<NodeJS.Platform, PcInspection<PcProcessInfo>>> = {
  linux: { file: "/bin/ps", args: ["-ww", "-axo", "pid=,comm="], parse: parsePosixProcesses },
  darwin: { file: "/bin/ps", args: ["-ww", "-axo", "pid=,ucomm="], parse: parsePosixProcesses },
  win32: { file: windowsPowerShell, args: [...windowsQueryArgs, windowsProcessQuery], parse: parseWindowsProcesses },
};

export interface LocalProcessRunner {
  run(file: string, args: readonly string[], signal?: AbortSignal): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
}

export const localProcessRunner: LocalProcessRunner = {
  async run(file, args, signal) {
    try {
      const result = await execFile(file, [...args], { signal, maxBuffer: 256 * 1024, windowsHide: true });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as { readonly stdout?: string; readonly stderr?: string; readonly code?: number };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: typeof failure.code === "number" ? failure.code : 1 };
    }
  },
};

export interface LocalPcTargetExecutorOptions {
  readonly platform?: NodeJS.Platform;
  readonly runner?: LocalProcessRunner;
  readonly readInterfaces?: typeof networkInterfaces;
}

export class LocalPcTargetExecutor implements PcTargetExecutor {
  readonly #platform: NodeJS.Platform;
  readonly #runner: LocalProcessRunner;
  readonly #readInterfaces: typeof networkInterfaces;

  constructor(options: LocalPcTargetExecutorOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#readInterfaces = options.readInterfaces ?? networkInterfaces;
    this.#runner = options.runner ?? localProcessRunner;
  }

  async inventory(signal?: AbortSignal): Promise<{ readonly hostname: string; readonly os: string; readonly version?: string }> {
    const hostname = (await this.#runner.run(this.#platform === "win32" ? "hostname.exe" : "hostname", [], signal)).stdout.trim() || "unknown-host";
    const kernel = this.#platform === "win32"
      ? (await this.#runner.run("cmd.exe", ["/d", "/s", "/c", "ver"], signal)).stdout.trim()
      : (await this.#runner.run("uname", ["-sr"], signal)).stdout.trim();
    return { hostname, os: this.#platform, version: kernel || undefined };
  }

  async readNetwork(signal?: AbortSignal): Promise<PcNetworkStatus> {
    signal?.throwIfAborted();
    for (const [interfaceName, addresses] of Object.entries(this.#readInterfaces())) {
      const address = addresses?.find(item => !item.internal && !/^(?:169\.254\.|fe[89ab][0-9a-f]:)/iu.test(item.address));
      if (address) return { connected: true, interfaceName, address: address.address };
    }
    return { connected: false };
  }

  async readServices(signal?: AbortSignal): Promise<readonly PcServiceStatus[] | undefined> {
    return this.#readInspection(serviceInspection[this.#platform], signal);
  }

  async readProcesses(signal?: AbortSignal): Promise<readonly PcProcessInfo[] | undefined> {
    return this.#readInspection(processInspection[this.#platform], signal);
  }

  async repairNetwork(input: { readonly mode: "refresh_dhcp" | "restart_network"; readonly signal?: AbortSignal }): Promise<{ readonly accepted: boolean; readonly changed: boolean }> {
    if (this.#platform === "linux" && input.mode === "restart_network") {
      const result = await this.#runner.run("systemctl", ["restart", "NetworkManager"], input.signal);
      return { accepted: result.exitCode === 0, changed: result.exitCode === 0 };
    }
    if (this.#platform === "darwin" && input.mode === "restart_network") {
      const off = await this.#runner.run("networksetup", ["-setnetworkserviceenabled", "Wi-Fi", "off"], input.signal);
      if (off.exitCode !== 0) return { accepted: false, changed: false };
      const on = await this.#runner.run("networksetup", ["-setnetworkserviceenabled", "Wi-Fi", "on"], input.signal);
      return { accepted: on.exitCode === 0, changed: on.exitCode === 0 };
    }
    return { accepted: false, changed: false };
  }

  async #readInspection<T>(inspection: PcInspection<T> | undefined, signal?: AbortSignal): Promise<readonly T[] | undefined> {
    signal?.throwIfAborted();
    if (!inspection) return undefined;
    const deadline = AbortSignal.timeout(PC_INSPECTION_TIMEOUT_MS);
    const querySignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const result = await this.#runner.run(inspection.file, inspection.args, querySignal);
    signal?.throwIfAborted();
    return result.exitCode === 0 && !deadline.aborted ? inspection.parse(result.stdout) : undefined;
  }
}

function parseSystemdServices(text: string): readonly PcServiceStatus[] | undefined {
  const services: PcServiceStatus[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^\s*(\S+)\.service\s+\S+\s+(\S+)\s+\S+(?:\s|$)/u.exec(line);
    if (!match) return undefined;
    const [, name, activeState] = match;
    if (!isInspectionName(name)) return undefined;
    const state = activeState === "failed" ? "failed"
      : activeState === "inactive" ? "stopped"
      : activeState === "active" || activeState === "reloading" || activeState === "refreshing" ? "running"
      : "unknown";
    services.push({ name, state });
  }
  return services;
}

function parseLaunchdServices(text: string): readonly PcServiceStatus[] | undefined {
  const [header, ...lines] = text.trim().split(/\r?\n/u);
  if (!header || !/^PID\s+Status\s+Label\s*$/u.test(header)) return undefined;
  const services: PcServiceStatus[] = [];
  for (const line of lines) {
    const match = /^\s*(-|[1-9]\d*)\s+(-?\d+)\s+(.+)$/u.exec(line);
    if (!match) return undefined;
    const [, pid, exitStatus, name] = match;
    if (!isInspectionName(name)) return undefined;
    const code = Number(exitStatus);
    const state = pid !== "-" ? "running" : code > 0 ? "failed" : code === 0 ? "stopped" : "unknown";
    services.push({ name, state });
  }
  return services;
}

function parseWindowsServices(text: string): readonly PcServiceStatus[] | undefined {
  const rows = parseWindowsInspection(text);
  if (!rows) return undefined;
  const services: PcServiceStatus[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || !("name" in row) || !("state" in row)
      || !isInspectionName(row.name) || typeof row.state !== "string") return undefined;
    const state = row.state === "Running" ? "running" : row.state === "Stopped" ? "stopped" : "unknown";
    services.push({ name: row.name, state });
  }
  return services;
}

function parsePosixProcesses(text: string): readonly PcProcessInfo[] | undefined {
  const processes: PcProcessInfo[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^(\d+)[ \t]+(.+)$/u.exec(line.trim());
    if (!match) return undefined;
    const [, pidText, name] = match;
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || !isInspectionName(name)) return undefined;
    processes.push({ pid, name });
  }
  return processes;
}

function parseWindowsProcesses(text: string): readonly PcProcessInfo[] | undefined {
  const rows = parseWindowsInspection(text);
  if (!rows) return undefined;
  const processes: PcProcessInfo[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || !("pid" in row) || !("name" in row)) return undefined;
    const { pid, name } = row;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 0 || !isInspectionName(name)) return undefined;
    processes.push({ pid, name });
  }
  return processes;
}

function parseWindowsInspection(text: string): readonly unknown[] | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isInspectionName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(value);
}
