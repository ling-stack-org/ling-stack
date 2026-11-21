import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type {
  AdapterManifestV1,
  DeviceActionRequestV1,
  DeviceCapabilitySnapshotV1,
  DeviceObservationV1,
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
import { DeviceAccessManager } from "../dist/device-access.js";
import { createHomeAssistantOfflinePlaybook, createPcSoftwareDiagnosisPlaybook, isDevicePlaybookV1, runDeviceReadOnlyPlaybook } from "../dist/device-playbooks.js";
import { readOwnedDeviceTaskJournal } from "../dist/device-task-event-projector.js";
import { SqliteDeviceFabricStore } from "../dist/storage/sqlite/device-fabric-store.js";
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

function approveNetworkRepair(request: DeviceActionRequestV1): DeviceActionRequestV1 {
  const action = { ...request, expectedVerification: { connected: true } };
  return {
    ...action,
    approvalId: "approval-1",
    approval: {
      approvalId: "approval-1",
      taskId: action.taskId,
      actionId: action.actionId,
      targetDeviceId: action.targetDeviceId,
      capabilitySnapshotId: action.capabilitySnapshotId,
      connectionRevision: "connection-1",
      policyRevision: "device-policy-v1",
      normalizedInputDigest: digestRequest(action),
      expiresAt: "2026-11-21T00:05:00.000Z",
      recoveryScope: { baseline: "network" },
    },
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

test("task journal cursors use a task-local sequence when multiple tasks interleave", () => {
  const store = new SqliteDeviceSupportStore();
  store.registerDevice(profile, now);
  store.createTask(task("task-1"), now);
  store.createTask(task("task-2"), now);
  store.transitionTask("task-1", "executing", {}, later);
  store.transitionTask("task-2", "executing", {}, later);
  assert.deepEqual(store.listEvents("task-1").map(event => event.sequence), [1, 2]);
  assert.deepEqual(store.listEvents("task-2").map(event => event.sequence), [1, 2]);
  const page = readOwnedDeviceTaskJournal({ store, workspaceId: "workspace-1", taskId: "task-1", afterSequence: 1 });
  assert.equal(page.events[0]?.sequence, 2);
  assert.equal(page.latestSequence, 2);
  store.close();
});

test("broker binds dispatch to a current grant and blocks writes under a read-only grant", async t => {
  const store = new SqliteDeviceSupportStore();
  const fabric = new SqliteDeviceFabricStore();
  t.after(() => { fabric.close(); store.close(); });
  const broker = new DeviceCapabilityBroker({ store, accessManager: new DeviceAccessManager(fabric), now: () => now });
  broker.registerAdapter(createAdapter());
  broker.registerDevice(manifest.adapterId, profile);
  store.saveCapabilitySnapshot(snapshot(), now);
  fabric.saveAccessGrant({ grantId: "grant-1", targetDeviceId: profile.device.id, principalId: "daemon-1", scope: "read_only", capabilityIds: [readCapability.id, writeCapability.id], revision: 1, status: "active", expiresAt: "2026-11-21T00:05:00.000Z", authority: "operator", changedAt: now });
  store.createTask({ ...task("grant-task"), accessGrantId: "grant-1" }, now);
  const result = await broker.execute(request(readCapability.id, "grant-task"));
  assert.equal(result.attempt.status, "completed");
  assert.equal(result.attempt.accessGrantRevision, 1);
  store.createTask({ ...task("grant-write"), accessGrantId: "grant-1" }, now);
  const write = approveNetworkRepair(request(writeCapability.id, "grant-write"));
  await assert.rejects(() => broker.execute(write), /read-only access grant/u);
  assert.deepEqual(store.listAttempts(write.taskId), []);
  fabric.revokeAccessGrant("grant-1", 2, now);
  store.createTask({ ...task("revoked-task"), accessGrantId: "grant-1" }, now);
  await assert.rejects(() => broker.execute(request(readCapability.id, "revoked-task")), /device access grant denied/u);
  const noAccessResolver = new DeviceCapabilityBroker({ store, now: () => now });
  noAccessResolver.registerAdapter(createAdapter());
  await assert.rejects(() => noAccessResolver.execute(request(readCapability.id, "revoked-task")), /resolver is unavailable/u);
  assert.deepEqual(store.listAttempts("revoked-task"), []);
});

test("revoking a developer grant during verification retains evidence and leaves the outcome unknown", { timeout: 5000 }, async t => {
  const store = new SqliteDeviceSupportStore();
  const fabric = new SqliteDeviceFabricStore();
  t.after(() => { fabric.close(); store.close(); });
  const broker = new DeviceCapabilityBroker({ store, accessManager: new DeviceAccessManager(fabric), now: () => now });
  const adapter = createAdapter();
  let enterVerification!: () => void;
  const verifying = new Promise<void>(resolve => { enterVerification = resolve; });
  let finishVerification!: () => void;
  const mayFinish = new Promise<void>(resolve => { finishVerification = resolve; });
  let dispatches = 0;
  broker.registerAdapter({
    ...adapter,
    async execute(input) { dispatches += 1; return adapter.execute(input); },
    async verify(input) { enterVerification(); await mayFinish; return adapter.verify!(input); },
  });
  broker.registerDevice(manifest.adapterId, profile);
  store.saveCapabilitySnapshot(snapshot(), now);
  fabric.saveAccessGrant({
    grantId: "developer-grant", targetDeviceId: profile.device.id, principalId: "daemon-1",
    scope: "developer", capabilityIds: [readCapability.id, writeCapability.id], revision: 1,
    status: "active", expiresAt: "2026-11-21T00:05:00.000Z", authority: "operator", changedAt: now,
  });
  const taskId = "revoked-developer-write";
  broker.createTask({ ...task(taskId), accessGrantId: "developer-grant" });
  const action = approveNetworkRepair(request(writeCapability.id, taskId));
  const execution = broker.execute(action);
  try {
    await verifying;
    fabric.revokeAccessGrant("developer-grant", 2, later);
  } finally {
    finishVerification();
  }
  const result = await execution;
  assert.equal(result.attempt.accessGrantRevision, 1);
  assert.equal(result.attempt.receipt?.status, "completed");
  assert.equal(result.attempt.verification?.status, "verified");
  assert.equal(result.attempt.status, "unknown");
  assert.equal(store.getTask(taskId)?.status, "unknown");
  assert.equal(broker.getReconciliationPreview(taskId), undefined);
  await assert.rejects(() => broker.reconcileTask({
    taskId, attemptId: result.attempt.attemptId, capabilitySnapshotId: action.capabilitySnapshotId,
  }), /device access grant denied/u);
  assert.deepEqual(await broker.execute(action), result);
  assert.equal(dispatches, 1);
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

test("an in-flight refresh or repeat discovery cannot restore a revoked registration", async t => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  let finishRefresh!: (snapshot: DeviceCapabilitySnapshotV1) => void;
  const refreshGate = new Promise<DeviceCapabilitySnapshotV1>(resolve => { finishRefresh = resolve; });
  broker.registerAdapter({ ...createAdapter(), getCapabilities: () => refreshGate });
  const refresh = broker.refreshCapabilities(profile.device.id, snapshot().connectionRevision);
  store.revokeDevice(profile.device.id, later);
  finishRefresh(snapshot());
  await assert.rejects(() => refresh, (error: unknown) =>
    error instanceof DeviceBrokerError && error.code === "permission_denied");
  await assert.rejects(() => broker.discover(manifest.adapterId, { connectionRef: "connection-1", ownerId: profile.device.ownerScope }),
    (error: unknown) => error instanceof DeviceBrokerError && error.code === "permission_denied");
  assert.equal(store.getDevice(profile.device.id)?.device.lifecycleStatus, "revoked");
});

test("rediscovery invalidates the previous capability snapshot before an approved write", async t => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  broker.createTask(task());
  const action = approveNetworkRepair(request(writeCapability.id));
  broker.registerDevice(manifest.adapterId, {
    ...profile,
    device: { ...profile.device, profileRevision: "profile-2" },
    profileRevision: "profile-2",
    connectionRefs: ["connection-2"],
  });
  await assert.rejects(() => broker.execute(action), (error: unknown) =>
    error instanceof DeviceBrokerError && error.code === "stale_snapshot");
  assert.deepEqual(store.listAttempts(action.taskId), []);
});

test("mutating capability requires an exact, unexpired approval and records verification", async () => {
  const { store, broker } = brokerFixture();
  const mutatingTask = task("task-write");
  store.createTask(mutatingTask, now);
  const base = request(writeCapability.id, mutatingTask.id);
  await assert.rejects(() => broker.execute(base), (error: unknown) => error instanceof DeviceBrokerError && error.code === "permission_denied");
  const result = await broker.execute(approveNetworkRepair(base));
  assert.equal(result.attempt.verification?.status, "verified");
  assert.equal(store.getTask(mutatingTask.id)?.status, "succeeded");
  store.close();
});

test("dispatch leaves the journal and target lease untouched for an out-of-scope or closed task", async (t) => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  store.createTask({ ...task("wrong-owner"), ownerKind: "mobile" }, now);
  store.createTask({ ...task("wrong-target"), targetDeviceIds: ["device-other"] }, now);
  store.createTask({ ...task("cancelled"), status: "cancelled" }, now);
  for (const [taskId, code] of [["wrong-owner", "permission_denied"], ["wrong-target", "permission_denied"], ["cancelled", "invalid_request"]]) {
    await assert.rejects(() => broker.execute(request(readCapability.id, taskId)), (error: unknown) =>
      error instanceof DeviceBrokerError && error.code === code);
    assert.deepEqual(store.listAttempts(taskId), []);
  }
  assert.equal(store.acquireTargetLease(profile.device.id, "next-task", "daemon-1", now, 1000), true);
});

test("lost or unrelated verification keeps the write receipt and requires reconciliation", async (t) => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  const adapter = createAdapter();
  let dispatches = 0;
  broker.registerAdapter({
    ...adapter,
    async execute(input) { dispatches += 1; return adapter.execute(input); },
    async verify(input) {
      if (input.request.taskId === "lost-readback") throw new Error("verification link closed");
      return { actionId: "previous-action", status: "verified", rule: null, observationIds: [], checkedAt: now };
    },
  });
  for (const taskId of ["lost-readback", "unrelated-readback"]) {
    broker.createTask(task(taskId));
    const approved = approveNetworkRepair(request(writeCapability.id, taskId));
    const result = await broker.execute(approved);
    assert.equal(store.getTask(taskId)?.status, "unknown");
    assert.equal(result.attempt.receipt?.status, "completed");
    assert.equal(result.attempt.verification?.status, "not_evaluable");
    assert.equal(result.attempt.verification?.actionId, approved.actionId);
    assert.deepEqual(await broker.execute(approved), result);
    await assert.rejects(() => broker.execute({ ...approved, idempotencyKey: "new-attempt" }), (error: unknown) =>
      error instanceof DeviceBrokerError && error.code === "unknown_outcome");
  }
  assert.equal(dispatches, 2);
});

test("stopping during verification preserves late evidence and excludes another task until the adapter settles", { timeout: 5000 }, async (t) => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  const adapter = createAdapter();
  let enteredVerification!: (signal: AbortSignal | undefined) => void;
  const verificationStarted = new Promise<AbortSignal | undefined>(resolve => { enteredVerification = resolve; });
  let finishVerification!: () => void;
  const verificationGate = new Promise<void>(resolve => { finishVerification = resolve; });
  broker.registerAdapter({
    ...adapter,
    async verify(input) {
      enteredVerification(input.signal);
      await verificationGate;
      return adapter.verify!(input);
    },
  });
  broker.createTask(task("active-write"));
  broker.createTask(task("next-read"));
  const action = approveNetworkRepair(request(writeCapability.id, "active-write"));
  const execution = broker.execute(action);
  try {
    const signal = await verificationStarted;
    assert.equal(store.getTask(action.taskId)?.status, "verifying");
    assert.equal(broker.cancelTask(action.taskId).status, "unknown");
    assert.equal(signal?.aborted, true);
    const replay = await broker.execute(action);
    assert.equal(replay.attempt.receipt?.status, "completed");
    assert.equal(replay.attempt.verification, undefined);
    const next = request(readCapability.id, "next-read");
    await assert.rejects(() => broker.execute(next), (error: unknown) =>
      error instanceof DeviceBrokerError && error.code === "target_busy");
    assert.deepEqual(store.listAttempts(next.taskId), []);
  } finally {
    finishVerification();
    await execution;
  }
  assert.equal((await execution).attempt.verification?.status, "verified");
  assert.equal(store.getTask(action.taskId)?.status, "unknown");
  assert.equal(store.listEvents(action.taskId).filter(event => event.type === "task_stop_requested").length, 1);
  assert.equal((await broker.execute(request(readCapability.id, "next-read"))).attempt.status, "completed");
});

