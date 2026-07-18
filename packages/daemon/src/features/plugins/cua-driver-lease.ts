import {
  isDesktopCuaDriverLeaseV1,
  type DesktopCuaDriverLease,
  type DesktopCuaDriverLeaseRevokeV1,
} from "@ling-stack/contracts";

export type CuaDriverLeaseRejectReason =
  | "invalid"
  | "expired"
  | "authority_mismatch"
  | "workspace_mismatch"
  | "stale_instance"
  | "stale_generation";

export interface CuaDriverLeaseRegistryOptions {
  readonly daemonAuthorityEpoch: string;
  readonly workspaceCwd: string;
  readonly now?: () => string;
  readonly onReplaced?: (previous: DesktopCuaDriverLease, next?: DesktopCuaDriverLease) => void;
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
  private currentLease: DesktopCuaDriverLease | undefined;

  constructor(options: CuaDriverLeaseRegistryOptions) {
    this.authorityEpoch = options.daemonAuthorityEpoch;
    this.workspaceCwd = options.workspaceCwd;
    this.clock = options.now ?? (() => new Date().toISOString());
    this.onReplaced = options.onReplaced;
  }

  getCurrent(now = this.clock()): DesktopCuaDriverLease | undefined {
    if (this.currentLease && this.currentLease.expiresAt <= now) {
      const previous = this.currentLease;
      this.currentLease = undefined;
      this.onReplaced?.(previous);
    }
    return this.currentLease;
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
    const now = this.clock();
    if (candidate.expiresAt <= now) {
      return { accepted: false, reason: "expired" };
    }

    const current = this.getCurrent(now);
    if (!current) {
      this.currentLease = candidate;
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
      this.currentLease = candidate;
      if (candidate.generation > current.generation) {
        this.onReplaced?.(current, candidate);
      }
      return { accepted: true, lease: candidate };
    }

    if (candidate.desktopInstanceEpoch <= current.desktopInstanceEpoch) {
      return { accepted: false, reason: "stale_instance", lease: current };
    }
    this.currentLease = candidate;
    this.onReplaced?.(current, candidate);
    return { accepted: true, lease: candidate };
  }

  renew(candidate: unknown): CuaDriverLeasePublishResult {
    const current = this.getCurrent();
    if (!current) {
      return { accepted: false, reason: "expired" };
    }
    if (!isDesktopCuaDriverLeaseV1(candidate) || !sameLeaseIdentity(current, candidate)) {
      return { accepted: false, reason: "stale_generation", lease: current };
    }
    return this.publish(candidate);
  }

  revoke(candidate: unknown): boolean {
    const current = this.getCurrent();
    if (!current || !isDesktopCuaDriverLeaseRevoke(candidate)) {
      return false;
    }
    if (!sameRevokeIdentity(current, candidate)) {
      return false;
    }
    this.currentLease = undefined;
    this.onReplaced?.(current);
    return true;
  }

  isCurrent(lease: unknown, now = this.clock()): lease is DesktopCuaDriverLease {
    const current = this.getCurrent(now);
    return Boolean(current && isDesktopCuaDriverLeaseV1(lease) && sameLeaseIdentity(current, lease));
  }

  clear(): void {
    const current = this.currentLease;
    this.currentLease = undefined;
    if (current) {
      this.onReplaced?.(current);
    }
  }
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

function isDesktopCuaDriverLeaseRevoke(value: unknown): value is DesktopCuaDriverLeaseRevokeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.schemaVersion === 1
    && row.providerId === "cua-driver"
    && typeof row.desktopInstanceId === "string"
    && Number.isSafeInteger(row.desktopInstanceEpoch)
    && typeof row.bridgeConnectionId === "string"
    && Number.isSafeInteger(row.generation)
    && typeof row.daemonAuthorityEpoch === "string"
    && typeof row.workspaceCwd === "string";
}
