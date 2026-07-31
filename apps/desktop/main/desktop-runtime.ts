import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type {
  BundledCuaDriverPlatform,
  CuaDriverArchitecture,
  CuaDriverFeatureFlags,
} from "@ling-stack/contracts";
import { DEFAULT_LOCKED_COMPUTER_CONTROL_POLICIES } from "@ling-stack/contracts";
import type { DesktopDaemonStatus } from "../shared/desktop-capabilities.js";
import type {
  ComputerControlPermissionKind,
  DesktopCommandResult,
} from "../shared/desktop-capabilities.js";
import {
  CuaDriverDesktopCoordinator,
  type CuaDriverCoordinatorSnapshot,
  type CuaDriverCoordinatorOptions,
} from "./cua-driver/coordinator.js";
import {
  desktopBundledCuaDriverGateEnabled,
  resolveDesktopCuaDriverFeatureFlags,
} from "./cua-driver/feature-gates.js";
import {
  CuaDriverAvailabilityPublisher,
  HttpCuaDriverAvailabilityClient,
  type CuaDriverAvailabilityClient,
} from "./cua-driver/availability-publisher.js";
import {
  normalizeCuaDriverPlatformBindingMetadata,
  selectCuaDriverPlatformBinding,
  type CuaDriverPlatformBinding,
} from "./cua-driver/platform-binding.js";
import type { CuaDriverDesktopPlatformOwner } from "./cua-driver/platform-owner.js";
import { createCuaDriverTelemetry } from "./cua-driver/telemetry.js";
import type {
  DesktopDaemonCuaDriverAuthorityTuple,
  DesktopDaemonLifecycle,
} from "./daemon-lifecycle.js";
import { createLockedControlCapabilityAttestor } from "./locked-computer-control/capability-attestor.js";
import { createLockedControlDaemonClient } from "./locked-computer-control/daemon-client.js";
import { createLockedControlIdentityVerifier } from "./locked-computer-control/identity-verifier.js";
import {
  LockedComputerControlPolicyCoordinator,
  type LockedControlPolicyCoordinatorSnapshot,
  type LockedControlGenerationRuntime,
} from "./locked-computer-control/policy-coordinator.js";
import {
  createLockedTaskContinuationDaemonClient,
  type LockedTaskContinuationDaemonClient,
} from "./locked-task-continuation/daemon-client.js";
import {
  DEFAULT_LOCKED_TASK_CONTINUATION_PREFERENCE,
  type LockedTaskContinuationPreference,
  type LockedTaskContinuationPreferenceStore,
} from "./locked-task-continuation/preference-store.js";
import { readSystemSessionLocked } from "./locked-task-continuation/system-session-lock-state.js";

const LOCKED_TASK_CONTINUATION_LEASE_TTL_MS = 15_000;
const LOCKED_TASK_CONTINUATION_HEARTBEAT_MS = 5_000;

export type DesktopRuntimeErrorCode =
  | "architecture_unsupported"
  | "authority_missing"
  | "platform_owner_conflict"
  | "platform_owner_mismatch"
  | "shutdown_requested";

export class DesktopRuntimeError extends Error {
  constructor(readonly code: DesktopRuntimeErrorCode) {
    super(`desktop_runtime_${code}`);
    this.name = "DesktopRuntimeError";
  }
}

