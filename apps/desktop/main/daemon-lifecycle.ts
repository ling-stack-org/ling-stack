import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir } from "node:fs/promises";
import { connect } from "node:net";
import type { DesktopDaemonStatus } from "../shared/desktop-capabilities.js";

const DEFAULT_DAEMON_STARTUP_TIMEOUT_MS = 20_000;

export type DesktopDaemonLifecycleErrorCode = "bridge_incompatible" | "child_exited" | "start_timeout";
export type DesktopDaemonPortOccupant = "foreign_service" | "ling_daemon";

type DaemonProbeResult = "compatible" | "incompatible" | "occupied" | "unavailable";
type DaemonPortProbeResult = "free" | "occupied";

interface OwnedDaemonExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class DesktopDaemonLifecycleError extends Error {
  constructor(
    readonly code: DesktopDaemonLifecycleErrorCode,
    readonly baseUrl: string,
    readonly occupant?: DesktopDaemonPortOccupant,
  ) {
    super(lifecycleErrorMessage(code, baseUrl, occupant));
    this.name = "DesktopDaemonLifecycleError";
  }
}

export interface DesktopDaemonLifecycleOptions {
  readonly baseUrl: string;
  readonly daemonEntryPath: string;
  readonly defaultWorkspaceCwd: string;
  readonly healthTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly probePort?: (input: {
    readonly hostname: string;
    readonly port: number;
    readonly timeoutMs: number;
  }) => Promise<DaemonPortProbeResult>;
  readonly spawnDaemon?: (input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  }) => ChildProcess;
  readonly executablePath?: string;
  readonly desktopBridgeToken?: string;
  readonly onDiagnostic?: (event: string, details?: Readonly<Record<string, unknown>>) => void;
}

export class DesktopDaemonLifecycle {
  private readonly events = new EventEmitter();
  private readonly fetchImpl: typeof globalThis.fetch;
  private child: ChildProcess | undefined;
  private statusValue: DesktopDaemonStatus;
  private ensureStartedPromise: Promise<DesktopDaemonStatus> | undefined;

  constructor(private readonly options: DesktopDaemonLifecycleOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.statusValue = {
      state: "checking",
      baseUrl: options.baseUrl,
      ownedByDesktop: false,
    };
  }

  get status(): DesktopDaemonStatus {
    return this.statusValue;
  }

  onStatusChanged(listener: (status: DesktopDaemonStatus) => void): () => void {
    this.events.on("status", listener);
    return () => this.events.off("status", listener);
  }

  ensureStarted(): Promise<DesktopDaemonStatus> {
    if (this.child && this.statusValue.state === "connected") {
      return Promise.resolve(this.statusValue);
    }
    if (this.ensureStartedPromise) {
      return this.ensureStartedPromise;
    }
    const pending = this.ensureStartedInternal();
    this.ensureStartedPromise = pending;
    pending.then(
      () => {
        if (this.ensureStartedPromise === pending) {
          this.ensureStartedPromise = undefined;
        }
      },
      () => {
        if (this.ensureStartedPromise === pending) {
          this.ensureStartedPromise = undefined;
        }
      },
    );
    return pending;
  }

  private async ensureStartedInternal(): Promise<DesktopDaemonStatus> {
    this.update({ state: "checking", baseUrl: this.options.baseUrl, ownedByDesktop: false });
    const existingProbe = await this.probeDaemon();
    if (existingProbe === "compatible") {
      this.options.onDiagnostic?.("daemon.reused", { baseUrl: this.options.baseUrl });
      return this.update({ state: "connected", baseUrl: this.options.baseUrl, ownedByDesktop: false });
    }
    if (existingProbe === "incompatible") {
      this.options.onDiagnostic?.("daemon.bridge_incompatible", { baseUrl: this.options.baseUrl });
      this.update({
        state: "disconnected",
        baseUrl: this.options.baseUrl,
        ownedByDesktop: false,
        reason: "bridge_incompatible",
        message: "Existing daemon is missing the authenticated Desktop preview bridge.",
      });
      throw new DesktopDaemonLifecycleError("bridge_incompatible", this.options.baseUrl, "ling_daemon");
    }
    if (existingProbe === "occupied") {
      this.options.onDiagnostic?.("daemon.port_occupied", {
        baseUrl: this.options.baseUrl,
        occupant: "foreign_service",
      });
      this.update({
        state: "disconnected",
        baseUrl: this.options.baseUrl,
        ownedByDesktop: false,
        reason: "bridge_incompatible",
        message: "A foreign service is using the configured daemon port.",
      });
      throw new DesktopDaemonLifecycleError("bridge_incompatible", this.options.baseUrl, "foreign_service");
    }

    await access(this.options.daemonEntryPath);
    await mkdir(this.options.defaultWorkspaceCwd, { recursive: true });
    this.update({ state: "starting", baseUrl: this.options.baseUrl, ownedByDesktop: true });
    const url = new URL(this.options.baseUrl);
    const spawnDaemon = this.options.spawnDaemon ?? defaultSpawnDaemon;
    const child = spawnDaemon({
      executable: this.options.executablePath ?? process.execPath,
      args: [this.options.daemonEntryPath],
      cwd: this.options.defaultWorkspaceCwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        LING_STACK_HOST: url.hostname,
        LING_STACK_PORT: url.port || (url.protocol === "https:" ? "443" : "80"),
        LING_STACK_DEFAULT_WORKSPACE_CWD: this.options.defaultWorkspaceCwd,
        ...(this.options.desktopBridgeToken ? { LING_DESKTOP_BRIDGE_TOKEN: this.options.desktopBridgeToken } : {}),
      },
    });
    this.options.onDiagnostic?.("daemon.spawned", { pid: child.pid ?? null, baseUrl: this.options.baseUrl });
    this.child = child;
    let resolveChildExit: (exit: OwnedDaemonExit) => void = () => undefined;
    const childExit = new Promise<OwnedDaemonExit>((resolve) => {
      resolveChildExit = resolve;
    });
    child.once("exit", (code, signal) => {
      const exit = { code, signal } satisfies OwnedDaemonExit;
      if (this.child !== child) {
        resolveChildExit(exit);
        return;
      }
      this.child = undefined;
      this.update({
        state: "disconnected",
        baseUrl: this.options.baseUrl,
        ownedByDesktop: false,
        reason: "child_exited",
        message: `Daemon exited (${signal ?? code ?? "unknown"})`,
      });
      this.options.onDiagnostic?.("daemon.exited", { code, signal });
      resolveChildExit(exit);
    });

