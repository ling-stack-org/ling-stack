import assert from "node:assert/strict";
import { REMOTE_DEVICE_JOURNAL_PAGE_LIMIT_V1, type RemotePairingQrV1 } from "@ling-stack/contracts";
import test from "node:test";
import {
  decodeRemotePairingQrV1,
  encodePairingQrV1,
  evaluateClientSequenceV1,
  evaluateCumulativeAckV1,
  evaluateServerSequenceV1,
  parseRemoteClientFrameV1,
  parseRemoteServerFrameV1,
  validateRemoteAuthChallengeV1,
  validateRemoteAuthProofV1,
  validateRemotePairingChallengeV1,
  validateRemotePairingProofV1,
  validateRemotePairingQrV1,
} from "../dist/index.js";
import { fixture } from "./canonical-signing-fixture.ts";

const now = "2026-07-19T10:00:00.000Z";
const nowMs = Date.parse(now);
const signature = fixture.authProof.signatureBase64Url;
const nonce0 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const nonce1 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

const pairingQr: RemotePairingQrV1 = {
  kind: "ling_remote_pairing",
  version: 1,
  gatewayId: "gateway-1",
  gatewayOrigin: "https://ling-pc.example.ts.net",
  gatewayIdentityPublicKeyJwk: fixture.gatewayIdentity.publicKeyJwk,
  gatewayIdentityFingerprint: fixture.gatewayIdentity.fingerprint,
  pairingId: "pairing-1",
  pairingSecret: nonce0,
  expiresAt: "2026-07-19T10:05:00.000Z",
};

const validClientFrame = {
  version: 1,
  type: "conversation.send_text",
  messageId: "frame-1",
  gatewayId: "gateway-1",
  sessionId: "session-1",
  sentAt: now,
  clientSeq: 1,
  expiresAt: "2026-07-19T10:00:30.000Z",
  payload: {
    commandId: "command-1",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    body: "手机端消息",
    issuedAt: now,
    retryUntil: "2026-07-19T11:00:00.000Z",
  },
};

test("phone device collaboration admits typed evidence with explicit commands", () => {
  const projection = {
    taskId: "phone-task", ownerId: "phone-owner", targetDeviceId: "external-pc", status: "unknown", updatedAt: now,
    attempt: { attemptId: "task:linux-wifi-diagnosis@1.0.0:inspect", capabilityId: "linux.wifi.read", connectionRevision: "conn-3", status: "unknown" },
    facts: { kind: "linux_network", network: { connected: true, wifiAssociated: false, linkError: "wifi_observation_failed" } },
  };
  const action = { kind: "publish", expiresAt: "2026-07-19T10:20:00.000Z", expectedRevision: 0, projection };
  const command = { ...validClientFrame, type: "device.collaboration",
    payload: { commandId: "phone-publish", workspaceId: "workspace-1", shareId: "phone-share", action } };
  assert.deepEqual(parseRemoteClientFrameV1(JSON.stringify(command), { nowMs }), command);
  for (const malformed of [
    { ...action, expectedRevision: -1 },
    { ...action, projection: { ...projection, normalizedInput: {} } },
    { ...action, projection: { ...projection, facts: { kind: "linux_network", network: { connected: true, host: "local-host" } } } },
    { ...action, kind: "read" },
    { kind: "execute", expectedRevision: 1 },
  ]) {
    assert.throws(() => parseRemoteClientFrameV1(JSON.stringify({ ...command, payload: { ...command.payload, action: malformed } }), { nowMs }));
  }
});

