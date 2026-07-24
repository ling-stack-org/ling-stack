import { randomBytes } from "node:crypto";
import type {
  BundledCuaDriverPlatform,
  CuaDriverArchitecture,
  CuaDriverFeatureFlags,
  CuaDriverIntegrityCoverage,
  CuaDriverLimitation,
  CuaDriverProviderState,
  DesktopCuaDriverLeaseV1,
} from "@ling-stack/contracts";
import { desktopBundledCuaDriverGateEnabled, resolveDesktopCuaDriverFeatureFlags } from "./feature-gates.js";
import {
  CuaDriverArtifactLockError,
  readCuaDriverProviderLock,
  type CuaDriverProviderLockValidationOptions,
} from "./artifact-lock.js";
import {
  CuaDriverProviderSealError,
  CuaDriverPlatformIdentityVerificationError,
  verifyCuaDriverProviderArtifacts,
  type CuaDriverPlatformIdentityVerifier,
  type VerifiedCuaDriverArtifacts,
} from "./provider-seal.js";
import {
  CuaDriverResourcePathError,
  resolveCuaDriverResourcePaths,
  type CuaDriverResourcePaths,
} from "./resource-path.js";
import {
  CuaDriverStateRootError,
  createCuaDriverStateRoot,
  reverifyCuaDriverStateRoot,
  type CuaDriverStateRoot,
  type CuaDriverStateRootPlatformProtector,
} from "./state-root.js";
import {
  CuaDriverProviderHostError,
  CuaDriverProviderPreSpawnError,
  CuaDriverProviderHost,
  type CuaDriverProviderHostOptions,
  type CuaDriverProviderProcessLifecycle,
} from "./provider-host.js";
import {
  CuaDriverMcpProxy,
  type CuaDriverMcpProxyPublicEndpoint,
  type CuaDriverProxyContext,
  publicCuaDriverMcpProxyEndpoint,
} from "./mcp-proxy.js";
import {
  CuaDriverLeasePublisherError,
  CuaDriverLeasePublisher,
  HttpCuaDriverLeaseClient,
  type CuaDriverLeaseClient,
} from "./lease-publisher.js";
import { createCuaDriverTelemetry, type CuaDriverTelemetrySink } from "./telemetry.js";
import {
  FailClosedCuaDriverReadinessController,
  GenerationFencedCuaDriverReadiness,
  WindowsActiveChildReadinessController,
  type CuaDriverReadinessController,
  type CuaDriverReadinessResult,
  type CuaDriverWindowsSessionRecoveryHint,
  type CuaDriverWindowsSessionRecoveryObserver,
} from "./readiness-controller.js";
import {
  assertCuaDriverPlatformBinding,
  CuaDriverPlatformBindingError,
  normalizeCuaDriverPlatformBindingMetadata,
  type CuaDriverPlatformBinding,
  type CuaDriverPlatformBindingMetadata,
} from "./platform-binding.js";
import type { CuaDriverAvailabilityPublisher } from "./availability-publisher.js";

export type CuaDriverCoordinatorLifecycle = "disabled" | "validating" | "included" | "starting" | "active" | "stopping" | "failed";

export interface CuaDriverCoordinatorSnapshot {
  readonly lifecycle: CuaDriverCoordinatorLifecycle;
  readonly providerState: CuaDriverProviderState;
  readonly generation: number;
  readonly endpoint?: CuaDriverMcpProxyPublicEndpoint;
  readonly pid?: number;
  readonly reason?: string;
  readonly integrityCoverage?: CuaDriverIntegrityCoverage;
  readonly limitations?: readonly CuaDriverLimitation[];
  readonly artifacts?: {
    readonly lockDigest: string;
    readonly providerSealDigest: string;
    readonly providerCatalogDigest?: string;
  };
}

export interface CuaDriverCoordinatorOptions {
  readonly platform: BundledCuaDriverPlatform;
  readonly architecture: CuaDriverArchitecture;
  readonly resourcesPath: string;
  readonly userDataPath: string;
  readonly workspaceCwd: string;
  readonly daemonBaseUrl: string;
  readonly bridgeContext: Omit<CuaDriverProxyContext, "generation">;
  readonly desktopInstanceId?: string;
  readonly featureFlags?: CuaDriverFeatureFlags;
  readonly packaged?: boolean;
  readonly requireReleaseEvidence?: boolean;
  /** Preferred production composition boundary for one coherent OS adapter. */
  readonly platformBinding?: CuaDriverPlatformBinding;
  /** Fixture-only fine-grained injection; cannot be mixed with platformBinding. */
  readonly platformIdentityVerifier?: CuaDriverPlatformIdentityVerifier;
  readonly stateRootProtector?: CuaDriverStateRootPlatformProtector;
  readonly processLifecycle?: CuaDriverProviderProcessLifecycle;
  readonly readinessController?: CuaDriverReadinessController;
  readonly windowsSessionRecoveryObserver?: CuaDriverWindowsSessionRecoveryObserver;
  readonly leaseClient?: CuaDriverLeaseClient;
  readonly fetch?: typeof globalThis.fetch;
  readonly telemetry?: CuaDriverTelemetrySink;
  readonly availabilityPublisher?: Pick<CuaDriverAvailabilityPublisher, "publish" | "close">;
  readonly onStateChanged?: (snapshot: CuaDriverCoordinatorSnapshot) => void;
}

type CuaDriverPendingRecoveryAction =
  | { readonly mode: "retry"; readonly reason: string; readonly generation: number }
  | {
      readonly mode: "terminal";
      readonly reason: string;
      readonly generation: number;
      readonly providerState: Extract<CuaDriverProviderState, "corrupt" | "platform_unavailable">;
    };

