import assert from "node:assert/strict";
import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import {
  DEFAULT_WORKSPACE_ID,
  createSqliteRunStore,
} from "@ling-stack/core";
import {
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SUPPORTED_PROTOCOL_VERSIONS,
} from "@ling-stack/contracts";
import {
  authChallengeSigningBytes,
  authChallengeSigningInput,
  authProofSigningBytes,
  authProofSigningInput,
  decodeBase64Url,
  decodeRemotePairingQrV1,
  encodeBase64Url,
  fingerprintPublicJwkSync,
  hmacSha256,
  pairingAcceptedSigningBytes,
  pairingAcceptedSigningInput,
  pairingChallengeSigningBytes,
  pairingChallengeSigningInput,
  pairingProofSigningBytes,
  pairingProofSigningInput,
  parseRemoteServerFrameV1,
  sha256,
} from "@ling-stack/remote-protocol";
import { createDaemonServer } from "../dist/index.js";
import {
  createRemoteGatewayIdentity,
  RemotePairingAuthService,
} from "../dist/features/remote-access/pairing-auth-service.js";
import { RemoteAccessStateStore } from "../dist/features/remote-access/state-store.js";

const gatewayOrigin = "https://ling-pc.example.ts.net";

function createDevice() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKeyJwk = publicKey.export({ format: "jwk" });
  return {
    privateKey,
    publicKey,
    publicKeyJwk,
    fingerprint: fingerprintPublicJwkSync(publicKeyJwk),
  };
}

function signP1363(privateKey, bytes) {
  return encodeBase64Url(sign("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" }));
}

function buildPairingProof({ qr, challenge, device, deviceId = "iphone_device_1" }) {
  const unsigned = {
    version: REMOTE_PROTOCOL_VERSION,
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    gatewayId: qr.gatewayId,
    pairingId: qr.pairingId,
    deviceId,
    displayName: "Tianxiao iPhone",
    platform: "ios",
    devicePublicKeyJwk: device.publicKeyJwk,
    devicePublicKeyFingerprint: device.fingerprint,
    serverNonce: challenge.serverNonce,
    clientNonce: encodeBase64Url(Buffer.alloc(32, 7)),
  };
  const bytes = pairingProofSigningBytes(pairingProofSigningInput(qr.gatewayOrigin, unsigned));
  return {
    ...unsigned,
    pairingHmac: encodeBase64Url(hmacSha256(decodeBase64Url(qr.pairingSecret), bytes)),
    deviceSignature: signP1363(device.privateKey, bytes),
  };
}

async function buildAuthProof({ challenge, device, resume = [] }) {
  const unsigned = {
    version: REMOTE_PROTOCOL_VERSION,
    gatewayId: challenge.gatewayId,
    challengeId: challenge.challengeId,
    candidateSessionId: challenge.candidateSessionId,
    deviceId: "iphone_device_1",
    deviceEpoch: challenge.deviceEpoch,
    clientNonce: encodeBase64Url(Buffer.alloc(32, 9)),
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    resume,
  };
  const { gatewaySignature: _signature, ...unsignedChallenge } = challenge;
  const signingInput = await authProofSigningInput(gatewayOrigin, unsignedChallenge, unsigned, sha256);
  return { ...unsigned, signature: signP1363(device.privateKey, authProofSigningBytes(signingInput)) };
}

