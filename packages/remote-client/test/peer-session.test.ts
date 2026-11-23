import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import {
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V3, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4,
  type LingServerGatewayRouteV1, type LingServerRoutingProfileV1, type RemoteAuthChallengeV1, type RemoteAuthProofV1, type RemoteP256PublicJwkV1,
} from "@ling-stack/contracts";
import {
  authChallengeSigningBytes, authChallengeSigningInput, authProofSigningBytes, authProofSigningInput, domainSeparatedCanonicalBytes, encodeBase64Url,
  fingerprintPublicJwkSync, sha256, validateRemoteAuthProofV1, validateRemoteP256PublicJwkV1,
  type RemoteMessageChannel, type RemoteMessageReceiver,
} from "@ling-stack/remote-protocol";
import { RemoteSessionClient, type RemoteBindingV1 } from "../dist/index.js";
import type { RemoteSessionConnectionOptions } from "../dist/session-authentication.js";

const now = "2026-11-22T01:00:00.000Z";
const gatewayOrigin = "https://pc.example";
const gatewayId = "gateway-1";
const deviceId = "phone-1";

function key() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    publicJwk: validateRemoteP256PublicJwkV1(publicKey.export({ format: "jwk" })),
    sign: (bytes: Uint8Array) => sign("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"),
  };
}