    // A cold packaged x64 build launched through Rosetta can spend almost eight
    // seconds starting the bundled daemon from a mounted DMG. Keep the timeout
    // bounded, but leave enough margin for real packaged cold starts rather
    // than racing the health probe at the old eight-second boundary.
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? DEFAULT_DAEMON_STARTUP_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const readiness = await Promise.race([
        this.probeDaemon().then((probe) => ({ kind: "probe" as const, probe })),
        childExit.then((exit) => ({ kind: "child_exit" as const, exit })),
      ]);
      if (readiness.kind === "child_exit") {
        throw new DesktopDaemonLifecycleError("child_exited", this.options.baseUrl);
      }
      const probe = readiness.probe;
      if (probe === "compatible") {
        if (this.child !== child || child.exitCode !== null || child.signalCode !== null) {
          throw new DesktopDaemonLifecycleError("child_exited", this.options.baseUrl);
        }
        this.options.onDiagnostic?.("daemon.ready", { pid: child.pid ?? null, baseUrl: this.options.baseUrl });
        return this.update({ state: "connected", baseUrl: this.options.baseUrl, ownedByDesktop: true });
      }
      if (probe === "incompatible") {
        await this.stopOwnedDaemon();
        this.options.onDiagnostic?.("daemon.bridge_incompatible", { baseUrl: this.options.baseUrl });
        this.update({
          state: "disconnected",
          baseUrl: this.options.baseUrl,
          ownedByDesktop: false,
          reason: "bridge_incompatible",
          message: "Started daemon did not accept the authenticated Desktop preview bridge.",
        });
        throw new DesktopDaemonLifecycleError("bridge_incompatible", this.options.baseUrl, "ling_daemon");
      }
      const pause = await Promise.race([
        wait(100).then(() => ({ kind: "elapsed" as const })),
        childExit.then((exit) => ({ kind: "child_exit" as const, exit })),
      ]);
      if (pause.kind === "child_exit") {
        throw new DesktopDaemonLifecycleError("child_exited", this.options.baseUrl);
      }
    }
    if (this.child !== child || child.exitCode !== null || child.signalCode !== null) {
      throw new DesktopDaemonLifecycleError("child_exited", this.options.baseUrl);
    }
    await this.stopOwnedDaemon();
    this.options.onDiagnostic?.("daemon.start_timeout", { baseUrl: this.options.baseUrl });
    this.update({
      state: "disconnected",
      baseUrl: this.options.baseUrl,
      ownedByDesktop: false,
      reason: "start_timeout",
      message: "Desktop-owned daemon did not become ready before the startup deadline.",
    });
    throw new DesktopDaemonLifecycleError("start_timeout", this.options.baseUrl);
  }

  async restart(): Promise<DesktopDaemonStatus> {
    if (!this.child) {
      const probe = await this.probeDaemon();
      if (probe === "compatible") {
        return this.update({
          state: "connected",
          baseUrl: this.options.baseUrl,
          ownedByDesktop: false,
          message: "Existing daemon is not owned by Desktop and was not restarted.",
        });
      }
      if (probe === "incompatible") {
        this.update({
          state: "disconnected",
          baseUrl: this.options.baseUrl,
          ownedByDesktop: false,
          reason: "bridge_incompatible",
          message: "Existing daemon is missing the authenticated Desktop preview bridge.",
        });
        throw new DesktopDaemonLifecycleError("bridge_incompatible", this.options.baseUrl, "ling_daemon");
      }
      if (probe === "occupied") {
        this.update({
          state: "disconnected",
          baseUrl: this.options.baseUrl,
          ownedByDesktop: false,
          reason: "bridge_incompatible",
          message: "A foreign service is using the configured daemon port.",
        });
        throw new DesktopDaemonLifecycleError("bridge_incompatible", this.options.baseUrl, "foreign_service");
      }
    }
    await this.stopOwnedDaemon();
    return this.ensureStarted();
  }

  async stopOwnedDaemon(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = undefined;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const exited = await waitForExit(child, this.options.shutdownTimeoutMs ?? 3_000);
      if (!exited && child.exitCode === null && child.signalCode === null) {
        this.options.onDiagnostic?.("daemon.force_killed", { pid: child.pid ?? null });
        child.kill("SIGKILL");
        await waitForExit(child, 1_000);
      }
    }
    this.update({ state: "disconnected", baseUrl: this.options.baseUrl, ownedByDesktop: false });
  }

  private async probeDaemon(): Promise<DaemonProbeResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL("/health", `${this.options.baseUrl}/`), {
        signal: AbortSignal.timeout(this.options.healthTimeoutMs ?? 800),
      });
    } catch {
      return await this.probeConfiguredPort() === "free" ? "unavailable" : "occupied";
    }
    if (!response.ok) {
      return "occupied";
    }
    const body = await response.json().catch(() => ({})) as { service?: unknown };
    if (body.service !== "ling-stack-daemon") {
      return "occupied";
    }
    if (!this.options.desktopBridgeToken) {
      return "compatible";
    }
    try {
      const handshake = await this.fetchImpl(
        new URL("/computer-use/desktop-bridge/handshake", `${this.options.baseUrl}/`),
        {
          headers: { "X-Ling-Desktop-Bridge-Token": this.options.desktopBridgeToken },
          signal: AbortSignal.timeout(this.options.healthTimeoutMs ?? 800),
        },
      );
      if (!handshake.ok) {
        return "incompatible";
      }
      const compatibility = await handshake.json() as {
        protocolVersion?: unknown;
        capabilities?: unknown;
        bridgeTokenAccepted?: unknown;
      };
      return compatibility.protocolVersion === 1
        && Array.isArray(compatibility.capabilities)
        && compatibility.capabilities.includes("preview-source")
        && compatibility.bridgeTokenAccepted === true
        ? "compatible"
        : "incompatible";
    } catch {
      // The daemon answered health, so a missing/timed-out handshake is an
      // incompatible daemon, not an invitation to spawn another process on
      // the same occupied port.
      return "incompatible";
    }
  }

  private async probeConfiguredPort(): Promise<DaemonPortProbeResult> {
    const url = new URL(this.options.baseUrl);
    const probePort = this.options.probePort ?? defaultProbePort;
    try {
      return await probePort({
        hostname: normalizeSocketHostname(url.hostname),
        port: url.port ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80,
        timeoutMs: this.options.healthTimeoutMs ?? 800,
      });
    } catch {
      // An indeterminate loopback port is not safe to spawn into. Fail closed
      // and let the normal incompatible-service recovery ask the user to retry.
      return "occupied";
    }
  }

  private update(status: DesktopDaemonStatus): DesktopDaemonStatus {
    this.statusValue = status;
    this.events.emit("status", status);
    return status;
  }
}

function defaultSpawnDaemon(input: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): ChildProcess {
  return spawn(input.executable, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    stdio: "ignore",
    windowsHide: true,
  });
}

function defaultProbePort(input: {
  readonly hostname: string;
  readonly port: number;
  readonly timeoutMs: number;
}): Promise<DaemonPortProbeResult> {
  return new Promise((resolve) => {
    const socket = connect({ host: input.hostname, port: input.port });
    let settled = false;
    const finish = (result: DaemonPortProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(input.timeoutMs);
    socket.once("connect", () => finish("occupied"));
    socket.once("timeout", () => finish("occupied"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" ? "free" : "occupied");
    });
  });
}

function normalizeSocketHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function lifecycleErrorMessage(
  code: DesktopDaemonLifecycleErrorCode,
  baseUrl: string,
  occupant?: DesktopDaemonPortOccupant,
): string {
  if (code === "bridge_incompatible") {
    return occupant === "foreign_service"
      ? `daemon_port_occupied_by_foreign_service: ${baseUrl}`
      : `daemon_desktop_bridge_incompatible: ${baseUrl}`;
  }
  return code === "child_exited"
    ? `daemon_child_exited_before_ready: ${baseUrl}`
    : `daemon_start_timeout: ${baseUrl}`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}