test("device journal frames bind cursor ranges to public events from the task owner", () => {
  const command = {
    ...validClientFrame,
    type: "device.task.journal",
    payload: { commandId: "read-journal", workspaceId: "workspace-1", taskId: "task-1", generation: 1, afterSequence: 2, limit: 1 },
  };
  assert.deepEqual(parseRemoteClientFrameV1(JSON.stringify(command), { nowMs }), command);
  assert.throws(() => parseRemoteClientFrameV1(JSON.stringify({
    ...command, payload: { ...command.payload, limit: REMOTE_DEVICE_JOURNAL_PAGE_LIMIT_V1 + 1 },
  }), { nowMs }), /allowed range/u);

  const streamId = "device-task:task-1";
  const event = {
    eventId: streamId + ":40", traceId: streamId, streamId, generation: 1, sequence: 3, sourceId: "runtime-1",
    kind: "observation_recorded", sourceKind: "adapter", payload: { observationId: "observation-1" },
    occurredAt: now, evidenceRefs: ["observation-1"], redactionClass: "public", retentionClass: "durable",
  };
  const page = {
    streamId, generation: 1, afterSequence: 2, latestSequence: 3, events: [event], hasMore: false, requiresSnapshot: false,
    workspaceId: "workspace-1", task: { taskId: "task-1", ownerId: "runtime-1", status: "succeeded", updatedAt: now },
  };
  function completed(journal: unknown) {
    return {
      version: 1, type: "command.completed", messageId: "result-1", gatewayId: "gateway-1", sessionId: "session-1",
      sentAt: now, streamId: "control-stream", eventId: "control-event-1", serverSeq: 2, occurredAt: now,
      payload: {
        commandId: command.payload.commandId, commandType: command.type, completedAt: now,
        result: { kind: "device_task_journal_read", journal },
      },
    };
  }
  assert.deepEqual(parseRemoteServerFrameV1(JSON.stringify(completed(page))), completed(page));
  assert.throws(() => parseRemoteServerFrameV1(JSON.stringify(completed({ ...page, hasMore: true }))), /projection is invalid/u);
  for (const altered of [
    { ...event, sequence: 2 },
    { ...event, sourceId: "runtime-2" },
    { ...event, redactionClass: "sensitive" },
    { ...event, evidenceRefs: ["observation-2"] },
    { ...event, payload: { ...event.payload, rawText: "private device log" } },
  ]) {
    assert.throws(() => parseRemoteServerFrameV1(JSON.stringify(completed({ ...page, events: [altered] }))));
  }

  const watch = { ...command, type: "device.task.journal.watch", payload: { ...command.payload, commandId: "watch-journal" } };
  const stop = {
    ...command, type: "device.task.journal.unwatch",
    payload: { commandId: "stop-watch", workspaceId: "workspace-1", taskId: "task-1", watchId: watch.payload.commandId },
  };
  assert.deepEqual(parseRemoteClientFrameV1(JSON.stringify(watch), { nowMs }), watch);
  assert.deepEqual(parseRemoteClientFrameV1(JSON.stringify(stop), { nowMs }), stop);
  assert.throws(() => parseRemoteClientFrameV1(JSON.stringify({
    ...watch, payload: { ...watch.payload, watchId: "extra-watch-id" },
  }), { nowMs }), /unknown field/u);
  assert.throws(() => parseRemoteClientFrameV1(JSON.stringify({
    ...stop, payload: { ...stop.payload, watchId: "" },
  }), { nowMs }), /allowed range/u);

  const watchResult = {
    ...completed(page),
    payload: {
      commandId: watch.payload.commandId, commandType: watch.type, completedAt: now,
      result: { kind: "device_task_journal_watching", journal: page },
    },
  };
  const unwatchResult = {
    ...completed(page),
    payload: {
      commandId: stop.payload.commandId, commandType: stop.type, completedAt: now,
      result: { kind: "device_task_journal_unwatched" },
    },
  };
  assert.deepEqual(parseRemoteServerFrameV1(JSON.stringify(watchResult)), watchResult);
  assert.deepEqual(parseRemoteServerFrameV1(JSON.stringify(unwatchResult)), unwatchResult);
  assert.throws(() => parseRemoteServerFrameV1(JSON.stringify({
    ...watchResult, payload: { ...watchResult.payload, result: completed(page).payload.result },
  })), /does not match command type/u);

  const update = {
    ...completed(page), type: "device.task.journal_page",
    payload: { watchId: watch.payload.commandId, journal: page },
  };
  assert.deepEqual(parseRemoteServerFrameV1(JSON.stringify(update)), update);
  assert.throws(() => parseRemoteServerFrameV1(JSON.stringify({
    ...update, payload: { ...update.payload, journal: { ...page, streamId: "device-task:foreign-task" } },
  })), /protocol literal/u);
  assert.throws(() => parseRemoteServerFrameV1(JSON.stringify({
    ...update, payload: { ...update.payload, journal: { ...page, requiresSnapshot: true } },
  })), /projection is invalid/u);
});

