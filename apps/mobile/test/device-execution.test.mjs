import assert from "node:assert/strict";
import test from "node:test";

import {
  MobileDeviceExecution,
  MobileDeviceExecutionError,
  digestDeviceRequest,
} from "../src/device/execution.ts";
import { createAsyncStorageMobileDeviceJournal } from "../src/device/journal.ts";

const now = "2026-11-21T00:00:00.000Z";
const profile = {
  device: {
    id: "ble:device-1",
    ownerScope: "workspace-1",
    displayName: "BLE sensor",
    kind: "hardware",
    lifecycleStatus: "healthy",
    profileRevision: "profile-1",
  },
  adapterId: "ble-sensor",
  adapterVersion: "1.0.0",
  transports: ["ble"],
  connectionRefs: ["ble:device-1"],
  transportDeployments: [{ transport: "ble", mode: "none", pairing: "user_confirmation", removal: "disconnect_only" }],
  profileRevision: "profile-1",
  source: "adapter",
};
const snapshot = {
  snapshotId: "snapshot-1",
  deviceId: profile.device.id,
  adapterId: profile.adapterId,
  adapterVersion: profile.adapterVersion,
  contractMajor: 1,
  connectionRevision: "connection-1",
  capabilities: [{
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
  }],
  observedAt: now,
  freshnessUntil: "2026-11-21T00:05:00.000Z",
};

class MemoryStorage {
  values = new Map();
  async getItem(key) { return this.values.get(key) ?? null; }
  async setItem(key, value) { this.values.set(key, value); }
}

function task(id = "task-1") {
  return {
    id,
    ownerKind: "mobile",
    ownerId: "mobile-1",
    targetDeviceIds: [profile.device.id],
    status: "planning",
    capabilitySnapshotIds: [snapshot.snapshotId],
    createdAt: now,
    updatedAt: now,
  };
}

function request(id = "action-1", taskId = "task-1") {
  return {
    actionId: id,
    taskId,
    targetDeviceId: profile.device.id,
    capabilityId: "hardware.read.status",
    capabilitySchemaVersion: "1.0",
    capabilitySnapshotId: snapshot.snapshotId,
    normalizedInput: {},
    idempotencyKey: `${taskId}:${id}`,
  };
}

function transport() {
  return {
    deviceId: profile.device.id,
    connectionRevision: snapshot.connectionRevision,
    permissions: ["ble"],
    async execute({ request: action }) {
      return { action: { actionId: action.actionId, status: "completed", startedAt: now, finishedAt: now, observationIds: [] } };
    },
  };
}

function approvedWrite(taskId) {
  const action = { ...request("write", taskId), capabilityId: "hardware.write.status", expectedVerification: { online: true } };
  const approval = {
    approvalId: "write-approval", taskId, actionId: action.actionId, targetDeviceId: action.targetDeviceId,
    capabilitySnapshotId: action.capabilitySnapshotId, connectionRevision: snapshot.connectionRevision,
    policyRevision: "device-policy-v1", normalizedInputDigest: digestDeviceRequest(action), expiresAt: snapshot.freshnessUntil,
  };
  return {
    profile,
    snapshot: { ...snapshot, capabilities: [{ ...snapshot.capabilities[0], id: action.capabilityId, sideEffect: "reversible", approvalClass: "ask" }] },
    task: task(taskId),
    request: { ...action, approvalId: approval.approvalId, approval },
  };
}

test("standalone mobile execution persists a local read-only task and replays it idempotently", async () => {
  const journal = createAsyncStorageMobileDeviceJournal(new MemoryStorage(), "mobile-1");
  const manager = new MobileDeviceExecution({ ownerId: "mobile-1", journal, now: () => now });
  const input = { profile, snapshot, task: task(), request: request(), capabilitySideEffect: "read_only", transport: transport() };
  await journal.saveTask(input.task);
  const first = await manager.execute(input);
  const second = await manager.execute(input);
  assert.equal(first.attempt.status, "completed");
  assert.equal(second.attempt.attemptId, first.attempt.attemptId);
  assert.equal((await journal.getTask("task-1")).status, "succeeded");
});

test("mobile writes stop after foreground authorization ends and require exact approval on resume", async () => {
  const journal = createAsyncStorageMobileDeviceJournal(new MemoryStorage(), "mobile-1");
  const manager = new MobileDeviceExecution({ ownerId: "mobile-1", journal, now: () => now });
  const writeRequest = { ...request("write-1", "write-task"), capabilityId: "hardware.write.status", expectedVerification: { online: true } };
  const writeSnapshot = { ...snapshot, capabilities: [{ ...snapshot.capabilities[0], id: "hardware.write.status", sideEffect: "reversible", approvalClass: "ask" }] };
  const writeTask = task("write-task");
  await journal.saveTask(writeTask);
  manager.setForeground(false);
  await assert.rejects(() => manager.execute({ profile, snapshot: writeSnapshot, task: writeTask, request: writeRequest, capabilitySideEffect: "reversible", transport: transport() }), error => error instanceof MobileDeviceExecutionError && error.code === "permission_denied");
  manager.setForeground(true);
  const approval = {
    approvalId: "approval-1",
    taskId: writeRequest.taskId,
    actionId: writeRequest.actionId,
    targetDeviceId: writeRequest.targetDeviceId,
    capabilitySnapshotId: writeRequest.capabilitySnapshotId,
    connectionRevision: snapshot.connectionRevision,
    policyRevision: "device-policy-v1",
    normalizedInputDigest: digestDeviceRequest(writeRequest),
    expiresAt: "2026-11-21T00:05:00.000Z",
  };
  const approved = { ...writeRequest, approvalId: approval.approvalId, approval };
  const result = await manager.execute({ profile, snapshot: writeSnapshot, task: writeTask, request: approved, capabilitySideEffect: "reversible", approval, transport: { ...transport(), async verify({ request: action }) { return { actionId: action.actionId, status: "verified", rule: { online: true }, observationIds: [], checkedAt: now }; } } });
  assert.equal(result.attempt.verification.status, "verified");
});