const WINDOWS_SESSION_OBSERVER_UNAVAILABLE_REASON = "windows_session_observer_unavailable";

/**
 * Platform-neutral Desktop owner. Native TCC/WTS/Job Object checks are injected
 * by PR6/PR7; this module owns ordering and fencing only.
 */
export class CuaDriverDesktopCoordinator {
  private readonly telemetry: CuaDriverTelemetrySink;
  private readonly desktopInstanceId: string;
  private readonly featureFlags: CuaDriverFeatureFlags;
  private readonly platformUnavailableReason: string | undefined;
  private readonly platformMetadata: CuaDriverPlatformBindingMetadata | undefined;
  private readonly platformIdentityVerifier: CuaDriverPlatformIdentityVerifier | undefined;
  private readonly stateRootProtector: CuaDriverStateRootPlatformProtector | undefined;
  private readonly processLifecycle: CuaDriverProviderProcessLifecycle | undefined;
  private readonly readinessController: CuaDriverReadinessController;
  private readonly availabilityPublisher:
    | Pick<CuaDriverAvailabilityPublisher, "publish" | "close">
    | undefined;
  private snapshotValue: CuaDriverCoordinatorSnapshot = {
    lifecycle: "disabled",
    providerState: "included",
    generation: 0,
  };
  private generation = 0;
  private enablePromise: Promise<CuaDriverCoordinatorSnapshot> | undefined;
  private disablePromise: Promise<void> | undefined;
  private disableBarrierPromise: Promise<void> | undefined;
  private stateRoot: CuaDriverStateRoot | undefined;
  private resourcePaths: CuaDriverResourcePaths | undefined;
  private artifacts: VerifiedCuaDriverArtifacts | undefined;
  private host: CuaDriverProviderHost | undefined;
  private proxy: CuaDriverMcpProxy | undefined;
  private leasePublisher: CuaDriverLeasePublisher | undefined;
  private stopped = false;
  private cleanupDebt = false;
  private requestedEnabled = false;
  private requestedRevision = 0;
  private recoveryPromise: Promise<void> | undefined;
  private sessionTransitionPromise: Promise<void> | undefined;
  private pendingRecoveryAction: CuaDriverPendingRecoveryAction | undefined;
  private recoveryAttempt = 0;
  private windowsSessionSuspended = false;
  private windowsSessionResumeHintPending = false;
  private windowsSessionSuspensionReason = "windows_interactive_session_required";
  private pendingWindowsSessionSuspension: { readonly reason: string; readonly generation: number } | undefined;
  private stopWindowsSessionRecoveryObserver: (() => void) | undefined;

