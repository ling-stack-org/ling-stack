import assert from "node:assert/strict";
import test from "node:test";
import type {
  CapabilityDescriptorV1,
  DeviceApprovalBindingV1,
  DeviceCapabilitySnapshotV1,
  DeviceObservationV1,
  DeviceProfileV1,
  DeviceTaskV1,
} from "@ling-stack/contracts";

import { digestDeviceRequest, MobileDeviceExecution, type MobileDeviceTransport } from "../src/device/execution.ts";
import { createAsyncStorageMobileDeviceJournal } from "../src/device/journal.ts";
import { runMobileSetupPlaybook } from "../src/device/playbook.ts";

const now = "2026-11-21T00:00:00.000Z";
const targetDeviceId = "ble:smart-home-1";
const expectedVerification = { connected: true, wifiAssociated: true } as const;

function fixture() {
  const setupCapability: CapabilityDescriptorV1 = {
    id: "smart_home.configure_wifi", schemaVersion: "1.0", semanticVerb: "configure.wifi",
    inputSchema: { type: "object", required: ["networkId"] }, outputSchema: { type: "object" },
    sideEffect: "reversible", approvalClass: "ask", requiredPermissions: ["wifi.write"], prerequisites: [],
    timeoutMs: 5_000, responseBytesLimit: 4_096, idempotency: "target_revision",
    verificationCapabilityId: "smart_home.inspect_wifi", supportedDeviceKinds: ["hardware"], supportedTransports: ["ble"],
  };
  const verifyCapability: CapabilityDescriptorV1 = {
    id: "smart_home.inspect_wifi", schemaVersion: "1.0", semanticVerb: "inspect.wifi",
    inputSchema: { type: "object" }, outputSchema: { type: "object" }, sideEffect: "read_only", approvalClass: "allow",
    requiredPermissions: ["wifi.read"], prerequisites: [], timeoutMs: 5_000, responseBytesLimit: 4_096,
    idempotency: "request", supportedDeviceKinds: ["hardware"], supportedTransports: ["ble"],
  };
  const profile: DeviceProfileV1 = {
    device: { id: targetDeviceId, ownerScope: "workspace-1", displayName: "Smart home device", kind: "hardware",
      lifecycleStatus: "identified", profileRevision: "profile-1", runtimeOwnerId: "mobile-1", lastSeenAt: now },
    adapterId: "smart-home-ble", adapterVersion: "1.0.0", transports: ["ble"], connectionRefs: [targetDeviceId],
    transportDeployments: [{ transport: "ble", mode: "none", pairing: "os_permission", removal: "disconnect_only" }],
    profileRevision: "profile-1", source: "adapter",
  };
  const snapshot: DeviceCapabilitySnapshotV1 = { snapshotId: "snapshot-smart-home-1", deviceId: targetDeviceId,
    adapterId: profile.adapterId, adapterVersion: profile.adapterVersion, contractMajor: 1, connectionRevision: "connection-1",
    capabilities: [setupCapability, verifyCapability], observedAt: now, freshnessUntil: "2026-11-21T00:05:00.000Z" };
  const task: DeviceTaskV1 = { id: "setup-task", ownerKind: "mobile", ownerId: "mobile-1", targetDeviceIds: [targetDeviceId],
    status: "awaiting_approval", capabilitySnapshotIds: [snapshot.snapshotId], createdAt: now, updatedAt: now };
  const normalizedInput = { networkId: "home" } as const;
  const request = { actionId: "smart-home-wifi-setup:configure", taskId: task.id, targetDeviceId,
    capabilityId: setupCapability.id, capabilitySchemaVersion: setupCapability.schemaVersion, capabilitySnapshotId: snapshot.snapshotId,
    normalizedInput, idempotencyKey: `${task.id}:smart-home-wifi-setup:configure`, expectedVerification };
  const approval: DeviceApprovalBindingV1 = { approvalId: "approval-smart-home-1", taskId: task.id, actionId: request.actionId,
    targetDeviceId, capabilitySnapshotId: snapshot.snapshotId, connectionRevision: "connection-1", policyRevision: "device-policy-v1",
    normalizedInputDigest: digestDeviceRequest(request), expiresAt: "2026-11-21T00:05:00.000Z" };
  const observation: DeviceObservationV1 = { id: "setup-wifi-observation", subjectId: targetDeviceId, source: "smart_home.wifi",
    value: expectedVerification, observedAt: now, receivedAt: now, freshnessUntil: "2026-11-21T00:05:00.000Z", quality: "good",
    provenance: [targetDeviceId], redactionClass: "public" };
  return { profile, snapshot, task, request, approval, observation };
}

function storage() {
  const values = new Map<string, string>();
  return { async getItem(key: string) { return values.get(key) ?? null; }, async setItem(key: string, value: string) { values.set(key, value); } };
}

function transport(observation?: DeviceObservationV1): { transport: MobileDeviceTransport; writes: () => number } {
  let writes = 0;
  return {
    writes: () => writes,
    transport: {
      deviceId: targetDeviceId, connectionRevision: "connection-1", permissions: ["wifi.write", "wifi.read"],
      async execute({ request }) {
        writes += 1;
        return { action: { actionId: request.actionId, status: "completed", startedAt: now, finishedAt: now, observationIds: [] } };
      },
      async verify({ request }) {
        return observation
          ? { verification: { actionId: request.actionId, status: "verified", rule: expectedVerification, observationIds: [observation.id], checkedAt: now }, observations: [observation] }
          : { actionId: request.actionId, status: "verified", rule: expectedVerification, observationIds: [], checkedAt: now };
      },
    },
  };
}

test("setup playbook requires approval and persists fresh Wi-Fi verification evidence", async () => {
  const f = fixture();
  const journal = createAsyncStorageMobileDeviceJournal(storage(), "mobile-1");
  await journal.saveTask(f.task);
  const t = transport(f.observation);
  const result = await runMobileSetupPlaybook({ playbookId: "smart-home-wifi-setup", ...f, transport: t.transport,
    execution: new MobileDeviceExecution({ ownerId: "mobile-1", journal, now: () => now }),
    steps: [{ stepId: "configure", capabilityId: f.request.capabilityId, capabilitySchemaVersion: "1.0", normalizedInput: f.request.normalizedInput,
      sideEffect: "reversible", approval: f.approval, expectedVerification }] });
  assert.equal(result.status, "succeeded");
  assert.equal(t.writes(), 1);
  assert.deepEqual(await journal.listObservations(f.task.id), [f.observation]);
  assert.equal((await journal.getTask(f.task.id))?.status, "succeeded");
});

test("missing Wi-Fi readback evidence leaves setup unknown and retry does not dispatch again", async () => {
  const f = fixture();
  const journal = createAsyncStorageMobileDeviceJournal(storage(), "mobile-1");
  await journal.saveTask(f.task);
  const t = transport();
  const input = { playbookId: "smart-home-wifi-setup", ...f, transport: t.transport,
    execution: new MobileDeviceExecution({ ownerId: "mobile-1", journal, now: () => now }),
    steps: [{ stepId: "configure", capabilityId: f.request.capabilityId, capabilitySchemaVersion: "1.0", normalizedInput: f.request.normalizedInput,
      sideEffect: "reversible" as const, approval: f.approval, expectedVerification }] };
  assert.equal((await runMobileSetupPlaybook(input)).status, "unknown");
  assert.equal(t.writes(), 1);
  assert.equal((await runMobileSetupPlaybook(input)).status, "unknown");
  assert.equal(t.writes(), 1);
});
