import type { ManagedPluginDescriptor } from "@ling-stack/core";
import type {
  DesktopCuaDriverAvailabilityV1,
  DesktopCuaDriverLease,
} from "@ling-stack/contracts";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { BundledCuaDriverActivationService } from "./cua-driver-bundled-activation.js";
import type { CuaDriverClientPool } from "./cua-driver-client-pool.js";
import type { CuaDriverLeaseMcpClient } from "./cua-driver-lease-client.js";
import {
  cuaDriverLeasePoolKey,
  type CuaDriverLeaseRegistry,
} from "./cua-driver-lease.js";
import { hasPersistedBundledCuaDriverProjection } from "./cua-driver-runtime-mode.js";
import {
  CUA_DRIVER_MCP_SERVER_ID,
  createBundledCuaDriverLogicalMcpServerInput,
} from "./presets.js";

/**
 * Process-wide composition owner for durable activation projection and the
 * in-memory lease-generation client pool.
 *
 * Lease authority changes synchronously hide effective state. Client cleanup
 * and retained-intent reconciliation are asynchronous so the private Desktop
 * lease route never waits on provider startup.
 */
export class CuaDriverDaemonActivationCoordinator {
  private static readonly RETIREMENT_RETRY_DELAYS_MS = [25, 100, 500, 1_000] as const;