export interface DesktopRuntimeCuaDriverCoordinator {
  /**
   * Validate the packaged provider, start its loopback proxy and publish the
   * generation-scoped availability lease. The provider child itself remains
   * lazy and is spawned only when the daemon opens an MCP session.
   */
  enable(): Promise<CuaDriverCoordinatorSnapshot>;
  restart?(reason?: string): Promise<CuaDriverCoordinatorSnapshot>;
  suspendForSystem?(reason: string): Promise<void>;
  resumeForSystem?(): Promise<void>;
  readonly snapshot?: CuaDriverCoordinatorSnapshot;
  closeCallGateForSecurityBoundary?(reason: string): void;
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
  readonly platformOwner?: CuaDriverDesktopPlatformOwner;
  readonly platformBinding?: CuaDriverPlatformBinding;
  readonly platformBindingFactory?: (platform: BundledCuaDriverPlatform) => CuaDriverPlatformBinding;
  readonly coordinatorFactory?: DesktopRuntimeCuaDriverCoordinatorFactory;
  readonly availabilityClient?: CuaDriverAvailabilityClient;
  readonly lockedTaskContinuationClient?: LockedTaskContinuationDaemonClient;
  readonly lockedTaskContinuationPreferenceStore?: LockedTaskContinuationPreferenceStore;
  readonly readSystemSessionLocked?: () => Promise<boolean | undefined>;
  readonly onDiagnostic?: (event: string, details?: Readonly<Record<string, unknown>>) => void;
  readonly openExternal?: (url: string) => Promise<void>;
  readonly powerMonitor?: {
    on(event: "lock-screen" | "suspend" | "unlock-screen" | "resume", listener: () => void): unknown;
    off(event: "lock-screen" | "suspend" | "unlock-screen" | "resume", listener: () => void): unknown;
  };
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
  private readonly lockedTaskContinuationClient: LockedTaskContinuationDaemonClient;
  private lockedTaskContinuationPreference: LockedTaskContinuationPreference =
    DEFAULT_LOCKED_TASK_CONTINUATION_PREFERENCE;
  private lockedTaskContinuationPreferenceLoaded = false;
  private lockedTaskContinuationPreferenceLoad: Promise<LockedTaskContinuationPreference> | undefined;
  private lockedTaskContinuationOperationTail: Promise<void> = Promise.resolve();
  private lockedTaskContinuationHeartbeat: ReturnType<typeof setInterval> | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private coordinatorValue: DesktopRuntimeCuaDriverCoordinator | undefined;
  private coordinatorAuthority: DesktopDaemonCuaDriverAuthorityTuple | undefined;
  private coordinatorPlatformOwnerReady: boolean | undefined;
  private ensureStartedPromise: Promise<DesktopDaemonStatus> | undefined;
  private restartPromise: Promise<DesktopDaemonStatus> | undefined;
  private stopDaemonStatusObserver: (() => void) | undefined;
  private shutdownRequested = false;
  private shutdownPromise: Promise<void> | undefined;
  private stopPowerMonitor: (() => void) | undefined;
  private systemSessionLocked = false;
  private systemSuspended = false;
  private systemSessionStateKnown = false;
  private systemBoundaryRevision = 0;
  private initialSystemSessionStatePromise: Promise<void> | undefined;
  private lockedControlPolicyCoordinator: LockedComputerControlPolicyCoordinator | undefined;
  private lockedControlSnapshotValue: LockedControlPolicyCoordinatorSnapshot = Object.freeze({
    phase: "off",
    lockEpoch: 0,
  });
  private readonly lockedControlListeners = new Set<(
    snapshot: LockedControlPolicyCoordinatorSnapshot,
  ) => void>();

  constructor(private readonly options: DesktopRuntimeOptions) {
    this.platform = options.platform ?? process.platform;
    this.architecture = options.architecture ?? process.arch;
    this.workspaceCwd = resolve(options.workspaceCwd);
    this.resourcesRoot = resolve(options.resourcesRoot);
    this.userDataPath = resolve(options.userDataPath);
    this.featureFlags = options.featureFlags ?? resolveDesktopCuaDriverFeatureFlags();
    if (options.platformOwner && (options.platformBinding || options.platformBindingFactory)) {
      throw new DesktopRuntimeError("platform_owner_conflict");
    }
    this.coordinatorFactory = options.coordinatorFactory
      ?? ((coordinatorOptions) => new CuaDriverDesktopCoordinator(coordinatorOptions));
    this.lockedTaskContinuationClient = options.lockedTaskContinuationClient
      ?? createLockedTaskContinuationDaemonClient({
        daemonBaseUrl: options.daemonBaseUrl,
        bridgeToken: options.bridgeToken,
      });
    this.desktopInstanceId = options.desktopInstanceId
      ?? `desktop-${randomBytes(16).toString("hex")}`;
    if (desktopBundledCuaDriverGateEnabled(this.featureFlags, this.platform)) {
      this.stopDaemonStatusObserver = options.daemon.onStatusChanged((status) => {
        this.handleDaemonStatusChanged(status);
      });
    }
    // Task continuation is independent from Cua Driver readiness. Even when a
    // provider owner fails to compose, Desktop must still publish lock state.
    if (options.powerMonitor) {
      this.stopPowerMonitor = this.observePowerMonitor(options.powerMonitor);
    }
  }

  get status(): DesktopDaemonStatus {
    return this.options.daemon.status;
  }

  get cuaDriverCoordinator(): DesktopRuntimeCuaDriverCoordinator | undefined {
    return this.coordinatorValue;
  }

  get computerControlPlatform(): "macos" | "windows" | undefined {
    if (
      this.options.packaged !== true
      || !this.options.platformOwner
      || !desktopBundledCuaDriverGateEnabled(this.featureFlags, this.platform)
    ) {
      return undefined;
    }
    return this.platform === "darwin" ? "macos" : this.platform === "win32" ? "windows" : undefined;
  }

  async requestComputerControlPermissions(): Promise<DesktopCommandResult> {
    if (this.computerControlPlatform === "windows") {
      return { accepted: false, reason: "unsupported_platform_action" };
    }
    if (this.computerControlPlatform !== "macos" || !this.options.platformOwner?.requestPermissions) {
      return { accepted: false, reason: "computer_control_unavailable" };
    }
    try {
      await this.options.platformOwner.requestPermissions();
      await this.refreshCuaDriverPlatform("darwin_permission_request");
      return { accepted: true };
    } catch (error) {
      return {
        accepted: false,
        reason: error instanceof Error ? error.message : "permission_request_failed",
      };
    }
  }