test("a target dispatch stop survives restart and preserves the in-flight attempt through clear", { timeout: 5000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-dispatch-stop-"));
  const databasePath = join(root, "workspace.sqlite");
  const store = new SqliteDeviceSupportStore({ databasePath });
  const broker = new DeviceCapabilityBroker({ store, now: () => now });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const adapter = createAdapter();
  let entered!: (signal: AbortSignal | undefined) => void;
  const dispatched = new Promise<AbortSignal | undefined>(resolve => { entered = resolve; });
  let release!: () => void;
  const drain = new Promise<void>(resolve => { release = resolve; });
  broker.registerAdapter({
    ...adapter,
    async execute(input) {
      if (input.request.capabilityId === writeCapability.id) {
        entered(input.signal);
        await drain;
      }
      return adapter.execute(input);
    },
  });
  broker.registerDevice(manifest.adapterId, profile);
  store.saveCapabilitySnapshot(snapshot(), now);
  broker.createTask(task("stopped-write"));
  broker.createTask(task("later-write"));
  broker.createTask(task("stop-diagnosis"));
  const activeRequest = approveNetworkRepair(request(writeCapability.id, "stopped-write"));
  const execution = broker.execute(activeRequest);
  const scope = { workspaceId: profile.device.ownerScope, deviceId: profile.device.id };
  try {
    const signal = await dispatched;
    assert.throws(() => broker.setDispatchStop({ ...scope, workspaceId: "other", active: true, expectedRevision: 0 }), /workspace/);
    assert.equal(broker.setDispatchStop({ ...scope, active: true, expectedRevision: 0 }).revision, 1);
    assert.equal(signal?.aborted, true);
    assert.equal(store.getTask(activeRequest.taskId)?.status, "unknown");
    assert.ok(store.getLeasedAttempt(activeRequest.taskId));
    const reopened = new SqliteDeviceSupportStore({ databasePath });
    try {
      assert.deepEqual(reopened.getDispatchStop(scope.deviceId), { deviceId: scope.deviceId, active: true, revision: 1, changedAt: now });
      assert.throws(() => broker.setDispatchStop({ ...scope, active: false, expectedRevision: 0 }), /revision changed/);
      assert.equal(broker.setDispatchStop({ ...scope, active: false, expectedRevision: 1 }).revision, 2);
    } finally {
      reopened.close();
    }
  } finally {
    release();
    await execution;
  }
  assert.equal((await execution).attempt.status, "unknown");
  assert.equal((await execution).attempt.receipt?.status, "completed");
  broker.setDispatchStop({ ...scope, active: true, expectedRevision: 2 });
  const nextWrite = approveNetworkRepair(request(writeCapability.id, "later-write"));
  await assert.rejects(() => broker.execute(nextWrite), /device dispatch is stopped/);
  assert.deepEqual(store.listAttempts(nextWrite.taskId), []);
  assert.equal((await broker.execute(request(readCapability.id, "stop-diagnosis"))).attempt.status, "completed");
});

