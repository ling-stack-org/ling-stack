import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V1,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V2,
  type RemoteAuthProofV1,
  type RemoteCapabilityV1,
  type RemoteClientFrameV1,
  type RemoteDeviceListSnapshotV1,
  type RemoteP256PublicJwkV1,
  type RemoteServerEventPayloadMapV1,
  type RemoteServerEventTypeV1,
} from "@ling-stack/contracts";
import {
  RemoteSessionClient,
  type RemoteBindingV1,
  type RemoteCacheEnvelopeV1,
  type RemoteClientState,
  type RemoteWebSocketLike,
} from "../dist/index.js";

const fixture: {
  gatewayIdentity: { publicKeyJwk: RemoteP256PublicJwkV1; fingerprint: string };
  authProof: { signatureBase64Url: string };
  authChallenge: { input: { serverNonce: string }; signatureBase64Url: string };
} = JSON.parse(await readFile(new URL("../../remote-protocol/fixtures/v1/canonical-signing.json", import.meta.url), "utf8"));
const now = "2026-07-31T10:00:00.000Z";
const gatewayId = "gateway-fixture-1";
const deviceId = "device-fixture-1";
const workspaceBindingId = "workspace-binding-1";
const legacyCapabilities = ["conversation.read", "conversation.send_text", "conversation.mark_read", "profile.read", "profile.update"] as const;

class FakeSocket implements RemoteWebSocketLike {
  readyState = 0;
  readonly sent: (RemoteAuthProofV1 | RemoteClientFrameV1)[] = [];
  readonly events = new EventEmitter();
  readonly addEventListener = this.events.on.bind(this.events);

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.events.emit("close", { code, reason });
  }

  open() {
    this.readyState = 1;
    this.events.emit("open");
  }

  frames() {
    return this.sent.filter((item): item is RemoteClientFrameV1 => "type" in item);
  }

  message<T extends RemoteServerEventTypeV1>(type: T, payload: RemoteServerEventPayloadMapV1[T], serverSeq: number, streamId = "control-stream-1") {
    const proof = this.sent[0];
    assert.ok(proof && "candidateSessionId" in proof);
    this.events.emit("message", { data: JSON.stringify({
      version: 1, type, messageId: `server-message-${serverSeq}`, gatewayId, sessionId: proof.candidateSessionId, sentAt: now,
      payload, streamId, eventId: `event-${serverSeq}`, serverSeq, occurredAt: now,
    }) });
  }
}

