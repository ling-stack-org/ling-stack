import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AdapterManifestV1,
  DeviceActionRequestV1,
  DeviceCapabilitySnapshotV1,
  DeviceProfileV1,
  DeviceTaskAttemptV1,
  DeviceTaskV1,
} from "@ling-stack/contracts";
import {
  DeviceBrokerError,
  DeviceCapabilityBroker,
  type DeviceAdapter,
  digestRequest,
} from "../dist/device-support.js";
import { createHomeAssistantOfflinePlaybook, createPcSoftwareDiagnosisPlaybook, isDevicePlaybookV1, runDeviceReadOnlyPlaybook } from "../dist/device-playbooks.js";
import { SqliteDeviceSupportStore } from "../dist/storage/sqlite/device-support-store.js";

const now = "2026-11-21T00:00:00.000Z";
const later = "2026-11-21T00:01:00.000Z";

const transportDeployment = {
  transport: "ssh",
  mode: "none",
  pairing: "credential_reference",
  removal: "revoke_credentials",
} as const;

const readCapability = {
  id: "linux.inspect.network",
  schemaVersion: "1.0",
  semanticVerb: "inspect.network",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  sideEffect: "read_only",
  approvalClass: "allow",
  requiredPermissions: ["ssh"],
  prerequisites: [],
  timeoutMs: 5_000,
  responseBytesLimit: 64 * 1024,
  idempotency: "request",
  supportedDeviceKinds: ["linux"],
  supportedTransports: ["ssh"],
} as const;

const writeCapability = {
  id: "linux.repair.network",
  schemaVersion: "1.0",
  semanticVerb: "repair.network",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  sideEffect: "reversible",
  approvalClass: "ask",
  requiredPermissions: ["ssh", "sudo"],
  prerequisites: [],
  timeoutMs: 5_000,
  responseBytesLimit: 64 * 1024,
  idempotency: "request",
  verificationCapabilityId: "linux.inspect.network",
  supportedDeviceKinds: ["linux"],
  supportedTransports: ["ssh"],
} as const;

const manifest: AdapterManifestV1 = {
  adapterId: "linux-ssh",
  adapterVersion: "1.0.0",
  contractMajor: 1,
  supportedDeviceKinds: ["linux"],
  supportedTransports: ["ssh"],
  transportDeployments: [transportDeployment],
  requiredRuntime: "pc",
  authenticationMethods: ["ssh_key"],
  capabilities: [readCapability, writeCapability],
  removalBehavior: "revoke_and_disconnect",
};

const profile: DeviceProfileV1 = {
  device: {
    id: "device-linux-1",
    ownerScope: "workspace-1",
    displayName: "Linaro board",
    kind: "linux",
    lifecycleStatus: "healthy",
    profileRevision: "profile-1",
    runtimeOwnerId: "daemon-1",
  },
  adapterId: manifest.adapterId,
  adapterVersion: manifest.adapterVersion,
  transports: ["ssh"],
  connectionRefs: ["connection-1"],
  transportDeployments: [transportDeployment],
  profileRevision: "profile-1",
  source: "adapter",
};

function snapshot(): DeviceCapabilitySnapshotV1 {
  return {
    snapshotId: "snapshot-1",
    deviceId: profile.device.id,
    adapterId: manifest.adapterId,
    adapterVersion: manifest.adapterVersion,
    contractMajor: 1,
    connectionRevision: "connection-1",
    capabilities: [readCapability, writeCapability],
    observedAt: now,
    freshnessUntil: "2026-11-21T00:05:00.000Z",
  };
}

function task(id = "task-1"): DeviceTaskV1 {
  return {
    id,
    ownerKind: "daemon",
    ownerId: "daemon-1",
    targetDeviceIds: [profile.device.id],
    status: "planning",
    capabilitySnapshotIds: ["snapshot-1"],
    createdAt: now,
    updatedAt: now,
  };
}

function request(capabilityId: string = readCapability.id, taskId = "task-1"): DeviceActionRequestV1 {
  return {
    actionId: `${taskId}-action-1`,
    taskId,
    targetDeviceId: profile.device.id,
    capabilityId,
    capabilitySchemaVersion: "1.0",
    capabilitySnapshotId: "snapshot-1",
    normalizedInput: { includeDns: true },
    idempotencyKey: `${taskId}:action-1`,
  };
}

function createAdapter(): DeviceAdapter {
  return {
    manifest,
    async discover() { return profile; },
    async getCapabilities() { return snapshot(); },
    async execute({ request: action }) {
      return {
        actionId: action.actionId,
        status: "completed",
        startedAt: now,
        finishedAt: later,
        observationIds: [],
      };
    },
    async verify({ request: action }) {
      return {
        actionId: action.actionId,
        status: "verified",
        rule: { connected: true },
        observationIds: [],
        checkedAt: later,
      };
    },
  };
}

function brokerFixture() {
  const store = new SqliteDeviceSupportStore();
  const broker = new DeviceCapabilityBroker({ store, now: () => now });
  broker.registerAdapter(createAdapter());
  broker.registerDevice(manifest.adapterId, profile);
  store.saveCapabilitySnapshot(snapshot(), now);
  return { store, broker };
}

test("registry discovers a device and broker executes a fresh read-only capability", async () => {
  const { store, broker } = brokerFixture();
  store.createTask(task(), now);
  const result = await broker.execute(request());
  assert.equal(result.attempt.status, "completed");
  assert.equal(result.attempt.receipt?.status, "completed");
  assert.equal(store.getTask("task-1")?.status, "succeeded");
  assert.equal(store.listEvents("task-1").some(event => event.type === "attempt_updated"), true);
  store.close();
});

