import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir } from "node:fs/promises";
import { connect } from "node:net";
import { resolve as resolvePath } from "node:path";
import {
  CUA_DRIVER_READINESS_DETAILS_V1_CAPABILITY,
  isCuaDriverDesktopBridgeHandshakeResponseV1,
  type CuaDriverFeatureFlags,
  type CuaDriverLeaseHandshakeAuthorityV1,
} from "@ling-stack/contracts";
import type { DesktopDaemonStatus } from "../shared/desktop-capabilities.js";
import {
  desktopCuaDriverDaemonFeatureEnvironment,
  desktopBundledCuaDriverGateEnabled,
  resolveDesktopCuaDriverFeatureFlags,
} from "./cua-driver/feature-gates.js";
import { deriveMobileAccessManagementCapability } from "./mobile-access/authority.js";

const DEFAULT_DAEMON_STARTUP_TIMEOUT_MS = 20_000;

export type DesktopDaemonLifecycleErrorCode =
  | "bridge_incompatible"
  | "child_exited"
  | "start_timeout"
  | "resource_missing"
  | "spawn_failed";
export type DesktopDaemonPortOccupant = "foreign_service" | "ling_daemon";

type DaemonProbeResult = "compatible" | "incompatible" | "occupied" | "unavailable";
type DaemonPortProbeResult = "free" | "occupied";

export type DesktopDaemonCuaDriverAuthorityTuple = Readonly<
  CuaDriverLeaseHandshakeAuthorityV1 & {
    readonly workspaceCwd: string;
    readonly readinessDetailsV1: boolean;
  }
>;

export interface DesktopDaemonOwnedExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export type DesktopDaemonUnexpectedExit = DesktopDaemonOwnedExit & {
  readonly baseUrl: string;
};

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
  readonly cuaDriverFeatureFlags?: CuaDriverFeatureFlags;
  /** Test seam for evaluating the platform-specific bundled gate. */
  readonly platform?: string;
  /** Called once when a Desktop-owned child exits outside an intentional stop. */
  readonly onUnexpectedExit?: (details: DesktopDaemonUnexpectedExit) => void;
  readonly onDiagnostic?: (event: string, details?: Readonly<Record<string, unknown>>) => void;
}

export class DesktopDaemonLifecycle {
  private readonly events = new EventEmitter();
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly defaultWorkspaceCwd: string;
  private readonly cuaDriverFeatureFlags: CuaDriverFeatureFlags;
  private readonly bundledCuaDriverGateEnabled: boolean;
  private child: ChildProcess | undefined;
  private statusValue: DesktopDaemonStatus;
  private cuaDriverAuthorityTupleValue: DesktopDaemonCuaDriverAuthorityTuple | undefined;
  private cuaDriverAuthorityGeneration = 0;
  private ensureStartedPromise: Promise<DesktopDaemonStatus> | undefined;
  private restartPromise: Promise<DesktopDaemonStatus> | undefined;
  private stopOwnedDaemonPromise: Promise<void> | undefined;
  private startupGeneration = 0;
  private statusGeneration = 0;

  constructor(private readonly options: DesktopDaemonLifecycleOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.defaultWorkspaceCwd = resolvePath(options.defaultWorkspaceCwd);
    this.cuaDriverFeatureFlags = options.cuaDriverFeatureFlags ?? resolveDesktopCuaDriverFeatureFlags();
    this.bundledCuaDriverGateEnabled = desktopBundledCuaDriverGateEnabled(
      this.cuaDriverFeatureFlags,
      options.platform ?? process.platform,
    );
    this.statusValue = {
      state: "checking",
      baseUrl: options.baseUrl,
      ownedByDesktop: false,
    };
  }

  get status(): DesktopDaemonStatus {
    return this.statusValue;
  }

  /** Authority is memory-only and changes only after a new authenticated handshake. */
  get cuaDriverAuthorityTuple(): DesktopDaemonCuaDriverAuthorityTuple | undefined {
    return this.cuaDriverAuthorityTupleValue;
  }

  onStatusChanged(listener: (status: DesktopDaemonStatus) => void): () => void {
    this.events.on("status", listener);
    return () => this.events.off("status", listener);
  }