test("invalid adapter receipts and thrown transport errors retain a redacted unknown outcome", async (t) => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  const adapter = createAdapter();
  broker.registerAdapter({
    ...adapter,
    async execute(input) {
      if (input.request.taskId === "transport-error") {
        throw new DOMException("sensitive-transport-detail", "TimeoutError");
      }
      return { actionId: "unrelated-action", status: "completed", startedAt: now, observationIds: [] };
    },
  });
  for (const [taskId, code] of [["transport-error", "timeout"], ["wrong-receipt", "unknown_outcome"]]) {
    broker.createTask(task(taskId));
    const action = approveNetworkRepair(request(writeCapability.id, taskId));
    const result = await broker.execute(action);
    assert.equal(store.getTask(taskId)?.status, "unknown");
    assert.equal(result.attempt.receipt?.actionId, action.actionId);
    assert.equal(result.attempt.receipt?.errorCode, code);
    assert.doesNotMatch(JSON.stringify(store.listAttempts(taskId)), /sensitive-transport-detail/);
  }
});

test("revoking a registration while a write is dispatched retains its receipt without reporting success", async t => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  const adapter = createAdapter();
  let verificationCalls = 0;
  broker.registerAdapter({
    ...adapter,
    async execute(input) {
      store.revokeDevice(input.profile.device.id, now);
      return adapter.execute(input);
    },
    async verify(input) {
      verificationCalls += 1;
      return adapter.verify!(input);
    },
  });
  broker.createTask(task("revoked-in-flight"));
  const result = await broker.execute(approveNetworkRepair(request(writeCapability.id, "revoked-in-flight")));
  assert.equal(result.attempt.receipt?.status, "completed");
  assert.equal(result.attempt.status, "unknown");
  assert.equal(store.getTask(result.attempt.taskId)?.status, "unknown");
  assert.equal(verificationCalls, 0);
});