test("pairing QR round-trips canonical wire encoding and rejects extra fields", () => {
  assert.deepEqual(validateRemotePairingQrV1(pairingQr, { nowMs }), pairingQr);
  assert.deepEqual(decodeRemotePairingQrV1(encodePairingQrV1(pairingQr), { nowMs }), pairingQr);
  assert.throws(
    () => validateRemotePairingQrV1({ ...pairingQr, cwd: "/tmp" }, { nowMs }),
    /unknown field/,
  );
  assert.throws(
    () => validateRemotePairingQrV1({ ...pairingQr, version: 2 }, { nowMs }),
    /protocol literal/,
  );
  assert.throws(
    () => validateRemotePairingQrV1({ ...pairingQr, gatewayIdentityFingerprint: nonce1 }, { nowMs }),
    /does not match the JWK/,
  );
  assert.throws(
    () => validateRemotePairingQrV1({ ...pairingQr, expiresAt: "2026-07-19T10:05:31.000Z" }, { nowMs }),
    /expiry exceeds/,
  );
});

test("pairing and auth handshakes enforce exact fields, time windows and P1363 signatures", () => {
  assert.deepEqual(validateRemotePairingChallengeV1({
    version: 1,
    gatewayId: "gateway-1",
    pairingId: "pairing-1",
    serverNonce: nonce0,
    issuedAt: now,
    expiresAt: "2026-07-19T10:05:00.000Z",
    gatewaySignature: signature,
  }, { nowMs }), {
    version: 1,
    gatewayId: "gateway-1",
    pairingId: "pairing-1",
    serverNonce: nonce0,
    issuedAt: now,
    expiresAt: "2026-07-19T10:05:00.000Z",
    gatewaySignature: signature,
  });

  const proof = {
    version: 1,
    protocolVersion: 1,
    gatewayId: "gateway-1",
    pairingId: "pairing-1",
    deviceId: "device-1",
    displayName: "我的手机",
    platform: "ios",
    devicePublicKeyJwk: fixture.deviceIdentity.publicKeyJwk,
    devicePublicKeyFingerprint: fixture.deviceIdentity.fingerprint,
    serverNonce: nonce0,
    clientNonce: nonce1,
    pairingHmac: fixture.pairingProof.hmacBase64Url,
    deviceSignature: signature,
  };
  assert.deepEqual(validateRemotePairingProofV1(proof), proof);
  assert.throws(() => validateRemotePairingProofV1({ ...proof, algorithm: "none" }), /unknown field/);
  assert.throws(
    () => validateRemotePairingProofV1({ ...proof, devicePublicKeyFingerprint: nonce1 }),
    /does not match the JWK/,
  );

  const challenge = {
    version: 1,
    gatewayId: "gateway-1",
    challengeId: "challenge-1",
    serverNonce: nonce0,
    candidateSessionId: "session-1",
    deviceEpoch: 1,
    issuedAt: now,
    expiresAt: "2026-07-19T10:00:30.000Z",
    supportedProtocolVersions: [1],
    gatewaySignature: signature,
  };
  assert.deepEqual(validateRemoteAuthChallengeV1(challenge, { nowMs }), challenge);
  assert.throws(
    () => validateRemoteAuthChallengeV1({ ...challenge, expiresAt: "2026-07-19T10:00:31.000Z" }, { nowMs }),
    /Expiry window/,
  );

  const authProof = {
    version: 1,
    gatewayId: "gateway-1",
    challengeId: "challenge-1",
    candidateSessionId: "session-1",
    deviceId: "device-1",
    deviceEpoch: 1,
    clientNonce: nonce1,
    protocolVersion: 1,
    resume: [],
    signature,
  };
  assert.deepEqual(validateRemoteAuthProofV1(authProof), authProof);
  assert.throws(() => validateRemoteAuthProofV1({ ...authProof, protocolVersion: 2 }), /protocol literal/);
});