  ensureStarted(): Promise<DesktopDaemonStatus> {
    if (
      this.statusValue.state === "connected"
      && !this.stopOwnedDaemonPromise
      && !this.restartPromise
    ) {
      return Promise.resolve(this.statusValue);
    }
    if (this.ensureStartedPromise) {
      return this.ensureStartedPromise;
    }
    this.statusGeneration += 1;
    const startupGeneration = this.startupGeneration;
    const pending = this.ensureStartedInternal(startupGeneration);
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

  private async ensureStartedInternal(startupGeneration: number): Promise<DesktopDaemonStatus> {
    this.assertStartupCurrent(startupGeneration);
    this.update({ state: "checking", baseUrl: this.options.baseUrl, ownedByDesktop: false });
    const stoppingOwnedDaemon = this.stopOwnedDaemonPromise;
    if (stoppingOwnedDaemon) {
      await stoppingOwnedDaemon;
      this.assertStartupCurrent(startupGeneration);
    }
    const existingProbe = await this.probeDaemon();
    this.assertStartupCurrent(startupGeneration);
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

    try {
      await access(this.options.daemonEntryPath);
      await mkdir(this.defaultWorkspaceCwd, { recursive: true });
    } catch (error) {
      this.failOwnedStartup("resource_missing", "Required Desktop files or workspace storage are unavailable.", error);
    }
    this.assertStartupCurrent(startupGeneration);
    this.update({ state: "starting", baseUrl: this.options.baseUrl, ownedByDesktop: true });
    const url = new URL(this.options.baseUrl);
    const spawnDaemon = this.options.spawnDaemon ?? defaultSpawnDaemon;
    let child: ChildProcess;
    try {
      child = spawnDaemon({
        executable: this.options.executablePath ?? process.execPath,
        args: [this.options.daemonEntryPath],
        cwd: this.defaultWorkspaceCwd,
        env: {
          ...process.env,
          ...desktopCuaDriverDaemonFeatureEnvironment(this.cuaDriverFeatureFlags),
          ELECTRON_RUN_AS_NODE: "1",
          LING_STACK_HOST: url.hostname,
          LING_STACK_PORT: url.port || (url.protocol === "https:" ? "443" : "80"),
          LING_STACK_DEFAULT_WORKSPACE_CWD: this.defaultWorkspaceCwd,
          ...(this.options.desktopBridgeToken
            ? {
                LING_DESKTOP_BRIDGE_TOKEN: this.options.desktopBridgeToken,
                LING_COMPUTER_USE_ROUTE_TOKEN: this.options.desktopBridgeToken,
                LING_MOBILE_ACCESS_MANAGEMENT_CAPABILITY: deriveMobileAccessManagementCapability(this.options.desktopBridgeToken),
              }
            : {}),
        },
      });
    } catch (error) {
      this.failOwnedStartup("spawn_failed", "Desktop could not launch the local daemon process.", error);
    }
    if (!this.isStartupCurrent(startupGeneration)) {
      await this.stopChild(child);
      throw new Error("daemon_start_cancelled");
    }
    this.options.onDiagnostic?.("daemon.spawned", { pid: child.pid ?? null, baseUrl: this.options.baseUrl });
    this.child = child;
    let resolveChildExit: (exit: DesktopDaemonOwnedExit) => void = () => undefined;
    const childExit = new Promise<DesktopDaemonOwnedExit>((resolve) => {
      resolveChildExit = resolve;
    });
    let resolveChildError: (error: Error) => void = () => undefined;
    let childSpawnError: Error | undefined;
    const childError = new Promise<Error>((resolve) => {
      resolveChildError = resolve;
    });
    child.once("error", (error) => {
      childSpawnError = error;
      if (this.child === child) {
        this.child = undefined;
        this.update({
          state: "disconnected",
          baseUrl: this.options.baseUrl,
          ownedByDesktop: false,
          reason: "spawn_failed",
          message: "Desktop could not launch the local daemon process.",
        });
        this.options.onDiagnostic?.("daemon.spawn_failed", {
          baseUrl: this.options.baseUrl,
          error: error.message,
        });
      }
      resolveChildError(error);
    });
    child.once("exit", (code, signal) => {
      const exit = { code, signal } satisfies DesktopDaemonOwnedExit;
      if (this.child !== child) {
        resolveChildExit(exit);
        return;
      }
      this.child = undefined;
      this.clearCuaDriverAuthorityTuple();
      this.update({
        state: "disconnected",
        baseUrl: this.options.baseUrl,
        ownedByDesktop: false,
        reason: "child_exited",
        message: `Daemon exited (${signal ?? code ?? "unknown"})`,
      });
      this.options.onDiagnostic?.("daemon.exited", { code, signal });
      try {
        this.options.onUnexpectedExit?.({
          baseUrl: this.options.baseUrl,
          code,
          signal,
        });
      } catch (error) {
        this.options.onDiagnostic?.("daemon.unexpected_exit_handler_failed", {
          baseUrl: this.options.baseUrl,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      resolveChildExit(exit);
    });

    // Keep ordinary startup bounded. Callers that intentionally exercise a
    // translated cold-start path may supply a larger budget without relaxing
    // native product behavior.
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? DEFAULT_DAEMON_STARTUP_TIMEOUT_MS);
    while (Date.now() < deadline) {
      this.assertStartupCurrent(startupGeneration);
      const readiness = await Promise.race([
        this.probeDaemon().then((probe) => ({ kind: "probe" as const, probe })),
        childExit.then((exit) => ({ kind: "child_exit" as const, exit })),
        childError.then((error) => ({ kind: "child_error" as const, error })),
      ]);
      if (readiness.kind === "child_error") {
        throw new DesktopDaemonLifecycleError("spawn_failed", this.options.baseUrl);
      }
      if (readiness.kind === "child_exit") {
        throw new DesktopDaemonLifecycleError("child_exited", this.options.baseUrl);
      }
      this.assertStartupCurrent(startupGeneration);
      const probe = readiness.probe;
      if (probe === "compatible") {
        if (childSpawnError) {
          throw new DesktopDaemonLifecycleError("spawn_failed", this.options.baseUrl);
        }
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
        childError.then((error) => ({ kind: "child_error" as const, error })),
      ]);
      if (pause.kind === "child_error") {
        throw new DesktopDaemonLifecycleError("spawn_failed", this.options.baseUrl);
      }
      if (pause.kind === "child_exit") {
        throw new DesktopDaemonLifecycleError("child_exited", this.options.baseUrl);
      }
      this.assertStartupCurrent(startupGeneration);
    }
    if (childSpawnError) {
      throw new DesktopDaemonLifecycleError("spawn_failed", this.options.baseUrl);
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

  private failOwnedStartup(
    code: "resource_missing" | "spawn_failed",
    message: string,
    error: unknown,
  ): never {
    this.update({
      state: "disconnected",
      baseUrl: this.options.baseUrl,
      ownedByDesktop: false,
      reason: code,
      message,
    });
    this.options.onDiagnostic?.(`daemon.${code}`, {
      baseUrl: this.options.baseUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new DesktopDaemonLifecycleError(code, this.options.baseUrl);
  }

  restart(): Promise<DesktopDaemonStatus> {
    if (this.restartPromise) {
      return this.restartPromise;
    }
    const pending = this.restartInternal();
    this.restartPromise = pending;
    pending.then(
      () => {
        if (this.restartPromise === pending) {
          this.restartPromise = undefined;
        }
      },
      () => {
        if (this.restartPromise === pending) {
          this.restartPromise = undefined;
        }
      },
    );
    return pending;
  }

  private async restartInternal(): Promise<DesktopDaemonStatus> {
    this.clearCuaDriverAuthorityTuple();
    while (true) {
      const stoppingOwnedDaemon = this.stopOwnedDaemonPromise;
      if (stoppingOwnedDaemon) {
        await stoppingOwnedDaemon;
        continue;
      }
      if (this.child) {
        await this.stopOwnedDaemon();
        return this.ensureStarted();
      }

      const probeStatusGeneration = this.statusGeneration;
      const probe = await this.probeDaemon();
      if (
        probeStatusGeneration !== this.statusGeneration
        || this.child
        || this.stopOwnedDaemonPromise
      ) {
        continue;
      }
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
      await this.stopOwnedDaemon();
      return this.ensureStarted();
    }
  }

  stopOwnedDaemon(): Promise<void> {
    this.clearCuaDriverAuthorityTuple();
    const stopStatusGeneration = ++this.statusGeneration;
    this.startupGeneration += 1;
    this.ensureStartedPromise = undefined;
    let pending = this.stopOwnedDaemonPromise;
    if (!pending) {
      const child = this.child;
      this.child = undefined;
      pending = child ? this.stopChild(child) : Promise.resolve();
      this.stopOwnedDaemonPromise = pending;
      pending.then(
        () => {
          if (this.stopOwnedDaemonPromise === pending) {
            this.stopOwnedDaemonPromise = undefined;
          }
        },
        () => {
          if (this.stopOwnedDaemonPromise === pending) {
            this.stopOwnedDaemonPromise = undefined;
          }
        },
      );
    }
    return pending.then(() => {
      if (stopStatusGeneration === this.statusGeneration) {
        this.update({ state: "disconnected", baseUrl: this.options.baseUrl, ownedByDesktop: false });
      }
    });
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill("SIGTERM");
    const exited = await waitForExit(child, this.options.shutdownTimeoutMs ?? 3_000);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      this.options.onDiagnostic?.("daemon.force_killed", { pid: child.pid ?? null });
      child.kill("SIGKILL");
      await waitForExit(child, 1_000);
    }
  }

  private isStartupCurrent(startupGeneration: number): boolean {
    return startupGeneration === this.startupGeneration;
  }

  private assertStartupCurrent(startupGeneration: number): void {
    if (!this.isStartupCurrent(startupGeneration)) {
      throw new Error("daemon_start_cancelled");
    }
  }

  private async probeDaemon(): Promise<DaemonProbeResult> {
    const authorityGeneration = this.cuaDriverAuthorityGeneration;
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
    const body = await response.json().catch(() => ({})) as {
      service?: unknown;
      defaultWorkspaceCwd?: unknown;
    };
    if (body.service !== "ling-stack-daemon") {
      return "occupied";
    }
    if (body.defaultWorkspaceCwd !== this.defaultWorkspaceCwd) {
      return "incompatible";
    }
    if (!this.options.desktopBridgeToken) {
      if (this.bundledCuaDriverGateEnabled) {
        return "incompatible";
      }
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
      const compatibility: unknown = await handshake.json();
      if (isCuaDriverDesktopBridgeHandshakeResponseV1(compatibility)) {
        if (
          compatibility.routeTokenAccepted !== true
          || compatibility.defaultWorkspaceCwd !== this.defaultWorkspaceCwd
        ) {
          return "incompatible";
        }
        if (
          this.bundledCuaDriverGateEnabled
          && authorityGeneration === this.cuaDriverAuthorityGeneration
        ) {
          this.cuaDriverAuthorityTupleValue = Object.freeze({
            daemonAuthorityEpoch: compatibility.daemonAuthorityEpoch,
            bridgeConnectionId: compatibility.bridgeConnectionId,
            desktopInstanceEpoch: compatibility.desktopInstanceEpoch,
            workspaceCwd: compatibility.defaultWorkspaceCwd,
            readinessDetailsV1: compatibility.capabilities.includes(
              CUA_DRIVER_READINESS_DETAILS_V1_CAPABILITY,
            ),
          });
        }
        return "compatible";
      }
      if (this.bundledCuaDriverGateEnabled) {
        return "incompatible";
      }
      return isLegacyPreviewHandshakeCompatible(compatibility, this.defaultWorkspaceCwd)
        ? "compatible"
        : "incompatible";
    } catch {
      // The daemon answered health, so a missing/timed-out handshake is an
      // incompatible daemon, not an invitation to spawn another process on
      // the same occupied port.
      return "incompatible";
    }
  }

  private clearCuaDriverAuthorityTuple(): void {
    this.cuaDriverAuthorityGeneration += 1;
    this.cuaDriverAuthorityTupleValue = undefined;
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

function isLegacyPreviewHandshakeCompatible(value: unknown, workspaceCwd: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const compatibility = value as Readonly<Record<string, unknown>>;
  return compatibility.protocolVersion === 1
    && Array.isArray(compatibility.capabilities)
    && compatibility.capabilities.every((capability) => typeof capability === "string")
    && compatibility.capabilities.includes("preview-source")
    && compatibility.bridgeTokenAccepted === true
    && compatibility.routeTokenAccepted === true
    && compatibility.defaultWorkspaceCwd === workspaceCwd;
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
  switch (code) {
    case "child_exited":
      return `daemon_child_exited_before_ready: ${baseUrl}`;
    case "start_timeout":
      return `daemon_start_timeout: ${baseUrl}`;
    case "resource_missing":
      return `daemon_resource_missing: ${baseUrl}`;
    case "spawn_failed":
      return `daemon_spawn_failed: ${baseUrl}`;
  }
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
