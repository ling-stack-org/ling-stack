import assert from "node:assert/strict";
import test from "node:test";

import {
  MobileNativeTransportError,
  MobileNativeTransportFactory,
} from "../src/device/native-transport.ts";
import { MobileDeviceExecution } from "../src/device/execution.ts";
import { createAsyncStorageMobileDeviceJournal } from "../src/device/journal.ts";
import { runMobileReadOnlyPlaybook } from "../src/device/playbook.ts";

const now = "2026-11-21T00:00:00.000Z";
const descriptor = {
  deviceId: "ble:device-1",
  displayName: "BLE sensor",
  kind: "hardware",
  transport: "ble",
  connectionRef: "ble:device-1",
  profileRevision: "profile-1",
  adapterId: "ble-sensor",
  adapterVersion: "1.0.0",
  supportedPermissions: ["ble"],
  permissionState: "granted",
};
const capability = {
  id: "hardware.read.status",
  schemaVersion: "1.0",
  semanticVerb: "read.status",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  sideEffect: "read_only",
  approvalClass: "allow",
  requiredPermissions: ["ble"],
  prerequisites: [],
  timeoutMs: 5000,
  responseBytesLimit: 4096,
  idempotency: "request",
  supportedDeviceKinds: ["hardware"],
  supportedTransports: ["ble"],
};

function bridge() {
  return {
    async discover() { return [descriptor]; },
    async connect({ deviceId }) {
      return {
        deviceId,
        connectionRevision: "connection-1",
        permissions: ["ble"],
        async getCapabilities() { return [capability]; },
        async execute({ request }) { return { action: { actionId: request.actionId, status: "completed", startedAt: now, finishedAt: now, observationIds: [] } }; },
      };
    },
  };
}

test("native mobile transport maps a granted platform session to shared device contracts", async () => {
  const factory = new MobileNativeTransportFactory({ bridge: bridge(), ownerScope: "workspace-1", ownerId: "mobile-1", now: () => now });
  const profiles = await factory.discover();
  assert.equal(profiles[0].device.id, descriptor.deviceId);
  const transport = await factory.connect({ device: descriptor, requiredPermissions: ["ble"] });
  assert.equal(transport.deviceId, descriptor.deviceId);
  assert.deepEqual(await transport.getCapabilities(), [capability]);
  const result = await transport.execute({ request: { actionId: "action-1", taskId: "task-1", targetDeviceId: descriptor.deviceId, capabilityId: capability.id, capabilitySchemaVersion: "1.0", capabilitySnapshotId: "snapshot-1", normalizedInput: {}, idempotencyKey: "task-1:action-1" } });
  assert.equal(result.action.status, "completed");
  const snapshot = await factory.snapshot({ profile: profiles[0], connectionRevision: transport.connectionRevision, capabilities: await transport.getCapabilities() });
  assert.equal(snapshot.connectionRevision, "connection-1");
});

test("native mobile transport refuses a device without OS authorization", async () => {
  const factory = new MobileNativeTransportFactory({ bridge: bridge(), ownerScope: "workspace-1", ownerId: "mobile-1", now: () => now });
  await assert.rejects(() => factory.connect({ device: { ...descriptor, permissionState: "denied" }, requiredPermissions: ["ble"] }), error => error instanceof MobileNativeTransportError && error.code === "permission_denied");
  const platform = bridge();
  let closed = false;
  const missingPermission = new MobileNativeTransportFactory({
    ownerScope: "workspace-1", ownerId: "mobile-1", now: () => now,
    bridge: {
      ...platform,
      async connect(input) {
        return { ...await platform.connect(input), permissions: [], async close() { closed = true; } };
      },
    },
  });
  await assert.rejects(() => missingPermission.connect({ device: descriptor, requiredPermissions: ["ble"] }),
    error => error instanceof MobileNativeTransportError && error.code === "permission_denied");
  assert.equal(closed, true);
});

test("mobile runs a deterministic read-only playbook through the native transport", async () => {
  const factory = new MobileNativeTransportFactory({ bridge: bridge(), ownerScope: "workspace-1", ownerId: "mobile-1", now: () => now });
  const profile = (await factory.discover())[0];
  const transport = await factory.connect({ device: descriptor, requiredPermissions: ["ble"] });
  const snapshot = await factory.snapshot({ profile, connectionRevision: transport.connectionRevision, capabilities: await transport.getCapabilities() });
  const storage = { values: new Map(), async getItem(key) { return this.values.get(key) ?? null; }, async setItem(key, value) { this.values.set(key, value); } };
  const journal = createAsyncStorageMobileDeviceJournal(storage, "mobile-1");
  const task = { id: "playbook-task", ownerKind: "mobile", ownerId: "mobile-1", targetDeviceIds: [profile.device.id], status: "planning", capabilitySnapshotIds: [snapshot.snapshotId], createdAt: now, updatedAt: now };
  await journal.saveTask(task);
  const result = await runMobileReadOnlyPlaybook({ playbookId: "network-diagnosis", profile, snapshot, task, transport, execution: new MobileDeviceExecution({ ownerId: "mobile-1", journal, now: () => now }), steps: [{ stepId: "status", capabilityId: capability.id, capabilitySchemaVersion: "1.0", normalizedInput: {} }, { stepId: "status-replay", capabilityId: capability.id, capabilitySchemaVersion: "1.0", normalizedInput: {} }] });
  assert.equal(result.status, "succeeded");
  assert.equal(result.attempts.length, 2);
  assert.equal((await journal.getTask(task.id)).status, "succeeded");
});