function createHarness() {
  let binding: RemoteBindingV1 | undefined = {
    version: 1, status: "active", gatewayId, gatewayOrigin: "https://ling-pc.example.ts.net",
    gatewayIdentityPublicKeyJwk: fixture.gatewayIdentity.publicKeyJwk,
    gatewayIdentityFingerprint: fixture.gatewayIdentity.fingerprint,
    deviceId, deviceKeyId: "ling.remote.device.gateway-fixture-1", deviceEpoch: 7, pairedAt: now,
  };
  let cache: RemoteCacheEnvelopeV1<RemoteClientState> | undefined;
  let sequence = 0;
  const sockets: FakeSocket[] = [];
  return {
    get binding() { return binding; },
    get cache() { return cache; },
    createClient() {
      assert.ok(binding);
      return new RemoteSessionClient({
        binding,
        autoReconnect: false,
        clock: { now: () => now },
        entropy: { randomBytes: length => new Uint8Array(length).fill(2), randomId: prefix => `${prefix}_${++sequence}` },
        keys: {
          generateOrLoad: async () => { throw new Error("not_used"); },
          sign: async () => fixture.authProof.signatureBase64Url,
          verify: async () => true,
          delete: async () => undefined,
        },
        bindingStore: {
          read: async () => binding,
          write: async next => { binding = next; },
          remove: async () => { binding = undefined; },
        },
        cacheStore: {
          read: async () => cache,
          write: async (_key, next) => { cache = next; },
          remove: async () => { cache = undefined; },
        },
        http: {
          getJson: async () => { throw new Error("not_used"); },
          postJson: async <T>(_origin: string, path: string, body: unknown) => {
            assert.equal(path, "/v1/auth/challenge");
            assert.deepEqual(body, { deviceId });
            return {
              status: 200,
              body: {
                version: 1, gatewayId, challengeId: "challenge-fixture-1",
                serverNonce: fixture.authChallenge.input.serverNonce, candidateSessionId: `session-fixture-${sockets.length + 1}`,
                deviceEpoch: 7, issuedAt: now, expiresAt: "2026-07-31T10:00:30.000Z", supportedProtocolVersions: [1],
                gatewaySignature: fixture.authChallenge.signatureBase64Url,
              } as T,
            };
          },
        },
        webSocketFactory: (url, subprotocol) => {
          assert.equal(url, "wss://ling-pc.example.ts.net/v1/session");
          assert.deepEqual(subprotocol, [REMOTE_DEVICE_TASKS_SUBPROTOCOL_V2, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V1]);
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
    },
    async connect(client: RemoteSessionClient, capabilities: readonly RemoteCapabilityV1[] = legacyCapabilities) {
      const previous = sockets.length;
      const connecting = client.connect();
      await waitFor(() => sockets.length > previous && sockets[previous]!.events.listenerCount("open") > 0);
      const socket = sockets[previous]!;
      socket.open();
      socket.message("session.ready", {
        deviceId, protocolVersion: 1, connectedAt: now,
        policy: {
          version: 1, workspaceId: "default", workspaceBindingId, policyVersion: 1,
          conversationAccess: { mode: "all_in_workspace", kinds: ["channel", "conversation", "teammate_direct"] },
          capabilities,
        },
      }, 1);
      await connecting;
      await waitFor(() => socket.frames().some(frame => frame.type === "stream.ack"));
      return socket;
    },
  };
}

test("session authentication restores the binding and requests a workspace snapshot on a sequence gap", async () => {
  const harness = createHarness();
  const client = harness.createClient();
  const socket = await harness.connect(client);
  assert.equal(client.state.connection, "connected");
  assert.equal(client.state.workspaceBindingId, workspaceBindingId);
  assert.equal(harness.binding?.workspaceBindingId, workspaceBindingId);
  assert.ok(socket.frames().some(frame => frame.type === "stream.subscribe" && frame.payload.scope.workspaceId === "default"));
  assert.ok(socket.frames().some(frame => frame.type === "stream.ack" && frame.payload.ackServerSeq === 1));

  const start = socket.frames().length;
  socket.message("profile.snapshot", { workspaceId: "default", displayName: "PC", revision: 0, updatedAt: now }, 3);
  await waitFor(() => socket.frames().slice(start).some(frame => frame.type === "snapshot.request"));
  assert.equal(socket.frames().slice(start).some(frame => frame.type === "stream.ack" && frame.payload.ackServerSeq === 3), false);
  client.disconnect();
});

test("device overview is restored offline and refreshed from the same PC task without a write", async () => {
  const harness = createHarness();
  const capabilities = [...legacyCapabilities, "device.read"] as const;
  const client = harness.createClient();
  const socket = await harness.connect(client, capabilities);
  const task = { taskId: "task-1", primaryTargetDeviceId: "pc-1", status: "awaiting_approval", updatedAt: now } as const;
  const overview: RemoteDeviceListSnapshotV1 = { workspaceId: "default", generatedAt: now, devices: [], recentTasks: [task] };
  socket.message("device.list_snapshot", overview, 1, "workspace-1");
  socket.message("device.task.snapshot", {
    workspaceId: "default", generatedAt: now,
    task: {
      taskId: task.taskId, ownerKind: "daemon", ownerId: "pc-runtime", targetDeviceIds: ["pc-1"], status: "awaiting_approval",
      updatedAt: now, attemptIds: [],
      pendingApproval: {
        actionId: "action-1", targetDeviceId: "pc-1", capabilityId: "pc.repair.network", capabilitySchemaVersion: "1.0",
        capabilitySnapshotId: "snapshot-1", connectionRevision: "connection-1", policyRevision: "policy-1",
        normalizedInputDigest: "digest-1", sideEffect: "reversible",
      },
    },
  }, 2, "workspace-1");
  await waitFor(() => harness.cache?.state.deviceTask?.task.taskId === task.taskId);
  assert.equal(client.state.deviceTask?.task.pendingApproval?.actionId, "action-1");
  assert.equal(harness.cache?.state.deviceTask?.task.pendingApproval, undefined);
  assert.equal(client.state.deviceOverviewCurrent, true);
  await assert.rejects(() => client.approveDeviceTask(task.taskId, client.state.deviceTask!.task.pendingApproval!), /remote_device_mutation_unavailable/);
  await assert.rejects(() => client.revokeDeviceTask(task.taskId), /remote_device_mutation_unavailable/);
  client.disconnect();
  assert.equal(client.state.deviceOverviewCurrent, false);
  assert.equal(client.state.deviceTaskCurrent, false);

  const resumed = harness.createClient();
  await resumed.restoreCachedState();
  assert.equal(resumed.state.connection, "disconnected");
  assert.equal(resumed.state.deviceOverview?.recentTasks?.[0]?.status, "awaiting_approval");
  assert.equal(resumed.state.deviceOverviewCurrent, false);
  const reconnected = await harness.connect(resumed, capabilities);
  assert.equal(resumed.state.deviceOverviewCurrent, false);
  reconnected.message("device.list_snapshot", { ...overview, recentTasks: [{ ...task, status: "succeeded" }] }, 1, "workspace-2");
  await waitFor(() => resumed.state.deviceOverviewCurrent === true);
  assert.equal(resumed.state.deviceOverview?.recentTasks?.[0]?.taskId, task.taskId);
  assert.equal(resumed.state.deviceOverview?.recentTasks?.[0]?.status, "succeeded");

  const request = await resumed.requestDeviceTaskStatus(task.taskId);
  assert.ok(reconnected.frames().some(frame =>
    frame.type === "device.task.status" && frame.payload.commandId === request.commandId && frame.payload.taskId === task.taskId));
  reconnected.message("device.task.snapshot", {
    workspaceId: "default", generatedAt: now,
    task: {
      taskId: task.taskId, ownerKind: "daemon", ownerId: "pc-runtime", targetDeviceIds: ["pc-1"], status: "succeeded",
      updatedAt: now, attemptIds: ["attempt-1"], lastVerificationId: "verification-1",
    },
  }, 2, "workspace-2");
  reconnected.message("command.completed", {
    commandId: request.commandId, commandType: "device.task.status",
    result: { kind: "device_task_status_requested", taskId: task.taskId }, completedAt: now,
  }, 2);
  await request.completion;
  await waitFor(() => resumed.state.deviceTask?.task.lastVerificationId === "verification-1");
  assert.equal(resumed.state.deviceTask?.task.lastVerificationId, "verification-1");
  assert.equal(resumed.state.deviceTask?.task.ownerKind, "daemon");
  assert.deepEqual(reconnected.frames().filter(frame => frame.type.startsWith("device.")).map(frame => frame.type), ["device.task.status"]);
  await waitFor(() => harness.cache?.state.deviceTask?.task.lastVerificationId === "verification-1");
  resumed.disconnect();

  await harness.connect(resumed);
  assert.equal(resumed.state.deviceOverview, undefined);
  assert.equal(resumed.state.deviceTask, undefined);
  resumed.disconnect();
});

test("device approval and revoke commands bind the current preview and paired session to typed Gateway frames", async () => {
  const harness = createHarness();
  const client = harness.createClient();
  const socket = await harness.connect(client, [...legacyCapabilities, "device.read", "device.approve", "device.revoke"] as const);
  const preview = {
    actionId: "action-1", targetDeviceId: "pc-1", capabilityId: "pc.repair.network", capabilitySchemaVersion: "1.0",
    capabilitySnapshotId: "snapshot-1", connectionRevision: "connection-1", policyRevision: "device-policy-v1",
    normalizedInputDigest: "digest-1", sideEffect: "reversible",
  } as const;
  await assert.rejects(() => client.approveDeviceTask("task-1", preview), /remote_device_approval_changed/);
  socket.message("device.task.snapshot", {
    workspaceId: "default", generatedAt: now,
    task: {
      taskId: "task-1", ownerKind: "daemon", ownerId: "pc-runtime", targetDeviceIds: ["pc-1"], status: "awaiting_approval",
      updatedAt: now, attemptIds: [], pendingApproval: preview,
    },
  }, 1, "workspace-1");
  await waitFor(() => client.state.deviceTaskCurrent === true);
  const current = client.state.deviceTask!.task.pendingApproval!;
  await assert.rejects(() => client.approveDeviceTask("other-task", current), /remote_device_approval_changed/);
  const approved = await client.approveDeviceTask("task-1", current);
  const approvalFrame = socket.frames().find(frame => frame.type === "device.task.approve");
  assert.ok(approvalFrame);
  assert.equal(approvalFrame.payload.taskId, "task-1");
  assert.equal(approvalFrame.payload.approval.actionId, preview.actionId);
  assert.equal(approvalFrame.payload.approval.normalizedInputDigest, preview.normalizedInputDigest);
  assert.equal(approvalFrame.payload.approval.expiresAt, "2026-07-31T10:05:00.000Z");
  socket.message("command.completed", {
    commandId: approved.commandId, commandType: "device.task.approve",
    result: { kind: "device_task_approved", taskId: "task-1" }, completedAt: now,
  }, 2);
  assert.deepEqual(await approved.completion, { kind: "device_task_approved", taskId: "task-1" });

  const revoked = await client.revokeDeviceTask("task-1");
  const revokeFrame = socket.frames().find(frame => frame.type === "device.task.revoke");
  assert.ok(revokeFrame);
  assert.equal(revokeFrame.payload.taskId, "task-1");
  socket.message("command.completed", {
    commandId: revoked.commandId, commandType: "device.task.revoke",
    result: { kind: "device_task_revoked", taskId: "task-1" }, completedAt: now,
  }, 3);
  assert.deepEqual(await revoked.completion, { kind: "device_task_revoked", taskId: "task-1" });
  client.disconnect();
  await assert.rejects(() => client.approveDeviceTask("task-1", current), /remote_session_not_ready/);
});

test("device reconciliation sends only the current preview of an unknown task", async () => {
  const harness = createHarness();
  const client = harness.createClient();
  const socket = await harness.connect(client, [...legacyCapabilities, "device.read", "device.reconcile"]);
  const preview = { attemptId: "attempt-1", targetDeviceId: "pc-1", capabilitySnapshotId: "snapshot-2" };
  await assert.rejects(() => client.reconcileDeviceTask("task-1", preview), /remote_device_reconciliation_changed/);
  const task = {
    taskId: "task-1", ownerKind: "daemon", ownerId: "pc-runtime", targetDeviceIds: ["pc-1"],
    status: "unknown", updatedAt: now, attemptIds: ["attempt-1"], pendingReconciliation: preview,
  } as const;
  socket.message("device.task.snapshot", { workspaceId: "default", generatedAt: now, task }, 1, "workspace-1");
  await waitFor(() => client.state.deviceTaskCurrent === true);
  const current = client.state.deviceTask!.task.pendingReconciliation!;
  await assert.rejects(() => client.reconcileDeviceTask("wrong-task", current), /remote_device_reconciliation_changed/);

  const handle = await client.reconcileDeviceTask("task-1", current);
  const frame = socket.frames().find(item => item.type === "device.task.reconcile");
  assert.deepEqual(frame?.payload, {
    commandId: handle.commandId, taskId: "task-1", workspaceId: "default", attemptId: "attempt-1", capabilitySnapshotId: "snapshot-2",
  });
  socket.message("command.completed", {
    commandId: handle.commandId, commandType: "device.task.reconcile",
    result: { kind: "device_task_rechecked", taskId: "task-1", status: "unresolved" }, completedAt: now,
  }, 2);
  assert.deepEqual(await handle.completion, { kind: "device_task_rechecked", taskId: "task-1", status: "unresolved" });
  client.disconnect();
  await assert.rejects(() => client.reconcileDeviceTask("task-1", current), /remote_session_not_ready/);
});

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(1);
  }
  assert.fail("Remote session did not apply the expected state");
}
