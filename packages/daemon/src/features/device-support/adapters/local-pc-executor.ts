import { execFile as nodeExecFile, spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { posix, win32 } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { PC_INSPECTION_TIMEOUT_MS, type PcInstalledSoftware, type PcLogEntry, type PcNetworkStatus, type PcProcessInfo, type PcServiceStatus, type PcSoftwareInventory, type PcTargetExecutor } from "./pc.js";

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
const windowsLogQuery = [
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "try {",
  "  $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 1, 2, 3 } -MaxEvents 200 -ErrorAction Stop)",
  "} catch {",
  "  if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound,*') { throw }",
  "  $events = @()",
  "}",
  "ConvertTo-Json -Compress -InputObject @($events | ForEach-Object {",
  "  @{ time = $_.TimeCreated.ToUniversalTime().ToString('o'); level = $_.Level; source = $_.ProviderName }",
  "})",
].join("\n");
const windowsSoftwareQuery = [
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$paths = @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
  "  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
  "  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
  "$ErrorActionPreference = 'Stop'",
  "$entries = foreach ($path in $paths) { if (Test-Path -Path $path) { Get-ItemProperty -Path $path } }",
  "ConvertTo-Json -Compress -InputObject @($entries |",
  "  Where-Object { $_.DisplayName -is [string] -and $_.DisplayName.Trim().Length -gt 0 } |",
  "  ForEach-Object { @{ name = $_.DisplayName; version = [string]$_.DisplayVersion } })",
].join("\n");
const logEntryLimit = 200;
const softwareEntryLimit = 200;
const macLogArgs = [
  "show", "--last", "30s", "--style", "ndjson", "--no-backtrace", "--no-loss", "--no-signpost",
  "--predicate", "logType == error OR logType == fault",
] as const;
const maximumLogStreamBytes = 16 * 1024 * 1024;

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

const logInspection: Partial<Record<NodeJS.Platform, PcInspection<PcLogEntry>>> = {
  linux: {
    file: "/usr/bin/journalctl",
    args: [
      "--no-pager", "--quiet", "--output=json", "--output-fields=PRIORITY,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,_COMM",
      "--priority=warning", "--lines=200",
    ],
    parse: parseLinuxLogs,
  },
  win32: { file: windowsPowerShell, args: [...windowsQueryArgs, windowsLogQuery], parse: parseWindowsLogs },
};

const softwareInspection: Partial<Record<NodeJS.Platform, PcInspection<PcInstalledSoftware>>> = {
  linux: {
    file: "/usr/bin/dpkg-query",
    args: ["-W", "-f=${db:Status-Status}\\t${binary:Package}\\t${Version}\\n"],
    parse: text => parseLinuxSoftware(text, "dpkg"),
  },
  win32: { file: windowsPowerShell, args: [...windowsQueryArgs, windowsSoftwareQuery], parse: parseWindowsSoftware },
  darwin: { file: "/usr/sbin/system_profiler", args: ["SPApplicationsDataType", "-json"], parse: parseMacSoftware },
};
const rpmSoftwareInspection: PcInspection<PcInstalledSoftware> = {
  file: "/usr/bin/rpm", args: ["-qa", "--qf", "%{NAME}.%{ARCH}\\t%{VERSION}-%{RELEASE}\\n"],
  parse: text => parseLinuxSoftware(text, "rpm"),
};

export interface LocalProcessRunner {
  run(file: string, args: readonly string[], signal?: AbortSignal): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
  scanLines?(file: string, args: readonly string[], consume: (line: string) => boolean, signal: AbortSignal): Promise<boolean>;
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
  async scanLines(file, args, consume, signal) {
    const child = spawn(file, args, { signal, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    child.on("error", () => {});
    const closed = new Promise<boolean>(resolve => child.once("close", code => resolve(code === 0)));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      let bytes = 0;
      for await (const line of lines) {
        bytes += Buffer.byteLength(line) + 1;
        if (bytes > maximumLogStreamBytes || !consume(line)) {
          child.kill();
          await closed;
          return false;
        }
      }
      return await closed;
    } finally {
      lines.close();
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

  async readLogs(signal?: AbortSignal): Promise<readonly PcLogEntry[] | undefined> {
    if (this.#platform === "darwin") return this.#readMacLogs(signal);
    return this.#readInspection(logInspection[this.#platform], signal);
  }

  async readSoftware(signal?: AbortSignal): Promise<PcSoftwareInventory | undefined> {
    const queryTimeout = AbortSignal.timeout(PC_INSPECTION_TIMEOUT_MS);
    const querySignal = signal ? AbortSignal.any([signal, queryTimeout]) : queryTimeout;
    const inspection = softwareInspection[this.#platform];
    try {
      const primary = await this.#readInspection(inspection, querySignal);
      const entries = primary ?? (this.#platform === "linux" ? await this.#readInspection(rpmSoftwareInspection, querySignal) : undefined);
      if (entries === undefined) return undefined;
      return { entries: entries.slice(0, softwareEntryLimit), truncated: entries.length > softwareEntryLimit };
    } catch (error) {
      signal?.throwIfAborted();
      if (queryTimeout.aborted) return undefined;
      throw error;
    }
  }

  async #readMacLogs(signal?: AbortSignal): Promise<readonly PcLogEntry[] | undefined> {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(PC_INSPECTION_TIMEOUT_MS);
    const querySignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const entries: PcLogEntry[] = [];
    let scanned = 0;
    let finished = false;
    const consume = (line: string): boolean => {
      if (!line.trim()) return true;
      const row = parseLogObject(line);
      if (!row || finished) return false;
      if (row.finished === 1 && row.count === scanned) {
        finished = true;
        return true;
      }
      if (row.eventType !== "logEvent") return false;
      const timestamp = parseLogTimestamp(row.timestamp);
      const level = row.messageType === "Error" || row.messageType === "Fault" ? "error" : "unknown";
      const name = typeof row.processImagePath === "string" ? posix.basename(row.processImagePath) : undefined;
      const source = isInspectionName(row.subsystem) ? row.subsystem : isInspectionName(name) ? name : "system";
      entries[scanned % logEntryLimit] = { ...(timestamp ? { timestamp } : {}), level, source };
      scanned += 1;
      return true;
    };
    let succeeded: boolean;
    if (this.#runner.scanLines) {
      succeeded = await this.#runner.scanLines("/usr/bin/log", macLogArgs, consume, querySignal);
    } else {
      const result = await this.#runner.run("/usr/bin/log", macLogArgs, querySignal);
      succeeded = result.exitCode === 0 && result.stdout.split(/\r?\n/u).every(consume);
    }
    signal?.throwIfAborted();
    if (!succeeded || !finished || deadline.aborted) return undefined;
    const start = scanned > logEntryLimit ? scanned % logEntryLimit : 0;
    return [...entries.slice(start), ...entries.slice(0, start)];
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

function parseLinuxLogs(text: string): readonly PcLogEntry[] | undefined {
  const entries: PcLogEntry[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const row = parseLogObject(line);
    if (!row || entries.length >= logEntryLimit) return undefined;
    const source = [row._SYSTEMD_UNIT, row.SYSLOG_IDENTIFIER, row._COMM].find(isInspectionName) ?? "system";
    const priority = typeof row.PRIORITY === "string" && /^[0-7]$/u.test(row.PRIORITY) ? Number(row.PRIORITY) : row.PRIORITY;
    const micros = typeof row.__REALTIME_TIMESTAMP === "string" && /^\d+$/u.test(row.__REALTIME_TIMESTAMP)
      ? Number(row.__REALTIME_TIMESTAMP) : Number.NaN;
    const timestamp = Number.isFinite(micros) && micros <= 8.64e18
      ? new Date(micros / 1000).toISOString() : undefined;
    const level = Number.isInteger(priority) ? (Number(priority) <= 3 ? "error" : Number(priority) === 4 ? "warning" : "unknown") : "unknown";
    entries.push({ ...(timestamp ? { timestamp } : {}), level, source });
  }
  return entries;
}

function parseWindowsLogs(text: string): readonly PcLogEntry[] | undefined {
  const rows = parseWindowsInspection(text);
  if (!rows || rows.length > logEntryLimit) return undefined;
  const entries: PcLogEntry[] = [];
  for (const row of rows) {
    if (!isLogObject(row)) return undefined;
    const timestamp = parseLogTimestamp(row.time);
    const level = row.level === 1 || row.level === 2 ? "error" : row.level === 3 ? "warning" : "unknown";
    const source = isInspectionName(row.source) ? row.source : "system";
    entries.push({ ...(timestamp ? { timestamp } : {}), level, source });
  }
  return entries.reverse();
}

function parseLinuxSoftware(text: string, source: "dpkg" | "rpm"): readonly PcInstalledSoftware[] | undefined {
  const entries: PcInstalledSoftware[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    if (fields.length !== (source === "dpkg" ? 3 : 2)) return undefined;
    if (source === "dpkg" && fields.shift() !== "installed") continue;
    const [name, version] = fields;
    if (!isInspectionName(name) || !isInspectionName(version)) return undefined;
    entries.push({ name, version, source });
    if (entries.length > softwareEntryLimit) break;
  }
  return entries;
}

function parseWindowsSoftware(text: string): readonly PcInstalledSoftware[] | undefined {
  const rows = parseWindowsInspection(text);
  if (!rows) return undefined;
  const entries: PcInstalledSoftware[] = [];
  for (const row of rows.slice(0, softwareEntryLimit + 1)) {
    if (!row || typeof row !== "object" || !("name" in row) || !("version" in row)
      || !isInspectionName(row.name) || typeof row.version !== "string") return undefined;
    entries.push({ name: row.name, ...(isInspectionName(row.version) ? { version: row.version } : {}), source: "registry" });
  }
  return entries;
}

function parseMacSoftware(text: string): readonly PcInstalledSoftware[] | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value) || !("SPApplicationsDataType" in value)) return undefined;
  const rows = (value as { readonly SPApplicationsDataType?: unknown }).SPApplicationsDataType;
  if (!Array.isArray(rows)) return undefined;
  const entries: PcInstalledSoftware[] = [];
  for (const row of rows.slice(0, softwareEntryLimit + 1)) {
    if (!row || typeof row !== "object" || Array.isArray(row) || !("_name" in row)) return undefined;
    const name = (row as { readonly _name?: unknown })._name;
    const version = (row as { readonly version?: unknown }).version;
    if (!isInspectionName(name) || (version !== undefined && typeof version !== "string")) return undefined;
    entries.push({ name, ...(isInspectionName(version) ? { version } : {}), source: "system_profiler" });
  }
  return entries;
}

function parseLogObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isLogObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isLogObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseLogTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
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