test("client frames accept only the V1 direction-specific schema", () => {
  assert.deepEqual(
    parseRemoteClientFrameV1(JSON.stringify(validClientFrame), { nowMs }),
    validClientFrame,
  );
  assert.throws(
    () => parseRemoteClientFrameV1(JSON.stringify({ ...validClientFrame, streamId: "stream-1" }), { nowMs }),
    /unknown field/,
  );
  assert.throws(
    () => parseRemoteClientFrameV1(JSON.stringify({ ...validClientFrame, type: "file.read" }), { nowMs }),
    /not allowed/,
  );
  assert.throws(
    () => parseRemoteClientFrameV1(JSON.stringify({ ...validClientFrame, version: 2 }), { nowMs }),
    /protocol literal/,
  );
  assert.throws(
    () => parseRemoteClientFrameV1(JSON.stringify({
      ...validClientFrame,
      payload: { ...validClientFrame.payload, cwd: "/tmp" },
    }), { nowMs }),
    /unknown field/,
  );
  assert.throws(
    () => parseRemoteClientFrameV1(JSON.stringify({
      ...validClientFrame,
      payload: { ...validClientFrame.payload, workspaceId: "/tmp/workspace" },
    }), { nowMs }),
    /opaque identifier/,
  );
});

test("self-unpair is a command-id-only security capability", () => {
  const frame = {
    ...validClientFrame,
    type: "security.unpair",
    payload: { commandId: "unpair-1" },
  };
  assert.deepEqual(parseRemoteClientFrameV1(JSON.stringify(frame), { nowMs }), frame);
  assert.throws(
    () => parseRemoteClientFrameV1(JSON.stringify({ ...frame, payload: { ...frame.payload, deviceId: "other-device" } }), { nowMs }),
    /unknown field/u,
  );
});

test("client frames enforce expiry, text and pre-parse frame limits", () => {
  assert.throws(
    () => parseRemoteClientFrameV1(JSON.stringify({
      ...validClientFrame,
      expiresAt: "2026-07-19T09:58:00.000Z",
    }), { nowMs }),
    /Expiry window|expired/,
  );
  assert.throws(
    () => parseRemoteClientFrameV1(JSON.stringify({
      ...validClientFrame,
      payload: { ...validClientFrame.payload, body: "x".repeat(32 * 1024 + 1) },
    }), { nowMs }),
    /length/,
  );
  assert.throws(
    () => parseRemoteClientFrameV1("x".repeat(256 * 1024 + 1), { nowMs }),
    /byte limit/,
  );
  assert.throws(
    () => parseRemoteClientFrameV1(Uint8Array.of(0xc0, 0x80), { nowMs }),
    /UTF-8/,
  );
});

test("duplicate JSON member names fail before JSON.parse can overwrite them", () => {
  const serialized = JSON.stringify(validClientFrame);
  const duplicateType = serialized.replace(
    '"type":"conversation.send_text"',
    '"type":"file.read","type":"conversation.send_text"',
  );
  const duplicateBody = serialized.replace(
    '"body":"手机端消息"',
    '"body":"safe","body":"手机端消息"',
  );
  const escapedDuplicate = serialized.replace(
    '"commandId":"command-1"',
    '"\\u0063ommandId":"safe","commandId":"command-1"',
  );
  for (const candidate of [duplicateType, duplicateBody, escapedDuplicate]) {
    assert.throws(
      () => parseRemoteClientFrameV1(candidate, { nowMs }),
      /duplicate member name/,
    );
  }
});

test("server frames reject client sequencing and duplicated stream fields in payload", () => {
  const frame = {
    version: 1,
    type: "workspace.summary",
    messageId: "event-frame-1",
    gatewayId: "gateway-1",
    sessionId: "session-1",
    sentAt: now,
    streamId: "stream-1",
    eventId: "event-1",
    serverSeq: 1,
    occurredAt: now,
    payload: {
      workspaceId: "workspace-1",
      workspaceBindingId: "binding-1",
      displayName: "Ling Workspace",
      policyVersion: 1,
    },
  };
  assert.deepEqual(parseRemoteServerFrameV1(JSON.stringify(frame)), frame);
  assert.throws(() => parseRemoteServerFrameV1(JSON.stringify({ ...frame, clientSeq: 1 })), /unknown field/);
  assert.throws(() => parseRemoteServerFrameV1(JSON.stringify({
    ...frame,
    payload: { ...frame.payload, streamId: "stream-1" },
  })), /unknown field/);
});

