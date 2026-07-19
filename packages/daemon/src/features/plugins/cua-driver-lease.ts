import {
  CUA_DRIVER_LEASE_MAX_TTL_MS,
  isDesktopCuaDriverLeaseV1,
  isDesktopCuaDriverLeaseRevokeV1,
  type DesktopCuaDriverLease,
  type DesktopCuaDriverLeaseRevokeV1,
} from "@ling-stack/contracts";

export type CuaDriverLeaseRejectReason =
  | "invalid"
  | "expired"
  | "ttl_exceeded"
  | "deadline_unavailable"
  | "authority_mismatch"
  | "workspace_mismatch"
  | "stale_instance"
  | "stale_generation";

interface CuaDriverLeaseDeadlineTimer {
  cancel(): void;
}

export interface CuaDriverLeaseRegistryOptions {
  readonly daemonAuthorityEpoch: string;
  readonly workspaceCwd: string;
  readonly now?: () => string;
  readonly onReplaced?: (previous: DesktopCuaDriverLease, next?: DesktopCuaDriverLease) => void;
  readonly scheduleDeadline?: (
    callback: () => void,
    delayMs: number,
  ) => CuaDriverLeaseDeadlineTimer;
}

export interface CuaDriverLeasePublishResult {
  readonly accepted: boolean;
  readonly reason?: CuaDriverLeaseRejectReason;
  readonly lease?: DesktopCuaDriverLease;
}

/**
 * Process-local authority for Desktop leases. A lease is deliberately never
 * persisted: expiry and a new authenticated bridge fence stale processes.
 */
export class CuaDriverLeaseRegistry {
  private readonly authorityEpoch: string;
  private readonly workspaceCwd: string;
  private readonly clock: () => string;
  private readonly onReplaced?: CuaDriverLeaseRegistryOptions["onReplaced"];
  private readonly scheduleDeadline: NonNullable<CuaDriverLeaseRegistryOptions["scheduleDeadline"]>;
  private currentLease: DesktopCuaDriverLease | undefined;
  private deadlineTimer: CuaDriverLeaseDeadlineTimer | undefined;
  private deadlineVersion = 0;

  constructor(options: CuaDriverLeaseRegistryOptions) {
    this.authorityEpoch = options.daemonAuthorityEpoch;
    this.workspaceCwd = options.workspaceCwd;
    this.clock = options.now ?? (() => new Date().toISOString());
    this.onReplaced = options.onReplaced;
    this.scheduleDeadline = options.scheduleDeadline ?? scheduleDeadlineTimer;
  }

  getCurrent(now = this.clock()): DesktopCuaDriverLease | undefined {
    const nowEpochMs = dateTimeEpoch(now);
    if (nowEpochMs === undefined) {
      this.clear();
      return undefined;
    }
    return this.getCurrentAt(nowEpochMs);
  }

  publish(candidate: unknown): CuaDriverLeasePublishResult {
    if (!isDesktopCuaDriverLeaseV1(candidate)) {
      return { accepted: false, reason: "invalid" };
    }
    if (candidate.daemonAuthorityEpoch !== this.authorityEpoch) {
      return { accepted: false, reason: "authority_mismatch" };
    }
    if (candidate.workspaceCwd !== this.workspaceCwd) {
      return { accepted: false, reason: "workspace_mismatch" };
    }
    const nowEpochMs = dateTimeEpoch(this.clock());
    if (nowEpochMs === undefined) {
      this.clear();
      return { accepted: false, reason: "invalid" };
    }
    return this.publishAt(candidate, nowEpochMs);
  }

  renew(candidate: unknown): CuaDriverLeasePublishResult {
    const nowEpochMs = dateTimeEpoch(this.clock());
    if (nowEpochMs === undefined) {
      this.clear();
      return { accepted: false, reason: "invalid" };
    }
    const current = this.getCurrentAt(nowEpochMs);
    if (!current) {
      return { accepted: false, reason: "expired" };
    }
    if (!isDesktopCuaDriverLeaseV1(candidate)) {
      return { accepted: false, reason: "invalid", lease: current };
    }
    if (!sameLeaseIdentity(current, candidate)) {
      return { accepted: false, reason: "stale_generation", lease: current };
    }
    return this.publishAt(candidate, nowEpochMs);
  }

  revoke(candidate: unknown): boolean {
    const current = this.getCurrent();
    if (!current || !isDesktopCuaDriverLeaseRevokeV1(candidate)) {
      return false;
    }
    if (!sameRevokeIdentity(current, candidate)) {
      return false;
    }
    this.clear();
    return true;
  }

  isCurrent(lease: unknown, now = this.clock()): lease is DesktopCuaDriverLease {
    const current = this.getCurrent(now);
    return Boolean(current && isDesktopCuaDriverLeaseV1(lease) && sameLeaseIdentity(current, lease));
  }

  clear(): void {
    const current = this.currentLease;
    this.currentLease = undefined;
    this.cancelDeadline();
    if (current) {
      this.notifyReplaced(current);
    }
  }

