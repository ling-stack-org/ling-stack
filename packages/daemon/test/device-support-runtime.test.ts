import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DeviceActionRequestV1, DeviceDiagnosisReportV1, DeviceTaskAttemptV1, DeviceTaskJournalPageV1, DeviceTaskStatusV1 } from "@ling-stack/contracts";
import {
  buildOwnedDevicePlanningInput, createSqliteRunStore, DEFAULT_WORKSPACE_ID, DeviceBrokerError, digestRequest,
  modbusRtuRegisterCodec, SqliteDeviceSupportStore,
} from "@ling-stack/core";
import { createDeviceSupportRuntime } from "../dist/features/device-support/runtime.js";
import { createDaemonServer } from "../dist/index.js";

test("daemon device-support runtime composes the durable store, broker and remote facade", () => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-runtime-"));
  const runtime = createDeviceSupportRuntime({ databasePath: join(root, "workspace.sqlite") });
  assert.ok(runtime.store.database);
  assert.ok(runtime.fabricStore.database);
  assert.ok(runtime.developerStore.database);
  assert.ok(runtime.protocolStore.database);
  assert.equal(runtime.broker.store, runtime.store);
  assert.ok(runtime.collaboration);
  assert.equal(runtime.remoteFacade.listDevices("workspace-1").devices.length, 0);
  const now = new Date().toISOString();
  const session = runtime.developerSessions.createSession({
    sessionId: "local-developer-session", workspaceId: DEFAULT_WORKSPACE_ID, ownerKind: "daemon", ownerId: "local-runtime",
    targetDeviceId: "fixture-target", targetKind: "android", mode: "developer", authorizationRevision: "local-confirmation",
    status: "created", revision: 1, createdAt: now, updatedAt: now,
  });
  assert.deepEqual(runtime.developerStore.getSession(session.sessionId), session);
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

test("daemon runtime registers the Modbus codec and restores offline captures with loss evidence", t => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-protocol-replay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "workspace.sqlite");
  const captureTime = "2026-11-21T00:00:00.000Z";
  const owner = createDeviceSupportRuntime({ databasePath });
  try {
    const capture = owner.protocolWorkbench.capture({
      captureId: "modbus-temperature-register", targetDeviceId: "fixture-rs485", transport: "rs485", source: "imported",
      createdAt: captureTime, loss: { reason: "connection_interrupted" },
      frames: [{ direction: "rx", bytes: Buffer.from("010302000a3843", "hex"), capturedAt: captureTime }],
    });
    owner.protocolStore.saveCapture(capture);
  } finally {
    owner.close();
  }
  const reopened = createDeviceSupportRuntime({ databasePath });
  try {
    const codec = reopened.protocolStore.getCodec(modbusRtuRegisterCodec.manifest.codecId);
    assert.deepEqual(codec, modbusRtuRegisterCodec.manifest);
    const capture = reopened.protocolStore.getCapture("modbus-temperature-register");
    assert.ok(capture && codec);
    assert.deepEqual(capture.loss, { reason: "connection_interrupted" });
    assert.equal(reopened.protocolWorkbench.decode(capture, codec.codecId)[0]?.fields.register0, 10);
  } finally {
    reopened.close();
  }
});

test("the local daemon exposes its PC report and sequenced task journal only on direct loopback", { timeout: 15_000 }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-device-pc-diagnosis-"));
  const workspace = createSqliteRunStore(cwd);
  const authToken = "fixture-daemon-authority";
  const headers = { Authorization: `Bearer ${authToken}` };
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, authToken, defaultWorkspaceCwd: cwd }, { storeFactory: () => workspace });
  t.after(async () => {
    await daemon.stop();
    rmSync(cwd, { recursive: true, force: true });
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/v1/device-support/pc/diagnose`;
  assert.equal((await fetch(url, { method: "POST", headers: { ...headers, Origin: "https://example.invalid" } })).status, 403);
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  assert.equal((await fetch(url, { headers })).status, 405);
  const response = await fetch(url, { method: "POST", headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/u);
  const { status, report } = await response.json() as { status: string; report: DeviceDiagnosisReportV1 };
  assert.equal(status, "succeeded");
  assert.equal(report.playbookId, "pc-software-diagnosis");
  assert.deepEqual(report.actions.map(action => action.capabilityId), ["pc.inspect.network", "pc.inspect.services"]);
  const network = report.facts.find(fact => fact.source === "pc.network");
  assert.ok(network);
  assert.equal(typeof (network.value as { connected?: unknown }).connected, "boolean");
  assert.doesNotMatch(JSON.stringify(network.value), /gatewayReachable|dnsReachable/u);

  const eventsUrl = `http://127.0.0.1:${address.port}/v1/device-support/tasks/${encodeURIComponent(report.taskId)}/events`;
  assert.equal((await fetch(eventsUrl, { headers: { ...headers, "X-Forwarded-For": "192.0.2.42" } })).status, 403);
  assert.equal((await fetch(`${eventsUrl}?limit=101`, { headers })).status, 400);
  const pageResponse = await fetch(`${eventsUrl}?limit=1`, { headers });
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("cache-control") ?? "", /no-store/u);
  const firstPage = await pageResponse.json() as DeviceTaskJournalPageV1;
  assert.equal(firstPage.events[0]?.kind, "task_created");
  assert.equal(firstPage.events[0]?.sequence, 1);
  assert.equal(firstPage.hasMore, true);
  const remainder = await (await fetch(`${eventsUrl}?afterSequence=1`, { headers })).json() as DeviceTaskJournalPageV1;
  assert.equal(remainder.events[0]?.sequence, 2);
  assert.equal(remainder.task.status, "succeeded");
  assert.ok(remainder.events.some(event => event.kind === "device_plan_accepted"));

  const journal = new SqliteDeviceSupportStore({ databasePath: workspace.paths.databasePath });
  try {
    const tasks = journal.listRecentDaemonTasks(DEFAULT_WORKSPACE_ID, 10);
    assert.deepEqual(tasks.map(task => task.id), [report.taskId]);
    assert.equal(tasks[0]?.status, "succeeded");
    assert.equal(tasks[0]?.ownerId, tasks[0]?.targetDeviceIds[0]);
    assert.equal(journal.listObservations(report.taskId).length, 2);
    const events = journal.listEvents(report.taskId);
    const planIndex = events.findIndex(event => event.type === "device_plan_accepted");
    const firstDispatch = events.findIndex(event => event.type === "attempt_prepared");
    assert.ok(planIndex >= 0 && firstDispatch > planIndex);
    assert.equal(events[planIndex]?.body.source, "local_playbook");
    assert.equal(events[planIndex]?.body.taskId, report.taskId);
    const input = {
      store: journal, taskId: report.taskId, ownerId: tasks[0]!.ownerId, workspaceId: DEFAULT_WORKSPACE_ID,
      contextId: "fixture-context", maxBytes: 4096, now: new Date().toISOString(),
    };
    const planned = buildOwnedDevicePlanningInput(input);
    assert.deepEqual(planned.context.facts, report.facts.map(fact => fact.value));
    assert.deepEqual(planned.targets.map(target => target.snapshot.deviceId), tasks[0]?.targetDeviceIds);
    assert.throws(() => buildOwnedDevicePlanningInput({ ...input, workspaceId: "elsewhere" }), /outside the workspace/);
  } finally {
    journal.close();
  }
});