test("session policy allows only least-privilege V1 capability subsets with conversation read", () => {
  const frame = {
    version: 1,
    type: "session.ready",
    messageId: "ready-frame-1",
    gatewayId: "gateway-1",
    sessionId: "session-1",
    sentAt: now,
    streamId: "control-session-1",
    eventId: "ready-event-1",
    serverSeq: 1,
    occurredAt: now,
    payload: {
      deviceId: "device-1",
      protocolVersion: 1,
      policy: {
        version: 1,
        workspaceId: "workspace-1",
        workspaceBindingId: "binding-1",
        policyVersion: 1,
        conversationAccess: { mode: "all_in_workspace", kinds: ["channel", "conversation", "teammate_direct"] },
        capabilities: ["conversation.read"],
      },
      connectedAt: now,
    },
  };
  assert.deepEqual(parseRemoteServerFrameV1(JSON.stringify(frame)), frame);
  assert.throws(() => parseRemoteServerFrameV1(JSON.stringify({
    ...frame,
    payload: { ...frame.payload, policy: { ...frame.payload.policy, capabilities: [] } },
  })), /must retain conversation.read/);
  assert.throws(() => parseRemoteServerFrameV1(JSON.stringify({
    ...frame,
    payload: {
      ...frame.payload,
      policy: { ...frame.payload.policy, capabilities: ["conversation.read", "file.read"] },
    },
  })), /protocol allowlist/);
});

test("command completion result discriminator must match its command type", () => {
  const frame = {
    version: 1,
    type: "command.completed",
    messageId: "event-frame-2",
    gatewayId: "gateway-1",
    sessionId: "session-1",
    sentAt: now,
    requestId: "frame-1",
    streamId: "control-session-1",
    eventId: "event-2",
    serverSeq: 2,
    occurredAt: now,
    payload: {
      commandId: "command-1",
      commandType: "conversation.send_text",
      result: { kind: "message_created", conversationId: "conversation-1", messageId: "message-1" },
      completedAt: now,
    },
  };
  assert.deepEqual(parseRemoteServerFrameV1(JSON.stringify(frame)), frame);
  assert.throws(() => parseRemoteServerFrameV1(JSON.stringify({
    ...frame,
    payload: {
      ...frame.payload,
      result: { kind: "pong", nonce: "ping-1" },
    },
  })), /does not match command type/);
  assert.throws(() => parseRemoteServerFrameV1(JSON.stringify({
    ...frame,
    payload: {
      ...frame.payload,
      commandType: "stream.ack",
    },
  })), /protocol allowlist/);
});

test("stream acknowledgements are transport control and never create lifecycle events", () => {
  const ack = {
    ...validClientFrame,
    type: "stream.ack",
    payload: { streamId: "stream-1", ackServerSeq: 4 },
  };
  assert.deepEqual(parseRemoteClientFrameV1(JSON.stringify(ack), { nowMs }), ack);
  assert.throws(() => parseRemoteClientFrameV1(JSON.stringify({
    ...ack,
    payload: { commandId: "command-loop", ...ack.payload },
  }), { nowMs }), /unknown field/);
});