  private publishAt(
    candidate: DesktopCuaDriverLease,
    nowEpochMs: number,
  ): CuaDriverLeasePublishResult {
    const expiresAtEpochMs = Date.parse(candidate.expiresAt);
    const ttlMs = expiresAtEpochMs - nowEpochMs;
    if (ttlMs <= 0) {
      return { accepted: false, reason: "expired" };
    }
    if (ttlMs > CUA_DRIVER_LEASE_MAX_TTL_MS) {
      return { accepted: false, reason: "ttl_exceeded" };
    }

    const current = this.getCurrentAt(nowEpochMs);
    if (!current) {
      if (!this.install(candidate, nowEpochMs)) {
        return { accepted: false, reason: "deadline_unavailable" };
      }
      return { accepted: true, lease: candidate };
    }
    const sameBridge = current.desktopInstanceId === candidate.desktopInstanceId
      && current.desktopInstanceEpoch === candidate.desktopInstanceEpoch
      && current.bridgeConnectionId === candidate.bridgeConnectionId;
    if (sameBridge) {
      if (candidate.generation < current.generation) {
        return { accepted: false, reason: "stale_generation", lease: current };
      }
      if (candidate.generation === current.generation && !sameLeaseIdentity(current, candidate)) {
        return { accepted: false, reason: "stale_generation", lease: current };
      }
      if (!this.install(candidate, nowEpochMs)) {
        return { accepted: false, reason: "deadline_unavailable" };
      }
      if (candidate.generation > current.generation) {
        this.notifyReplaced(current, candidate);
      }
      return { accepted: true, lease: candidate };
    }

    if (candidate.desktopInstanceEpoch <= current.desktopInstanceEpoch) {
      return { accepted: false, reason: "stale_instance", lease: current };
    }
    if (!this.install(candidate, nowEpochMs)) {
      return { accepted: false, reason: "deadline_unavailable" };
    }
    this.notifyReplaced(current, candidate);
    return { accepted: true, lease: candidate };
  }

  private getCurrentAt(nowEpochMs: number): DesktopCuaDriverLease | undefined {
    const current = this.currentLease;
    if (current && Date.parse(current.expiresAt) <= nowEpochMs) {
      this.clear();
    }
    return this.currentLease;
  }

  private install(candidate: DesktopCuaDriverLease, nowEpochMs: number): boolean {
    const previous = this.currentLease;
    this.cancelDeadline();
    this.currentLease = candidate;
    try {
      this.armDeadline(candidate, nowEpochMs);
      return true;
    } catch {
      this.currentLease = undefined;
      this.cancelDeadline();
      if (previous) {
        this.notifyReplaced(previous);
      }
      return false;
    }
  }

  private armDeadline(candidate: DesktopCuaDriverLease, nowEpochMs: number): void {
    const delayMs = Date.parse(candidate.expiresAt) - nowEpochMs;
    const deadlineVersion = ++this.deadlineVersion;
    this.deadlineTimer = this.scheduleDeadline(() => {
      if (deadlineVersion !== this.deadlineVersion || this.currentLease !== candidate) {
        return;
      }
      this.deadlineTimer = undefined;
      this.deadlineVersion += 1;
      const previous = this.currentLease;
      this.currentLease = undefined;
      if (previous) {
        this.notifyReplaced(previous);
      }
    }, delayMs);
  }

  private cancelDeadline(): void {
    this.deadlineVersion += 1;
    const timer = this.deadlineTimer;
    this.deadlineTimer = undefined;
    if (timer) {
      try {
        timer.cancel();
      } catch {
        // State is already fenced; a broken timer adapter cannot retain the lease.
      }
    }
  }

  private notifyReplaced(
    previous: DesktopCuaDriverLease,
    next?: DesktopCuaDriverLease,
  ): void {
    try {
      this.onReplaced?.(previous, next);
    } catch {
      // An observer cannot retain a lease or crash the daemon deadline callback.
    }
  }
}

function scheduleDeadlineTimer(callback: () => void, delayMs: number): CuaDriverLeaseDeadlineTimer {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return {
    cancel: () => clearTimeout(timer),
  };
}

function dateTimeEpoch(value: string): number | undefined {
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? epochMs : undefined;
}

export function cuaDriverLeasePoolKey(lease: DesktopCuaDriverLease): string {
  return [
    lease.providerId,
    lease.desktopInstanceId,
    lease.desktopInstanceEpoch,
    lease.bridgeConnectionId,
    lease.daemonAuthorityEpoch,
    lease.generation,
    lease.endpoint,
    lease.workspaceCwd,
    lease.lockDigest,
    lease.providerSealDigest,
    lease.providerCatalogDigest ?? "",
  ].map((part) => `${String(part).length}:${String(part)}`).join("|");
}

function sameLeaseIdentity(left: DesktopCuaDriverLease, right: DesktopCuaDriverLease): boolean {
  return left.providerId === right.providerId
    && left.desktopInstanceId === right.desktopInstanceId
    && left.desktopInstanceEpoch === right.desktopInstanceEpoch
    && left.bridgeConnectionId === right.bridgeConnectionId
    && left.generation === right.generation
    && left.daemonAuthorityEpoch === right.daemonAuthorityEpoch
    && left.workspaceCwd === right.workspaceCwd
    && left.endpoint === right.endpoint
    && left.providerVersion === right.providerVersion
    && left.distributionRevision === right.distributionRevision
    && left.integrationMode === right.integrationMode
    && left.lockDigest === right.lockDigest
    && left.providerSealDigest === right.providerSealDigest
    && left.providerCatalogDigest === right.providerCatalogDigest
    && left.platform === right.platform
    && left.architecture === right.architecture
    && left.integrityCoverage === right.integrityCoverage;
}

function sameRevokeIdentity(left: DesktopCuaDriverLease, right: DesktopCuaDriverLeaseRevokeV1): boolean {
  return left.providerId === right.providerId
    && left.desktopInstanceId === right.desktopInstanceId
    && left.desktopInstanceEpoch === right.desktopInstanceEpoch
    && left.bridgeConnectionId === right.bridgeConnectionId
    && left.generation === right.generation
    && left.daemonAuthorityEpoch === right.daemonAuthorityEpoch
    && left.workspaceCwd === right.workspaceCwd;
}