function verifyProof(jwk: RemoteP256PublicJwkV1, bytes: Uint8Array, signature: string): boolean {
  return verify("sha256", bytes, { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
}

function channel() {
  let receiver: RemoteMessageReceiver | undefined;
  let readyState = 1;
  const sent: unknown[] = [];
  const transport: RemoteMessageChannel = {
    get readyState() { return readyState; },
    bufferedAmount: 0,
    send(data) { sent.push(JSON.parse(data) as unknown); },
    close(code, reason) {
      readyState = 3;
      receiver?.closed({ code, reason });
    },
    subscribe(next) {
      receiver = next;
      return () => { if (receiver === next) receiver = undefined; };
    },
  };
  return {
    sent, transport, get subscribed() { return receiver !== undefined; },
    receive(value: unknown) { receiver?.received(JSON.stringify(value)); },
  };
}

function makeFixture(lingServerRoutingProfile?: LingServerRoutingProfileV1) {
  const gateway = key();
  const phone = key();
  const binding: RemoteBindingV1 = {
    version: 1, status: "active", gatewayId, gatewayOrigin, gatewayIdentityPublicKeyJwk: gateway.publicJwk,
    gatewayIdentityFingerprint: fingerprintPublicJwkSync(gateway.publicJwk),
    deviceId, deviceKeyId: "device-key", deviceEpoch: 7, pairedAt: now,
    ...(lingServerRoutingProfile ? { workspaceBindingId: "workspace-binding", lingServerRoutingProfile } : {}),
  };
  let saved: RemoteBindingV1 | undefined = binding;
  let keyRemovals = 0;
  const route: LingServerGatewayRouteV1 = {
    version: 1, serverOrigin: "https://ling.example", instanceId: "instance-1", installationId: "installation-1",
    bindingId: "binding-1", applicationKeyFingerprint: encodeBase64Url(sha256(Uint8Array.of(1))),
    routeAttemptId: "route-1", preferredRoute: "relay", peerEpoch: 7, gatewayId, mobileDeviceId: deviceId,
    gatewayKeyFingerprint: binding.gatewayIdentityFingerprint, mobileKeyFingerprint: fingerprintPublicJwkSync(phone.publicJwk),
    protocolMajor: 1, features: ["ordered-channel"], expiresAt: "2026-11-22T01:03:00.000Z",
    offerDigest: encodeBase64Url(sha256(Uint8Array.of(2))), answerDigest: encodeBase64Url(sha256(Uint8Array.of(3))),
  };
  const clientOptions = {
    binding,
    bindingStore: {
      async read() { return saved; },
      async write(next: RemoteBindingV1) { saved = next; },
      async remove() { saved = undefined; },
    },
    cacheStore: { read: async () => undefined, write: async () => undefined, remove: async () => undefined },
    keys: {
      async generateOrLoad() { throw new Error("paired key already loaded"); },
      async sign(id: string, bytes: Uint8Array) {
        assert.equal(id, binding.deviceKeyId);
        return phone.sign(bytes);
      },
      async verify(jwk: RemoteP256PublicJwkV1, bytes: Uint8Array, signature: string) { return verifyProof(jwk, bytes, signature); },
      async delete() { keyRemovals += 1; },
    },
    entropy: { randomBytes, randomId: (prefix: string) => prefix + "_" + randomUUID() },
    clock: { now: () => now },
    autoReconnect: false,
  };
  function createClient(connectPeer: (signal: AbortSignal) => Promise<{ readonly route: LingServerGatewayRouteV1; readonly transport: RemoteMessageChannel }>) {
    return new RemoteSessionClient({ ...clientOptions, connectPeer });
  }
  function createHybridClient(connection: Extract<RemoteSessionConnectionOptions, { readonly peerFallback: true }>) {
    return new RemoteSessionClient({ ...clientOptions, ...connection });
  }
  function challenge(signedRoute?: LingServerGatewayRouteV1) {
    const unsigned: Omit<RemoteAuthChallengeV1, "gatewaySignature"> = {
      version: 1, gatewayId, challengeId: "challenge_" + randomUUID(), candidateSessionId: "session_" + randomUUID(),
      serverNonce: randomBytes(32).toString("base64url"), deviceEpoch: binding.deviceEpoch,
      issuedAt: now, expiresAt: "2026-11-22T01:00:30.000Z", supportedProtocolVersions: [1],
    };
    return { ...unsigned, gatewaySignature: gateway.sign(authChallengeSigningBytes(authChallengeSigningInput(gatewayOrigin, unsigned), signedRoute)) };
  }
  return {
    route, createClient, createHybridClient, challenge, phone, get binding() { return saved; }, get keyRemovals() { return keyRemovals; },
  };
}

function frame<T>(type: string, sessionId: string, payload: T, sequence: number) {
  return {
    version: 1, type, sessionId, gatewayId, payload, streamId: "control-stream", serverSeq: sequence,
    messageId: "message-" + sequence, eventId: "event-" + sequence, sentAt: now, occurredAt: now,
  };
}

function ready(sessionId: string, workspaceBindingId = "workspace-binding") {
  return frame("session.ready", sessionId, {
    deviceId, protocolVersion: 1, connectedAt: now,
    policy: {
      version: 1, workspaceId: "default", workspaceBindingId, policyVersion: 1,
      conversationAccess: { mode: "all_in_workspace", kinds: ["channel", "conversation", "teammate_direct"] },
      capabilities: ["conversation.read", "device.read", "device.journal"],
    },
  }, 1);
}

test("peer authentication binds the device proof and keeps the pairing across session replacement", async () => {
  const fixture = makeFixture();
  const first = channel();
  const second = channel();
  const nextRoute = { ...fixture.route, routeAttemptId: "route-2", features: [...fixture.route.features, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4] };
  const paths = [first, second];
  const client = fixture.createClient(async () => {
    const next = paths.shift();
    assert.ok(next);
    return { route: next === first ? fixture.route : nextRoute, transport: next.transport };
  });
  async function connect(peer: typeof first, route: LingServerGatewayRouteV1, subprotocol: string) {
    const connected = client.connect();
    await setImmediate();
    assert.equal(peer.subscribed, true);
    assert.deepEqual(peer.sent, []);
    const challenge = fixture.challenge(route);
    const { gatewaySignature: _gatewaySignature, ...unsigned } = challenge;
    const challengeInput = authChallengeSigningInput(gatewayOrigin, unsigned);
    assert.deepEqual(authChallengeSigningBytes(challengeInput, route), domainSeparatedCanonicalBytes("ling.server.gateway.challenge.v1", {
      subprotocol, route, input: challengeInput,
    }));
    peer.receive(challenge);
    await setImmediate();
    const { signature, ...proof }: RemoteAuthProofV1 = validateRemoteAuthProofV1(peer.sent[0]);
    assert.equal(proof.candidateSessionId, challenge.candidateSessionId);
    const signingInput = await authProofSigningInput(gatewayOrigin, unsigned, proof, sha256);
    assert.ok(verifyProof(fixture.phone.publicJwk, domainSeparatedCanonicalBytes("ling.server.gateway.proof.v1", {
      subprotocol, route, input: signingInput,
    }), signature));
    assert.equal(verifyProof(fixture.phone.publicJwk, authProofSigningBytes(signingInput), signature), false);
    peer.receive(ready(challenge.candidateSessionId));
    await connected;
    return proof;
  }
  const old = await connect(first, fixture.route, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V3);
  first.receive(frame("security.revoked", old.candidateSessionId, { reason: "replaced", revokedAt: now }, 2));
  first.transport.close();
  await setImmediate();
  assert.equal(client.state.connection, "disconnected");
  assert.equal(fixture.binding?.status, "active");
  assert.equal(fixture.keyRemovals, 0);
  const replacement = await connect(second, nextRoute, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4);
  assert.notEqual(replacement.candidateSessionId, old.candidateSessionId);
  assert.ok(client.state.policy?.capabilities.includes("device.journal"));
  client.disconnect();
});

test("peer challenge signatures and session readiness must match the verified route and candidate", async () => {
  const fixture = makeFixture();
  const copied = channel();
  const first = fixture.createClient(async () => ({ route: fixture.route, transport: copied.transport }));
  const wrongRoute = assert.rejects(first.connect(), /gateway_signature_invalid/u);
  await setImmediate();
  copied.receive(fixture.challenge({ ...fixture.route, answerDigest: encodeBase64Url(sha256(Uint8Array.of(99))) }));
  await wrongRoute;
  assert.deepEqual(copied.sent, []);

  const wrongSession = channel();
  const second = fixture.createClient(async () => ({ route: fixture.route, transport: wrongSession.transport }));
  const rejected = assert.rejects(second.connect(), /session_ready_required/u);
  await setImmediate();
  wrongSession.receive(fixture.challenge(fixture.route));
  await setImmediate();
  assert.equal(wrongSession.sent.length, 1);
  wrongSession.receive(ready("wrong-session"));
  await rejected;
  assert.equal(fixture.binding?.status, "active");
});

test("reauthentication retains the confirmed server pin only within its authenticated workspace", async () => {
  const profile: LingServerRoutingProfileV1 = {
    schemaVersion: 1, bindingId: "binding-1", installationId: "installation-1", installationRevision: 1,
    serverOrigin: "https://ling.example", applicationKeyFingerprint: encodeBase64Url(sha256(Uint8Array.of(1))),
    signalingProtocolMajor: 1, gatewayProtocolMajor: 1,
  };
  const fixture = makeFixture(profile);
  let peer = channel();
  const client = fixture.createClient(async () => ({ route: fixture.route, transport: peer.transport }));
  for (const workspaceBindingId of ["workspace-binding", "another-workspace"]) {
    const connected = client.connect();
    await setImmediate();
    const challenge = fixture.challenge(fixture.route);
    peer.receive(challenge);
    await setImmediate();
    peer.receive(ready(challenge.candidateSessionId, workspaceBindingId));
    await connected;
    assert.equal(fixture.binding?.workspaceBindingId, workspaceBindingId);
    assert.deepEqual(fixture.binding?.lingServerRoutingProfile, workspaceBindingId === "workspace-binding" ? profile : undefined);
    client.disconnect();
    peer = channel();
  }
});

test("the mixed transport uses a verified peer without calling Gateway fallback", async () => {
  const fixture = makeFixture();
  const peer = channel();
  const client = fixture.createHybridClient({
    peerFallback: true,
    connectPeer: async () => ({ route: fixture.route, transport: peer.transport }),
    http: {
      async getJson() { return assert.fail("unexpected HTTP GET"); },
      async postJson() { return assert.fail("unexpected Gateway challenge"); },
    },
    webSocketFactory: () => assert.fail("unexpected Gateway WebSocket"),
  });
  const connected = client.connect();
  await setImmediate();
  const challenge = fixture.challenge(fixture.route);
  assert.equal(client.connectionTransport, undefined);
  peer.receive(challenge);
  await setImmediate();
  peer.receive(ready(challenge.candidateSessionId));
  await connected;
  assert.equal(client.state.connection, "connected");
  assert.equal(client.connectionTransport, "ling_server_webrtc");
  client.disconnect();
  assert.equal(client.connectionTransport, undefined);
});

test("an unavailable peer falls back to the paired Gateway authentication", async () => {
  const fixture = makeFixture();
  const challenge = fixture.challenge();
  const requests: string[] = [];
  const events = new EventEmitter();
  let state = 0;
  const sent: unknown[] = [];
  const client = fixture.createHybridClient({
    peerFallback: true,
    connectPeer: async () => { requests.push("peer"); return undefined; },
    http: {
      async getJson() { return assert.fail("unexpected HTTP GET"); },
      async postJson<T>(origin: string, path: string, body: unknown) {
        requests.push("gateway-challenge");
        assert.equal(origin, gatewayOrigin);
        assert.equal(path, "/v1/auth/challenge");
        assert.deepEqual(body, { deviceId });
        return { status: 200, body: challenge as T };
      },
    },
    webSocketFactory: url => {
      requests.push("gateway-socket");
      assert.equal(url, "wss://pc.example/v1/session");
      return {
        get readyState() { return state; },
        send(data) { sent.push(JSON.parse(data) as unknown); },
        close() { state = 3; events.emit("close", {}); },
        addEventListener: events.on.bind(events),
      };
    },
  });
  const connected = client.connect();
  await setImmediate();
  assert.deepEqual(requests, ["peer", "gateway-challenge", "gateway-socket"]);
  state = 1;
  events.emit("open");
  const { signature, ...proof } = validateRemoteAuthProofV1(sent[0]);
  const { gatewaySignature: _gatewaySignature, ...unsigned } = challenge;
  const signingInput = await authProofSigningInput(gatewayOrigin, unsigned, proof, sha256);
  assert.ok(verifyProof(fixture.phone.publicJwk, authProofSigningBytes(signingInput), signature));
  events.emit("message", { data: JSON.stringify(ready(challenge.candidateSessionId)) });
  await connected;
  assert.equal(client.state.connection, "connected");
  assert.equal(client.connectionTransport, "gateway_websocket");
  client.disconnect();
});

test("a peer connector error or returned binding mismatch cannot initiate fallback", async () => {
  const fixture = makeFixture();
  const peer = channel();
  const transports = {
    peerFallback: true as const,
    http: {
      async getJson() { return assert.fail("unexpected HTTP GET"); },
      async postJson() { return assert.fail("unexpected Gateway challenge"); },
    },
    webSocketFactory: () => assert.fail("unexpected Gateway WebSocket"),
  };
  const mismatched = fixture.createHybridClient({
    ...transports,
    connectPeer: async () => ({ route: { ...fixture.route, gatewayId: "another-gateway" }, transport: peer.transport }),
  });
  await assert.rejects(mismatched.connect(), /remote_peer_binding_mismatch/u);
  assert.equal(peer.transport.readyState, 3);
  assert.equal(peer.subscribed, false);
  const failed = fixture.createHybridClient({
    ...transports,
    connectPeer: async () => { throw new Error("invalid_peer_signature"); },
  });
  await assert.rejects(failed.connect(), /invalid_peer_signature/u);
});
