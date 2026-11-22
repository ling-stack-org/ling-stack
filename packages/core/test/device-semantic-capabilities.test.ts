import assert from "node:assert/strict";
import test from "node:test";

import type { DeviceCapabilitySnapshotV1, DeviceProfileV1 } from "@ling-stack/contracts";
import { projectDeviceSemanticTarget, resolveDeviceSemanticTargets } from "../dist/device-semantic-capabilities.js";
import { SqliteDeviceSupportStore } from "../dist/storage/sqlite/device-support-store.js";

const now = "2026-11-22T00:00:00.000Z";
const profile: DeviceProfileV1 = {
  device: { id: "linux-semantic", ownerScope: "workspace-1", displayName: "Linux semantic target", kind: "linux", lifecycleStatus: "healthy", profileRevision: "profile-1" },
  adapterId: "linux-ssh", adapterVersion: "1.0.0", transports: ["ssh"], connectionRefs: ["ssh:semantic"],
  transportDeployments: [{ transport: "ssh", mode: "target_executor", pairing: "credential_reference", removal: "revoke_credentials" }],
  profileRevision: "profile-1", source: "adapter",
};
const capability = {
  id: "linux.inspect.network", schemaVersion: "1.0", semanticVerb: "inspect.network", inputSchema: {}, outputSchema: {},
  sideEffect: "read_only" as const, approvalClass: "allow" as const, requiredPermissions: ["ssh"], prerequisites: [],
  timeoutMs: 5000, responseBytesLimit: 4096, idempotency: "request" as const, supportedDeviceKinds: ["linux" as const], supportedTransports: ["ssh" as const],
};
const snapshot: DeviceCapabilitySnapshotV1 = {
  snapshotId: "semantic-snapshot", deviceId: profile.device.id, adapterId: profile.adapterId, adapterVersion: profile.adapterVersion,
  contractMajor: 1, connectionRevision: "connection-1", capabilities: [capability], observedAt: now, freshnessUntil: "2026-11-22T00:05:00.000Z",
};

test("semantic capability resolution distinguishes available, unsupported and stale targets", () => {
  const store = new SqliteDeviceSupportStore();
  try {
    store.registerDevice(profile, now);
    store.saveCapabilitySnapshot(snapshot, now);
    const available = resolveDeviceSemanticTargets({ store, workspaceId: "workspace-1", semanticVerb: "inspect.network", evaluatedAt: now });
    assert.equal(available[0]?.status, "available");
    assert.equal(available[0]?.capabilities[0]?.id, capability.id);
    assert.equal(resolveDeviceSemanticTargets({ store, workspaceId: "workspace-1", semanticVerb: "repair.network", evaluatedAt: now })[0]?.status, "unsupported");
    assert.equal(projectDeviceSemanticTarget(profile, snapshot, "2026-11-22T00:06:00.000Z", "inspect.network").status, "stale");
    assert.deepEqual(resolveDeviceSemanticTargets({ store, workspaceId: "other-workspace", semanticVerb: "inspect.network", evaluatedAt: now }), []);
  } finally {
    store.close();
  }
});