  private projectedLeaseKey: string | undefined;
  private projectedAvailabilityKey: string | undefined;
  private projectionInitialized = false;
  private rejectingLease = false;
  private shutdownRequested = false;
  private readonly pending = new Set<Promise<void>>();
  private retirementRetryAttempt = 0;
  private retirementRetryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: {
    /** Keep the external-only runtime byte-for-byte inert while the gate is off. */
    readonly enabled?: boolean;
    readonly workspaceCwd: string;
    readonly storeRegistry: RunStoreRegistry;
    readonly descriptor: ManagedPluginDescriptor;
    readonly leaseRegistry: CuaDriverLeaseRegistry;
    readonly getDesktopAvailability?: () => DesktopCuaDriverAvailabilityV1 | undefined;
    readonly activationService: BundledCuaDriverActivationService;
    readonly clientPool: CuaDriverClientPool<CuaDriverLeaseMcpClient>;
    readonly now?: () => string;
  }) {}

  resetForDaemonStart(): void {
    const store = this.options.storeRegistry.getStore(this.options.workspaceCwd);
    if (
      this.options.enabled === false
      && !hasPersistedBundledCuaDriverProjection(store)
    ) {
      return;
    }
    const now = this.now();
    if (
      this.options.enabled !== false
      && store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID)
      && !hasPersistedBundledCuaDriverProjection(store)
    ) {
      const migrated = store.updateMcpServer(
        CUA_DRIVER_MCP_SERVER_ID,
        createBundledCuaDriverLogicalMcpServerInput(),
        now,
      );
      if (!migrated) {
        throw new Error("cua_driver_startup_projection_migration_failed");
      }
    }
    const reset = this.options.activationService.resetForDaemonStart({
      store,
      descriptor: this.options.descriptor,
      now,
    });
    if (!reset.committed) {
      throw new Error("cua_driver_startup_reset_stale");
    }
  }

  /** Called for first publication and harmlessly deduplicated for renewals. */
  handleLeasePublished(lease: DesktopCuaDriverLease): boolean {
    return this.handleLeaseChanged(lease);
  }

  handleAvailabilityPublished(availability: DesktopCuaDriverAvailabilityV1): boolean {
    const current = this.options.getDesktopAvailability?.();
    if (!current || availabilityKey(current) !== availabilityKey(availability)) {
      return false;
    }
    return this.handleLeaseChanged(undefined);
  }

  /** Callback target for replacement, expiry, revoke and authority clear. */
  handleLeaseChanged(next?: DesktopCuaDriverLease): boolean {
    if (this.options.enabled === false) {
      return true;
    }
    if (next) {
      this.cancelRetirementProjectionRetry();
    }
    if (this.rejectingLease) {
      return false;
    }
    if (next && !this.options.leaseRegistry.isCurrent(next)) {
      return false;
    }
    const nextKey = next ? cuaDriverLeasePoolKey(next) : undefined;
    const availability = next ? undefined : this.options.getDesktopAvailability?.();
    const nextAvailabilityKey = availability ? availabilityKey(availability) : undefined;
    if (
      this.projectionInitialized
      && this.projectedLeaseKey === nextKey
      && this.projectedAvailabilityKey === nextAvailabilityKey
    ) {
      return true;
    }
    let invalidated: ReturnType<BundledCuaDriverActivationService["invalidateForLeaseChange"]>;
    try {
      invalidated = this.options.activationService.invalidateForLeaseChange({
        store: this.options.storeRegistry.getStore(this.options.workspaceCwd),
        descriptor: this.options.descriptor,
        now: this.now(),
        ...(availability ? { availability } : {}),
      });
    } catch {
      const recovered = this.rejectCurrentLeaseAndRetryProjection();
      if (!next && !recovered) {
        this.scheduleRetirementProjectionRetry();
      }
      return next ? false : recovered;
    }
    if (!invalidated.committed) {
      const recovered = this.rejectCurrentLeaseAndRetryProjection();
      if (!next && !recovered) {
        this.scheduleRetirementProjectionRetry();
      }
      return next ? false : recovered;
    }
    // Publish the dedupe key only after the synchronous durable fence ran. If
    // storage throws, the accepted lease may be retried and must reattempt the
    // projection instead of being mistaken for a harmless renewal.
    this.projectionInitialized = true;
    this.projectedLeaseKey = nextKey;
    this.projectedAvailabilityKey = nextAvailabilityKey;
    if (!next) {
      this.cancelRetirementProjectionRetry();
    }
    this.track(this.closeAndReconcile(next, nextKey));
    return true;
  }

  beginShutdown(): void {
    this.shutdownRequested = true;
    this.cancelRetirementProjectionRetry();
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.cancelRetirementProjectionRetry();
    await this.options.clientPool.closeAll();
    await Promise.allSettled([...this.pending]);
    // A reconcile that crossed the first closeAll boundary may have acquired a
    // client before observing shutdown. The final pass guarantees zero residue.
    await this.options.clientPool.closeAll();
  }

  private async closeAndReconcile(
    next: DesktopCuaDriverLease | undefined,
    nextKey: string | undefined,
  ): Promise<void> {
    if (this.projectedLeaseKey !== nextKey) {
      return;
    }
    await this.options.clientPool.closeStale(next);
    if (
      this.shutdownRequested
      || !next
      || this.projectedLeaseKey !== nextKey
    ) {
      return;
    }
    await this.options.activationService.reconcileRequestedIntent({
      store: this.options.storeRegistry.getStore(this.options.workspaceCwd),
      descriptor: this.options.descriptor,
      now: this.now(),
    });
  }

  /**
   * A lease must never become executable while the durable projection fence is
   * stale. Clear the in-memory authority synchronously, start pool shutdown,
   * then make one post-clear projection attempt for expiry/revoke recovery.
   */
  private rejectCurrentLeaseAndRetryProjection(): boolean {
    // Poison dedupe before clearing authority. A later same-generation lease
    // renewal must re-run the durable fence even when both projection attempts
    // below fail.
    this.projectionInitialized = false;
    this.projectedLeaseKey = undefined;
    this.projectedAvailabilityKey = undefined;
    this.rejectingLease = true;
    try {
      this.options.leaseRegistry.clear();
    } finally {
      this.rejectingLease = false;
    }
    this.track(this.options.clientPool.closeAll());
    try {
      const availability = this.options.getDesktopAvailability?.();
      const recovered = this.options.activationService.invalidateForLeaseChange({
        store: this.options.storeRegistry.getStore(this.options.workspaceCwd),
        descriptor: this.options.descriptor,
        now: this.now(),
        ...(availability ? { availability } : {}),
      });
      if (!recovered.committed) {
        return false;
      }
      this.projectionInitialized = true;
      this.projectedLeaseKey = undefined;
      this.projectedAvailabilityKey = availability ? availabilityKey(availability) : undefined;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Expiry and handshake replacement have no request waiting for a 503. Keep a
   * single unref'ed retry loop until their durable projection catches up. The
   * in-memory lease is already gone, so execution remains fenced throughout.
   */
  private scheduleRetirementProjectionRetry(): void {
    if (this.shutdownRequested || this.retirementRetryTimer) {
      return;
    }
    const delayIndex = Math.min(
      this.retirementRetryAttempt,
      CuaDriverDaemonActivationCoordinator.RETIREMENT_RETRY_DELAYS_MS.length - 1,
    );
    const delayMs = CuaDriverDaemonActivationCoordinator.RETIREMENT_RETRY_DELAYS_MS[delayIndex];
    this.retirementRetryAttempt += 1;
    const timer = setTimeout(() => {
      if (this.retirementRetryTimer !== timer) {
        return;
      }
      this.retirementRetryTimer = undefined;
      if (this.shutdownRequested || this.options.leaseRegistry.getCurrent()) {
        this.retirementRetryAttempt = 0;
        return;
      }
      this.handleLeaseChanged(undefined);
    }, delayMs);
    timer.unref();
    this.retirementRetryTimer = timer;
  }

  private cancelRetirementProjectionRetry(): void {
    if (this.retirementRetryTimer) {
      clearTimeout(this.retirementRetryTimer);
      this.retirementRetryTimer = undefined;
    }
    this.retirementRetryAttempt = 0;
  }

  private track(operation: Promise<void>): void {
    const observed = operation.catch(() => undefined);
    this.pending.add(observed);
    void observed.finally(() => {
      this.pending.delete(observed);
    });
  }

  private now(): string {
    return this.options.now ? this.options.now() : new Date().toISOString();
  }
}

function availabilityKey(availability: DesktopCuaDriverAvailabilityV1): string {
  return [
    availability.desktopInstanceId,
    availability.desktopInstanceEpoch,
    availability.bridgeConnectionId,
    availability.daemonAuthorityEpoch,
    availability.generation,
    availability.sequence,
    availability.providerState,
  ].join("\u0000");
}
