import assert from "node:assert/strict";
import test from "node:test";

import { SqliteDeviceSupportStore } from "@ling-stack/core";
import { createRemoteDeviceFacade } from "../dist/features/remote-access/device-facade.js";

const now = "2026-11-21T00:00:00.000Z";
const profile = {
  device: {
    id: "linux:workspace-1:board",
    ownerScope: "workspace-1",
    displayName: "board",
    kind: "linux",
    lifecycleStatus: "healthy",
    profileRevision: "profile-1",
    lastSeenAt: now,
  },
  adapterId: "linux-ssh",
  adapterVersion: "1.0.0",
  transports: ["ssh"],
  connectionRefs: ["ssh:board"],
  transportDeployments: [{ transport: "ssh", mode: "none", pairing: "credential_reference", removal: "revoke_credentials" }],
  profileRevision: "profile-1",
  source: "adapter",
} as const;

test("remote device facade projects workspace-scoped devices and task attempts", () => {
  const store = new SqliteDeviceSupportStore();
  store.registerDevice(profile, now);
  store.createTask({
    id: "task-1",
    ownerKind: "daemon",
    ownerId: "daemon-1",
    targetDeviceIds: [profile.device.id],
    status: "awaiting_approval",
    capabilitySnapshotIds: [],
    createdAt: now,
    updatedAt: now,
  }, now);
  const facade = createRemoteDeviceFacade({ store, now: () => now });
  assert.equal(facade.listDevices("workspace-1").devices.length, 1);
  assert.equal(facade.listDevices("workspace-2").devices.length, 0);
  assert.equal(facade.taskSnapshot({ commandId: "command-1", workspaceId: "workspace-1", taskId: "task-1" }).task.status, "awaiting_approval");
  assert.throws(() => facade.taskSnapshot({ commandId: "command-2", workspaceId: "workspace-2", taskId: "task-1" }), /outside the paired workspace/);
  assert.equal(facade.revokeTask({ commandId: "command-3", workspaceId: "workspace-1", taskId: "task-1" }).task.status, "cancelled");
  store.close();
});

test("remote approval remains unavailable until an explicit owner callback is attached", async () => {
  const store = new SqliteDeviceSupportStore();
  store.registerDevice(profile, now);
  store.createTask({
    id: "task-2",
    ownerKind: "daemon",
    ownerId: "daemon-1",
    targetDeviceIds: [profile.device.id],
    status: "awaiting_approval",
    capabilitySnapshotIds: [],
    createdAt: now,
    updatedAt: now,
  }, now);
  const facade = createRemoteDeviceFacade({ store, now: () => now });
  await assert.rejects(() => facade.approveTask({
    commandId: "command-4",
    workspaceId: "workspace-1",
    taskId: "task-2",
    approval: {
      approvalId: "approval-1",
      taskId: "task-2",
      actionId: "action-1",
      targetDeviceId: profile.device.id,
      capabilitySnapshotId: "snapshot-1",
      connectionRevision: "connection-1",
      policyRevision: "device-policy-v1",
      normalizedInputDigest: "digest",
      expiresAt: "2026-11-21T00:05:00.000Z",
    },
  }), /executor is not attached/);
  store.close();
});
