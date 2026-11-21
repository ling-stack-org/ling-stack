import { isIP, isIPv4 } from "node:net";

import type { LinuxNetworkObservation, LinuxSshExecutor } from "./linux-ssh.js";
import type { LocalProcessRunner } from "./local-pc-executor.js";

export interface LinuxSshProcessExecutorOptions {
  readonly host: string;
  readonly user: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly knownHostsFile: string;
  readonly runner: LocalProcessRunner;
}

export class LinuxSshProcessExecutor implements LinuxSshExecutor {
  readonly #options: LinuxSshProcessExecutorOptions;

  constructor(options: LinuxSshProcessExecutorOptions) {
    if ((!isIP(options.host) && !/^[a-z0-9][a-z0-9_.-]{0,252}$/iu.test(options.host))
      || !options.user || /[\u0000-\u0020\u007f]/u.test(options.user)
      || !options.knownHostsFile.trim()
      || /[\u0000-\u001f]/u.test(options.knownHostsFile)
      || (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535))) {
      throw new Error("SSH host, user, port and known-hosts file must be valid");
    }
    this.#options = { ...options };
  }

  async inventory(signal?: AbortSignal): Promise<{ readonly hostname: string; readonly kernel: string }> {
    const hostname = await this.runRemote(["hostname"], signal);
    if (hostname.exitCode !== 0 || !hostname.stdout.trim()) throw new Error("Linux host name is unavailable");
    const kernel = await this.runRemote(["uname", "-sr"], signal);
    if (kernel.exitCode !== 0 || !kernel.stdout.trim()) throw new Error("Linux kernel version is unavailable");
    return { hostname: hostname.stdout.trim(), kernel: kernel.stdout.trim() };
  }

  async readNetwork(signal?: AbortSignal): Promise<LinuxNetworkObservation> {
    const addresses = await this.runRemote(["ip", "-j", "addr"], signal);
    if (addresses.exitCode !== 0) throw new Error("Linux interface addresses are unavailable");
    const interfaces = readIpRecords(addresses.stdout);
    const routeResult = await this.runRemote(["env", "LC_ALL=C", "ip", "-j", "route", "get", "1.1.1.1"], signal);
    const routes = routeResult.exitCode === 0 ? readIpRecords(routeResult.stdout) : undefined;
    const route = routes?.find(item =>
      typeof item.dev === "string" && !["unreachable", "prohibit", "blackhole", "throw"].includes(String(item.type)));
    const noRoute = routeResult.exitCode === 2 && /RTNETLINK answers: Network is unreachable/u.test(routeResult.stderr);

    const configuredAddresses: { interfaceName: string; ipv4: string }[] = [];
    for (const iface of interfaces) {
      if (typeof iface.ifname !== "string" || iface.ifname === "lo" || !Array.isArray(iface.addr_info)) continue;
      for (const address of iface.addr_info.filter(isRecord)) {
        if (address.family === "inet" && address.scope === "global" && typeof address.local === "string" && isIPv4(address.local)) {
          configuredAddresses.push({ interfaceName: iface.ifname, ipv4: address.local });
        }
      }
    }
    const address = route
      ? configuredAddresses.find(item => item.interfaceName === route.dev && item.ipv4 === route.prefsrc)
        ?? configuredAddresses.find(item => item.interfaceName === route.dev)
      : configuredAddresses[0];
    return {
      connected: configuredAddresses.length > 0,
      ...(routes || noRoute ? { routeAvailable: route !== undefined } : {}),
      ...(address ?? (typeof route?.dev === "string" ? { interfaceName: route.dev } : {})),
    };
  }

  async readWifi(signal?: AbortSignal): Promise<LinuxNetworkObservation> {
    const wifi = await this.runRemote(["iw", "dev"], signal);
    const network = await this.readNetwork(signal);
    if (wifi.exitCode !== 0) {
      return { ...network, linkError: wifi.exitCode === 127 ? "wireless_tools_unavailable" : "wifi_observation_failed" };
    }
    const wireless = [...wifi.stdout.matchAll(/^[ \t]*Interface[ \t]+([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*\r?$/gmu)]
      .map(match => match[1]!);
    const wifiInterfaceName = network.interfaceName && wireless.includes(network.interfaceName) ? network.interfaceName : wireless[0];
    if (!wifiInterfaceName) return { ...network, linkError: "wireless_interface_not_found" };
    const link = await this.runRemote(["iw", "dev", wifiInterfaceName, "link"], signal);
    const details = { ...network, wifiInterfaceName };
    if (link.exitCode !== 0) return { ...details, linkError: "wifi_observation_failed" };
    if (/^\s*Not connected\.?\s*$/mu.test(link.stdout)) return { ...details, wifiAssociated: false };
    if (!/^\s*Connected to\s/u.test(link.stdout)) return { ...details, linkError: "wifi_observation_failed" };
    const ssid = /^\s*SSID:\s*([^\r\n]*)/mu.exec(link.stdout)?.[1]?.trim();
    return { ...details, wifiAssociated: true, ...(ssid ? { ssid } : {}) };
  }

  async restartNetwork(input: { readonly signal?: AbortSignal }): Promise<{ readonly accepted: boolean }> {
    const result = await this.runRemote(["systemctl", "restart", "NetworkManager"], input.signal);
    if (result.exitCode !== 0) throw new Error("Linux network restart outcome is unavailable");
    return { accepted: true };
  }

  private async runRemote(command: readonly string[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const knownHosts = this.#options.knownHostsFile.replace(/["\\]/gu, "\\$&");
    const args = [
      "-F", "none",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "GlobalKnownHostsFile=none",
      "-o", `UserKnownHostsFile="${knownHosts}"`,
      "-o", "UpdateHostKeys=no",
    ];
    if (this.#options.port) args.push("-p", String(this.#options.port));
    if (this.#options.identityFile) args.push("-o", "IdentitiesOnly=yes", "-i", this.#options.identityFile);
    args.push("-l", this.#options.user, "--", this.#options.host, ...command);
    const result = await this.#options.runner.run("ssh", args, signal);
    signal?.throwIfAborted();
    if (result.exitCode === 255) throw new Error("Linux SSH connection failed or was interrupted");
    return result;
  }
}

function readIpRecords(stdout: string): readonly Record<string, unknown>[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (Array.isArray(parsed) && parsed.every(isRecord)) return parsed;
  } catch {
    // Parse errors can include device output.
  }
  throw new Error("Linux ip command returned invalid JSON");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
