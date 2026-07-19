import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type {
  BundledCuaDriverPlatform,
  CuaDriverArchitecture,
  CuaDriverFeatureFlags,
} from "@ling-stack/contracts";
import type { DesktopDaemonStatus } from "../shared/desktop-capabilities.js";
import {
  CuaDriverDesktopCoordinator,
  type CuaDriverCoordinatorOptions,
} from "./cua-driver/coordinator.js";
import {
  desktopBundledCuaDriverGateEnabled,
  resolveDesktopCuaDriverFeatureFlags,
} from "./cua-driver/feature-gates.js";
import {
  selectCuaDriverPlatformBinding,
  type CuaDriverPlatformBinding,
} from "./cua-driver/platform-binding.js";
import type {
  DesktopDaemonCuaDriverAuthorityTuple,
  DesktopDaemonLifecycle,
} from "./daemon-lifecycle.js";

export type DesktopRuntimeErrorCode =
  | "architecture_unsupported"
  | "authority_missing"
  | "shutdown_requested";

export class DesktopRuntimeError extends Error {
  constructor(readonly code: DesktopRuntimeErrorCode) {
    super(`desktop_runtime_${code}`);
    this.name = "DesktopRuntimeError";
  }
}

export interface DesktopRuntimeCuaDriverCoordinator {
  shutdown(): Promise<void>;
}

export type DesktopRuntimeCuaDriverCoordinatorFactory = (
  options: CuaDriverCoordinatorOptions,
) => DesktopRuntimeCuaDriverCoordinator;

export type DesktopRuntimeDaemon = Pick<
  DesktopDaemonLifecycle,
  | "status"
  | "cuaDriverAuthorityTuple"
  | "ensureStarted"
  | "restart"
  | "stopOwnedDaemon"
  | "onStatusChanged"
>;

export interface DesktopRuntimeOptions {
  readonly daemon: DesktopRuntimeDaemon;
  readonly daemonBaseUrl: string;
  readonly bridgeToken: string;
  readonly workspaceCwd: string;
  readonly resourcesRoot: string;
  readonly userDataPath: string;
  readonly platform?: string;
  readonly architecture?: string;
  readonly featureFlags?: CuaDriverFeatureFlags;
  readonly packaged?: boolean;
  readonly requireReleaseEvidence?: boolean;
  readonly desktopInstanceId?: string;
  readonly platformBinding?: CuaDriverPlatformBinding;
  readonly platformBindingFactory?: (platform: BundledCuaDriverPlatform) => CuaDriverPlatformBinding;
  readonly coordinatorFactory?: DesktopRuntimeCuaDriverCoordinatorFactory;
  readonly onDiagnostic?: (event: string, details?: Readonly<Record<string, unknown>>) => void;
}

/**
 * Process-wide owner for the daemon connection and its authority-bound provider
 * coordinator. BrowserWindow visibility never participates in this lifecycle.
 */
export class DesktopRuntime {
  readonly desktopInstanceId: string;

  private readonly platform: string;
  private readonly architecture: string;
  private readonly workspaceCwd: string;
  private readonly resourcesRoot: string;
  private readonly userDataPath: string;
  private readonly featureFlags: CuaDriverFeatureFlags;
  private readonly coordinatorFactory: DesktopRuntimeCuaDriverCoordinatorFactory;
  private operationTail: Promise<void> = Promise.resolve();
  private coordinatorValue: DesktopRuntimeCuaDriverCoordinator | undefined;
  private coordinatorAuthority: DesktopDaemonCuaDriverAuthorityTuple | undefined;
  private ensureStartedPromise: Promise<DesktopDaemonStatus> | undefined;
  private restartPromise: Promise<DesktopDaemonStatus> | undefined;
  private shutdownRequested = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(private readonly options: DesktopRuntimeOptions) {
    this.platform = options.platform ?? process.platform;
    this.architecture = options.architecture ?? process.arch;
    this.workspaceCwd = resolve(options.workspaceCwd);
    this.resourcesRoot = resolve(options.resourcesRoot);
    this.userDataPath = resolve(options.userDataPath);
    this.featureFlags = options.featureFlags ?? resolveDesktopCuaDriverFeatureFlags();
    this.coordinatorFactory = options.coordinatorFactory
      ?? ((coordinatorOptions) => new CuaDriverDesktopCoordinator(coordinatorOptions));
    this.desktopInstanceId = options.desktopInstanceId
      ?? `desktop-${randomBytes(16).toString("hex")}`;
  }

  get status(): DesktopDaemonStatus {
    return this.options.daemon.status;
  }

  get cuaDriverCoordinator(): DesktopRuntimeCuaDriverCoordinator | undefined {
    return this.coordinatorValue;
  }

  onStatusChanged(listener: (status: DesktopDaemonStatus) => void): () => void {
    return this.options.daemon.onStatusChanged(listener);
  }

  /** Idempotent for one daemon handshake tuple, including window reopen. */
  ensureStarted(): Promise<DesktopDaemonStatus> {
    if (this.shutdownRequested) {
      return Promise.reject(new DesktopRuntimeError("shutdown_requested"));
    }
    if (this.ensureStartedPromise) {
      return this.ensureStartedPromise;
    }
    const pending = this.enqueue(async () => {
      this.assertCanStart();
      const status = await this.options.daemon.ensureStarted();
      this.assertCanStart();
      await this.reconcileCoordinator();
      return status;
    });
    this.ensureStartedPromise = pending;
    void pending.finally(() => {
      if (this.ensureStartedPromise === pending) {
        this.ensureStartedPromise = undefined;
      }
    }).catch(() => undefined);
    return pending;
  }

