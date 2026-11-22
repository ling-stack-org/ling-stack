import type { DeviceCapabilitySnapshotV1, DeviceProfileV1, DeviceSemanticTargetV1 } from "@ling-stack/contracts";

import type { SqliteDeviceSupportStore } from "./storage/sqlite/device-support-store.js";

export function resolveDeviceSemanticTargets(input: {
  readonly store: SqliteDeviceSupportStore;
  readonly workspaceId: string;
  readonly semanticVerb: string;
  readonly targetDeviceId?: string;
  readonly evaluatedAt: string;
}): readonly DeviceSemanticTargetV1[] {
  return input.store.withWriteTransaction(() => {
    const profiles = input.targetDeviceId ? [input.store.getDevice(input.targetDeviceId)] : input.store.listDevices();
    return profiles.flatMap(profile => {
      if (profile?.device.ownerScope !== input.workspaceId) return [];
      return [projectDeviceSemanticTarget(profile, input.store.getCurrentCapabilitySnapshot(profile.device.id),
        input.evaluatedAt, input.semanticVerb)];
    }).sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  });
}

export function projectDeviceSemanticTarget(
  profile: DeviceProfileV1, snapshot: DeviceCapabilitySnapshotV1 | undefined, evaluatedAt: string, semanticVerb?: string,
): DeviceSemanticTargetV1 {
  const { id: deviceId, kind, lifecycleStatus } = profile.device;
  const { profileRevision, adapterId, adapterVersion } = profile;
  const registered = { deviceId, kind, profileRevision, adapterId, adapterVersion, capabilities: [] };
  if (["offline", "revoked", "retired"].includes(lifecycleStatus) || !snapshot) return { ...registered, status: "unavailable" };
  const evaluated = Date.parse(evaluatedAt);
  if (snapshot.deviceId !== deviceId || snapshot.adapterId !== adapterId || snapshot.adapterVersion !== adapterVersion
    || !(Date.parse(snapshot.observedAt) <= evaluated && evaluated < Date.parse(snapshot.freshnessUntil))) {
    return { ...registered, status: "stale" };
  }
  const capabilities = snapshot.capabilities.filter(capability =>
    (semanticVerb === undefined || capability.semanticVerb === semanticVerb)
    && capability.supportedDeviceKinds.includes(kind)
    && capability.supportedTransports.some(transport => profile.transports.includes(transport))
  ).map(({ id, schemaVersion, semanticVerb, sideEffect, approvalClass, prerequisites, verificationCapabilityId }) => ({
    id, schemaVersion, semanticVerb, sideEffect, approvalClass, prerequisites,
    ...(verificationCapabilityId ? { verificationCapabilityId } : {}),
  }));
  const { snapshotId, connectionRevision, observedAt, freshnessUntil } = snapshot;
  return {
    ...registered, capabilities, status: capabilities.length ? "available" : "unsupported",
    snapshot: { snapshotId, connectionRevision, observedAt, freshnessUntil },
  };
}
