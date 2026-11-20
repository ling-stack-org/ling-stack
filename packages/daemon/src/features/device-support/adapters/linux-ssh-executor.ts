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
    if (!options.host.trim() || !options.user.trim() || !options.knownHostsFile.trim()) throw new Error("SSH host, user and known-hosts file are required");
    this.#options = options;
  }

  async inventory(signal?: AbortSignal): Promise<{ readonly hostname: string; readonly kernel: string }> {
    const hostname = await this.runRemote(["hostname"], signal);
    const kernel = await this.runRemote(["uname", "-sr"], signal);
    return { hostname: hostname.stdout.trim() || this.#options.host, kernel: kernel.stdout.trim() };
  }

  async readNetwork(signal?: AbortSignal): Promise<LinuxNetworkObservation> {
    const addr = await this.runRemote(["ip", "-j", "addr"], signal);
    const route = await this.runRemote(["ip", "route", "get", "1.1.1.1"], signal);
    const text = `${addr.stdout}\n${route.stdout}`;
    const connected = addr.exitCode === 0 && /\binet\s+\d{1,3}(?:\.\d{1,3}){3}/u.test(text);
    return { connected, interfaceName: /\bdev\s+([A-Za-z0-9_.-]+)/u.exec(route.stdout)?.[1], ipv4: /\binet\s+(\d{1,3}(?:\.\d{1,3}){3})/u.exec(text)?.[1], gatewayReachable: connected && route.exitCode === 0, dnsReachable: connected };
  }

  async readWifi(signal?: AbortSignal): Promise<LinuxNetworkObservation> {
    const wifi = await this.runRemote(["iw", "dev"], signal);
    const network = await this.readNetwork(signal);
    return { ...network, ssid: /\bssid\s+([^\n]+)/iu.exec(wifi.stdout)?.[1]?.trim(), linkError: wifi.exitCode === 0 ? undefined : wifi.stderr.trim() || "wifi_observation_failed" };
  }

  async restartNetwork(input: { readonly signal?: AbortSignal }): Promise<{ readonly accepted: boolean }> {
    const result = await this.runRemote(["systemctl", "restart", "NetworkManager"], input.signal);
    return { accepted: result.exitCode === 0 };
  }

  private runRemote(command: readonly string[], signal?: AbortSignal) {
    const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${this.#options.knownHostsFile}`];
    if (this.#options.port) args.push("-p", String(this.#options.port));
    if (this.#options.identityFile) args.push("-i", this.#options.identityFile);
    args.push(`${this.#options.user}@${this.#options.host}`, ...command);
    return this.#options.runner.run("ssh", args, signal);
  }
}
