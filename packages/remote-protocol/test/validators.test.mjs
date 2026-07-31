import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

const fixture = JSON.parse(await readFile(
  new URL("../fixtures/v1/canonical-signing.json", import.meta.url),
  "utf8",
));

const now = "2026-07-19T10:00:00.000Z";
const nowMs = Date.parse(now);
const signature = fixture.authProof.signatureBase64Url;
const nonce0 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const nonce1 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

const pairingQr = {
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
