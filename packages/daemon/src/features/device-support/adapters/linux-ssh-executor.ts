import { isIP } from "node:net";

import { isLinuxDnsProbeHostname, readLinuxDnsLookup, readLinuxIpv4Evidence, readLinuxWifiLink, selectLinuxWifiInterface } from "@ling-stack/contracts";
import { DeviceBrokerError } from "@ling-stack/core";

import type { LinuxNetworkObservation, LinuxSshExecutor } from "./linux-ssh.js";
import type { LocalProcessRunner } from "./local-pc-executor.js";

export interface LinuxSshProcessExecutorOptions {
  readonly host: string;
  readonly user: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly knownHostsFile: string;
  readonly dnsProbeHostname?: string;
  readonly runner: LocalProcessRunner;
}

export class LinuxSshProcessExecutor implements LinuxSshExecutor {
  readonly #options: LinuxSshProcessExecutorOptions;

  constructor(options: LinuxSshProcessExecutorOptions) {
    if (!isLinuxSshHost(options.host)
      || !options.user || /[\u0000-\u0020\u007f]/u.test(options.user)
      || !options.knownHostsFile.trim()
      || /[\u0000-\u001f]/u.test(options.knownHostsFile)
      || (options.dnsProbeHostname !== undefined && !isLinuxDnsProbeHostname(options.dnsProbeHostname))
      || (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535))) {
      throw new Error("SSH host, user, port and known-hosts file must be valid");
    }
    this.#options = { ...options };
  }

  async inventory(signal?: AbortSignal): Promise<{ readonly hostname: string; readonly kernel: string }> {
    const hostname = await this.runRemote(["hostname"], signal);
    const name = hostname.stdout.trim();
    if (hostname.exitCode !== 0 || !name || name.length > 253 || /[\u0000-\u001f\u007f]/u.test(name)) {
      throw new Error("Linux host name is unavailable");
    }
    const kernel = await this.runRemote(["uname", "-sr"], signal);
    const version = kernel.stdout.trim();
    if (kernel.exitCode !== 0 || !version.startsWith("Linux ") || version.length > 256 || /[\u0000-\u001f\u007f]/u.test(version)) {
      throw new Error("Linux kernel version is unavailable");
    }
    return { hostname: name, kernel: version };
  }

  async readNetwork(signal?: AbortSignal): Promise<LinuxNetworkObservation> {
    const addresses = await this.runRemote(["ip", "-j", "addr"], signal);
    const network = await readLinuxIpv4Evidence(
      addresses, () => this.runRemote(["env", "LC_ALL=C", "ip", "-j", "route", "get", "1.1.1.1"], signal),
    );
    const dnsNameResolved = await this.probeDnsName(signal);
    return {
      ...network,
      ...(dnsNameResolved === undefined ? {} : { dnsNameResolved }),
    };
  }

  async readWifi(signal?: AbortSignal): Promise<LinuxNetworkObservation> {
    const wifi = await this.runRemote(["iw", "dev"], signal);
    const network = await this.readNetwork(signal);
    const selection = selectLinuxWifiInterface(wifi, network.interfaceName);
    if ("linkError" in selection) return { ...network, linkError: selection.linkError };
    const wifiInterfaceName = selection.interfaceName;
    const link = await this.runRemote(["iw", "dev", wifiInterfaceName, "link"], signal);
    return { ...network, wifiInterfaceName, ...readLinuxWifiLink(link) };
  }

  async restartNetwork(input: { readonly signal?: AbortSignal }): Promise<{ readonly accepted: boolean }> {
    const result = await this.runRemote(["systemctl", "restart", "NetworkManager"], input.signal);
    if (result.exitCode !== 0) throw new Error("Linux network restart outcome is unavailable");
    return { accepted: true };
  }

  private async probeDnsName(signal?: AbortSignal): Promise<boolean | undefined> {
    const name = this.#options.dnsProbeHostname;
    if (!name) return undefined;
    const deadline = AbortSignal.timeout(3_000);
    const probeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const result = await this.runRemote(["getent", "-s", "dns", "ahostsv4", name], probeSignal);
      return readLinuxDnsLookup(result);
    } catch (error) {
      if (deadline.aborted && !signal?.aborted) return undefined;
      throw error;
    }
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
    if (result.exitCode === 255) throw new DeviceBrokerError("connection_failed", "Linux SSH connection failed or was interrupted");
    return result;
  }
}

export function isLinuxSshHost(host: string): boolean {
  return /^[a-z0-9_.:%-]{1,253}$/iu.test(host)
    && (isIP(host) !== 0 || /^[a-z0-9][a-z0-9_.-]*$/iu.test(host));
}