test("device task commands and projections stay workspace-scoped and strictly typed", () => {
  const command = {
    version: 1,
    type: "device.task.approve",
    messageId: "device-frame-1",
    gatewayId: "gateway-1",
    sessionId: "session-1",
    sentAt: now,
    clientSeq: 4,
    expiresAt: "2026-07-19T10:00:30.000Z",
    payload: {
      commandId: "device-command-1",
      workspaceId: "workspace-1",
      taskId: "task-1",
      approval: {
        approvalId: "approval-1",
        taskId: "task-1",
        actionId: "action-1",
        targetDeviceId: "device-1",
        capabilitySnapshotId: "snapshot-1",
        connectionRevision: "connection-1",
        policyRevision: "policy-1",
        normalizedInputDigest: "digest-1",
        expiresAt: "2026-07-19T10:05:00.000Z",
        recoveryScope: { baseline: "network" },
      },
    },
  } as const;
  assert.deepEqual(parseRemoteClientFrameV1(JSON.stringify(command), { nowMs }), command);
  assert.throws(() => parseRemoteClientFrameV1(JSON.stringify({
    ...command,
    payload: { ...command.payload, approval: { ...command.payload.approval, unexpected: true } },
  }), { nowMs }), /unknown field/);
  const reconcile = {
    ...command,
    type: "device.task.reconcile",
    payload: { commandId: "reconcile-command", workspaceId: "workspace-1", taskId: "task-1", attemptId: "attempt-1", capabilitySnapshotId: "snapshot-2" },
  } as const;
  assert.deepEqual(parseRemoteClientFrameV1(JSON.stringify(reconcile), { nowMs }), reconcile);
  assert.throws(() => parseRemoteClientFrameV1(JSON.stringify({
    ...reconcile,
    payload: { ...reconcile.payload, normalizedInput: { repair: true } },
  }), { nowMs }), /unknown field/);

  const event = {
    version: 1,
    type: "device.task.snapshot",
    messageId: "device-event-1",
    gatewayId: "gateway-1",
    sessionId: "session-1",
    sentAt: now,
    streamId: "control-session-1",
    eventId: "event-device-1",
    serverSeq: 3,
    occurredAt: now,
    payload: {
      workspaceId: "workspace-1",
      generatedAt: now,
      task: {
        taskId: "task-1",
        ownerKind: "daemon",
        ownerId: "daemon-1",
        targetDeviceIds: ["device-1"],
        status: "awaiting_approval",
        updatedAt: now,
        attemptIds: [],
      },
    },
  } as const;
  assert.deepEqual(parseRemoteServerFrameV1(JSON.stringify(event)), event);
  const unresolved = {
    ...event,
    payload: {
      ...event.payload,
      task: {
        ...event.payload.task,
        status: "unknown",
        attemptIds: ["attempt-1"],
        pendingReconciliation: { attemptId: "attempt-1", targetDeviceId: "device-1", capabilitySnapshotId: "snapshot-2" },
      },
    },
  };
  assert.deepEqual(parseRemoteServerFrameV1(JSON.stringify(unresolved)), unresolved);
  assert.throws(() => parseRemoteServerFrameV1(JSON.stringify({
    ...unresolved,
    payload: { ...unresolved.payload, task: { ...unresolved.payload.task, attemptIds: [] } },
  })), /Device projection is invalid/u);

  const overview = {
    ...event,
    type: "device.list_snapshot",
    payload: {
      workspaceId: "workspace-1",
      generatedAt: now,
      devices: [],
      recentTasks: [{ taskId: "task-1", primaryTargetDeviceId: "device-1", status: "awaiting_approval", updatedAt: now }],
    },
  };
  assert.deepEqual(parseRemoteServerFrameV1(JSON.stringify(overview)), overview);
  assert.throws(() => parseRemoteServerFrameV1(JSON.stringify({
    ...overview, payload: { ...overview.payload, recentTasks: [{ ...overview.payload.recentTasks[0], credentials: "forbidden" }] },
  })), /unknown field/u);
  assert.throws(() => parseRemoteServerFrameV1(JSON.stringify({
    ...overview, payload: { ...overview.payload, recentTasks: Array.from({ length: 21 }, () => overview.payload.recentTasks[0]) },
  })), /Device projection is invalid/u);
});