  async openComputerControlPermissionSettings(
    permission: ComputerControlPermissionKind,
  ): Promise<DesktopCommandResult> {
    if (this.computerControlPlatform !== "macos") {
      return { accepted: false, reason: "unsupported_platform_action" };
    }
    const url = permission === "accessibility"
      ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
      : "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
    try {
      const openExternal = this.options.openExternal
        ?? (async (target: string) => (await import("electron")).shell.openExternal(target).then(() => undefined));
      await openExternal(url);
      return { accepted: true };
    } catch (error) {
      return {
        accepted: false,
        reason: error instanceof Error ? error.message : "permission_settings_failed",
      };
    }
  }

  revokeLockedComputerControl(): Promise<DesktopCommandResult> {
    return this.lockedControlPolicyCoordinator?.revokeCurrentGrant()
      ?? Promise.resolve({ accepted: false, reason: "locked_control_disabled_by_build" });
  }

  get lockedComputerControlSnapshot(): LockedControlPolicyCoordinatorSnapshot {
    return this.lockedControlSnapshotValue;
  }

  onLockedComputerControlChanged(
    listener: (snapshot: LockedControlPolicyCoordinatorSnapshot) => void,
  ): () => void {
    this.lockedControlListeners.add(listener);
    listener(this.lockedControlSnapshotValue);
    return () => this.lockedControlListeners.delete(listener);
  }

  onStatusChanged(listener: (status: DesktopDaemonStatus) => void): () => void {
    return this.options.daemon.onStatusChanged(listener);
  }

  async getLockedTaskContinuationPreferences(): Promise<{ readonly continueWhileLocked: boolean }> {
    const preference = await this.loadLockedTaskContinuationPreference();
    return Object.freeze({ continueWhileLocked: preference.continueWhileLocked });
  }