test("mobile resume marks an interrupted dispatch unknown without replaying the write", async () => {
  const journal = createAsyncStorageMobileDeviceJournal(new MemoryStorage(), "mobile-1");
  const manager = new MobileDeviceExecution({ ownerId: "mobile-1", journal, now: () => now });
  const interruptedTask = task("interrupted");
  const interruptedRequest = request("action-1", interruptedTask.id);
  await journal.saveTask({ ...interruptedTask, status: "executing" });
  await journal.saveAttempt({
    attempt: { attemptId: "interrupted:action-1", taskId: interruptedTask.id, actionId: interruptedRequest.actionId, ownerKind: "mobile", ownerId: "mobile-1", targetDeviceId: profile.device.id, dispatchIntentAt: now, status: "dispatched" },
    request: interruptedRequest,
    requestDigest: digestDeviceRequest(interruptedRequest),
  });
  const recovered = await manager.recoverAfterResume();
  assert.equal(recovered[0].attempt.status, "unknown");
  assert.equal((await journal.getTask(interruptedTask.id)).status, "unknown");
});

test("standalone writes derive authority from the live session and bound task", async () => {
  const journal = createAsyncStorageMobileDeviceJournal(new MemoryStorage(), "mobile-1");
  const manager = new MobileDeviceExecution({ ownerId: "mobile-1", journal, now: () => now });
  const input = approvedWrite("bound-write");
  const native = transport();
  for (const [patch, code] of [
    [{ task: task("other-task") }, "permission_denied"],
    [{ capabilitySideEffect: "read_only" }, "permission_denied"],
    [{ transport: { ...native, permissions: [] } }, "permission_denied"],
    [{ transport: { ...native, connectionRevision: "replacement" } }, "stale_snapshot"],
  ]) {
    await assert.rejects(() => manager.execute({ ...input, transport: native, ...patch }),
      error => error instanceof MobileDeviceExecutionError && error.code === code);
  }
  assert.deepEqual(await journal.listAttempts(input.task.id), []);
});

test("suspending an active standalone write keeps its late receipt and excludes a concurrent dispatch", { timeout: 5_000 }, async () => {
  const journal = createAsyncStorageMobileDeviceJournal(new MemoryStorage(), "mobile-1");
  const manager = new MobileDeviceExecution({ ownerId: "mobile-1", journal, now: () => now });
  const input = approvedWrite("interrupted-write");
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let dispatches = 0;
  const native = transport();
  const pending = {
    ...native,
    async execute(operation) {
      dispatches += 1;
      entered.resolve(operation.signal);
      await finish.promise;
      return native.execute(operation);
    },
    async verify() { assert.fail("suspended write should not start a new readback"); },
  };
  const running = manager.execute({ ...input, transport: pending });
  try {
    const signal = await entered.promise;
    const other = approvedWrite("same-target");
    await assert.rejects(() => manager.execute({ ...other, transport: pending }), error => error.code === "target_busy");
    manager.setForeground(false);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await manager.recoverAfterResume(), []);
  } finally {
    finish.resolve();
    await running;
  }
  const result = await running;
  assert.equal(result.attempt.status, "unknown");
  assert.equal(result.attempt.receipt.status, "completed");
  assert.equal((await journal.getTask(input.task.id)).status, "unknown");
  manager.setForeground(true);
  assert.deepEqual(await manager.execute({ ...input, transport: pending }), result);
  assert.equal(dispatches, 1);
});

test("a lost standalone readback leaves the completed write receipt in the phone journal", async () => {
  const journal = createAsyncStorageMobileDeviceJournal(new MemoryStorage(), "mobile-1");
  const manager = new MobileDeviceExecution({ ownerId: "mobile-1", journal, now: () => now });
  const input = approvedWrite("lost-verification");
  let receiptDuringReadback;
  const result = await manager.execute({ ...input, transport: {
    ...transport(),
    async verify() {
      const attempts = await journal.listAttempts(input.task.id);
      receiptDuringReadback = attempts[0]?.attempt.receipt?.status;
      throw new Error("unavailable transport context");
    },
  } });
  assert.equal(receiptDuringReadback, "completed");
  assert.equal(result.attempt.receipt.status, "completed");
  assert.equal(result.attempt.verification.status, "not_evaluable");
  assert.equal((await journal.getTask(input.task.id)).status, "unknown");
  assert.doesNotMatch(JSON.stringify(await journal.listAttempts(input.task.id)), /unavailable transport context/);
});
