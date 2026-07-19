import { randomUUID } from "node:crypto";
import type {
  CuaDriverLeaseHandshakeAuthorityV1,
  DesktopCuaDriverLease,
  DesktopCuaDriverLeaseRevokeV1,
} from "@ling-stack/contracts";
import {
  CuaDriverLeaseRegistry,
  type CuaDriverLeasePublishResult,
} from "../plugins/cua-driver-lease.js";

export interface CuaDriverDesktopBridgeAuthorityOptions {
  readonly workspaceCwd: string;
  readonly daemonAuthorityEpoch?: string;
  readonly createConnectionId?: () => string;
  readonly now?: () => string;
  readonly onLeaseReplaced?: (
    previous: DesktopCuaDriverLease,
    next?: DesktopCuaDriverLease,
  ) => void;
}

type LeaseHandshakeIdentity = Pick<
  DesktopCuaDriverLease | DesktopCuaDriverLeaseRevokeV1,
  "daemonAuthorityEpoch" | "bridgeConnectionId" | "desktopInstanceEpoch" | "workspaceCwd"
>;

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

  constructor(options: CuaDriverDesktopBridgeAuthorityOptions) {
    this.workspaceCwd = options.workspaceCwd;
    this.daemonAuthorityEpoch = options.daemonAuthorityEpoch ?? randomUUID();
    this.createConnectionId = options.createConnectionId ?? randomUUID;
    this.leaseRegistry = new CuaDriverLeaseRegistry({
      daemonAuthorityEpoch: this.daemonAuthorityEpoch,
      workspaceCwd: this.workspaceCwd,
      now: options.now,
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

  clear(): void {
    this.currentAuthority = undefined;
    this.leaseRegistry.clear();
  }
}
