import { execFile as nodeExecFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import type { PcNetworkStatus, PcServiceStatus, PcTargetExecutor } from "./pc.js";

const execFile = promisify(nodeExecFile);

export interface LocalProcessRunner {
  run(file: string, args: readonly string[], signal?: AbortSignal): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
}

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
    this.#runner = options.runner ?? {
      async run(file, args, signal) {
        try {
          const result = await execFile(file, [...args], { signal, maxBuffer: 256 * 1024 });
          return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
        } catch (error) {
          const failure = error as { readonly stdout?: string; readonly stderr?: string; readonly code?: number };
          return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: typeof failure.code === "number" ? failure.code : 1 };
        }
      },
    };
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

  async readServices(signal?: AbortSignal): Promise<readonly PcServiceStatus[]> {
    if (this.#platform === "linux") {
      const result = await this.#runner.run("systemctl", ["list-units", "--type=service", "--no-legend", "--plain"], signal);
      return parseSystemdServices(result.stdout);
    }
    if (this.#platform === "darwin") {
      const result = await this.#runner.run("launchctl", ["list"], signal);
      return result.exitCode === 0 ? [{ name: "launchd", state: "running" }] : [{ name: "launchd", state: "unknown" }];
    }
    const result = await this.#runner.run("sc.exe", ["query", "state=", "all"], signal);
    return result.exitCode === 0 ? [{ name: "Service Control Manager", state: "running" }] : [{ name: "Service Control Manager", state: "unknown" }];
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
}

function parseSystemdServices(text: string): readonly PcServiceStatus[] {
  return text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).slice(0, 256).map(line => {
    const parts = line.split(/\s+/u);
    const name = parts[0]?.replace(/\.service$/u, "") ?? "unknown";
    const activeState = parts[3] ?? parts[2];
    const state = activeState === "running" ? "running" : activeState === "failed" ? "failed" : activeState === "dead" ? "stopped" : "unknown";
    return { name, state };
  });
}