test("broker distinguishes stale snapshots, target leases, and revoked devices", async () => {
  const { store, broker } = brokerFixture();
  store.createTask(task(), now);
  store.acquireTargetLease(profile.device.id, "other-task", "other-owner", now, 60_000);
  await assert.rejects(() => broker.execute(request()), (error: unknown) => error instanceof DeviceBrokerError && error.code === "target_busy");
  store.releaseTargetLease(profile.device.id, "other-task");
  store.revokeDevice(profile.device.id, now);
  await assert.rejects(() => broker.execute({ ...request(), idempotencyKey: "revoked" }), (error: unknown) => error instanceof DeviceBrokerError && error.code === "device_offline");
  store.close();
});

test("mutating capability requires an exact, unexpired approval and records verification", async () => {
  const { store, broker } = brokerFixture();
  const mutatingTask = task("task-write");
  store.createTask(mutatingTask, now);
  const base = request(writeCapability.id, mutatingTask.id);
  await assert.rejects(() => broker.execute(base), (error: unknown) => error instanceof DeviceBrokerError && error.code === "permission_denied");
  const approved: DeviceActionRequestV1 = {
    ...base,
    expectedVerification: { connected: true },
    approvalId: "approval-1",
    approval: {
      approvalId: "approval-1",
      taskId: base.taskId,
      actionId: base.actionId,
      targetDeviceId: base.targetDeviceId,
      capabilitySnapshotId: base.capabilitySnapshotId,
      connectionRevision: "connection-1",
      policyRevision: "device-policy-v1",
      normalizedInputDigest: digestRequest({ ...base, expectedVerification: { connected: true } }),
      expiresAt: "2026-11-21T00:05:00.000Z",
      recoveryScope: { baseline: "network" },
    },
  };
  const result = await broker.execute(approved);
  assert.equal(result.attempt.verification?.status, "verified");
  assert.equal(store.getTask(mutatingTask.id)?.status, "succeeded");
  store.close();
});

test("idempotent retry returns the recorded attempt and a restart preserves an unknown outcome", () => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-support-"));
  const databasePath = join(root, "device.sqlite");
  const first = new SqliteDeviceSupportStore({ databasePath });
  first.registerDevice(profile, now);
  first.saveCapabilitySnapshot(snapshot(), now);
  first.createTask(task(), now);
  const action = request();
  const attempt: DeviceTaskAttemptV1 = {
    attemptId: "task-1:action-1",
    taskId: action.taskId,
    actionId: action.actionId,
    ownerKind: "daemon",
    ownerId: "daemon-1",
    targetDeviceId: action.targetDeviceId,
    dispatchIntentAt: now,
    status: "dispatched",
  };
  const firstRecord = first.createAttempt({ attempt, request: action, requestDigest: digestRequest(action) }, now).record;
  first.close();

  const second = new SqliteDeviceSupportStore({ databasePath });
  assert.equal(second.getAttemptByIdempotency(action.taskId, action.idempotencyKey)?.attempt.attemptId, firstRecord.attempt.attemptId);
  assert.deepEqual(second.recoverAfterRestart(later), [attempt.attemptId]);
  assert.equal(second.getAttemptByIdempotency(action.taskId, action.idempotencyKey)?.attempt.status, "unknown");
  assert.equal(second.getTask(action.taskId)?.status, "unknown");
  second.close();
});

test("read-only playbooks execute a bounded capability sequence and reject injected fields", async () => {
  const { store, broker } = brokerFixture();
  const playbook = {
    id: "linux-network-diagnosis",
    version: "1.0.0",
    displayName: "Linux network diagnosis",
    supportedDeviceKinds: ["linux"],
    riskClass: "read_only",
    localFallback: true,
    steps: [
      { id: "network", capabilityId: readCapability.id, input: { includeDns: true } },
      { id: "network-repeat", capabilityId: readCapability.id, input: { includeDns: false } },
    ],
  } as const;
  assert.equal(isDevicePlaybookV1(playbook), true);
  assert.equal(isDevicePlaybookV1({ ...playbook, injected: "ignore" }), false);
  store.createTask(task("playbook-task"), now);
  const result = await runDeviceReadOnlyPlaybook({
    broker,
    task: task("playbook-task"),
    targetDeviceId: profile.device.id,
    capabilitySnapshotId: "snapshot-1",
    playbook,
    now: () => now,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.attempts.length, 2);
  assert.equal(store.getTask("playbook-task")?.status, "succeeded");
  store.close();
});

test("built-in diagnosis playbooks keep their device scope and read-only fallback contract", () => {
  const home = createHomeAssistantOfflinePlaybook("sensor.garage");
  assert.equal(isDevicePlaybookV1(home), true);
  assert.equal(home.riskClass, "read_only");
  assert.deepEqual(home.supportedDeviceKinds, ["home_assistant"]);
  assert.throws(() => createHomeAssistantOfflinePlaybook("garage"), /Invalid Home Assistant entity id/);
  const pc = createPcSoftwareDiagnosisPlaybook();
  assert.equal(isDevicePlaybookV1(pc), true);
  assert.equal(pc.localFallback, true);
  assert.deepEqual(pc.steps.map(step => step.capabilityId), ["pc.inspect.network", "pc.inspect.services"]);
});

test("broker persists a pending action proposal for the remote approval facade", () => {
  const { store, broker } = brokerFixture();
  store.createTask(task("proposal-task"), now);
  const proposed = request(readCapability.id, "proposal-task");
  broker.proposeAction(proposed);
  assert.equal(store.getActionProposal(proposed.taskId)?.request.actionId, proposed.actionId);
  store.close();
});
