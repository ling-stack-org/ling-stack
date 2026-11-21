import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocket } from "ws";

import {
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V1,
  type DeviceActionRequestV1,
  type DeviceTaskV1,
  type RemoteAuthProofV1,
  type RemoteClientCommandPayloadMapV1,
  type RemoteServerFrameV1,
} from "@ling-stack/contracts";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, DeviceCapabilityBroker, digestRequest, SqliteDeviceSupportStore } from "@ling-stack/core";
import {
  authProofSigningBytes,
  authProofSigningInput,
  encodeBase64Url,
  fingerprintPublicJwkSync,
  parseRemoteServerFrameV1,
  sha256,
  validateRemoteAuthChallengeV1,
  validateRemoteP256PublicJwkV1,
} from "@ling-stack/remote-protocol";
import { RemoteAccessController } from "../dist/features/remote-access/controller.js";
import { createRemoteDeviceFacade } from "../dist/features/remote-access/device-facade.js";
import { createRemoteGatewayIdentity } from "../dist/features/remote-access/pairing-auth-service.js";
import { RemoteAccessStateStore } from "../dist/features/remote-access/state-store.js";
import { PcAdapter } from "../dist/features/device-support/adapters/pc.js";

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

function deviceTask(id: string, targetDeviceIds: readonly string[], overrides: Partial<DeviceTaskV1> = {}): DeviceTaskV1 {
  return {
    id, targetDeviceIds, ownerKind: "daemon", ownerId: "daemon-1", status: "awaiting_approval",
    capabilitySnapshotIds: [], createdAt: now, updatedAt: now, ...overrides,
  };
}

test("remote device facade projects workspace-scoped devices and task attempts", () => {
  const store = new SqliteDeviceSupportStore();
  store.registerDevice(profile, now);
  store.registerDevice({ ...profile, device: { ...profile.device, id: "other-board", ownerScope: "workspace-2" } }, now);
  store.createTask(deviceTask("task-1", [profile.device.id]), now);
  store.createTask(deviceTask("mixed-task", [profile.device.id, "other-board"]), now);
  store.createTask(deviceTask("mobile-task", [profile.device.id], { ownerKind: "mobile" }), now);
  store.createTask(deviceTask("missing-target", ["unregistered-target"]), now);
  const facade = createRemoteDeviceFacade({ store, now: () => now });
  assert.equal(facade.listDevices("workspace-1").devices.length, 1);
  assert.deepEqual(facade.listDevices("workspace-1").recentTasks?.map(task => task.taskId), ["task-1"]);
  assert.deepEqual(facade.listDevices("workspace-2").recentTasks, []);
  assert.equal(facade.taskSnapshot({ commandId: "command-1", workspaceId: "workspace-1", taskId: "task-1" }).task.status, "awaiting_approval");
  assert.throws(() => facade.taskSnapshot({ commandId: "command-2", workspaceId: "workspace-2", taskId: "task-1" }), /outside the paired workspace/);
  assert.throws(() => facade.taskSnapshot({ commandId: "command-2", workspaceId: "workspace-1", taskId: "mobile-task" }), /PC device task is unavailable/);
  assert.equal(facade.revokeTask({ commandId: "command-3", workspaceId: "workspace-1", taskId: "task-1" }).task.status, "cancelled");
  store.close();
});