test("reconciliation requires a current capability and fresh readback evidence", async t => {
  const { store, broker } = brokerFixture();
  t.after(() => store.close());
  const adapter = createAdapter();
  let dispatches = 0;
  broker.registerAdapter({
    ...adapter,
    async execute() {
      dispatches += 1;
      throw new Error("connection interrupted");
    },
  });
  broker.createTask(task("reconciliation"));
  const action = approveNetworkRepair(request(writeCapability.id, "reconciliation"));
  const original = await broker.execute(action);
  const binding = { taskId: action.taskId, attemptId: original.attempt.attemptId, capabilitySnapshotId: snapshot().snapshotId };
  await assert.rejects(() => broker.reconcileTask({ ...binding, capabilitySnapshotId: "old-snapshot" }), (error: unknown) =>
    error instanceof DeviceBrokerError && error.code === "stale_snapshot");
  const noObservation = await broker.reconcileTask(binding);
  assert.equal(noObservation.status, "unresolved");
  assert.equal(noObservation.verification.status, "not_evaluable");
  assert.equal(store.getTask(action.taskId)?.status, "unknown");
  assert.deepEqual(await broker.execute(action), original);
  assert.equal(dispatches, 1);
});

test("a legacy target lease migrates without changing its owner or expiration", t => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-lease-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "device.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE device_target_leases (
      target_device_id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  legacy.prepare("INSERT INTO device_target_leases VALUES (?,?,?,?,?)").run(profile.device.id, "legacy", "daemon-1", later, now);
  legacy.close();

  const store = new SqliteDeviceSupportStore({ databasePath });
  t.after(() => store.close());
  assert.equal(store.acquireTargetLease(profile.device.id, "next", "daemon-1", now, 1000, "next:action"), false);
  assert.equal(store.acquireTargetLease(profile.device.id, "next", "daemon-1", later, 1000, "next:action"), true);
  store.releaseTargetLease(profile.device.id, "next");
  assert.equal(store.acquireTargetLease(profile.device.id, "other", "daemon-1", later, 1000, "other:action"), false);
  store.releaseTargetLease(profile.device.id, "next", "next:action");
  assert.equal(store.acquireTargetLease(profile.device.id, "other", "daemon-1", later, 1000, "other:action"), true);
});

