import { randomUUID } from "node:crypto";

import type { AdapterManifestV1, DeviceCapabilitySnapshotV1, DeviceProfileV1 } from "@ling-stack/contracts";

export function createAdapterCapabilitySnapshot(
  manifest: AdapterManifestV1,
  input: { readonly profile: DeviceProfileV1; readonly connectionRevision: string },
  observedAt: string,
): DeviceCapabilitySnapshotV1 {
  return {
    snapshotId: `device_snapshot_${randomUUID()}`,
    deviceId: input.profile.device.id,
    adapterId: manifest.adapterId,
    adapterVersion: manifest.adapterVersion,
    contractMajor: manifest.contractMajor,
    connectionRevision: input.connectionRevision,
    capabilities: manifest.capabilities,
    observedAt,
    freshnessUntil: new Date(Date.parse(observedAt) + 30_000).toISOString(),
  };
}