  /** Revoke the old coordinator before asking the daemon for a fresh tuple. */
  restart(): Promise<DesktopDaemonStatus> {
    if (this.shutdownRequested) {
      return Promise.reject(new DesktopRuntimeError("shutdown_requested"));
    }
    if (this.restartPromise) {
      return this.restartPromise;
    }
    const pending = this.enqueue(async () => {
      this.assertCanStart();
      let firstError: unknown;
      try {
        await this.shutdownCoordinator("daemon_restart");
      } catch (error) {
        firstError = error;
      }
      this.assertCanStart();
      let status: DesktopDaemonStatus | undefined;
      try {
        status = await this.options.daemon.restart();
      } catch (error) {
        firstError ??= error;
      }
      this.assertCanStart();
      if (firstError !== undefined) {
        // A fresh daemon handshake fences the old lease, but an incompletely
        // stopped local coordinator must block creation of another provider.
        throw firstError;
      }
      if (!status) {
        throw new Error("desktop_runtime_restart_status_missing");
      }
      await this.reconcileCoordinator();
      return status;
    });
    this.restartPromise = pending;
    void pending.finally(() => {
      if (this.restartPromise === pending) {
        this.restartPromise = undefined;
      }
    }).catch(() => undefined);
    return pending;
  }

  /**
   * Cleanup is serialized and best-effort-complete: provider/coordinator first,
   * then the Desktop-owned daemon even when the earlier cleanup rejects.
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shutdownRequested = true;
    const pending = this.enqueue(async () => {
      let firstError: unknown;
      const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          firstError ??= error;
        }
      };
      await attempt(() => this.shutdownCoordinator("desktop_quit"));
      await attempt(() => this.options.daemon.stopOwnedDaemon());
      if (firstError !== undefined) {
        throw firstError;
      }
    });
    this.shutdownPromise = pending;
    return pending;
  }

  private async reconcileCoordinator(): Promise<void> {
    const gateEnabled = desktopBundledCuaDriverGateEnabled(this.featureFlags, this.platform);
    if (!gateEnabled) {
      // Closed gates preserve the current preview/external runtime exactly and
      // must not even construct a provider coordinator.
      await this.shutdownCoordinator("feature_gate_closed");
      return;
    }
    const authority = this.options.daemon.cuaDriverAuthorityTuple;
    if (!authority) {
      await this.shutdownCoordinator("authority_unavailable");
      throw new DesktopRuntimeError("authority_missing");
    }
    if (sameAuthorityTuple(authority, this.coordinatorAuthority) && this.coordinatorValue) {
      return;
    }
    await this.shutdownCoordinator("authority_rotated");
    this.assertCanStart();

    const platform = bundledPlatform(this.platform);
    const architecture = cuaDriverArchitecture(this.architecture);
    if (!platform || !architecture) {
      throw new DesktopRuntimeError("architecture_unsupported");
    }
    if (authority.workspaceCwd !== this.workspaceCwd) {
      throw new DesktopRuntimeError("authority_missing");
    }
    const platformBinding = this.options.platformBinding
      ?? this.options.platformBindingFactory?.(platform)
      ?? selectCuaDriverPlatformBinding(platform);
    const coordinator = this.coordinatorFactory({
      platform,
      architecture,
      resourcesPath: this.resourcesRoot,
      userDataPath: this.userDataPath,
      workspaceCwd: this.workspaceCwd,
      daemonBaseUrl: this.options.daemonBaseUrl,
      bridgeContext: Object.freeze({
        bridgeToken: this.options.bridgeToken,
        daemonAuthorityEpoch: authority.daemonAuthorityEpoch,
        bridgeConnectionId: authority.bridgeConnectionId,
        desktopInstanceEpoch: authority.desktopInstanceEpoch,
        workspaceCwd: authority.workspaceCwd,
      }),
      desktopInstanceId: this.desktopInstanceId,
      featureFlags: this.featureFlags,
      packaged: this.options.packaged,
      requireReleaseEvidence: this.options.requireReleaseEvidence,
      platformBinding,
    });
    this.coordinatorValue = coordinator;
    this.coordinatorAuthority = authority;
    this.options.onDiagnostic?.("desktop_runtime.cua_driver_composed", {
      platform,
      gateEnabled: true,
    });
  }

  private async shutdownCoordinator(reason: string): Promise<void> {
    const coordinator = this.coordinatorValue;
    if (!coordinator) {
      return;
    }
    this.options.onDiagnostic?.("desktop_runtime.cua_driver_shutdown", { reason });
    await coordinator.shutdown();
    if (this.coordinatorValue === coordinator) {
      this.coordinatorValue = undefined;
      this.coordinatorAuthority = undefined;
    }
  }

  private assertCanStart(): void {
    if (this.shutdownRequested) {
      throw new DesktopRuntimeError("shutdown_requested");
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operationTail.then(operation, operation);
    this.operationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}

function sameAuthorityTuple(
  left: DesktopDaemonCuaDriverAuthorityTuple | undefined,
  right: DesktopDaemonCuaDriverAuthorityTuple | undefined,
): boolean {
  return Boolean(
    left
    && right
    && left.daemonAuthorityEpoch === right.daemonAuthorityEpoch
    && left.bridgeConnectionId === right.bridgeConnectionId
    && left.desktopInstanceEpoch === right.desktopInstanceEpoch
    && left.workspaceCwd === right.workspaceCwd,
  );
}

function bundledPlatform(platform: string): BundledCuaDriverPlatform | undefined {
  return platform === "darwin" || platform === "win32" ? platform : undefined;
}

function cuaDriverArchitecture(architecture: string): CuaDriverArchitecture | undefined {
  return architecture === "arm64"
    ? "arm64"
    : architecture === "x64" || architecture === "x86_64"
      ? "x86_64"
      : undefined;
}
