import type { DeviceAccessGrantV1 } from "@ling-stack/contracts";
import { DeviceFabricError } from "./device-fabric.js";

export interface DeviceAccessPersistence {
  saveAccessGrant(grant: DeviceAccessGrantV1): DeviceAccessGrantV1;
  getAccessGrant(grantId: string): DeviceAccessGrantV1 | undefined;
  revokeAccessGrant(grantId: string, revision: number, changedAt: string): DeviceAccessGrantV1;
}

export class DeviceAccessManager {
  readonly #store: DeviceAccessPersistence;

  constructor(store: DeviceAccessPersistence) { this.#store = store; }

  grant(grant: DeviceAccessGrantV1): DeviceAccessGrantV1 {
    validateGrant(grant);
    return this.#store.saveAccessGrant(grant);
  }

  revoke(grantId: string, revision: number, changedAt: string): DeviceAccessGrantV1 {
    return this.#store.revokeAccessGrant(grantId, revision, changedAt);
  }

  authorize(input: { readonly grantId: string; readonly principalId: string; readonly targetDeviceId: string; readonly capabilityId: string; readonly now: string }): DeviceAccessGrantV1 {
    const grant = this.#store.getAccessGrant(input.grantId);
    if (!grant || grant.status !== "active") throw new DeviceFabricError("safety_denied", "device access grant is inactive");
    if (grant.principalId !== input.principalId || grant.targetDeviceId !== input.targetDeviceId) throw new DeviceFabricError("safety_denied", "device access grant principal or target does not match");
    if (Date.parse(grant.expiresAt) <= Date.parse(input.now)) throw new DeviceFabricError("safety_denied", "device access grant has expired");
    if (grant.scope !== "owner" && !grant.capabilityIds.includes(input.capabilityId)) throw new DeviceFabricError("safety_denied", "capability is outside the access grant");
    return grant;
  }
}

function validateGrant(grant: DeviceAccessGrantV1): void {
  if (!grant.grantId.trim() || !grant.targetDeviceId.trim() || !grant.principalId.trim() || !grant.authority.trim() || grant.revision < 1 || grant.capabilityIds.some(capabilityId => !capabilityId.trim()) || new Set(grant.capabilityIds).size !== grant.capabilityIds.length || Number.isNaN(Date.parse(grant.expiresAt)) || Number.isNaN(Date.parse(grant.changedAt))) throw new DeviceFabricError("revision_conflict", "device access grant is invalid");
}