test("pairing and authentication bind both identities, require PC confirmation, and reject replay", async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-auth-"));
  let currentTime = "2026-07-31T08:00:00.000Z";
  const stateStore = new RemoteAccessStateStore({
    stateDir,
    listenerPort: 18992,
    createIdentity: createRemoteGatewayIdentity,
    now: () => currentTime,
  });
  const auth = new RemotePairingAuthService({ stateStore, now: () => currentTime });
  try {
    auth.enable(gatewayOrigin);
    const { qr } = auth.beginPairing();
    const challenge = auth.createPairingChallenge(qr.pairingId);
    assert.equal(verify(
      "sha256",
      pairingChallengeSigningBytes(pairingChallengeSigningInput(gatewayOrigin, {
        version: challenge.version,
        gatewayId: challenge.gatewayId,
        pairingId: challenge.pairingId,
        serverNonce: challenge.serverNonce,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
      })),
      { key: createPublicKey({ key: qr.gatewayIdentityPublicKeyJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      decodeBase64Url(challenge.gatewaySignature),
    ), true);

    const device = createDevice();
    const proof = buildPairingProof({ qr, challenge, device });
    assert.deepEqual(auth.submitPairingProof(proof), { status: "confirmation_required" });
    assert.equal(auth.pairingStatus().state, "awaiting_pc_confirmation");

    currentTime = "2026-07-31T08:00:05.000Z";
    const accepted = auth.confirmPendingPairing();
    assert.equal(accepted.deviceEpoch, 1);
    assert.equal(auth.submitPairingProof(proof).status, "accepted");
    const { gatewaySignature: _acceptedSignature, ...unsignedAccepted } = accepted;
    assert.equal(verify(
      "sha256",
      pairingAcceptedSigningBytes(pairingAcceptedSigningInput(gatewayOrigin, unsignedAccepted)),
      { key: createPublicKey({ key: qr.gatewayIdentityPublicKeyJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      decodeBase64Url(accepted.gatewaySignature),
    ), true);

    const authChallenge = auth.createAuthChallenge("iphone_device_1");
    const { gatewaySignature: _authSignature, ...unsignedAuthChallenge } = authChallenge;
    assert.equal(verify(
      "sha256",
      authChallengeSigningBytes(authChallengeSigningInput(gatewayOrigin, unsignedAuthChallenge)),
      { key: createPublicKey({ key: qr.gatewayIdentityPublicKeyJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      decodeBase64Url(authChallenge.gatewaySignature),
    ), true);
    const authProof = await buildAuthProof({ challenge: authChallenge, device });
    const session = await auth.verifyAuthProof(authProof);
    assert.equal(session.sessionId, authChallenge.candidateSessionId);
    await assert.rejects(() => auth.verifyAuthProof(authProof), /missing, used, or expired/u);

    auth.revokeDevice();
    assert.equal(auth.state().deviceEpoch, 2);
    assert.throws(() => auth.createAuthChallenge("iphone_device_1"), /not paired/u);

    assert.equal((await stat(stateStore.identityPath)).mode & 0o777, 0o600);
    assert.equal((await stat(stateStore.statePath)).mode & 0o777, 0o600);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("management API uses strict Origin, capability, and CSRF while remote listener exposes no daemon router", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-controller-"));
  const stateDir = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-controller-state-"));
  const mainPort = await reservePort();
  const remotePort = await reservePort();
  const origin = `http://127.0.0.1:${mainPort}`;
  const capability = "test_mobile_management_capability_32_bytes";
  const store = createSqliteRunStore(cwd);
  store.createChannel({ name: "iPhone Channel", boundPath: cwd }, new Date().toISOString());
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: mainPort,
    defaultWorkspaceCwd: cwd,
    remoteAccess: { listenerPort: remotePort, managementAllowedOrigins: [origin] },
  }, {
    storeFactory: () => store,
    remoteAccessStateDir: stateDir,
    remoteAccessManagementCapability: capability,
  });
  try {
    await daemon.start();
    const missingOrigin = await fetch(`${origin}/v1/mobile-access/status`, {
      headers: { "X-Ling-Mobile-Management-Capability": capability },
    });
    assert.equal(missingOrigin.status, 403);
    assert.equal(missingOrigin.headers.get("access-control-allow-origin"), null);

    const headers = {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Ling-Mobile-Management-Capability": capability,
      "X-Ling-CSRF-Token": daemon.remoteAccessManagement.csrfToken,
    };
    const noCsrf = await fetch(`${origin}/v1/mobile-access/enable`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "X-Ling-Mobile-Management-Capability": capability },
      body: JSON.stringify({ gatewayOrigin }),
    });
    assert.equal(noCsrf.status, 403);

    const enabled = await fetch(`${origin}/v1/mobile-access/enable`, {
      method: "POST",
      headers,
      body: JSON.stringify({ gatewayOrigin }),
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.headers.get("access-control-allow-origin"), origin);
    assert.notEqual(enabled.headers.get("access-control-allow-origin"), "*");
    const enabledBody = await enabled.json();
    assert.deepEqual(enabledBody.listener, { host: "127.0.0.1", port: remotePort, listening: true });
    assert.equal(enabledBody.sendEnabled, true);

    const remoteHealth = await fetch(`http://127.0.0.1:${remotePort}/v1/health`);
    assert.equal(remoteHealth.status, 200);
    const generalRouterProbe = await fetch(`http://127.0.0.1:${remotePort}/channels`);
    assert.equal(generalRouterProbe.status, 405);

    const disabled = await fetch(`${origin}/v1/mobile-access/disable`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).listener.listening, false);
    await assert.rejects(() => fetch(`http://127.0.0.1:${remotePort}/v1/health`));
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("authenticated WebSocket receives snapshots and fails closed on unavailable send capability", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-websocket-"));
  const stateDir = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-websocket-state-"));
  const mainPort = await reservePort();
  const remotePort = await reservePort();
  const origin = `http://127.0.0.1:${mainPort}`;
  const capability = "test_mobile_management_capability_websocket";
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "WebSocket Channel", boundPath: cwd }, new Date().toISOString());
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: mainPort,
    defaultWorkspaceCwd: cwd,
    remoteAccess: { listenerPort: remotePort, managementAllowedOrigins: [origin] },
  }, {
    storeFactory: () => store,
    remoteAccessStateDir: stateDir,
    remoteAccessManagementCapability: capability,
    remoteReplyDispatcher: null,
  });
  let socket;
  try {
    await daemon.start();
    const managementHeaders = {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Ling-Mobile-Management-Capability": capability,
      "X-Ling-CSRF-Token": daemon.remoteAccessManagement.csrfToken,
    };
    await expectOk(fetch(`${origin}/v1/mobile-access/enable`, {
      method: "POST",
      headers: managementHeaders,
      body: JSON.stringify({ gatewayOrigin }),
    }));
    const pairingResponse = await expectOk(fetch(`${origin}/v1/mobile-access/pairing/start`, {
      method: "POST",
      headers: managementHeaders,
      body: "{}",
    }));
    const qr = decodeRemotePairingQrV1(pairingResponse.encodedQr);
    const device = createDevice();
    const pairChallenge = await expectOk(fetch(`http://127.0.0.1:${remotePort}/v1/pairing/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingId: qr.pairingId }),
    }));
    const pairingProof = buildPairingProof({ qr, challenge: pairChallenge, device });
    const pending = await fetch(`http://127.0.0.1:${remotePort}/v1/pairing/proof`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pairingProof),
    });
    assert.equal(pending.status, 202);
    await expectOk(fetch(`${origin}/v1/mobile-access/pairing/confirm`, {
      method: "POST",
      headers: managementHeaders,
      body: "{}",
    }));
    const accepted = await expectOk(fetch(`http://127.0.0.1:${remotePort}/v1/pairing/proof`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pairingProof),
    }));
    assert.equal(accepted.status, "accepted");

    const authChallenge = await expectOk(fetch(`http://127.0.0.1:${remotePort}/v1/auth/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: "iphone_device_1" }),
    }));
    const authProof = await buildAuthProof({ challenge: authChallenge, device });
    socket = new WebSocket(`ws://127.0.0.1:${remotePort}/v1/session`);
    await new Promise((resolvePromise, rejectPromise) => {
      socket.once("open", resolvePromise);
      socket.once("error", rejectPromise);
    });
    const frames = [];
    socket.on("message", (data) => frames.push(parseRemoteServerFrameV1(data.toString())));
    socket.send(JSON.stringify(authProof));
    await waitFor(() => frames.some((frame) => frame.type === "session.ready"));
    const ready = frames.find((frame) => frame.type === "session.ready");
    assert.equal(ready.payload.capabilities?.includes?.("conversation.send_text") ?? ready.payload.policy.capabilities.includes("conversation.send_text"), false);

    socket.send(JSON.stringify(clientFrame({
      gatewayId: qr.gatewayId,
      sessionId: authChallenge.candidateSessionId,
      clientSeq: 1,
      type: "conversation.list",
      payload: { commandId: "list_1", workspaceId: DEFAULT_WORKSPACE_ID },
    })));
    await waitFor(() => frames.some((frame) => frame.type === "conversation.list_snapshot"));
    const listSnapshot = frames.find((frame) => frame.type === "conversation.list_snapshot");
    assert.ok(listSnapshot.payload.conversations.some((item) => item.conversationId === channel.id));

    socket.send(JSON.stringify(clientFrame({
      gatewayId: qr.gatewayId,
      sessionId: authChallenge.candidateSessionId,
      clientSeq: 2,
      type: "conversation.send_text",
      payload: {
        commandId: "send_denied",
        workspaceId: DEFAULT_WORKSPACE_ID,
        conversationId: channel.id,
        body: "Must remain read-only without a safe dispatcher.",
        issuedAt: new Date().toISOString(),
        retryUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    })));
    await waitFor(() => frames.some((frame) => frame.type === "command.failed" && frame.payload.commandId === "send_denied"));
    const failed = frames.find((frame) => frame.type === "command.failed" && frame.payload.commandId === "send_denied");
    assert.equal(failed.payload.error.code, "capability_not_allowed");
    assert.equal(store.getRemoteCommandReceipt("send_denied"), undefined);
  } finally {
    socket?.close();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

function clientFrame({ gatewayId, sessionId, clientSeq, type, payload }) {
  const sentAt = new Date().toISOString();
  return {
    version: REMOTE_PROTOCOL_VERSION,
    type,
    messageId: `client_message_${clientSeq}`,
    gatewayId,
    sessionId,
    sentAt,
    payload,
    clientSeq,
    expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
  };
}

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function expectOk(responsePromise) {
  const response = await responsePromise;
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.fail("Timed out waiting for remote gateway frame");
}