  setContinueTasksWhileLocked(enabled: boolean): Promise<DesktopCommandResult> {
    return this.enqueueLockedTaskContinuation(async () => {
      const previous = await this.loadLockedTaskContinuationPreference();
      if (previous.continueWhileLocked === enabled) {
        try {
          await this.publishLockedTaskContinuationState(previous);
          return { accepted: true };
        } catch (error) {
          this.reportLockedTaskContinuationFailure("sync_failed", error);
          return { accepted: false, reason: "locked_task_continuation_sync_failed" };
        }
      }

      const next = Object.freeze({
        schemaVersion: 1 as const,
        continueWhileLocked: enabled,
      });
      let saved = false;
      try {
        await this.options.lockedTaskContinuationPreferenceStore?.save(next);
        saved = true;
        this.lockedTaskContinuationPreference = next;
        await this.publishLockedTaskContinuationState(next);
        return { accepted: true };
      } catch (error) {
        if (!saved) {
          this.lockedTaskContinuationPreference = previous;
          this.reportLockedTaskContinuationFailure("save_failed", error);
          return { accepted: false, reason: "locked_task_continuation_save_failed" };
        }
        try {
          await this.options.lockedTaskContinuationPreferenceStore?.save(previous);
          this.lockedTaskContinuationPreference = previous;
        } catch (rollbackError) {
          // The new value is still the durable truth. Keep memory and Renderer
          // reconcilable with disk instead of claiming a rollback that failed.
          this.lockedTaskContinuationPreference = next;
          this.reportLockedTaskContinuationFailure("rollback_failed", rollbackError);
          await this.publishLockedTaskContinuationState(next).catch(() => undefined);
          return { accepted: false, reason: "locked_task_continuation_rollback_failed" };
        }
        await this.publishLockedTaskContinuationState(previous).catch(() => undefined);
        this.reportLockedTaskContinuationFailure("sync_failed", error);
        return {
          accepted: false,
          reason: "locked_task_continuation_sync_failed",
        };
      }
    });
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
      const [status] = await Promise.all([
        this.options.daemon.ensureStarted(),
        this.ensureInitialSystemSessionState(),
      ]);
      this.assertCanStart();
      await this.syncLockedTaskContinuationState();
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
      await this.syncLockedTaskContinuationState();
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

  /** Rotate only the provider generation after a host permission/session change. */
  refreshCuaDriverPlatform(reason: string): Promise<void> {
    if (this.shutdownRequested) {
      return Promise.reject(new DesktopRuntimeError("shutdown_requested"));
    }
    return this.enqueue(async () => {
      this.assertCanStart();
      if (!desktopBundledCuaDriverGateEnabled(this.featureFlags, this.platform)) {
        return;
      }
      const coordinator = this.coordinatorValue;
      if (!coordinator) {
        await this.reconcileCoordinator();
        return;
      }
      if (coordinator.restart) {
        await coordinator.restart(reason);
        return;
      }
      await this.shutdownCoordinator(reason);
      this.assertCanStart();
      await this.reconcileCoordinator();
    });
  }

  suspendComputerControlForSystem(reason: string): Promise<void> {
    if (this.shutdownRequested) return Promise.resolve();
    if (reason === "system_lock") {
      this.systemSessionLocked = true;
    } else {
      this.systemSuspended = true;
    }
    this.systemSessionStateKnown = true;
    this.systemBoundaryRevision += 1;
    const continuationSync = this.syncLockedTaskContinuationState();
    const lockedPolicy = this.lockedControlPolicyCoordinator;
    const controlSuspension = lockedPolicy
      ? reason === "system_lock"
        ? lockedPolicy.handleLock()
        : lockedPolicy.handleSuspend()
      : this.enqueue(async () => {
          const coordinator = this.coordinatorValue;
          if (!coordinator) return;
          if (coordinator.suspendForSystem) {
            await coordinator.suspendForSystem(reason);
          } else {
            await this.shutdownCoordinator(reason);
          }
        });
    return Promise.all([controlSuspension, continuationSync]).then(() => undefined);
  }

  resumeComputerControlForSystem(kind: "unlock" | "resume" = "unlock"): Promise<void> {
    if (this.shutdownRequested) return Promise.resolve();
    const boundaryWasActive = kind === "unlock"
      ? this.systemSessionLocked
      : this.systemSuspended;
    if (kind === "unlock") {
      this.systemSessionLocked = false;
    } else {
      this.systemSuspended = false;
    }
    this.systemSessionStateKnown = true;
    this.systemBoundaryRevision += 1;
    if (!boundaryWasActive) return Promise.resolve();
    const continuationSync = this.syncLockedTaskContinuationState();
    const lockedPolicy = this.lockedControlPolicyCoordinator;
    if (lockedPolicy) {
      const controlResume = kind === "unlock" ? lockedPolicy.handleUnlock() : lockedPolicy.handleResume();
      return Promise.all([controlResume, continuationSync]).then(() => undefined);
    }
    if (this.systemSessionLocked || this.systemSuspended) return continuationSync;
    const controlResume = this.enqueue(async () => {
      const coordinator = this.coordinatorValue;
      if (!coordinator) {
        await this.reconcileCoordinator();
        return;
      }
      if (coordinator.resumeForSystem) {
        await coordinator.resumeForSystem();
      } else {
        await this.reconcileCoordinator();
      }
    });
    return Promise.all([controlResume, continuationSync]).then(() => undefined);
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
    this.stopObservingDaemonStatus();
    this.stopObservingPowerMonitor();
    this.stopLockedTaskContinuationHeartbeat();
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
      await attempt(() => this.options.platformOwner?.dispose());
      await attempt(() => this.enqueueLockedTaskContinuation(async () => {
        await this.lockedTaskContinuationClient.release?.({
          workspaceCwd: this.workspaceCwd,
          desktopInstanceId: this.desktopInstanceId,
        });
      }));
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
    const platform = bundledPlatform(this.platform);
    const architecture = cuaDriverArchitecture(this.architecture);
    if (!platform || !architecture) {
      await this.shutdownCoordinator("architecture_unsupported");
      throw new DesktopRuntimeError("architecture_unsupported");
    }
    if (authority.workspaceCwd !== this.workspaceCwd) {
      await this.shutdownCoordinator("authority_workspace_mismatch");
      throw new DesktopRuntimeError("authority_missing");
    }
    const existingCoordinator = this.coordinatorValue;
    const sameAuthority = existingCoordinator
      && sameAuthorityTuple(authority, this.coordinatorAuthority);
    if (existingCoordinator && !sameAuthority) {
      await this.shutdownCoordinator("authority_rotated");
      this.assertCanStart();
    }
    const platformOwner = this.options.platformOwner;
    if (platformOwner && platformOwner.platform !== platform) {
      throw new DesktopRuntimeError("platform_owner_mismatch");
    }
    let platformOwnerReady = true;
    try {
      await platformOwner?.start();
    } catch (error) {
      platformOwnerReady = false;
      this.options.onDiagnostic?.("desktop_runtime.cua_driver_platform_observer_unavailable", {
        platform,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.assertCanStart();
    const platformOwnerState = platformOwner ? platformOwnerReady : undefined;
    if (
      existingCoordinator
      && sameAuthority
      && this.coordinatorPlatformOwnerReady === platformOwnerState
    ) {
      // This is deliberately an idempotent revalidation, not a no-op. A
      // transient resource or lease-publication failure may recover while the
      // authenticated daemon tuple remains unchanged.
      await this.enableCoordinator(existingCoordinator, authority, platform);
      return;
    }
    if (existingCoordinator && sameAuthority) {
      await this.shutdownCoordinator("platform_observer_recovered");
      this.assertCanStart();
    }

    // A production main process injects one policy-bound platform owner. Tests
    // and unfinished package slices that omit it retain the fail-closed binding.
    const platformBinding = platformOwnerReady
      ? platformOwner?.binding
        ?? this.options.platformBinding
        ?? this.options.platformBindingFactory?.(platform)
        ?? selectCuaDriverPlatformBinding(platform)
      : selectCuaDriverPlatformBinding(platform);
    const platformMetadata = normalizeCuaDriverPlatformBindingMetadata(
      platformBinding.metadata,
      platform,
    );
    const availabilityPublisher = new CuaDriverAvailabilityPublisher({
      client: this.options.availabilityClient ?? new HttpCuaDriverAvailabilityClient({
        daemonBaseUrl: this.options.daemonBaseUrl,
        bridgeToken: this.options.bridgeToken,
      }),
      authority: Object.freeze({
        desktopInstanceId: this.desktopInstanceId,
        desktopInstanceEpoch: authority.desktopInstanceEpoch,
        bridgeConnectionId: authority.bridgeConnectionId,
        daemonAuthorityEpoch: authority.daemonAuthorityEpoch,
        workspaceCwd: authority.workspaceCwd,
        platform,
        readinessDetailsV1: authority.readinessDetailsV1,
        ...(platformMetadata.integrityCoverage
          ? { integrityCoverage: platformMetadata.integrityCoverage }
          : {}),
        limitations: platformMetadata.limitations,
      }),
      onError: (error, report) => {
        this.options.onDiagnostic?.("desktop_runtime.cua_driver_availability_projection_failed", {
          platform,
          generation: report.generation,
          providerState: report.providerState,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
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
      readinessDetailsV1: authority.readinessDetailsV1,
      platformBinding,
      availabilityPublisher,
      telemetry: createCuaDriverTelemetry({
        onEvent: ({ level, event, details }) => {
          this.options.onDiagnostic?.("desktop_runtime.cua_driver_telemetry", {
            platform,
            level,
            providerEvent: event,
            ...details,
          });
        },
      }),
      onStateChanged: (snapshot) => {
        this.options.onDiagnostic?.("desktop_runtime.cua_driver_state_changed", {
          platform,
          lifecycle: snapshot.lifecycle,
          providerState: snapshot.providerState,
          generation: snapshot.generation,
          pid: snapshot.pid ?? null,
          ...(snapshot.reason ? { reason: snapshot.reason } : {}),
        });
      },
    });
    this.coordinatorValue = coordinator;
    this.coordinatorAuthority = authority;
    this.coordinatorPlatformOwnerReady = platformOwnerState;
    this.lockedControlPolicyCoordinator = this.createLockedControlPolicyCoordinator(
      coordinator,
      authority,
      platform,
    );
    this.options.onDiagnostic?.("desktop_runtime.cua_driver_composed", {
      platform,
      gateEnabled: true,
    });
    await this.enableCoordinator(coordinator, authority, platform);
  }

  private async enableCoordinator(
    coordinator: DesktopRuntimeCuaDriverCoordinator,
    authority: DesktopDaemonCuaDriverAuthorityTuple,
    platform: BundledCuaDriverPlatform,
  ): Promise<void> {
    let snapshot: CuaDriverCoordinatorSnapshot | undefined;
    let enableFailed = false;
    let enableError: unknown;
    try {
      snapshot = await coordinator.enable();
    } catch (error) {
      enableFailed = true;
      enableError = error;
    }

    this.assertCanStart();
    if (!this.isCurrentCoordinatorAuthority(coordinator, authority)) {
      try {
        await this.shutdownCoordinatorInstance(coordinator, "authority_lost_during_enable");
      } catch (error) {
        this.options.onDiagnostic?.("desktop_runtime.cua_driver_authority_cleanup_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw new DesktopRuntimeError("authority_missing");
    }

    if (enableFailed) {
      // Resource, identity or lease publication failures are intentionally
      // fail-closed provider states. Keep the coordinator retained so its
      // state and cleanup ownership remain intact, and so a later idempotent
      // enable or authority restart can recover without making a healthy
      // Desktop daemon look like startup failed.
      this.options.onDiagnostic?.("desktop_runtime.cua_driver_availability_failed", {
        platform,
        error: enableError instanceof Error ? enableError.message : String(enableError),
      });
      return;
    }
    if (snapshot?.lifecycle === "failed") {
      this.options.onDiagnostic?.("desktop_runtime.cua_driver_availability_failed", {
        platform,
        providerState: snapshot.providerState,
        reason: snapshot.reason ?? snapshot.providerState,
      });
    }
    await this.reassertSystemBoundaryAfterEnable(coordinator);
  }

  private async reassertSystemBoundaryAfterEnable(
    coordinator: DesktopRuntimeCuaDriverCoordinator,
  ): Promise<void> {
    const reason = this.systemSessionLocked
      ? "system_lock"
      : this.systemSuspended
        ? "system_suspend"
        : undefined;
    if (!reason || this.coordinatorValue !== coordinator) return;
    coordinator.closeCallGateForSecurityBoundary?.(reason);
    try {
      if (coordinator.suspendForSystem) {
        await coordinator.suspendForSystem(reason);
      } else {
        await this.shutdownCoordinatorInstance(coordinator, reason);
      }
    } catch (error) {
      this.options.onDiagnostic?.("desktop_runtime.cua_driver_system_boundary_reassert_failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.shutdownCoordinatorInstance(coordinator, reason).catch((cleanupError) => {
        this.options.onDiagnostic?.("desktop_runtime.cua_driver_system_boundary_cleanup_failed", {
          reason,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      });
    }
  }

  private createLockedControlPolicyCoordinator(
    coordinator: DesktopRuntimeCuaDriverCoordinator,
    authority: DesktopDaemonCuaDriverAuthorityTuple,
    platform: Exclude<BundledCuaDriverPlatform, "unsupported">,
  ): LockedComputerControlPolicyCoordinator {
    const handshakeAuthority = Object.freeze({
      daemonAuthorityEpoch: authority.daemonAuthorityEpoch,
      bridgeConnectionId: authority.bridgeConnectionId,
      desktopInstanceEpoch: authority.desktopInstanceEpoch,
      workspaceCwd: authority.workspaceCwd,
    });
    const capability = Object.freeze({
      schemaVersion: 1 as const,
      platform,
      state: "disabled_by_build" as const,
      reason: "locked_control_disabled_by_build" as const,
      canCaptureSameUserDesktopWhileLocked: false,
      canInjectSameUserDesktopWhileLocked: false,
      canProveSessionContinuity: false,
      secureSurfaceExcluded: false,
      adapterVersion: `${platform}-locked-control-disabled-v1`,
      osVersion: process.version,
      observedAt: new Date().toISOString(),
    });
    const daemon = createLockedControlDaemonClient({
      daemonBaseUrl: this.options.daemonBaseUrl,
      workspaceCwd: this.workspaceCwd,
      bridgeToken: this.options.bridgeToken,
    });
    let policyCoordinator: LockedComputerControlPolicyCoordinator | undefined;
    let lastReservedGeneration = 0;
    const runtime: LockedControlGenerationRuntime = {
      readAuthority: () => ({
        platform,
        desktopInstanceId: this.desktopInstanceId,
        desktopInstanceEpoch: authority.desktopInstanceEpoch,
        daemonAuthorityEpoch: authority.daemonAuthorityEpoch,
        bridgeConnectionId: authority.bridgeConnectionId,
        workspaceCwd: authority.workspaceCwd,
        normalGeneration: coordinator.snapshot?.generation ?? 0,
        lockEpoch: policyCoordinator?.snapshot().lockEpoch ?? 0,
        // A packaged native session adapter must provide this before the
        // policy can move beyond fixed Off. Never synthesize a digest.
      }),
      closeCallGate: (reason) => coordinator.closeCallGateForSecurityBoundary?.(reason),
      retireNormalForLock: async (reason) => {
        if (!coordinator.suspendForSystem) throw new Error("locked_control_runtime_unavailable");
        await coordinator.suspendForSystem(
          reason === "locked_control_suspend" ? "system_suspend" : "system_lock",
        );
      },
      reserveLockedGeneration: () => {
        const current = coordinator.snapshot?.generation ?? 0;
        lastReservedGeneration = Math.max(lastReservedGeneration + 1, current + 1);
        if (!Number.isSafeInteger(lastReservedGeneration)) {
          throw new Error("locked_control_generation_exhausted");
        }
        return lastReservedGeneration;
      },
      async startLockedGeneration() {
        // Product builds remain fixed Off until a packaged native capability
        // and an exact restricted-generation launcher are promoted together.
        throw new Error("locked_control_disabled_by_build");
      },
      async stopLockedGeneration() {},
      resumeNormal: async () => {
        if (this.systemSessionLocked || this.systemSuspended) return;
        await coordinator.resumeForSystem?.();
        const reason = this.systemSessionLocked
          ? "system_lock"
          : this.systemSuspended
            ? "system_suspend"
            : undefined;
        if (reason) {
          coordinator.closeCallGateForSecurityBoundary?.(reason);
          await coordinator.suspendForSystem?.(reason);
        }
      },
    };
    const identityVerifier = createLockedControlIdentityVerifier({
      platform,
      localizedReason: "Authorize Ling to control this computer for the current task",
      readContext: () => {
        throw new Error("locked_control_native_session_binding_unavailable");
      },
    });
    policyCoordinator = new LockedComputerControlPolicyCoordinator({
      policy: DEFAULT_LOCKED_COMPUTER_CONTROL_POLICIES[platform],
      capability: () => capability,
      daemon,
      identityVerifier,
      attestor: createLockedControlCapabilityAttestor({}),
      runtime,
      onStateChanged: (snapshot) => {
        this.lockedControlSnapshotValue = snapshot;
        for (const listener of this.lockedControlListeners) {
          try {
            listener(snapshot);
          } catch {
            // UI observers do not own locked-control authority.
          }
        }
        this.options.onDiagnostic?.("desktop_runtime.locked_control_state_changed", {
          phase: snapshot.phase,
          lockEpoch: snapshot.lockEpoch,
          ...(snapshot.reason ? { reason: snapshot.reason } : {}),
        });
      },
    });
    void daemon.publishCapability({
      authority: handshakeAuthority,
      capability,
      buildId: "ling-desktop-locked-control-v1",
    }).catch((error) => {
      this.options.onDiagnostic?.("desktop_runtime.locked_control_capability_publish_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return policyCoordinator;
  }

  private isCurrentCoordinatorAuthority(
    coordinator: DesktopRuntimeCuaDriverCoordinator,
    authority: DesktopDaemonCuaDriverAuthorityTuple,
  ): boolean {
    return this.options.daemon.status.state === "connected"
      && this.coordinatorValue === coordinator
      && sameAuthorityTuple(authority, this.coordinatorAuthority)
      && sameAuthorityTuple(authority, this.options.daemon.cuaDriverAuthorityTuple);
  }

  private async shutdownCoordinator(reason: string): Promise<void> {
    const coordinator = this.coordinatorValue;
    if (!coordinator) {
      return;
    }
    await this.shutdownCoordinatorInstance(coordinator, reason);
  }

  private async shutdownCoordinatorInstance(
    coordinator: DesktopRuntimeCuaDriverCoordinator,
    reason: string,
  ): Promise<void> {
    if (this.coordinatorValue !== coordinator) {
      return;
    }
    this.options.onDiagnostic?.("desktop_runtime.cua_driver_shutdown", { reason });
    const lockedPolicy = this.lockedControlPolicyCoordinator;
    this.lockedControlPolicyCoordinator = undefined;
    await lockedPolicy?.shutdown();
    await coordinator.shutdown();
    if (this.coordinatorValue === coordinator) {
      this.coordinatorValue = undefined;
      this.coordinatorAuthority = undefined;
      this.coordinatorPlatformOwnerReady = undefined;
    }
  }

  private handleDaemonStatusChanged(status: DesktopDaemonStatus): void {
    if (status.state === "connected" || this.shutdownRequested) {
      return;
    }
    const coordinator = this.coordinatorValue;
    if (!coordinator) {
      // Initial checking/starting events must never enqueue cleanup for a
      // coordinator that may be composed later by the same startup attempt.
      return;
    }
    const reason = `daemon_status_${status.state}`;
    void this.enqueue(async () => {
      if (this.shutdownRequested || this.coordinatorValue !== coordinator) {
        return;
      }
      await this.shutdownCoordinatorInstance(coordinator, reason);
    }).catch((error) => {
      this.options.onDiagnostic?.("desktop_runtime.cua_driver_status_cleanup_failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private stopObservingDaemonStatus(): void {
    const stopObserver = this.stopDaemonStatusObserver;
    this.stopDaemonStatusObserver = undefined;
    if (!stopObserver) {
      return;
    }
    try {
      stopObserver();
    } catch (error) {
      this.options.onDiagnostic?.("desktop_runtime.cua_driver_status_observer_stop_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private observePowerMonitor(monitor: NonNullable<DesktopRuntimeOptions["powerMonitor"]>): () => void {
    const onLock = (): void => {
      void this.suspendComputerControlForSystem("system_lock").catch(() => undefined);
    };
    const onSuspend = (): void => {
      void this.suspendComputerControlForSystem("system_suspend").catch(() => undefined);
    };
    const onUnlock = (): void => {
      void this.resumeComputerControlForSystem("unlock").catch(() => undefined);
    };
    const onResume = (): void => {
      void this.resumeComputerControlForSystem("resume").catch(() => undefined);
    };
    monitor.on("lock-screen", onLock);
    monitor.on("suspend", onSuspend);
    monitor.on("unlock-screen", onUnlock);
    monitor.on("resume", onResume);
    return () => {
      monitor.off("lock-screen", onLock);
      monitor.off("suspend", onSuspend);
      monitor.off("unlock-screen", onUnlock);
      monitor.off("resume", onResume);
    };
  }

  private stopObservingPowerMonitor(): void {
    const stop = this.stopPowerMonitor;
    this.stopPowerMonitor = undefined;
    if (!stop) return;
    try {
      stop();
    } catch (error) {
      this.options.onDiagnostic?.("desktop_runtime.cua_driver_power_monitor_stop_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private loadLockedTaskContinuationPreference(): Promise<LockedTaskContinuationPreference> {
    if (this.lockedTaskContinuationPreferenceLoaded) {
      return Promise.resolve(this.lockedTaskContinuationPreference);
    }
    if (this.lockedTaskContinuationPreferenceLoad) {
      return this.lockedTaskContinuationPreferenceLoad;
    }
    const pending = (async () => {
      const preference = await this.options.lockedTaskContinuationPreferenceStore?.load()
        ?? DEFAULT_LOCKED_TASK_CONTINUATION_PREFERENCE;
      this.lockedTaskContinuationPreference = preference;
      this.lockedTaskContinuationPreferenceLoaded = true;
      return preference;
    })();
    this.lockedTaskContinuationPreferenceLoad = pending;
    void pending.finally(() => {
      if (this.lockedTaskContinuationPreferenceLoad === pending) {
        this.lockedTaskContinuationPreferenceLoad = undefined;
      }
    }).catch(() => undefined);
    return pending;
  }

  private syncLockedTaskContinuationState(): Promise<void> {
    const pending = this.enqueueLockedTaskContinuation(async () => {
      const preference = await this.loadLockedTaskContinuationPreference();
      await this.publishLockedTaskContinuationState(preference);
    });
    return pending.catch((error) => {
      this.reportLockedTaskContinuationFailure("sync_failed", error);
      throw error;
    });
  }

  private async publishLockedTaskContinuationState(
    preference: LockedTaskContinuationPreference,
  ): Promise<void> {
    await this.lockedTaskContinuationClient.publish({
      workspaceCwd: this.workspaceCwd,
      desktopInstanceId: this.desktopInstanceId,
      leaseTtlMs: LOCKED_TASK_CONTINUATION_LEASE_TTL_MS,
      continueWhileLocked: preference.continueWhileLocked,
      locked: this.systemSessionLocked || this.systemSuspended,
    });
    this.ensureLockedTaskContinuationHeartbeat();
  }

  private ensureInitialSystemSessionState(): Promise<void> {
    if (this.systemSessionStateKnown) return Promise.resolve();
    if (this.initialSystemSessionStatePromise) return this.initialSystemSessionStatePromise;
    const boundaryRevision = this.systemBoundaryRevision;
    const pending = (async () => {
      const locked = await (this.options.readSystemSessionLocked?.()
        ?? readSystemSessionLocked(this.platform as NodeJS.Platform));
      if (this.systemSessionStateKnown || this.systemBoundaryRevision !== boundaryRevision) return;
      this.systemSessionLocked = locked ?? true;
      this.systemSessionStateKnown = true;
      if (locked === undefined) {
        this.options.onDiagnostic?.("desktop_runtime.locked_task_initial_state_unknown", {
          platform: this.platform,
          failClosed: true,
        });
      }
    })();
    this.initialSystemSessionStatePromise = pending;
    void pending.finally(() => {
      if (this.initialSystemSessionStatePromise === pending) {
        this.initialSystemSessionStatePromise = undefined;
      }
    }).catch(() => undefined);
    return pending;
  }

  private ensureLockedTaskContinuationHeartbeat(): void {
    if (this.lockedTaskContinuationHeartbeat || this.shutdownRequested) return;
    this.lockedTaskContinuationHeartbeat = setInterval(() => {
      if (this.shutdownRequested) return;
      void this.syncLockedTaskContinuationState().catch(() => undefined);
    }, LOCKED_TASK_CONTINUATION_HEARTBEAT_MS);
    if (typeof this.lockedTaskContinuationHeartbeat.unref === "function") {
      this.lockedTaskContinuationHeartbeat.unref();
    }
  }

  private stopLockedTaskContinuationHeartbeat(): void {
    if (!this.lockedTaskContinuationHeartbeat) return;
    clearInterval(this.lockedTaskContinuationHeartbeat);
    this.lockedTaskContinuationHeartbeat = undefined;
  }

  private enqueueLockedTaskContinuation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.lockedTaskContinuationOperationTail.then(operation, operation);
    this.lockedTaskContinuationOperationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private reportLockedTaskContinuationFailure(reason: string, error: unknown): void {
    this.options.onDiagnostic?.("desktop_runtime.locked_task_continuation_failed", {
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
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
    && left.workspaceCwd === right.workspaceCwd
    && left.readinessDetailsV1 === right.readinessDetailsV1,
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
