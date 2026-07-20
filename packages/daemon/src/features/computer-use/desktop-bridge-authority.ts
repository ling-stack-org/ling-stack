import { randomUUID } from "node:crypto";
import type {
  CuaDriverLeaseHandshakeAuthorityV1,
  DesktopCuaDriverAvailabilityV1,
  DesktopCuaDriverLease,
  DesktopCuaDriverLeaseRevokeV1,
} from "@ling-stack/contracts";
import { isDesktopCuaDriverAvailabilityV1 } from "@ling-stack/contracts";
import {
  CuaDriverLeaseRegistry,
  type CuaDriverLeasePublishResult,
  type CuaDriverLeaseRegistryOptions,
} from "../plugins/cua-driver-lease.js";

export interface CuaDriverDesktopBridgeAuthorityOptions {
  readonly workspaceCwd: string;
  readonly daemonAuthorityEpoch?: string;
  readonly createConnectionId?: () => string;
  readonly now?: () => string;
  readonly scheduleDeadline?: CuaDriverLeaseRegistryOptions["scheduleDeadline"];
  readonly onLeaseReplaced?: (
    previous: DesktopCuaDriverLease,
    next?: DesktopCuaDriverLease,
  ) => void;
}

type LeaseHandshakeIdentity = Pick<
  DesktopCuaDriverAvailabilityV1 | DesktopCuaDriverLease | DesktopCuaDriverLeaseRevokeV1,
  "daemonAuthorityEpoch" | "bridgeConnectionId" | "desktopInstanceEpoch" | "workspaceCwd"
>;

export interface CuaDriverAvailabilityPublishResult {
  readonly accepted: boolean;
  readonly reason?: "invalid" | "stale_generation" | "stale_sequence";
  readonly availability?: DesktopCuaDriverAvailabilityV1;
}

/**
 * Process-local authority shared by the bridge handshake and lease routes.
 * Issuing a new handshake is a synchronous fencing operation: the new tuple
 * becomes current and every lease owned by the previous tuple is cleared.
 */
export class CuaDriverDesktopBridgeAuthority {
  readonly daemonAuthorityEpoch: string;
  readonly workspaceCwd: string;
  readonly leaseRegistry: CuaDriverLeaseRegistry;

  private readonly createConnectionId: () => string;
  private desktopInstanceEpoch = 0;
  private currentAuthority: (CuaDriverLeaseHandshakeAuthorityV1 & {
    readonly workspaceCwd: string;
  }) | undefined;
  private currentAvailability: DesktopCuaDriverAvailabilityV1 | undefined;

  constructor(options: CuaDriverDesktopBridgeAuthorityOptions) {
    this.workspaceCwd = options.workspaceCwd;
    this.daemonAuthorityEpoch = options.daemonAuthorityEpoch ?? randomUUID();
    this.createConnectionId = options.createConnectionId ?? randomUUID;
    this.leaseRegistry = new CuaDriverLeaseRegistry({
      daemonAuthorityEpoch: this.daemonAuthorityEpoch,
      workspaceCwd: this.workspaceCwd,
      now: options.now,
      scheduleDeadline: options.scheduleDeadline,
      onReplaced: options.onLeaseReplaced,
    });
  }

  issueAuthenticatedHandshake(): CuaDriverLeaseHandshakeAuthorityV1 {
    if (this.desktopInstanceEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new Error("cua_driver_desktop_instance_epoch_exhausted");
    }
    const bridgeConnectionId = this.createConnectionId();
    if (!bridgeConnectionId.trim()) {
      throw new Error("cua_driver_bridge_connection_id_invalid");
    }
    const authority = Object.freeze({
      daemonAuthorityEpoch: this.daemonAuthorityEpoch,
      bridgeConnectionId,
      desktopInstanceEpoch: this.desktopInstanceEpoch + 1,
      workspaceCwd: this.workspaceCwd,
    });
    this.desktopInstanceEpoch = authority.desktopInstanceEpoch;
    this.currentAuthority = authority;
    this.currentAvailability = undefined;
    this.leaseRegistry.clear();
    return {
      daemonAuthorityEpoch: authority.daemonAuthorityEpoch,
      bridgeConnectionId: authority.bridgeConnectionId,
      desktopInstanceEpoch: authority.desktopInstanceEpoch,
    };
  }