  constructor(private readonly options: CuaDriverCoordinatorOptions) {
    if (options.bridgeContext.workspaceCwd !== options.workspaceCwd) {
      throw new Error("cua_driver_bridge_workspace_mismatch");
    }
    this.telemetry = options.telemetry ?? createCuaDriverTelemetry();
    this.availabilityPublisher = options.availabilityPublisher;
    this.desktopInstanceId = options.desktopInstanceId ?? `desktop-${randomBytes(16).toString("hex")}`;
    this.featureFlags = options.featureFlags ?? resolveDesktopCuaDriverFeatureFlags();
    const hasFineGrainedPlatformOverride = options.platformIdentityVerifier !== undefined
      || options.stateRootProtector !== undefined
      || options.processLifecycle !== undefined
      || options.readinessController !== undefined
      || options.windowsSessionRecoveryObserver !== undefined;
    if (options.platformBinding && hasFineGrainedPlatformOverride) {
      throw new CuaDriverPlatformBindingError("mixed_dependency_overrides", options.platform);
    }
    if (options.platformBinding && options.platformBinding.platform !== options.platform) {
      throw new CuaDriverPlatformBindingError("platform_mismatch", options.platform);
    }
    if (options.platformBinding) {
      assertCuaDriverPlatformBinding(options.platformBinding, options.platform);
    }
    let platformUnavailableReason = options.platformBinding?.availability.status === "unavailable"
      ? options.platformBinding.availability.reason
      : undefined;
    this.platformMetadata = options.platformBinding
      ? normalizeCuaDriverPlatformBindingMetadata(options.platformBinding.metadata, options.platform)
      : undefined;
    if (this.platformMetadata) {
      this.snapshotValue = {
        ...this.snapshotValue,
        ...(this.platformMetadata.integrityCoverage
          ? { integrityCoverage: this.platformMetadata.integrityCoverage }
          : {}),
        limitations: this.platformMetadata.limitations,
      };
    }
    this.platformIdentityVerifier = options.platformBinding?.platformIdentityVerifier ?? options.platformIdentityVerifier;
    this.stateRootProtector = options.platformBinding?.stateRootProtector ?? options.stateRootProtector;
    this.processLifecycle = options.platformBinding?.processLifecycle ?? options.processLifecycle;
    const defaultReadiness = options.platform === "win32"
      ? new WindowsActiveChildReadinessController()
      : new FailClosedCuaDriverReadinessController();
    this.readinessController = new GenerationFencedCuaDriverReadiness(
      options.platformBinding?.readinessController ?? options.readinessController ?? defaultReadiness,
    );
    const windowsSessionRecoveryObserver = options.platformBinding?.windowsSessionRecoveryObserver
      ?? options.windowsSessionRecoveryObserver;
    if (options.platform === "win32"
      && windowsSessionRecoveryObserver
      && options.platformBinding?.availability.status !== "unavailable") {
      let activeHandler: ((hint: CuaDriverWindowsSessionRecoveryHint) => void) | undefined;
      try {
        const stopObserver = windowsSessionRecoveryObserver.subscribe((hint) => {
          activeHandler?.(hint);
        });
        if (typeof stopObserver !== "function") {
          throw new Error("windows_session_observer_unsubscribe_invalid");
        }
        activeHandler = (hint) => {
          this.handleWindowsSessionRecoveryHint(hint);
        };
        this.stopWindowsSessionRecoveryObserver = () => {
          activeHandler = undefined;
          stopObserver();
        };
      } catch (error) {
        activeHandler = undefined;
        platformUnavailableReason = WINDOWS_SESSION_OBSERVER_UNAVAILABLE_REASON;
        this.telemetry.emit("error", "cua_driver.coordinator.session_observer_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.platformUnavailableReason = platformUnavailableReason;
  }

  get snapshot(): CuaDriverCoordinatorSnapshot {
    return this.snapshotValue;
  }

  get endpoint(): CuaDriverMcpProxyPublicEndpoint | undefined {
    return publicCuaDriverMcpProxyEndpoint(this.proxy?.endpoint);
  }

  get providerHost(): CuaDriverProviderHost | undefined {
    return this.host;
  }

  /** Validate, bind and publish one generation. Child spawn remains lazy until initialize. */
  enable(): Promise<CuaDriverCoordinatorSnapshot> {
    if (this.stopped) {
      return Promise.reject(new Error("cua_driver_coordinator_stopped"));
    }
    if (!this.requestedEnabled) {
      this.requestedRevision += 1;
      this.requestedEnabled = true;
    }
    const requestedRevision = this.requestedRevision;
    return this.enableForRevision(requestedRevision);
  }

  private enableForRevision(requestedRevision: number): Promise<CuaDriverCoordinatorSnapshot> {
    if (this.stopped) {
      return Promise.reject(new Error("cua_driver_coordinator_stopped"));
    }
    if (!this.isCurrentEnableIntent(requestedRevision)) {
      return Promise.reject(new Error("cua_driver_enable_superseded"));
    }
    if (this.cleanupDebt) {
      return Promise.reject(new Error("cua_driver_cleanup_incomplete"));
    }
    if (this.disableBarrierPromise) {
      const pendingBarrier = this.disableBarrierPromise;
      return pendingBarrier.then(() => {
        if (this.disableBarrierPromise === pendingBarrier) {
          this.disableBarrierPromise = undefined;
        }
        return this.enableForRevision(requestedRevision);
      });
    }
    if (this.disablePromise) {
      const pendingDisable = this.disablePromise;
      return pendingDisable.then(() => {
        if (this.disablePromise === pendingDisable) {
          this.disablePromise = undefined;
        }
        return this.enableForRevision(requestedRevision);
      });
    }
    if (this.sessionTransitionPromise) {
      return this.waitForSessionTransition(this.sessionTransitionPromise, requestedRevision);
    }
    if (this.recoveryPromise) {
      const pendingRecovery = this.recoveryPromise;
      return this.waitForRecoveryEnable(pendingRecovery, requestedRevision);
    }
    if (this.snapshotValue.lifecycle === "active" || this.snapshotValue.lifecycle === "included") {
      return Promise.resolve(this.snapshotValue);
    }
    if (this.enablePromise) {
      return this.enablePromise;
    }
    this.recoveryAttempt = 0;
    return this.beginEnable();
  }

  private beginEnable(): Promise<CuaDriverCoordinatorSnapshot> {
    if (this.enablePromise) {
      return this.enablePromise;
    }
    const pending = this.enableInternal();
    this.enablePromise = pending;
    void pending.finally(() => {
      if (this.enablePromise === pending) {
        this.enablePromise = undefined;
      }
    }).catch(() => undefined);
    return pending;
  }

  disable(reason = "disabled"): Promise<void> {
    this.requestedRevision += 1;
    this.requestedEnabled = false;
    this.recoveryAttempt = 0;
    this.windowsSessionSuspended = false;
    this.windowsSessionResumeHintPending = false;
    this.windowsSessionSuspensionReason = "windows_interactive_session_required";
    this.pendingWindowsSessionSuspension = undefined;
    if (this.disableBarrierPromise) {
      return this.disableBarrierPromise;
    }
    const pending = this.waitForDisableCompletion(this.beginDisable(reason));
    this.disableBarrierPromise = pending;
    void pending.finally(() => {
      if (this.disableBarrierPromise === pending) {
        this.disableBarrierPromise = undefined;
      }
    }).catch(() => undefined);
    return pending;
  }

  private async waitForDisableCompletion(pendingDisable: Promise<void>): Promise<void> {
    await pendingDisable;
    while (this.sessionTransitionPromise) {
      const transition = this.sessionTransitionPromise;
      await transition;
      await Promise.resolve();
    }
  }

  private beginDisable(reason: string): Promise<void> {
    if (this.disablePromise) {
      return this.disablePromise;
    }
    const pending = this.disableInternal(reason);
    this.disablePromise = pending;
    void pending.finally(() => {
      if (this.disablePromise === pending) {
        this.disablePromise = undefined;
        this.resumeWindowsSessionIfHinted();
      }
    }).catch(() => undefined);
    return pending;
  }

  async restart(reason = "restart"): Promise<CuaDriverCoordinatorSnapshot> {
    const disabling = this.disable(reason);
    const disableRevision = this.requestedRevision;
    await disabling;
    if (this.requestedRevision !== disableRevision || this.requestedEnabled) {
      throw new Error("cua_driver_enable_superseded");
    }
    return this.enable();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.requestedEnabled = false;
    try {
      await this.disable("desktop_quit");
    } finally {
      try {
        this.stopWindowsSessionRecoveryObserver?.();
      } catch (error) {
        this.telemetry.emit("warn", "cua_driver.coordinator.session_observer_stop_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.stopWindowsSessionRecoveryObserver = undefined;
      await this.availabilityPublisher?.close();
    }
  }

  private async enableInternal(): Promise<CuaDriverCoordinatorSnapshot> {
    if (!desktopBundledCuaDriverGateEnabled(this.featureFlags, this.options.platform)) {
      // Feature gate off is an intentional compatibility state. It never probes
      // PATH and never falls through to external_local.
      return this.publishSnapshot({ lifecycle: "included", providerState: "included", generation: this.generation });
    }
    if (this.platformUnavailableReason) {
      return this.publishSnapshot({
        lifecycle: "failed",
        providerState: "platform_unavailable",
        generation: this.generation,
        reason: this.platformUnavailableReason,
      });
    }
    if (
      this.options.platform === "win32"
      && this.processLifecycle?.lifetimeBoundary !== "windows-job-object"
      && this.processLifecycle?.lifetimeBoundary !== "test-fixture"
    ) {
      return this.publishSnapshot({
        lifecycle: "failed",
        providerState: "platform_unavailable",
        generation: this.generation,
        reason: "windows_provider_job_object_lifecycle_required",
      });
    }
    this.publishSnapshot({ lifecycle: "validating", providerState: "included", generation: this.generation });
    this.generation = this.generation + 1;
    const generation = this.generation;
    try {
      const paths = resolveCuaDriverResourcePaths({
        resourcesPath: this.options.resourcesPath,
        platform: this.options.platform,
        architecture: this.options.architecture,
      });
      const lockOptions: CuaDriverProviderLockValidationOptions = {
        platform: this.options.platform,
        architecture: this.options.architecture,
        requireReleaseEvidence: this.options.requireReleaseEvidence ?? this.options.packaged ?? false,
      };
      const lock = await readCuaDriverProviderLock(paths.lockPath, lockOptions);
      const artifacts = await verifyCuaDriverProviderArtifacts({
        platform: this.options.platform,
        architecture: this.options.architecture,
        paths,
        lock,
        platformIdentityVerifier: this.platformIdentityVerifier,
        requirePlatformIdentityVerification: this.options.packaged === true,
      });
      const stateRoot = await createCuaDriverStateRoot({
        userDataPath: this.options.userDataPath,
        platform: this.options.platform,
        platformProtector: this.stateRootProtector,
      });
      this.resourcePaths = paths;
      this.artifacts = artifacts;
      this.stateRoot = stateRoot;
      const proxyContext: CuaDriverProxyContext = {
        ...this.options.bridgeContext,
        generation,
      };
      const telemetry = this.telemetry;
      const hostOptions: CuaDriverProviderHostOptions = {
        executablePath: paths.executablePath,
        executableDigest: artifacts.executableDigest,
        stateRoot,
        generation,
        platform: this.options.platform,
        lifecycle: this.processLifecycle,
        telemetry,
        preSpawn: async (signal) => {
          try {
            signal.throwIfAborted();
            const liveLock = await readCuaDriverProviderLock(paths.lockPath, lockOptions);
            signal.throwIfAborted();
            const liveArtifacts = await verifyCuaDriverProviderArtifacts({
              platform: this.options.platform,
              architecture: this.options.architecture,
              paths,
              lock: liveLock,
              platformIdentityVerifier: this.platformIdentityVerifier,
              requirePlatformIdentityVerification: this.options.packaged === true,
            });
            signal.throwIfAborted();
            if (
              liveArtifacts.lockDigest !== artifacts.lockDigest
              || liveArtifacts.executableDigest !== artifacts.executableDigest
              || liveArtifacts.sealDigest !== artifacts.sealDigest
              || liveArtifacts.catalogDigest !== artifacts.catalogDigest
            ) {
              throw new CuaDriverProviderPreSpawnError("artifact_invalid");
            }
            // Keep state validation as the final await before lifecycle.spawn().
            await reverifyCuaDriverStateRoot({
              stateRoot,
              platform: this.options.platform,
              platformProtector: this.stateRootProtector,
              signal,
            });
            signal.throwIfAborted();
          } catch (error) {
            if (error instanceof CuaDriverProviderPreSpawnError) {
              throw error;
            }
            throw new CuaDriverProviderPreSpawnError(classifyCuaDriverPreSpawnFailure(error));
          }
        },
        onTerminal: ({ reason, unexpected, preSpawnFailureKind }) => {
          if (this.host?.generation !== generation) {
            return;
          }
          telemetry.emit(unexpected ? "error" : "info", "cua_driver.coordinator.host_terminal", { generation, reason });
          if (unexpected) {
            if (reason === "pre_spawn_validation_failed") {
              this.scheduleTerminalFailure(
                `provider_${reason}`,
                generation,
                preSpawnFailureKind === "artifact_invalid" ? "corrupt" : "platform_unavailable",
              );
            } else {
              this.scheduleRecovery(`provider_${reason}`, generation);
            }
          }
        },
      };
      const host = new CuaDriverProviderHost(hostOptions);
      this.host = host;
      const readinessContext = () => ({
        generation,
        childInstanceNonce: host.childInstanceNonce,
        platform: this.options.platform,
        hostProcessId: process.pid,
        providerProcessId: host.pid,
        requestControl: (method: `ling/${string}`, params: import("./provider-host.js").JsonRpcParams) => host.requestControl(method, params),
        requestCheckPermissions: () => host.requestCheckPermissions(),
      });
      const proxy = new CuaDriverMcpProxy({
        host,
        context: proxyContext,
        telemetry,
        onSessionClosed: (reason) => {
          if (this.host?.generation === generation) {
            this.scheduleRecovery(reason, generation);
          }
        },
        onManagedReadinessChanged: (message) => {
          const readiness = this.readinessController.acceptChanged?.(readinessContext(), message);
          if (!readiness || this.host?.generation !== generation) {
            return;
          }
          if (!readiness.ready) {
            proxy.closeCallGate(readiness.reason ?? "readiness_revoked");
          } else {
            this.resetRecoveryBudget(generation);
          }
          this.publishSnapshot({
            lifecycle: "active",
            providerState: readiness.providerState,
            generation,
            endpoint: publicCuaDriverMcpProxyEndpoint(endpoint),
            ...(host.pid ? { pid: host.pid } : {}),
            ...(this.artifacts ? {
              artifacts: {
                lockDigest: this.artifacts.lockDigest,
                providerSealDigest: this.artifacts.sealDigest,
                ...(this.artifacts.catalogDigest ? { providerCatalogDigest: this.artifacts.catalogDigest } : {}),
              },
            } : {}),
            ...(readiness.reason ? { reason: readiness.reason } : {}),
          });
          if (!readiness.ready) {
            if (readiness.providerState === "interactive_session_required") {
              this.scheduleWindowsSessionSuspension(readiness.reason ?? "windows_interactive_session_required", generation);
            } else {
              this.scheduleRecovery(readiness.reason ?? "readiness_revoked", generation);
            }
          }
        },
        onInitialized: async () => {
          const readiness = await this.readinessController.check(readinessContext());
          if (this.host?.generation !== generation) {
            throw new Error("cua_driver_readiness_generation_stale");
          }
          const readinessAction = classifyCuaDriverInitialReadiness(readiness);
          if (readinessAction !== "open_call_gate") {
            proxy.closeCallGate(readiness.reason ?? "readiness_failed");
            this.publishSnapshot({
              lifecycle: "active",
              providerState: readiness.providerState,
              generation,
              endpoint: publicCuaDriverMcpProxyEndpoint(proxy.endpoint),
              ...(host.pid ? { pid: host.pid } : {}),
              ...(this.artifacts ? {
                artifacts: {
                  lockDigest: this.artifacts.lockDigest,
                  providerSealDigest: this.artifacts.sealDigest,
                  ...(this.artifacts.catalogDigest ? { providerCatalogDigest: this.artifacts.catalogDigest } : {}),
                },
              } : {}),
              ...(readiness.reason ? { reason: readiness.reason } : {}),
            });
            if (readiness.providerState === "interactive_session_required") {
              this.scheduleWindowsSessionSuspension(readiness.reason ?? "windows_interactive_session_required", generation);
            }
            if (readinessAction === "retain_gated_session") {
              return { callGate: "closed" as const };
            }
            throw new Error(readiness.reason ?? "cua_driver_readiness_failed");
          }
          this.resetRecoveryBudget(generation);
          this.publishSnapshot({
            lifecycle: "active",
            providerState: "ready",
            generation,
            endpoint: publicCuaDriverMcpProxyEndpoint(proxy.endpoint),
            ...(host.pid ? { pid: host.pid } : {}),
            ...(this.artifacts ? {
              artifacts: {
                lockDigest: this.artifacts.lockDigest,
                providerSealDigest: this.artifacts.sealDigest,
                ...(this.artifacts.catalogDigest ? { providerCatalogDigest: this.artifacts.catalogDigest } : {}),
              },
            } : {}),
          });
          return { callGate: "open" as const };
        },
      });
      this.proxy = proxy;
      const endpoint = await proxy.start();
      const leaseTemplate: Omit<DesktopCuaDriverLeaseV1, "expiresAt"> = {
        schemaVersion: 1,
        providerId: "cua-driver",
        desktopInstanceId: this.desktopInstanceId,
        desktopInstanceEpoch: this.options.bridgeContext.desktopInstanceEpoch,
        bridgeConnectionId: this.options.bridgeContext.bridgeConnectionId,
        generation,
        daemonAuthorityEpoch: this.options.bridgeContext.daemonAuthorityEpoch,
        workspaceCwd: this.options.workspaceCwd,
        endpoint: endpoint.url,
        providerVersion: "0.8.3",
        distributionRevision: "ling.1",
        integrationMode: "embedded-stdio",
        lockDigest: artifacts.lockDigest,
        providerSealDigest: artifacts.sealDigest,
        ...(artifacts.catalogDigest ? { providerCatalogDigest: artifacts.catalogDigest } : {}),
        platform: this.options.platform,
        architecture: this.options.architecture,
        ...(this.platformMetadata?.integrityCoverage
          ? { integrityCoverage: this.platformMetadata.integrityCoverage }
          : this.options.platform === "win32"
            ? { integrityCoverage: "standard" as const }
            : {}),
      };
      const leaseClient = this.options.leaseClient ?? new HttpCuaDriverLeaseClient({
        daemonBaseUrl: this.options.daemonBaseUrl,
        bridgeToken: this.options.bridgeContext.bridgeToken,
        fetch: this.options.fetch,
      });
      const publisher = new CuaDriverLeasePublisher({
        client: leaseClient,
        lease: leaseTemplate,
        telemetry,
        onLeaseLost: (error) => {
          if (this.leasePublisher === publisher) {
            this.scheduleRecovery("lease_lost", generation);
          }
          telemetry.emit("error", "cua_driver.coordinator.lease_lost", { generation, error: String(error) });
        },
      });
      this.leasePublisher = publisher;
      await publisher.publish();
      return this.publishSnapshot({
        lifecycle: "active",
        providerState: "desktop_unavailable",
        generation,
        endpoint: publicCuaDriverMcpProxyEndpoint(endpoint),
        artifacts: {
          lockDigest: artifacts.lockDigest,
          providerSealDigest: artifacts.sealDigest,
          ...(artifacts.catalogDigest ? { providerCatalogDigest: artifacts.catalogDigest } : {}),
        },
      });
    } catch (error) {
      await this.cleanupPartiallyStarted(`enable_failed:${error instanceof Error ? error.message : String(error)}`);
      const reason = error instanceof Error ? error.message : "cua_driver_enable_failed";
      this.publishSnapshot({ lifecycle: "failed", providerState: classifyProviderFailure(error), generation, reason });
      throw error;
    }
  }

  private async disableInternal(reason: string): Promise<void> {
    if (this.enablePromise) {
      await this.enablePromise.catch(() => undefined);
    }
    const publisher = this.leasePublisher;
    const proxy = this.proxy;
    const host = this.host;
    this.readinessController.invalidate(this.generation, reason);
    proxy?.closeCallGate(reason);
    if (publisher || proxy || host) {
      this.publishSnapshot({ lifecycle: "stopping", providerState: "desktop_unavailable", generation: this.generation, reason });
    }
    let leaseError: unknown;
    let cleanupError: unknown;
    try {
      await publisher?.revoke();
    } catch (error) {
      leaseError = error;
    }
    try {
      await proxy?.close(reason);
    } catch (error) {
      cleanupError = cleanupError ?? error;
    }
    if (host) {
      try {
        await host.stop(reason);
      } catch (error) {
        cleanupError = cleanupError ?? error;
      }
    }
    if (cleanupError) {
      this.cleanupDebt = true;
      this.publishSnapshot({
        lifecycle: "failed",
        providerState: "platform_unavailable",
        generation: this.generation,
        reason: `cleanup_incomplete:${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      });
      throw cleanupError;
    }
    this.cleanupDebt = false;
    this.leasePublisher = undefined;
    this.proxy = undefined;
    this.host = undefined;
    this.publishSnapshot({ lifecycle: "disabled", providerState: "included", generation: this.generation, reason });
    if (leaseError) {
      this.telemetry.emit("warn", "cua_driver.coordinator.lease_revoke_failed", {
        generation: this.generation,
        error: leaseError instanceof Error ? leaseError.message : String(leaseError),
      });
    }
  }

  private async cleanupPartiallyStarted(reason: string): Promise<void> {
    const results = await Promise.allSettled([
      this.leasePublisher?.revoke(),
      this.proxy?.close(reason),
      this.host?.stop(reason),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      this.cleanupDebt = true;
      return;
    }
    this.cleanupDebt = false;
    this.leasePublisher = undefined;
    this.proxy = undefined;
    this.host = undefined;
  }

  private scheduleRecovery(reason: string, generation: number): void {
    if (
      !this.requestedEnabled
      || this.stopped
      || this.windowsSessionSuspended
      || this.host?.generation !== generation
    ) {
      return;
    }
    this.proxy?.closeCallGate(reason);
    if (this.recoveryPromise) {
      this.queueRecoveryAction({ mode: "retry", reason, generation });
      return;
    }
    if (this.recoveryAttempt >= 3) {
      this.scheduleTerminalFailure("recovery_attempts_exhausted", generation, "platform_unavailable");
      return;
    }
    const pending = (async () => {
      try {
        await this.beginDisable(reason);
        while (
          this.requestedEnabled
          && !this.stopped
          && !this.cleanupDebt
          && !this.windowsSessionSuspended
          && this.recoveryAttempt < 3
        ) {
          this.recoveryAttempt += 1;
          const attempt = this.recoveryAttempt;
          await waitForRecovery(100 * 2 ** (attempt - 1));
          if (!this.requestedEnabled || this.stopped || this.cleanupDebt || this.windowsSessionSuspended) {
            return;
          }
          try {
            await this.beginEnable();
            return;
          } catch (error) {
            this.telemetry.emit("error", "cua_driver.coordinator.recovery_failed", {
              generation,
              attempt,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (this.requestedEnabled && !this.stopped && this.recoveryAttempt >= 3) {
          this.publishSnapshot({
            lifecycle: "failed",
            providerState: "desktop_unavailable",
            generation: this.generation,
            reason: "recovery_attempts_exhausted",
          });
        }
      } catch (error) {
        this.telemetry.emit("error", "cua_driver.coordinator.recovery_failed", {
          generation,
          attempt: this.recoveryAttempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    this.recoveryPromise = pending;
    void pending.finally(() => {
      if (this.recoveryPromise === pending) {
        this.recoveryPromise = undefined;
        this.drainPendingRecoveryAction();
        this.resumeWindowsSessionIfHinted();
      }
    }).catch(() => undefined);
  }

  private scheduleWindowsSessionSuspension(reason: string, generation: number): void {
    if (
      this.options.platform !== "win32"
      || !this.requestedEnabled
      || this.stopped
      || this.host?.generation !== generation
    ) {
      return;
    }
    const alreadySuspended = this.windowsSessionSuspended;
    this.windowsSessionSuspended = true;
    this.windowsSessionSuspensionReason = reason;
    if (!alreadySuspended) {
      this.windowsSessionResumeHintPending = false;
    }
    this.proxy?.closeCallGate(reason);
    this.publishSnapshot({
      lifecycle: "active",
      providerState: "interactive_session_required",
      generation,
      ...(this.endpoint ? { endpoint: this.endpoint } : {}),
      reason,
    });
    if (this.sessionTransitionPromise) {
      this.queueWindowsSessionSuspension(reason, generation);
      return;
    }
    this.startWindowsSessionSuspensionCleanup(reason, generation);
  }

  private startWindowsSessionSuspensionCleanup(reason: string, generation: number): void {
    const pending = Promise.resolve().then(async () => {
      try {
        await this.beginDisable(reason);
        if (this.requestedEnabled && !this.stopped && !this.cleanupDebt && this.windowsSessionSuspended) {
          this.publishSnapshot({
            lifecycle: "included",
            providerState: "interactive_session_required",
            generation,
            reason,
          });
        }
      } catch (error) {
        this.telemetry.emit("error", "cua_driver.coordinator.session_suspend_failed", {
          generation,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    this.trackSessionTransition(pending);
  }

  private queueWindowsSessionSuspension(reason: string, generation: number): void {
    if (!this.pendingWindowsSessionSuspension || generation >= this.pendingWindowsSessionSuspension.generation) {
      this.pendingWindowsSessionSuspension = { reason, generation };
    }
  }

  private drainPendingWindowsSessionSuspension(): void {
    const pending = this.pendingWindowsSessionSuspension;
    this.pendingWindowsSessionSuspension = undefined;
    if (
      !pending
      || !this.windowsSessionSuspended
      || !this.requestedEnabled
      || this.stopped
      || this.host?.generation !== pending.generation
    ) {
      return;
    }
    this.startWindowsSessionSuspensionCleanup(pending.reason, pending.generation);
  }

  private handleWindowsSessionRecoveryHint(hint: CuaDriverWindowsSessionRecoveryHint): void {
    if (
      this.options.platform !== "win32"
      || (hint.kind !== "unlock" && hint.kind !== "session_active")
      || !this.windowsSessionSuspended
      || !this.requestedEnabled
      || this.stopped
    ) {
      return;
    }
    this.windowsSessionResumeHintPending = true;
    this.resumeWindowsSessionIfHinted();
  }

  private resumeWindowsSessionIfHinted(): void {
    if (
      !this.windowsSessionResumeHintPending
      || !this.windowsSessionSuspended
      || !this.requestedEnabled
      || this.stopped
      || this.cleanupDebt
      || this.sessionTransitionPromise
      || this.disablePromise
      || this.recoveryPromise
    ) {
      return;
    }
    this.windowsSessionResumeHintPending = false;
    this.windowsSessionSuspended = false;
    const requestedRevision = this.requestedRevision;
    const pending = Promise.resolve().then(async () => {
      if (!this.isCurrentEnableIntent(requestedRevision)) {
        return;
      }
      try {
        const snapshot = await this.beginEnable();
        if (snapshot.lifecycle === "failed") {
          this.restoreWindowsSessionHintWaitAfterTransientFailure(requestedRevision);
        }
      } catch (error) {
        this.telemetry.emit("error", "cua_driver.coordinator.session_resume_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.restoreWindowsSessionHintWaitAfterTransientFailure(requestedRevision);
      }
    });
    this.trackSessionTransition(pending);
  }

  private restoreWindowsSessionHintWaitAfterTransientFailure(requestedRevision: number): void {
    if (
      !this.isCurrentEnableIntent(requestedRevision)
      || this.stopped
      || this.cleanupDebt
      || this.snapshotValue.providerState !== "desktop_unavailable"
    ) {
      return;
    }
    this.windowsSessionSuspended = true;
    this.publishSnapshot({
      lifecycle: "included",
      providerState: "interactive_session_required",
      generation: this.generation,
      reason: this.windowsSessionSuspensionReason,
    });
  }

  private trackSessionTransition(pending: Promise<void>): void {
    this.sessionTransitionPromise = pending;
    void pending.finally(() => {
      if (this.sessionTransitionPromise === pending) {
        this.sessionTransitionPromise = undefined;
        this.drainPendingWindowsSessionSuspension();
        this.resumeWindowsSessionIfHinted();
      }
    }).catch(() => undefined);
  }

  private async waitForSessionTransition(
    pending: Promise<void>,
    requestedRevision: number,
  ): Promise<CuaDriverCoordinatorSnapshot> {
    await pending;
    if (this.sessionTransitionPromise && this.sessionTransitionPromise !== pending) {
      return this.waitForSessionTransition(this.sessionTransitionPromise, requestedRevision);
    }
    if (this.stopped || !this.isCurrentEnableIntent(requestedRevision)) {
      throw new Error("cua_driver_enable_superseded");
    }
    if (this.snapshotValue.lifecycle === "active" || this.snapshotValue.lifecycle === "included") {
      return this.snapshotValue;
    }
    throw new Error(this.snapshotValue.reason ?? "cua_driver_session_transition_failed");
  }

  private scheduleTerminalFailure(
    reason: string,
    generation: number,
    providerState: Extract<CuaDriverProviderState, "corrupt" | "platform_unavailable">,
  ): void {
    if (this.host?.generation !== generation) {
      return;
    }
    this.proxy?.closeCallGate(reason);
    if (this.recoveryPromise) {
      this.queueRecoveryAction({ mode: "terminal", reason, generation, providerState });
      return;
    }
    const pending = (async () => {
      try {
        await this.beginDisable(reason);
        if (this.requestedEnabled && !this.stopped && !this.cleanupDebt) {
          this.publishSnapshot({ lifecycle: "failed", providerState, generation, reason });
        }
      } catch (error) {
        this.telemetry.emit("error", "cua_driver.coordinator.terminal_cleanup_failed", {
          generation,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    this.recoveryPromise = pending;
    void pending.finally(() => {
      if (this.recoveryPromise === pending) {
        this.recoveryPromise = undefined;
        this.drainPendingRecoveryAction();
        this.resumeWindowsSessionIfHinted();
      }
    }).catch(() => undefined);
  }

  private resetRecoveryBudget(generation: number): void {
    if (this.requestedEnabled && !this.stopped && this.host?.generation === generation) {
      this.recoveryAttempt = 0;
      this.windowsSessionSuspended = false;
      this.windowsSessionResumeHintPending = false;
    }
  }

  private queueRecoveryAction(action: CuaDriverPendingRecoveryAction): void {
    const pending = this.pendingRecoveryAction;
    if (
      !pending
      || action.generation > pending.generation
      || (action.generation === pending.generation && action.mode === "terminal" && pending.mode === "retry")
    ) {
      this.pendingRecoveryAction = action;
    }
  }

  private drainPendingRecoveryAction(): void {
    const action = this.pendingRecoveryAction;
    this.pendingRecoveryAction = undefined;
    if (
      !action
      || !this.requestedEnabled
      || this.stopped
      || this.windowsSessionSuspended
      || this.host?.generation !== action.generation
    ) {
      return;
    }
    if (action.mode === "terminal") {
      this.scheduleTerminalFailure(action.reason, action.generation, action.providerState);
    } else {
      this.scheduleRecovery(action.reason, action.generation);
    }
  }

  private async waitForRecoveryEnable(
    pending: Promise<void>,
    requestedRevision: number,
  ): Promise<CuaDriverCoordinatorSnapshot> {
    await pending;
    if (this.recoveryPromise && this.recoveryPromise !== pending) {
      return this.waitForRecoveryEnable(this.recoveryPromise, requestedRevision);
    }
    if (this.stopped || !this.isCurrentEnableIntent(requestedRevision)) {
      throw new Error("cua_driver_enable_superseded");
    }
    if (this.snapshotValue.lifecycle === "active" || this.snapshotValue.lifecycle === "included") {
      return this.snapshotValue;
    }
    throw new Error(this.snapshotValue.reason ?? "cua_driver_recovery_failed");
  }

  private isCurrentEnableIntent(requestedRevision: number): boolean {
    return this.requestedEnabled && this.requestedRevision === requestedRevision;
  }

  private publishSnapshot(input: Omit<CuaDriverCoordinatorSnapshot, "generation"> & { readonly generation?: number }): CuaDriverCoordinatorSnapshot {
    const snapshot: CuaDriverCoordinatorSnapshot = {
      ...input,
      ...(this.platformMetadata?.integrityCoverage
        ? { integrityCoverage: this.platformMetadata.integrityCoverage }
        : {}),
      ...(this.platformMetadata
        ? { limitations: this.platformMetadata.limitations }
        : {}),
      generation: input.generation ?? this.generation,
    };
    this.snapshotValue = snapshot;
    try {
      this.options.onStateChanged?.(snapshot);
    } catch {
      // State projection is observational.
    }
    void this.availabilityPublisher?.publish(snapshot).catch((error) => {
      this.telemetry.emit("warn", "cua_driver.coordinator.availability_publish_failed", {
        generation: snapshot.generation,
        providerState: snapshot.providerState,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return snapshot;
  }
}

export type CuaDriverInitialReadinessAction =
  | "open_call_gate"
  | "retain_gated_session"
  | "reject_initialize";

/** Keep expected host-permission waits out of crash recovery. */
export function classifyCuaDriverInitialReadiness(
  readiness: Pick<CuaDriverReadinessResult, "ready" | "providerState">,
): CuaDriverInitialReadinessAction {
  if (readiness.ready && readiness.providerState === "ready") {
    return "open_call_gate";
  }
  if (!readiness.ready && readiness.providerState === "permission_required") {
    return "retain_gated_session";
  }
  return "reject_initialize";
}

async function waitForRecovery(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveWait) => {
    const timeout = setTimeout(resolveWait, milliseconds);
    timeout.unref?.();
  });
}

function classifyProviderFailure(error: unknown): CuaDriverProviderState {
  if (error instanceof CuaDriverLeasePublisherError) {
    return "desktop_unavailable";
  }
  if (error instanceof CuaDriverPlatformBindingError
    || error instanceof CuaDriverProviderHostError
    || (error instanceof Error && error.message.includes("state_root"))) {
    return "platform_unavailable";
  }
  return "corrupt";
}

export function classifyCuaDriverPreSpawnFailure(
  error: unknown,
): import("./provider-host.js").CuaDriverProviderPreSpawnFailureKind {
  if (error instanceof CuaDriverPlatformIdentityVerificationError) {
    return error.failureKind === "invalid" ? "artifact_invalid" : "platform_unavailable";
  }
  if (error instanceof CuaDriverStateRootError) {
    return "platform_unavailable";
  }
  if (error instanceof CuaDriverProviderSealError) {
    return error.message === "platform_identity_verifier_required" ? "platform_unavailable" : "artifact_invalid";
  }
  if (error instanceof CuaDriverArtifactLockError || error instanceof CuaDriverResourcePathError) {
    return "artifact_invalid";
  }
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
    return "artifact_invalid";
  }
  return "platform_unavailable";
}