test("conversation snapshots reject cross-workspace and duplicate projected entities", () => {
  const base = {
    version: 1,
    messageId: "snapshot-frame-1",
    gatewayId: "gateway-1",
    sessionId: "session-1",
    sentAt: now,
    streamId: "stream-1",
    eventId: "snapshot-event-1",
    serverSeq: 1,
    occurredAt: now,
  };
  const conversation = {
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    kind: "channel",
    title: "频道一",
    identity: { kind: "channel", label: "频道一" },
    status: "active",
    activitySeq: 3,
    unreadCount: 1,
    mentioned: true,
    updatedAt: now,
  };
  const normalConversation = {
    ...conversation,
    conversationId: "conversation-2",
    kind: "conversation",
    title: "与 Ling 对话",
    identity: { kind: "ling", label: "Ling" },
    unreadCount: 0,
    mentioned: false,
  };
  const teammateDirect = {
    ...conversation,
    conversationId: "conversation-3",
    kind: "teammate_direct",
    title: "Noah",
    identity: { kind: "teammate", label: "Noah", subtitle: "系统架构师" },
  };
  const listFrame = {
    ...base,
    type: "conversation.list_snapshot",
    payload: {
      workspaceId: "workspace-1",
      workspaceBindingId: "binding-1",
      conversations: [conversation, normalConversation, teammateDirect],
      generatedAt: now,
    },
  };
  assert.deepEqual(parseRemoteServerFrameV1(JSON.stringify(listFrame)), listFrame);
  assert.throws(() => parseRemoteServerFrameV1(JSON.stringify({
    ...listFrame,
    payload: {
      ...listFrame.payload,
      conversations: [{ ...conversation, workspaceId: "workspace-other" }],
    },
  })), /outside the snapshot workspace/);
  assert.throws(() => parseRemoteServerFrameV1(JSON.stringify({
    ...listFrame,
    payload: { ...listFrame.payload, conversations: [conversation, conversation] },
  })), /duplicate/);

  const message = {
    messageId: "message-1",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    role: "local_user",
    authorLabel: "我",
    body: "hello",
    status: "ready",
    revision: 1,
    activitySeq: 3,
    createdAt: now,
    updatedAt: now,
  };
  const snapshotFrame = {
    ...base,
    type: "conversation.snapshot",
    payload: {
      snapshotId: "snapshot-1",
      barrierSeq: 1,
      workspace: {
        workspaceId: "workspace-1",
        workspaceBindingId: "binding-1",
        displayName: "Workspace",
        policyVersion: 1,
      },
      conversation,
      readState: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        readThroughActivitySeq: 2,
        unreadCount: 1,
        mentioned: true,
        updatedAt: now,
      },
      messages: [message, message],
      hasMoreOlder: false,
      generatedAt: now,
    },
  };
  assert.throws(() => parseRemoteServerFrameV1(JSON.stringify(snapshotFrame)), /duplicate message/);
});

test("profile update permits only display name and bounded image data", () => {
  const update = {
    ...validClientFrame,
    type: "profile.update",
    payload: {
      commandId: "profile-command-1",
      workspaceId: "workspace-1",
      displayName: "Tianxiao",
      avatarDataUrl: "data:image/png;base64,iVBORw==",
    },
  };
  assert.deepEqual(parseRemoteClientFrameV1(JSON.stringify(update), { nowMs }), update);
  assert.throws(() => parseRemoteClientFrameV1(JSON.stringify({
    ...update,
    payload: { commandId: "profile-command-1", workspaceId: "workspace-1" },
  }), { nowMs }), /editable field/);
  assert.throws(() => parseRemoteClientFrameV1(JSON.stringify({
    ...update,
    payload: { ...update.payload, handle: "forbidden" },
  }), { nowMs }), /unknown field/);
  assert.throws(() => parseRemoteClientFrameV1(JSON.stringify({
    ...update,
    payload: { ...update.payload, avatarDataUrl: "file:///tmp/avatar.png" },
  }), { nowMs }), /data URL/);
});

test("sequence and acknowledgement decisions are deterministic", () => {
  assert.deepEqual(evaluateClientSequenceV1(0, 1), { kind: "accept", next: 1 });
  assert.deepEqual(evaluateClientSequenceV1(1, 1), { kind: "close", expected: 2, received: 1 });
  assert.deepEqual(evaluateClientSequenceV1(1, 3), { kind: "close", expected: 2, received: 3 });

  assert.deepEqual(evaluateServerSequenceV1(4, 5), { kind: "apply", next: 5 });
  assert.deepEqual(evaluateServerSequenceV1(4, 4), { kind: "duplicate", current: 4 });
  assert.deepEqual(evaluateServerSequenceV1(4, 6), { kind: "gap", expected: 5, received: 6 });

  assert.deepEqual(evaluateCumulativeAckV1(3, 8, 6), { kind: "advance", next: 6 });
  assert.deepEqual(evaluateCumulativeAckV1(6, 8, 6), { kind: "duplicate", current: 6 });
  assert.deepEqual(evaluateCumulativeAckV1(6, 8, 9), { kind: "invalid", lastSent: 8, received: 9 });
  assert.deepEqual(evaluateCumulativeAckV1(6, 8, 5), { kind: "invalid", lastSent: 8, received: 5 });
});

test("random extra envelope fields fail closed", () => {
  for (let index = 0; index < 100; index += 1) {
    const extraField = `unexpected_${index}`;
    assert.throws(
      () => parseRemoteClientFrameV1(JSON.stringify({ ...validClientFrame, [extraField]: index }), { nowMs }),
      /unknown field/,
    );
  }
});