  isCurrentHandshake(identity: LeaseHandshakeIdentity): boolean {
    const current = this.currentAuthority;
    return Boolean(
      current
      && identity.daemonAuthorityEpoch === current.daemonAuthorityEpoch
      && identity.bridgeConnectionId === current.bridgeConnectionId
      && identity.desktopInstanceEpoch === current.desktopInstanceEpoch
      && identity.workspaceCwd === current.workspaceCwd,
    );
  }

  publish(lease: DesktopCuaDriverLease): CuaDriverLeasePublishResult {
    if (!this.isCurrentHandshake(lease)) {
      return { accepted: false, reason: "stale_instance" };
    }
    return this.leaseRegistry.publish(lease);
  }

  revoke(revoke: DesktopCuaDriverLeaseRevokeV1): boolean {
    return this.isCurrentHandshake(revoke) && this.leaseRegistry.revoke(revoke);
  }

  getCurrentAvailability(): DesktopCuaDriverAvailabilityV1 | undefined {
    return this.currentAvailability;
  }

  /**
   * Install one non-authoritative Desktop state report. Any report at or beyond
   * the current lease generation first retires executable authority.
   */
  publishAvailability(
    availability: DesktopCuaDriverAvailabilityV1,
  ): CuaDriverAvailabilityPublishResult {
    if (!isDesktopCuaDriverAvailabilityV1(availability)) {
      return { accepted: false, reason: "invalid" };
    }
    if (!this.isCurrentHandshake(availability)) {
      return { accepted: false, reason: "stale_generation" };
    }
    const currentLease = this.leaseRegistry.getCurrent();
    if (currentLease && availability.generation < currentLease.generation) {
      return { accepted: false, reason: "stale_generation", availability: this.currentAvailability };
    }
    const current = this.currentAvailability;
    if (current) {
      if (availability.generation < current.generation) {
        return { accepted: false, reason: "stale_generation", availability: current };
      }
      if (availability.generation === current.generation && availability.sequence === current.sequence) {
        return sameAvailability(current, availability)
          ? { accepted: true, availability: current }
          : { accepted: false, reason: "stale_sequence", availability: current };
      }
      if (availability.generation === current.generation && availability.sequence < current.sequence) {
        return { accepted: false, reason: "stale_sequence", availability: current };
      }
    }
    this.currentAvailability = availability;
    if (currentLease && availability.generation >= currentLease.generation) {
      this.leaseRegistry.clear();
    }
    return { accepted: true, availability };
  }

  clear(): void {
    this.currentAuthority = undefined;
    this.currentAvailability = undefined;
    this.leaseRegistry.clear();
  }
}

function sameAvailability(
  left: DesktopCuaDriverAvailabilityV1,
  right: DesktopCuaDriverAvailabilityV1,
): boolean {
  return left.desktopInstanceId === right.desktopInstanceId
    && left.desktopInstanceEpoch === right.desktopInstanceEpoch
    && left.bridgeConnectionId === right.bridgeConnectionId
    && left.daemonAuthorityEpoch === right.daemonAuthorityEpoch
    && left.workspaceCwd === right.workspaceCwd
    && left.generation === right.generation
    && left.sequence === right.sequence
    && left.platform === right.platform
    && left.providerState === right.providerState
    && left.reason === right.reason
    && left.integrityCoverage === right.integrityCoverage
    && sameStringArray(left.limitations, right.limitations);
}

function sameStringArray(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return left === right || Boolean(
    left
    && right
    && left.length === right.length
    && left.every((value, index) => value === right[index]),
  );
}