test("signed Gateway sessions reconnect to durable PC tasks and revoke an active approval without blocking", { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-device-gateway-"));
  const store = createSqliteRunStore(root);
  const deviceStore = new SqliteDeviceSupportStore({ databasePath: store.paths.databasePath });
  const broker = new DeviceCapabilityBroker({ store: deviceStore, now: () => now });
  const listenerPort = await reserveLoopbackPort();
  const stateDir = join(root, "state");
  const state = new RemoteAccessStateStore({ stateDir, listenerPort, createIdentity: createRemoteGatewayIdentity, now: () => now });
  const gatewayOrigin = "https://device-gateway.example";
  const deviceId = "phone-1";
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKeyJwk = validateRemoteP256PublicJwkV1(publicKey.export({ format: "jwk" }));
  state.writeState({
    ...state.readState(), enabled: true, gatewayOrigin, deviceEpoch: 1,
    pairedDevice: {
      deviceId, deviceEpoch: 1, publicKeyJwk, displayName: "Paired phone", platform: "ios", pairedAt: now,
      publicKeyFingerprint: fingerprintPublicJwkSync(publicKeyJwk),
    },
  });
  const controller = new RemoteAccessController({
    store, stateDir, listenerPort, workspaceDisplayName: "Test workspace",
    managementCapability: "fixture-management-capability", managementAllowedOrigins: ["http://127.0.0.1"],
    deviceFacade: createRemoteDeviceFacade({ store: deviceStore, broker, now: () => now }),
    now: () => now,
  });
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await controller.stop();
    deviceStore.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  let networkReads = 0;
  let repairCalls = 0;
  let repairSignal: AbortSignal | undefined;
  let finishRepair!: () => void;
  const repairGate = new Promise<void>(resolve => { finishRepair = resolve; });
  const adapter = new PcAdapter({
    now: () => now,
    executor: {
      async inventory() { return { hostname: "fixture-pc", os: "linux" }; },
      async readNetwork() { networkReads += 1; return { connected: true, gatewayReachable: true, dnsReachable: true }; },
      async readServices() { throw new Error("unexpected service read"); },
      async repairNetwork({ signal }) {
        repairCalls += 1;
        repairSignal = signal;
        await repairGate;
        return { accepted: true, changed: true };
      },
    },
  });
  broker.registerAdapter(adapter);
  const target = await broker.discover(adapter.manifest.adapterId, { connectionRef: "local:fixture-pc", ownerId: DEFAULT_WORKSPACE_ID });
  const capability = await broker.refreshCapabilities(target.device.id, target.device.profileRevision);
  deviceStore.registerDevice({ ...profile, device: { ...profile.device, id: "other-board", ownerScope: "workspace-2" } }, now);
  broker.createTask(deviceTask("task-1", [target.device.id], { status: "planning", capabilitySnapshotIds: [capability.snapshotId] }));
  await controller.startIfEnabled();
  const loopback = `127.0.0.1:${listenerPort}`;

  async function connect(protocol?: string) {
    const response = await fetch(`http://${loopback}/v1/auth/challenge`, { method: "POST", body: JSON.stringify({ deviceId }) });
    assert.equal(response.status, 200);
    const challenge = validateRemoteAuthChallengeV1(await response.json(), { nowMs: Date.parse(now) });
    const { gatewaySignature: _signature, ...unsignedChallenge } = challenge;
    const unsignedProof: Omit<RemoteAuthProofV1, "signature"> = {
      version: 1, gatewayId: challenge.gatewayId, challengeId: challenge.challengeId,
      candidateSessionId: challenge.candidateSessionId, deviceId, deviceEpoch: challenge.deviceEpoch,
      clientNonce: encodeBase64Url(new Uint8Array(32).fill(1)), protocolVersion: 1, resume: [],
    };
    const bytes = authProofSigningBytes(await authProofSigningInput(gatewayOrigin, unsignedChallenge, unsignedProof, sha256));
    const signature = encodeBase64Url(sign("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" }));
    const socket = new WebSocket(`ws://${loopback}/v1/session`, protocol);
    sockets.add(socket);
    const frames: RemoteServerFrameV1[] = [];
    socket.on("message", data => frames.push(parseRemoteServerFrameV1(data.toString())));
    await once(socket, "open");
    socket.send(JSON.stringify({ ...unsignedProof, signature }));
    const ready = await waitForFrame(frames, "session.ready");
    let clientSeq = 0;
    return {
      ready: ready.payload,
      async send<T extends "device.list" | "device.task.status" | "device.task.approve" | "device.task.revoke" | "stream.subscribe">(type: T, payload: RemoteClientCommandPayloadMapV1[T]) {
        clientSeq += 1;
        const messageId = `message-${clientSeq}`;
        socket.send(JSON.stringify({
          version: 1, type, payload, clientSeq, messageId, gatewayId: challenge.gatewayId,
          sessionId: ready.sessionId, sentAt: now, expiresAt: "2026-11-21T00:00:30.000Z",
        }));
        return messageId;
      },
      frames,
      async close() {
        const closed = once(socket, "close");
        socket.close();
        await closed;
      },
    };
  }

  const legacy = await connect();
  assert.equal(legacy.ready.policy.capabilities.includes("device.read"), false);
  await legacy.send("stream.subscribe", { commandId: "subscribe-legacy", scope: { kind: "workspace", workspaceId: DEFAULT_WORKSPACE_ID } });
  await waitForFrame(legacy.frames, "profile.snapshot");
  await legacy.send("device.list", { commandId: "list-legacy", workspaceId: DEFAULT_WORKSPACE_ID });
  assert.equal((await waitForFrame(legacy.frames, "command.failed")).payload.error.code, "capability_not_allowed");
  assert.equal(legacy.frames.some(frame => frame.type === "device.list_snapshot"), false);
  await legacy.close();

  const first = await connect(REMOTE_DEVICE_TASKS_SUBPROTOCOL_V1);
  assert.ok(first.ready.policy.capabilities.includes("device.read"));
  await first.send("stream.subscribe", { commandId: "subscribe-first", scope: { kind: "workspace", workspaceId: DEFAULT_WORKSPACE_ID } });
  const firstList = await waitForFrame(first.frames, "device.list_snapshot");
  assert.deepEqual(firstList.payload.recentTasks?.map(task => [task.taskId, task.status]), [["task-1", "planning"]]);
  await first.send("device.list", { commandId: "scope-denied", workspaceId: "workspace-2" });
  assert.equal((await waitForFrame(first.frames, "command.failed")).payload.error.code, "workspace_not_allowed");
  assert.equal(first.frames.some(frame => frame.type === "command.completed" && frame.payload.commandId === "scope-denied"), false);
  await first.close();

  const action = await broker.execute({
    taskId: "task-1", actionId: "inspect-network", targetDeviceId: target.device.id,
    capabilityId: "pc.inspect.network", capabilitySchemaVersion: "1.0", capabilitySnapshotId: capability.snapshotId,
    normalizedInput: {}, expectedVerification: { connected: true }, idempotencyKey: "inspect-network-1",
  });
  assert.equal(action.attempt.verification?.status, "verified");
  assert.equal(networkReads, 2);
  const reconnected = await connect(REMOTE_DEVICE_TASKS_SUBPROTOCOL_V1);
  await reconnected.send("stream.subscribe", { commandId: "subscribe-reconnect", scope: { kind: "workspace", workspaceId: DEFAULT_WORKSPACE_ID } });
  const newList = await waitForFrame(reconnected.frames, "device.list_snapshot");
  assert.deepEqual(newList.payload.recentTasks?.map(task => [task.taskId, task.status]), [["task-1", "succeeded"]]);
  await reconnected.send("device.task.status", { commandId: "task-reconnect", workspaceId: DEFAULT_WORKSPACE_ID, taskId: "task-1" });
  const detail = (await waitForFrame(reconnected.frames, "device.task.snapshot")).payload.task;
  assert.equal(detail.taskId, "task-1");
  assert.equal(detail.ownerId, "daemon-1");
  assert.deepEqual(detail.attemptIds, [action.attempt.attemptId]);
  assert.equal(detail.lastVerificationId, "inspect-network:verification");
  assert.equal(networkReads, 2);
  assert.equal(deviceStore.listRecentDaemonTasks(DEFAULT_WORKSPACE_ID, 20).length, 1);

  function proposeRepair(taskId: string) {
    broker.createTask(deviceTask(taskId, [target.device.id], { capabilitySnapshotIds: [capability.snapshotId] }));
    const proposed: DeviceActionRequestV1 = {
      taskId, actionId: `${taskId}:repair`, targetDeviceId: target.device.id,
      capabilityId: "pc.repair.network", capabilitySchemaVersion: "1.0", capabilitySnapshotId: capability.snapshotId,
      normalizedInput: { mode: "refresh_dhcp" }, expectedVerification: { connected: true }, idempotencyKey: taskId,
    };
    broker.proposeAction(proposed);
    return {
      taskId, workspaceId: DEFAULT_WORKSPACE_ID,
      approval: {
        taskId, approvalId: `${taskId}:approved`, actionId: proposed.actionId, targetDeviceId: target.device.id,
        capabilitySnapshotId: capability.snapshotId, connectionRevision: capability.connectionRevision,
        policyRevision: broker.policyRevision, normalizedInputDigest: digestRequest(proposed),
        expiresAt: "2026-11-21T00:01:00.000Z",
      },
    };
  }

  const stopped = proposeRepair("stop-before-dispatch");
  const revokeBefore = await reconnected.send("device.task.revoke", {
    commandId: "revoke-before", workspaceId: DEFAULT_WORKSPACE_ID, taskId: stopped.taskId,
  });
  assert.equal((await waitForFrame(reconnected.frames, "device.task.snapshot", revokeBefore)).payload.task.status, "cancelled");
  const denied = await reconnected.send("device.task.approve", { commandId: "approve-after-revoke", ...stopped });
  await waitForFrame(reconnected.frames, "command.failed", denied);
  assert.deepEqual(deviceStore.listAttempts(stopped.taskId), []);
  assert.equal(repairCalls, 0);

  const active = proposeRepair("stop-during-dispatch");
  const stale = await reconnected.send("device.task.approve", {
    commandId: "approve-stale-repair", ...active,
    approval: { ...active.approval, normalizedInputDigest: "0".repeat(64) },
  });
  await waitForFrame(reconnected.frames, "command.failed", stale);
  assert.deepEqual(deviceStore.listAttempts(active.taskId), []);
  const approve = await reconnected.send("device.task.approve", { commandId: "approve-repair", ...active });
  try {
    await waitForFrame(reconnected.frames, "command.accepted", approve);
    assert.equal(repairCalls, 1);
    const revoke = await reconnected.send("device.task.revoke", {
      commandId: "revoke-active", workspaceId: DEFAULT_WORKSPACE_ID, taskId: active.taskId,
    });
    const snapshot = await waitForFrame(reconnected.frames, "device.task.snapshot", revoke);
    assert.equal(snapshot.payload.task.status, "unknown");
    assert.equal(deviceStore.listAttempts(active.taskId)[0]?.attempt.status, "unknown");
    assert.equal(repairSignal?.aborted, true);
  } finally {
    finishRepair();
    await waitForFrame(reconnected.frames, "command.completed", approve);
  }
  assert.equal(deviceStore.listAttempts(active.taskId)[0]?.attempt.receipt?.status, "completed");
  assert.equal((await waitForFrame(reconnected.frames, "device.task.snapshot", approve)).payload.task.status, "unknown");
  const replay = await reconnected.send("device.task.approve", { commandId: "replay-repair", ...active });
  assert.equal((await waitForFrame(reconnected.frames, "device.task.snapshot", replay)).payload.task.status, "unknown");
  assert.equal(repairCalls, 1);
  assert.equal(networkReads, 2);

  const attempt = deviceStore.listAttempts(active.taskId)[0]!.attempt;
  const readbackSnapshot = await broker.refreshCapabilities(target.device.id, "reconnected-target-connection");
  const reconciliation = await broker.reconcileTask({
    taskId: active.taskId,
    attemptId: attempt.attemptId,
    capabilitySnapshotId: readbackSnapshot.snapshotId,
  });
  assert.equal(reconciliation.status, "verified");
  assert.equal(reconciliation.connectionRevision, "reconnected-target-connection");
  assert.deepEqual(deviceStore.getAttempt(active.taskId, attempt.attemptId)?.attempt, attempt);
  const journaledReadback = deviceStore.listEvents(active.taskId).find(event => event.type === "attempt_reconciled");
  assert.deepEqual(journaledReadback?.body, reconciliation);
  assert.equal(deviceStore.listObservations(active.taskId)[0]?.id, reconciliation.reconciliationId);
  const refreshed = await reconnected.send("device.task.status", {
    commandId: "reconciled-status", workspaceId: DEFAULT_WORKSPACE_ID, taskId: active.taskId,
  });
  const reconciled = await waitForFrame(reconnected.frames, "device.task.snapshot", refreshed);
  assert.equal(reconciled.payload.task.status, "succeeded");
  assert.equal(reconciled.payload.task.lastVerificationId, reconciliation.reconciliationId);
  assert.equal(repairCalls, 1);
  assert.equal(networkReads, 3);
});

async function waitForFrame<T extends RemoteServerFrameV1["type"]>(frames: readonly RemoteServerFrameV1[], type: T, requestId?: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const frame = frames.find((frame): frame is Extract<RemoteServerFrameV1, { type: T }> =>
      frame.type === type && (requestId === undefined || frame.requestId === requestId));
    if (frame) return frame;
    await delay(10);
  }
  assert.fail(`Gateway did not send ${type}`);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const closed = once(server, "close");
  server.close();
  await closed;
  return address.port;
}

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
