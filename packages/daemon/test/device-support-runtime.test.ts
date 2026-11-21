import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DeviceActionRequestV1, DeviceTaskAttemptV1, DeviceTaskStatusV1 } from "@ling-stack/contracts";
import { DeviceBrokerError, digestRequest } from "@ling-stack/core";
import { createDeviceSupportRuntime } from "../dist/features/device-support/runtime.js";

test("daemon device-support runtime composes the durable store, broker and remote facade", () => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-runtime-"));
  const runtime = createDeviceSupportRuntime({ databasePath: join(root, "workspace.sqlite") });
  assert.ok(runtime.store.database);
  assert.ok(runtime.fabricStore.database);
  assert.ok(runtime.developerStore.database);
  assert.ok(runtime.protocolStore.database);
  assert.equal(runtime.broker.store, runtime.store);
  assert.equal(runtime.remoteFacade.listDevices("workspace-1").devices.length, 0);
  runtime.close();
});

test("daemon startup recovers interrupted dispatch and readback from the owner journal", async t => {
  const root = mkdtempSync(join(tmpdir(), "ling-runtime-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "workspace.sqlite");
  const startedAt = "2026-11-21T00:00:00.000Z";
  const restartedAt = "2026-11-21T00:01:00.000Z";
  const first = createDeviceSupportRuntime({ databasePath, now: () => startedAt });
  function record(taskId: string, taskStatus: DeviceTaskStatusV1, attemptStatus: DeviceTaskAttemptV1["status"], ownerKind: DeviceTaskAttemptV1["ownerKind"] = "daemon") {
    const request: DeviceActionRequestV1 = {
      taskId, actionId: "inspect-network", targetDeviceId: "device-1", capabilityId: "pc.inspect.network",
      capabilitySchemaVersion: "1.0", capabilitySnapshotId: "snapshot-1", idempotencyKey: "original-request",
      normalizedInput: {},
    };
    first.store.createTask({
      id: taskId, ownerKind, ownerId: "runtime-1", targetDeviceIds: [request.targetDeviceId],
      capabilitySnapshotIds: [request.capabilitySnapshotId], status: taskStatus,
      currentActionId: request.actionId, createdAt: startedAt, updatedAt: startedAt,
    }, startedAt);
    first.store.createAttempt({
      request, requestDigest: digestRequest(request),
      attempt: {
        attemptId: `${taskId}:attempt-1`, taskId, ownerKind, actionId: request.actionId, ownerId: "runtime-1",
        targetDeviceId: request.targetDeviceId, status: attemptStatus, dispatchIntentAt: startedAt,
        ...(attemptStatus === "completed" ? {
          receipt: { actionId: request.actionId, status: "completed", startedAt, finishedAt: startedAt, observationIds: [] },
        } : {}),
      },
    }, startedAt);
    return request;
  }
  const dispatch = record("interrupted-dispatch", "executing", "dispatched");
  const readback = record("interrupted-verification", "verifying", "completed");
  const peer = record("peer-task", "executing", "dispatched", "mobile");
  first.close();

  const restarted = createDeviceSupportRuntime({ databasePath, now: () => restartedAt });
  try {
    assert.equal(restarted.store.getTask(dispatch.taskId)?.status, "unknown");
    assert.equal(restarted.store.getTask(readback.taskId)?.status, "unknown");
    assert.equal(restarted.store.getTask(peer.taskId)?.status, "executing");
    assert.equal((await restarted.broker.execute(dispatch)).attempt.status, "unknown");
    const priorReadback = (await restarted.broker.execute(readback)).attempt;
    assert.equal(priorReadback.receipt?.status, "completed");
    assert.equal(priorReadback.verification, undefined);
    await assert.rejects(() => restarted.broker.execute({ ...readback, idempotencyKey: "changed-request" }), (error: unknown) =>
      error instanceof DeviceBrokerError && error.code === "unknown_outcome");
    assert.deepEqual(restarted.store.recoverAfterRestart(restartedAt), []);
  } finally {
    restarted.close();
  }
});