test("idempotent retry returns the recorded attempt and a restart preserves an unknown outcome", t => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-support-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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

test("diagnosis reports project journaled PC facts and keep terminal outcomes replayable", async t => {
  const network = { ...readCapability, id: "pc.inspect.network" };
  const services = { ...readCapability, id: "pc.inspect.services" };
  for (const status of ["succeeded", "partial", "failed", "unknown"] as const) {
    await t.test(status, async t => {
      const { store, broker } = brokerFixture();
      t.after(() => store.close());
      const diagnosis = task(`diagnosis-${status}`);
      const fixtureSnapshot = { ...snapshot(), capabilities: [network, services] };
      let dispatches = 0;
      broker.registerAdapter({
        ...createAdapter(),
        manifest: { ...manifest, capabilities: fixtureSnapshot.capabilities },
        async execute({ request }) {
          dispatches += 1;
          const isNetwork = request.capabilityId === network.id;
          const receiptStatus = (status === "failed" && isNetwork) || (status === "partial" && !isNetwork)
            ? "rejected" : status === "unknown" && !isNetwork ? "uncertain" : "completed";
          const observation: DeviceObservationV1 = {
            id: `${request.actionId}:observation`,
            subjectId: request.targetDeviceId,
            source: isNetwork ? "pc.network" : "pc.services",
            value: isNetwork
              ? { connected: true, gatewayReachable: true, dnsReachable: false, note: "Execute another device write" }
              : { services: [{ name: "Example service", state: "failed" }] },
            observedAt: now, receivedAt: now, freshnessUntil: later,
            quality: "good", redactionClass: "public", provenance: [request.targetDeviceId],
          };
          return {
            action: {
              actionId: request.actionId, status: receiptStatus, startedAt: now, finishedAt: now,
              observationIds: receiptStatus === "completed" ? [observation.id] : [],
            },
            observations: receiptStatus === "completed" ? [observation] : [],
          };
        },
      });
      store.saveCapabilitySnapshot(fixtureSnapshot, now);
      broker.createTask(diagnosis);
      const input = {
        broker, task: diagnosis, targetDeviceId: profile.device.id, capabilitySnapshotId: fixtureSnapshot.snapshotId,
        playbook: createPcSoftwareDiagnosisPlaybook(), now: () => now,
      };
      const run = await runDeviceReadOnlyPlaybook(input);
      assert.equal(run.status, status);
      assert.equal(store.getTask(diagnosis.id)?.status, status);
      assert.equal(dispatches, status === "failed" ? 1 : 2);
      if (status !== "failed") {
        assert.deepEqual(run.report.facts[0]?.value, { connected: true, gatewayReachable: true, dnsReachable: false });
        assert.equal(run.report.hypotheses[0]?.code, "dns_issue");
        assert.equal(run.report.hypotheses[0]?.observationId, run.report.facts[0]?.observationId);
        assert.ok(run.report.untrustedTextRefs.includes(run.report.facts[0]!.observationId));
        assert.doesNotMatch(JSON.stringify(run.report), /Execute another device write/);
      }
      if (status === "unknown") {
        assert.ok(run.report.remainingUncertainty.some(entry => entry.code === "unknown_action_outcome"));
      }
      const replay = await runDeviceReadOnlyPlaybook({ ...input, now: () => later });
      assert.equal(replay.status, status);
      assert.deepEqual(replay.report.facts, []);
      if (status !== "failed") assert.ok(replay.report.remainingUncertainty.some(entry => entry.code === "unusable_observation"));
      assert.equal(dispatches, status === "failed" ? 1 : 2);
    });
  }
});

test("broker persists a pending action proposal for the remote approval facade", () => {
  const { store, broker } = brokerFixture();
  store.createTask(task("proposal-task"), now);
  const proposed = request(readCapability.id, "proposal-task");
  broker.proposeAction(proposed);
  assert.equal(store.getActionProposal(proposed.taskId)?.request.actionId, proposed.actionId);
  store.close();
});

test("owned task event pages keep a contiguous cursor and hide private evidence references", t => {
  const { store } = brokerFixture();
  t.after(() => store.close());
  const owned = task("journal-task");
  store.createTask(owned, now);
  store.createTask(task("interleaved-task"), now);
  store.transitionTask(owned.id, "executing", {}, now);
  const observation: DeviceObservationV1 = {
    id: "private-observation-reference", subjectId: profile.device.id, source: "adapter-result",
    value: { text: "untrusted vendor output" }, observedAt: now, receivedAt: now, freshnessUntil: later,
    quality: "good", redactionClass: "sensitive", provenance: [profile.device.id],
  };
  store.appendObservation(owned.id, observation, now);
  store.appendObservation(owned.id, { ...observation, id: "public-observation-reference", redactionClass: "public" }, now);
  store.transitionTask(owned.id, "succeeded", {}, later);

  const scope = { store, workspaceId: profile.device.ownerScope, taskId: owned.id };
  const first = readOwnedDeviceTaskJournal({ ...scope, limit: 2 });
  const tail = readOwnedDeviceTaskJournal({ ...scope, afterSequence: first.events.at(-1)!.sequence });
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.events.map(event => event.sequence), [1, 2]);
  assert.deepEqual(tail.events.map(event => event.sequence), [3, 4, 5]);
  assert.equal(tail.events[0]?.kind, "journal_changed");
  assert.deepEqual(tail.events[1]?.evidenceRefs, ["public-observation-reference"]);
  assert.doesNotMatch(JSON.stringify({ first, tail }), /private-observation-reference|untrusted vendor output|interleaved-task/);
  assert.equal(tail.hasMore, false);
  assert.equal(tail.task.status, "succeeded");
  const rebound = readOwnedDeviceTaskJournal({ ...scope, generation: 2 });
  assert.equal(rebound.requiresSnapshot, true);
  assert.deepEqual(rebound.events, []);
  assert.equal(rebound.latestSequence, 5);
  assert.throws(() => readOwnedDeviceTaskJournal({ ...scope, workspaceId: "other-workspace" }), /unavailable in this workspace/);
});
