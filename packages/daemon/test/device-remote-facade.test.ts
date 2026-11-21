import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
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
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V2,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V3,
  type DeviceActionRequestV1,
  type DeviceTaskV1,
  type LingServerGatewayRouteV1,
  type RemoteAuthProofV1,
  type RemoteClientCommandPayloadMapV1,
  type RemoteServerFrameV1,
} from "@ling-stack/contracts";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, DeviceCapabilityBroker, digestRequest, readOwnedDeviceTaskJournal, readOwnedDeviceTaskTrace, SqliteDeviceSupportStore } from "@ling-stack/core";
import {
  authChallengeSigningBytes,
  authChallengeSigningInput,
  authProofSigningBytes,
  authProofSigningInput,
  encodeBase64Url,
  fingerprintPublicJwkSync,
  parseRemoteServerFrameV1,
  sha256,
  type RemoteMessageChannel,
  type RemoteMessageReceiver,
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

test("authenticated Gateway sessions recover PC tasks, reconcile writes and resume owner journals", { timeout: 10_000 }, async t => {
  let clock = now;
  const readClock = () => clock;
  const root = await mkdtemp(join(tmpdir(), "ling-device-gateway-"));
  const store = createSqliteRunStore(root);
  const deviceStore = new SqliteDeviceSupportStore({ databasePath: store.paths.databasePath });
  const broker = new DeviceCapabilityBroker({ store: deviceStore, now: readClock });
  const listenerPort = await reserveLoopbackPort();
  const stateDir = join(root, "state");
  const state = new RemoteAccessStateStore({ stateDir, listenerPort, createIdentity: createRemoteGatewayIdentity, now: readClock });
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
    deviceFacade: createRemoteDeviceFacade({ store: deviceStore, broker, now: readClock }),
    now: readClock,
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
  let networkConnected = true;
  let repairCalls = 0;
  let repairSignal: AbortSignal | undefined;
  let finishRepair!: () => void;
  const repairGate = new Promise<void>(resolve => { finishRepair = resolve; });
  const adapter = new PcAdapter({
    now: readClock,
    executor: {
      async inventory() { return { hostname: "fixture-pc", os: "linux" }; },
      async readNetwork() { networkReads += 1; return { connected: networkConnected, gatewayReachable: true, dnsReachable: true }; },
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

  async function connect(protocol?: string | string[]) {
    const response = await fetch(`http://${loopback}/v1/auth/challenge`, { method: "POST", body: JSON.stringify({ deviceId }) });
    assert.equal(response.status, 200);
    const challenge = validateRemoteAuthChallengeV1(await response.json(), { nowMs: Date.parse(clock) });
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
      sessionId: ready.sessionId,
      async send<T extends "device.list" | "device.task.status" | "device.task.approve" | "device.task.revoke" | "device.task.reconcile" | "device.task.journal" | "stream.subscribe">(type: T, payload: RemoteClientCommandPayloadMapV1[T]) {
        clientSeq += 1;
        const messageId = `message-${clientSeq}`;
        socket.send(JSON.stringify({
          version: 1, type, payload, clientSeq, messageId, gatewayId: challenge.gatewayId,
          sessionId: ready.sessionId, sentAt: clock, expiresAt: new Date(Date.parse(clock) + 30_000).toISOString(),
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
  assert.equal(first.ready.policy.capabilities.includes("device.reconcile"), false);
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
  const taskScope = { workspaceId: DEFAULT_WORKSPACE_ID, taskId: active.taskId };
  const binding = {
    ...taskScope,
    attemptId: attempt.attemptId,
    capabilitySnapshotId: readbackSnapshot.snapshotId,
  };
  const oldStatus = await reconnected.send("device.task.status", { commandId: "old-status", ...taskScope });
  assert.equal((await waitForFrame(reconnected.frames, "device.task.snapshot", oldStatus)).payload.task.pendingReconciliation, undefined);
  const unsupported = await reconnected.send("device.task.reconcile", { commandId: "old-reconcile", ...binding });
  assert.equal((await waitForFrame(reconnected.frames, "command.failed", unsupported)).payload.error.code, "capability_not_allowed");
  await reconnected.close();

  clock = "2026-11-21T00:00:31.000Z";
  const modern = await connect([REMOTE_DEVICE_TASKS_SUBPROTOCOL_V2, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V1]);
  assert.ok(modern.ready.policy.capabilities.includes("device.reconcile"));
  assert.equal(modern.ready.policy.capabilities.includes("device.journal"), false);
  const status = await modern.send("device.task.status", { commandId: "current-status", ...taskScope });
  const preview = (await waitForFrame(modern.frames, "device.task.snapshot", status)).payload.task.pendingReconciliation;
  assert.deepEqual(preview, {
    attemptId: attempt.attemptId, capabilitySnapshotId: readbackSnapshot.snapshotId, targetDeviceId: target.device.id,
  });
  const staleBinding = await modern.send("device.task.reconcile", {
    commandId: "stale-recheck", ...binding, capabilitySnapshotId: capability.snapshotId,
  });
  assert.equal((await waitForFrame(modern.frames, "command.failed", staleBinding)).payload.error.code, "resync_required");
  const outsideWorkspace = await modern.send("device.task.reconcile", { commandId: "wrong-workspace", ...binding, workspaceId: "workspace-2" });
  assert.equal((await waitForFrame(modern.frames, "command.failed", outsideWorkspace)).payload.error.code, "workspace_not_allowed");
  const wrongAttempt = await modern.send("device.task.reconcile", { commandId: "wrong-attempt", ...binding, attemptId: action.attempt.attemptId });
  assert.equal((await waitForFrame(modern.frames, "command.failed", wrongAttempt)).payload.error.code, "resync_required");
  assert.equal(networkReads, 2);

  networkConnected = false;
  const failedReadback = await modern.send("device.task.reconcile", { commandId: "first-recheck", ...binding });
  const unresolved = await waitForFrame(modern.frames, "device.task.snapshot", failedReadback);
  assert.equal(unresolved.payload.task.status, "unknown");
  const refreshedSnapshotId = unresolved.payload.task.pendingReconciliation?.capabilitySnapshotId;
  assert.ok(refreshedSnapshotId && refreshedSnapshotId !== binding.capabilitySnapshotId);
  assert.deepEqual((await waitForFrame(modern.frames, "command.completed", failedReadback)).payload.result, {
    kind: "device_task_rechecked", taskId: active.taskId, status: "unresolved",
  });
  assert.equal(networkReads, 3);

  networkConnected = true;
  const recheck = await modern.send("device.task.reconcile", { commandId: "second-recheck", ...binding, capabilitySnapshotId: refreshedSnapshotId });
  const reconciled = await waitForFrame(modern.frames, "device.task.snapshot", recheck);
  assert.equal(reconciled.payload.task.status, "succeeded");
  assert.equal(reconciled.payload.task.pendingReconciliation, undefined);
  assert.deepEqual((await waitForFrame(modern.frames, "command.completed", recheck)).payload.result, {
    kind: "device_task_rechecked", taskId: active.taskId, status: "verified",
  });
  const journaledReadback = deviceStore.listEvents(active.taskId).findLast(event => event.type === "attempt_reconciled");
  assert.equal(journaledReadback?.body.connectionRevision, "reconnected-target-connection");
  assert.equal(journaledReadback?.body.reconciliationId, reconciled.payload.task.lastVerificationId);
  assert.ok(deviceStore.listObservations(active.taskId).some(observation => observation.id === reconciled.payload.task.lastVerificationId));
  assert.deepEqual(deviceStore.getAttempt(active.taskId, attempt.attemptId)?.attempt, attempt);
  const trace = readOwnedDeviceTaskTrace({ store: deviceStore, taskId: active.taskId, workspaceId: DEFAULT_WORKSPACE_ID });
  const originalDispatch = trace.spans.find(span => span.kind === "adapter");
  assert.equal(originalDispatch?.status, "unknown");
  assert.deepEqual((originalDispatch?.metadata as { authority?: unknown })?.authority, {
    state: "recorded", policyRevision: broker.policyRevision, dispatchStop: { active: false, revision: 0 },
    approval: {
      approvalId: active.approval.approvalId, normalizedInputDigest: active.approval.normalizedInputDigest, expiresAt: active.approval.expiresAt,
      principal: { kind: "paired_mobile", deviceId, deviceEpoch: 1, sessionId: reconnected.sessionId },
    },
  });
  assert.deepEqual(trace.capabilitySnapshots?.map(record => [record.snapshotId, record.state]), [
    [capability.snapshotId, "recorded"], [refreshedSnapshotId, "recorded"],
  ]);
  const readbacks = trace.spans.filter(span => span.kind === "verification");
  assert.deepEqual(readbacks.map(span => [span.status, span.parentSpanId]), [["unknown", originalDispatch?.spanId], ["ok", originalDispatch?.spanId]]);
  assert.equal(readbacks[1]?.lineage?.connectionRevision, "reconnected-target-connection");
  assert.deepEqual(readbacks[1]?.metadata, {
    verificationStatus: "verified", evidenceRefs: [reconciled.payload.task.lastVerificationId],
    capabilitySnapshotId: refreshedSnapshotId, capabilityId: "pc.inspect.network",
    authority: { state: "recorded", policyRevision: broker.policyRevision, dispatchStop: { active: false, revision: 0 } },
  });
  const replayReadback = await modern.send("device.task.reconcile", {
    commandId: "second-recheck", ...binding, capabilitySnapshotId: refreshedSnapshotId,
  });
  assert.equal((await waitForFrame(modern.frames, "command.failed", replayReadback)).payload.error.code, "resync_required");
  const cursor = { workspaceId: DEFAULT_WORKSPACE_ID, taskId: active.taskId, generation: 1, afterSequence: 0, limit: 1 };
  const oldJournal = await modern.send("device.task.journal", { ...cursor, commandId: "journal-v2" });
  assert.equal((await waitForFrame(modern.frames, "command.failed", oldJournal)).payload.error.code, "capability_not_allowed");
  await modern.close();

  deviceStore.appendObservation(active.taskId, {
    id: "private-observation", subjectId: target.device.id, source: "pc.private", value: { text: "owner-only-output" },
    observedAt: clock, receivedAt: clock, freshnessUntil: clock,
    quality: "good", provenance: [target.device.id], redactionClass: "sensitive",
  }, clock);
  deviceStore.createTask(deviceTask("other-workspace-task", ["other-board"]), clock);
  deviceStore.createTask(deviceTask("phone-owned-task", [target.device.id], { ownerKind: "mobile" }), clock);

  async function readJournal(peer: Awaited<ReturnType<typeof connect>>, payload: RemoteClientCommandPayloadMapV1["device.task.journal"]) {
    const requestId = await peer.send("device.task.journal", payload);
    const frame = await waitForFrame(peer.frames, "command.completed", requestId);
    assert.equal(frame.payload.commandType, "device.task.journal");
    return frame.payload.result.journal;
  }

  const v3 = await connect([REMOTE_DEVICE_TASKS_SUBPROTOCOL_V3, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V2]);
  assert.ok(v3.ready.policy.capabilities.includes("device.journal"));
  const firstJournal = await readJournal(v3, { ...cursor, commandId: "journal-first" });
  assert.equal(firstJournal.events[0]?.kind, "task_created");
  assert.equal(firstJournal.events[0]?.sequence, 1);
  assert.equal(firstJournal.hasMore, true);
  assert.equal(firstJournal.task.lastVerificationId, reconciled.payload.task.lastVerificationId);
  await v3.close();

  const resumed = await connect(REMOTE_DEVICE_TASKS_SUBPROTOCOL_V3);
  const rest = await readJournal(resumed, { ...cursor, commandId: "journal-resume", limit: 25, afterSequence: 1 });
  const local = readOwnedDeviceTaskJournal({ ...cursor, store: deviceStore, afterSequence: 1, limit: 25 });
  assert.deepEqual(rest.events, local.events);
  assert.equal(rest.events[0]?.sequence, 2);
  assert.ok(rest.events.some(event => event.kind === "attempt_reconciled"));
  assert.doesNotMatch(JSON.stringify(rest), /private-observation|owner-only-output|connectionRevision|capabilitySnapshotIds/u);
  const stalePage = await readJournal(resumed, { ...cursor, commandId: "journal-stale", generation: 2, afterSequence: 1 });
  assert.equal(stalePage.requiresSnapshot, true);
  assert.equal(stalePage.generation, 1);
  assert.equal(stalePage.task.status, "succeeded");
  assert.deepEqual(stalePage.events, []);
  const replacement = await readJournal(resumed, { ...cursor, commandId: "journal-reset", generation: stalePage.generation });
  assert.deepEqual(replacement.events, firstJournal.events);
  const crossWorkspace = await resumed.send("device.task.journal", { ...cursor, taskId: "other-workspace-task", commandId: "journal-cross-workspace" });
  assert.equal((await waitForFrame(resumed.frames, "command.failed", crossWorkspace)).payload.error.code, "workspace_not_allowed");
  const wrongOwner = await resumed.send("device.task.journal", { ...cursor, taskId: "phone-owned-task", commandId: "journal-phone-owned" });
  assert.equal((await waitForFrame(resumed.frames, "command.failed", wrongOwner)).payload.error.code, "pc_unavailable");

  const identity = state.readOrCreateIdentity();
  const route: LingServerGatewayRouteV1 = {
    version: 1, installationId: "ling-server", instanceId: "server-instance", applicationKeyFingerprint: encodeBase64Url(sha256(new Uint8Array([1]))),
    serverOrigin: "https://ling-server.example", bindingId: "peer-binding", preferredRoute: "relay", routeAttemptId: "route-1",
    gatewayId: identity.gatewayId, mobileDeviceId: deviceId, peerEpoch: 1,
    gatewayKeyFingerprint: identity.publicKeyFingerprint, mobileKeyFingerprint: fingerprintPublicJwkSync(publicKeyJwk),
    protocolMajor: 1, features: ["ordered-channel"], expiresAt: new Date(Date.parse(clock) + 60_000).toISOString(),
    offerDigest: encodeBase64Url(sha256(new Uint8Array([2]))), answerDigest: encodeBase64Url(sha256(new Uint8Array([3]))),
  };
  function attach(peerRoute: LingServerGatewayRouteV1) {
    const transport = peerFixture();
    controller.attachLingServerPeer({ route: peerRoute, channel: transport.channel });
    const challenge = validateRemoteAuthChallengeV1(JSON.parse(transport.outbound[0]), { nowMs: Date.parse(clock) });
    const { gatewaySignature, ...unsigned } = challenge;
    const expected = authChallengeSigningBytes(authChallengeSigningInput(gatewayOrigin, unsigned), peerRoute);
    assert.ok(verify("sha256", expected, {
      key: createPublicKey({ format: "jwk", key: identity.publicKeyJwk }), dsaEncoding: "ieee-p1363",
    }, Buffer.from(gatewaySignature, "base64url")));
    return {
      ...transport, challenge,
      async proof(signedRoute: LingServerGatewayRouteV1) {
        const unsignedProof: Omit<RemoteAuthProofV1, "signature"> = {
          version: 1, gatewayId: challenge.gatewayId, challengeId: challenge.challengeId, candidateSessionId: challenge.candidateSessionId,
          deviceId, deviceEpoch: challenge.deviceEpoch, clientNonce: encodeBase64Url(new Uint8Array(32).fill(3)), protocolVersion: 1, resume: [],
        };
        const input = await authProofSigningInput(gatewayOrigin, unsigned, unsignedProof, sha256);
        const signature = encodeBase64Url(sign("sha256", authProofSigningBytes(input, signedRoute), { key: privateKey, dsaEncoding: "ieee-p1363" }));
        return JSON.stringify({ ...unsignedProof, signature });
      },
      async journal(afterSequence: number, commandId: string) {
        transport.receive(JSON.stringify({
          version: 1, type: "device.task.journal", gatewayId: challenge.gatewayId, sessionId: challenge.candidateSessionId,
          messageId: commandId, clientSeq: 1, sentAt: clock, expiresAt: new Date(Date.parse(clock) + 10_000).toISOString(),
          payload: { ...cursor, afterSequence, limit: 25, commandId },
        }));
        const completed = await waitForFrame(transport.events, "command.completed", commandId);
        assert.equal(completed.payload.commandType, "device.task.journal");
        return completed.payload.result.journal;
      },
    };
  }

  const rejected = attach(route);
  rejected.receive(await rejected.proof({ ...route, routeAttemptId: "other-route" }));
  assert.match(await rejected.closed, /signature is invalid/u);
  assert.equal(rejected.outbound.length, 1);
  assert.equal(controller.status().pairedDevice?.deviceId, deviceId);
  const stillConnected = await resumed.send("device.task.status", { commandId: "still-connected", workspaceId: DEFAULT_WORKSPACE_ID, taskId: active.taskId });
  await waitForFrame(resumed.frames, "command.completed", stillConnected);

  const routed = attach(route);
  const proof = await routed.proof(route);
  routed.receive(proof);
  const routedReady = await waitForFrame(routed.events, "session.ready");
  assert.ok(routedReady.payload.policy.capabilities.includes("device.journal"));
  assert.equal(routedReady.sessionId, routed.challenge.candidateSessionId);
  assert.deepEqual((await routed.journal(1, "relay-journal")).events, rest.events);

  const nextRoute = { ...route, routeAttemptId: "route-2", preferredRoute: "direct" } as const;
  const replayed = attach(nextRoute);
  replayed.receive(proof);
  assert.match(await replayed.closed, /missing, used, or expired/u);
  assert.equal(routed.channel.readyState, 1);
  const replacementPeer = attach(nextRoute);
  replacementPeer.receive(await replacementPeer.proof(nextRoute));
  await waitForFrame(replacementPeer.events, "session.ready");
  assert.equal(await routed.closed, "replaced");
  assert.equal(controller.status().pairedDevice?.deviceId, deviceId);
  assert.deepEqual((await replacementPeer.journal(1, "replacement-journal")).events, rest.events);
  clock = nextRoute.expiresAt;
  replacementPeer.receive(JSON.stringify({ type: "device.task.journal" }));
  assert.equal(await replacementPeer.closed, "peer_route_expired");
  const duringShutdown = { ...nextRoute, routeAttemptId: "route-shutdown", expiresAt: new Date(Date.parse(clock) + 60_000).toISOString() };
  const shutdownPeer = attach(duringShutdown);
  shutdownPeer.receive(await shutdownPeer.proof(duringShutdown));
  await waitForFrame(shutdownPeer.events, "session.ready");
  await controller.stop();
  assert.equal(await shutdownPeer.closed, "gateway_stopping");
  assert.equal(shutdownPeer.events.some(event => event.type === "security.revoked"), false);
  assert.equal(controller.status().pairedDevice?.deviceId, deviceId);
  await controller.startIfEnabled();
  const afterRestart = { ...duringShutdown, routeAttemptId: "route-after-restart" };
  const restartedPeer = attach(afterRestart);
  restartedPeer.receive(await restartedPeer.proof(afterRestart));
  await waitForFrame(restartedPeer.events, "session.ready");
  assert.deepEqual((await restartedPeer.journal(1, "restart-journal")).events, rest.events);
  assert.equal(repairCalls, 1);
  assert.equal(networkReads, 4);
});

function peerFixture() {
  const outbound: string[] = [];
  const events: RemoteServerFrameV1[] = [];
  let receiver: RemoteMessageReceiver | undefined;
  let readyState = 1;
  let resolveClosed!: (reason: string) => void;
  const closed = new Promise<string>(resolve => { resolveClosed = resolve; });
  const channel: RemoteMessageChannel = {
    get readyState() { return readyState; },
    bufferedAmount: 0,
    send(data) {
      if (outbound.length > 0) events.push(parseRemoteServerFrameV1(data));
      outbound.push(data);
    },
    close(code, reason) {
      readyState = 3;
      resolveClosed(reason ?? "");
      queueMicrotask(() => receiver?.closed({ code, reason }));
    },
    subscribe(next) {
      assert.equal(receiver, undefined);
      receiver = next;
      return () => {
        if (next === receiver) receiver = undefined;
      };
    },
  };
  return {
    channel, outbound, events, closed,
    receive(data: string) { queueMicrotask(() => receiver?.received(data)); },
  };
}

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
