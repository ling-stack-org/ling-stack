import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import {
  LING_SERVER_NEGOTIATED_DATA_CHANNEL_FEATURE_V1, type LingServerRendezvousReceiptV1,
  type LingServerSignalingInputV1, type LingServerSignedRendezvousRequestV1, type RemoteP256PublicJwkV1,
} from "@ling-stack/contracts";
import {
  fingerprintPublicJwkSync, lingServerRendezvousReceiptBytes, lingServerSignalingSigningBytes, validateRemoteP256PublicJwkV1,
  validateLingServerSignedRendezvousRequestV1, validateLingServerSignedSignalingV1,
} from "@ling-stack/remote-protocol";
import {
  connectLingServerDataChannel, LingServerSignalingClient, pollLingServerRoute, requestLingServerRoute,
  type LingServerRendezvousOptions, type LingServerSignalingClientOptions,
} from "../dist/index.js";

function createKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = validateRemoteP256PublicJwkV1(publicKey.export({ format: "jwk" }));
  return {
    publicJwk,
    fingerprint: fingerprintPublicJwkSync(publicJwk),
    sign: (message: Uint8Array) => sign("sha256", message, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"),
  };
}

function verifySignature(jwk: RemoteP256PublicJwkV1, message: Uint8Array, signature: string): boolean {
  return verify("sha256", message, {
    key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363",
  }, Buffer.from(signature, "base64url"));
}

function harness(preferred: "lan" | "direct" | "relay" = "lan") {
  const gateway = createKey();
  const mobile = createKey();
  let now = "2026-11-22T00:00:00.000Z";
  const expiresAt = "2026-11-22T00:03:00.000Z";
  const origin = "https://ling.example";
  const instanceId = "instance-1";
  const requests: LingServerSignalingInputV1[] = [];
  let respond: (input: LingServerSignalingInputV1) => unknown = () => undefined;
  const options: LingServerSignalingClientOptions = {
    installation: {
      installationId: "installation-1", serverOrigin: origin, applicationKeyFingerprint: createKey().fingerprint, revision: 1, status: "active",
    },
    binding: {
      bindingId: "binding-1", installationId: "installation-1", gatewayId: "gateway-1", mobileDeviceId: "phone-1",
      gatewayKeyFingerprint: gateway.fingerprint, mobileKeyFingerprint: mobile.fingerprint, epoch: 2, revision: 2, status: "active",
    },
    route: { bindingId: "binding-1", routeAttemptId: "route-1", peerEpoch: 2, preferred, status: "checking", expiresAt },
    features: ["ordered-channel"],
    role: "mobile",
    key: { keyId: "phone-key", publicJwk: mobile.publicJwk },
    keys: {
      async sign(keyId, message) {
        assert.equal(keyId, "phone-key");
        return mobile.sign(message);
      },
      async verify(jwk, message, signature) { return verifySignature(jwk, message, signature); },
    },
    entropy: { randomBytes },
    clock: { now: () => now },
    http: {
      async getJson<T>(requestOrigin: string, path: string, requestOptions?: Pick<RequestInit, "signal" | "redirect">) {
        assert.equal(requestOrigin, origin);
        assert.equal(path, "/v1/signaling/instance");
        assert.equal(requestOptions?.redirect, "error");
        return { status: 200, body: { instanceId } as T };
      },
      async postJson<T>(requestOrigin: string, path: string, body: unknown, requestOptions?: Pick<RequestInit, "signal" | "redirect">) {
        assert.equal(requestOrigin, origin);
        assert.equal(path, "/v1/signaling");
        assert.equal(requestOptions?.redirect, "error");
        const proof = validateLingServerSignedSignalingV1(body);
        assert.deepEqual(proof.publicKeyJwk, mobile.publicJwk);
        assert.ok(verifySignature(mobile.publicJwk, lingServerSignalingSigningBytes(proof.input), proof.signature));
        requests.push(proof.input);
        return { status: 200, body: respond(proof.input) as T };
      },
    },
  };
  function offer(overrides: Partial<LingServerSignalingInputV1> = {}, key = gateway) {
    const input: LingServerSignalingInputV1 = {
      version: 1, instanceId, installationId: options.installation.installationId,
      applicationKeyFingerprint: options.installation.applicationKeyFingerprint,
      bindingId: options.binding.bindingId, routeAttemptId: options.route.routeAttemptId, preferredRoute: preferred,
      peerEpoch: options.binding.epoch, gatewayId: options.binding.gatewayId, mobileDeviceId: options.binding.mobileDeviceId,
      role: "gateway", protocolMajor: 1, features: ["ordered-channel"], expiresAt,
      operation: { kind: "publish", sequence: 1, messageType: "offer", payload: "v=0\r\ns=ling-fixture\r\n" },
      ...overrides,
    };
    return { input, publicKeyJwk: key.publicJwk, signature: key.sign(lingServerSignalingSigningBytes(input)) };
  }
  return {
    options, offer, requests,
    unpairedKey: createKey(),
    setResponse(value: unknown) { respond = () => value; },
    setResponder(responder: typeof respond) { respond = responder; },
    setNow(value: string) { now = value; },
  };
}

test("an endpoint signs its lane requests and delivers only verified peer messages in sequence", async () => {
  const fixture = harness();
  const client = await LingServerSignalingClient.open(fixture.options);
  const description = fixture.offer();
  const candidate = fixture.offer({
    operation: { kind: "publish", messageType: "ice_candidate", sequence: 2, payload: '{"candidate":"candidate:1"}' },
  });
  fixture.setResponse({ kind: "signals", messages: [description, candidate], latestSequence: 2, hasMore: false });
  assert.deepEqual(await client.poll(0), {
    messages: [description.input.operation, candidate.input.operation], latestSequence: 2, hasMore: false,
  });
  fixture.setResponse({ kind: "signals", messages: [], latestSequence: 2, hasMore: false });
  assert.deepEqual(await client.poll(2), { messages: [], latestSequence: 2, hasMore: false });
  const [first, next] = fixture.requests;
  assert.equal(first.role, "mobile");
  assert.equal(first.peerEpoch, 2);
  assert.equal(first.routeAttemptId, fixture.options.route.routeAttemptId);
  assert.ok(first.operation.kind === "poll" && next.operation.kind === "poll");
  assert.equal(next.operation.afterSequence, 2);
  assert.notEqual(first.operation.nonce, next.operation.nonce);

  const answer = { kind: "publish", sequence: 1, messageType: "answer", payload: "v=0\r\ns=answer\r\n" } as const;
  fixture.setResponse({ kind: "published", sequence: 1, replayed: true });
  assert.deepEqual(await client.publish(answer), { replayed: true });
  assert.deepEqual(fixture.requests.at(-1)?.operation, answer);
  fixture.setResponse({ kind: "published", sequence: 2, replayed: false });
  await assert.rejects(client.publish(answer), /receipt_mismatch/u);
});

test("tampered, misrouted, unpaired, and out-of-sequence signaling never reaches the transport", async () => {
  const fixture = harness();
  const client = await LingServerSignalingClient.open(fixture.options);
  const valid = fixture.offer();
  const tampered = {
    ...valid,
    input: { ...valid.input, operation: { kind: "publish", sequence: 1, messageType: "offer", payload: "modified SDP" } },
  };
  const invalidMessages = [
    [tampered, /signature_invalid/u],
    [fixture.offer({}, fixture.unpairedKey), /signature_invalid/u],
    [fixture.offer({ instanceId: "instance-before-restart" }), /scope_mismatch/u],
    [fixture.offer({ routeAttemptId: "another-route" }), /scope_mismatch/u],
    [fixture.offer({ preferredRoute: "relay" }), /scope_mismatch/u],
    [fixture.offer({ peerEpoch: 1 }), /scope_mismatch/u],
    [fixture.offer({ role: "mobile" }), /scope_mismatch/u],
    [fixture.offer({ features: [] }), /scope_mismatch/u],
    [fixture.offer({ operation: { kind: "publish", sequence: 2, messageType: "offer", payload: "v=0" } }), /scope_mismatch/u],
  ] as const;
  for (const [message, reason] of invalidMessages) {
    fixture.setResponse({ kind: "signals", messages: [message], latestSequence: 1, hasMore: false });
    await assert.rejects(client.poll(0), reason);
  }
  fixture.setResponse({ kind: "signals", messages: [], latestSequence: 2, hasMore: true });
  await assert.rejects(client.poll(0), /cursor_mismatch/u);
  fixture.setResponse({ kind: "signals", messages: Array.from({ length: 9 }, () => valid), latestSequence: 9, hasMore: false });
  await assert.rejects(client.poll(0), /Array length/u);
});

test("transport configuration fences the selected route and relay credential lifetime", async () => {
  const fixture = harness("relay");
  const client = await LingServerSignalingClient.open(fixture.options);
  const config = {
    kind: "transport_config", route: "relay", stunUrls: ["stun:ling.example"],
    turnUrls: ["turns:relay.ling.example:443?transport=tcp"],
    relayCredential: {
      url: "turns:relay.ling.example:443?transport=tcp", username: "fixture-user", credential: "fixture-credential",
      expiresAt: fixture.options.route.expiresAt,
    },
  };
  fixture.setResponse(config);
  assert.deepEqual(await client.transportConfig(), config);
  fixture.setResponse({ ...config, relayCredential: { ...config.relayCredential, url: "turns:other.example:443" } });
  await assert.rejects(client.transportConfig(), /outside the configured route/u);
  fixture.setResponse({ ...config, relayCredential: { ...config.relayCredential, expiresAt: "2026-11-22T00:04:00.000Z" } });
  await assert.rejects(client.transportConfig(), /credential_expiry_invalid/u);
  fixture.setResponse({ ...config, route: "direct", relayCredential: undefined });
  await assert.rejects(client.transportConfig());
  fixture.setResponse({ kind: "transport_config", route: "direct", stunUrls: ["stun:ling.example"], turnUrls: [] });
  await assert.rejects(client.transportConfig(), /route_mismatch/u);
  fixture.setNow(fixture.options.route.expiresAt);
  const count = fixture.requests.length;
  await assert.rejects(client.poll(0), /expiry_invalid/u);
  assert.equal(fixture.requests.length, count);
});

test("cancelling negotiation interrupts signaling before any peer connection is created", async () => {
  const fixture = harness();
  const abort = new AbortController();
  let requestOpened = false;
  const connection = connectLingServerDataChannel({
    ...fixture.options,
    signal: abort.signal,
    createPeerConnection: () => assert.fail("unexpected peer connection"),
    http: {
      ...fixture.options.http,
      async getJson(_, __, requestOptions) {
        requestOpened = true;
        return await new Promise((_, reject) => {
          requestOptions?.signal?.addEventListener("abort", () => reject(requestOptions.signal?.reason), { once: true });
        });
      },
    },
  });
  assert.equal(requestOpened, true);
  abort.abort();
  await assert.rejects(connection, /negotiation_cancelled/u);
});

test("relay negotiation offers UDP and TLS to ICE and can cancel while the peer is preparing its answer", { timeout: 5_000 }, async t => {
  const fixture = harness("relay");
  const abort = new AbortController();
  const udpUrl = "turn:relay.ling.example:3478?transport=udp";
  const tlsUrl = "turns:relay.ling.example:443?transport=tcp";
  const relayCredential = {
    url: udpUrl, username: "fixture-user", credential: "fixture-credential", expiresAt: fixture.options.route.expiresAt,
  };
  const offer = fixture.offer();
  assert.equal(offer.input.operation.kind, "publish");
  fixture.setResponder(({ operation }) => {
    if (operation.kind === "transport_config") {
      return {
        kind: "transport_config", route: "relay", stunUrls: ["stun:ling.example"],
        turnUrls: [udpUrl, udpUrl, tlsUrl], relayCredential,
      };
    }
    assert.equal(operation.kind, "poll");
    return { kind: "signals", messages: [offer], latestSequence: 1, hasMore: false };
  });

  let describe!: (description: RTCSessionDescriptionInit) => void;
  const descriptionStarted = new Promise<RTCSessionDescriptionInit>(resolve => { describe = resolve; });
  let finishDescription!: () => void;
  const descriptionFinished = new Promise<void>(resolve => { finishDescription = resolve; });
  let closeCount = 0;
  let answerCount = 0;
  const peer = Object.assign(new EventTarget(), {
    setRemoteDescription(description: RTCSessionDescriptionInit) {
      describe(description);
      return descriptionFinished;
    },
    createAnswer() { answerCount += 1; },
    close() { closeCount += 1; },
  });
  t.after(() => {
    abort.abort();
    finishDescription();
  });
  const connection = connectLingServerDataChannel({
    ...fixture.options,
    signal: abort.signal,
    createPeerConnection(configuration) {
      assert.deepEqual(configuration, {
        iceTransportPolicy: "relay",
        iceServers: [{ urls: [udpUrl, tlsUrl], username: relayCredential.username, credential: relayCredential.credential }],
      });
      return peer as unknown as RTCPeerConnection;
    },
  });
  const description = await Promise.race([
    descriptionStarted,
    connection.then(() => assert.fail("peer opened before processing the offer")),
  ]);
  assert.deepEqual(description, { type: "offer", sdp: offer.input.operation.payload });
  abort.abort();
  await assert.rejects(connection, /ling_server_negotiation_cancelled/u);
  assert.equal(closeCount, 1);
  finishDescription();
  await setImmediate();
  assert.equal(answerCount, 0);
  assert.deepEqual(fixture.requests.map(request => request.operation.kind), ["transport_config", "poll"]);
});

test("the negotiation deadline bounds a signaling request that ignores cancellation", { timeout: 5_000 }, async () => {
  const fixture = harness("direct");
  let requestStarted = false;
  let requestSignal: AbortSignal | undefined;
  await assert.rejects(connectLingServerDataChannel({
    ...fixture.options,
    timeoutMs: 10,
    http: {
      ...fixture.options.http,
      getJson(_, __, requestOptions) {
        requestStarted = true;
        requestSignal = requestOptions?.signal ?? undefined;
        return new Promise<never>(() => {});
      },
    },
    createPeerConnection: () => assert.fail("unexpected peer connection"),
  }), /ling_server_negotiation_timed_out/u);
  assert.equal(requestStarted, true);
  assert.equal(requestSignal?.aborted, true);
  assert.deepEqual(fixture.requests, []);
});

test("the route client verifies the server receipt and the original phone offer before returning shared signaling scope", async () => {
  const application = createKey();
  const mobile = createKey();
  const gateway = createKey();
  const wrongKey = createKey();
  const clock = { now: () => "2026-11-22T00:00:00.000Z" };
  const instanceId = "fixture-instance";
  const origin = "https://ling.example";
  let offer: LingServerSignedRendezvousRequestV1 | undefined;
  let responseSigner = application;
  let tamperOffer = false;
  let staleReceipt: LingServerRendezvousReceiptV1 | undefined;
  const options = (identity: typeof mobile): LingServerRendezvousOptions => ({
    installation: { installationId: "installation-1", serverOrigin: origin, applicationKeyFingerprint: application.fingerprint,
      revision: 1, status: "active" },
    binding: { bindingId: "binding-1", installationId: "installation-1", gatewayId: "gateway-1", mobileDeviceId: "mobile-1",
      status: "active", epoch: 2, revision: 1, gatewayKeyFingerprint: gateway.fingerprint, mobileKeyFingerprint: mobile.fingerprint },
    key: { keyId: "fixture-key", publicJwk: identity.publicJwk },
    keys: {
      async sign(_id, bytes) { return identity.sign(bytes); },
      async verify(jwk, bytes, signature) { return verifySignature(jwk, bytes, signature); },
    },
    entropy: { randomBytes },
    clock,
    http: {
      async getJson<T>(requestOrigin: string, path: string, requestOptions?: Pick<RequestInit, "signal" | "redirect">) {
        assert.equal(requestOrigin, origin);
        assert.equal(path, "/v1/signaling/instance");
        assert.equal(requestOptions?.redirect, "error");
        return { status: 200, body: { instanceId } as T };
      },
      async postJson<T>(requestOrigin: string, path: string, body: unknown, requestOptions?: Pick<RequestInit, "signal" | "redirect">) {
        assert.equal(requestOrigin, origin);
        assert.equal(path, "/v1/rendezvous");
        assert.equal(requestOptions?.redirect, "error");
        const verified = validateLingServerSignedRendezvousRequestV1(body);
        if (staleReceipt) return { status: 200, body: staleReceipt as T };
        if (verified.input.operation.kind === "request_route") offer = verified;
        let sharedOffer = offer;
        if (sharedOffer && tamperOffer) {
          sharedOffer = { ...sharedOffer, publicKeyJwk: wrongKey.publicJwk };
        }
        const receipt = {
          request: verified.input, applicationPublicKeyJwk: responseSigner.publicJwk,
          ...(sharedOffer ? { offer: sharedOffer } : {}),
        };
        const response = { ...receipt, applicationSignature: responseSigner.sign(lingServerRendezvousReceiptBytes(receipt)) };
        return { status: 200, body: response as T };
      },
    },
  });
  assert.equal(await pollLingServerRoute(options(gateway)), undefined);
  await assert.rejects(requestLingServerRoute(options(gateway), "direct"), /rendezvous_binding_invalid/u);
  const requested = await requestLingServerRoute(options(mobile), "direct");
  assert.equal(requested.instanceId, instanceId);
  assert.equal(requested.route.preferred, "direct");
  assert.deepEqual(await pollLingServerRoute(options(gateway)), requested);
  tamperOffer = true;
  await assert.rejects(pollLingServerRoute(options(gateway)), /rendezvous_offer_invalid/u);
  tamperOffer = false;
  responseSigner = wrongKey;
  await assert.rejects(pollLingServerRoute(options(gateway)), /rendezvous_receipt_invalid/u);
  assert.ok(offer);
  const stale = { request: offer.input, offer, applicationPublicKeyJwk: application.publicJwk };
  staleReceipt = { ...stale, applicationSignature: application.sign(lingServerRendezvousReceiptBytes(stale)) };
  await assert.rejects(pollLingServerRoute(options(gateway)), /rendezvous_receipt_invalid/u);
  const fixture = harness();
  await assert.rejects(connectLingServerDataChannel({
    ...fixture.options, expectedInstanceId: "before-restart",
    createPeerConnection: () => assert.fail("opened a peer for a different signaling instance"),
  }), /signaling_instance_changed/u);
});

test("the signed native feature opens a reliable negotiated channel with the fixed ID on Mobile", async () => {
  const fixture = harness();
  const features = [LING_SERVER_NEGOTIATED_DATA_CHANNEL_FEATURE_V1];
  const offer = fixture.offer({ features });
  fixture.setResponder(({ operation }) => {
    if (operation.kind === "transport_config") return { kind: "transport_config", route: "lan", stunUrls: [], turnUrls: [] };
    if (operation.kind === "poll") return { kind: "signals", messages: [offer], latestSequence: 1, hasMore: false };
    return { kind: "published", sequence: 1, replayed: false };
  });
  const channel = Object.assign(new EventTarget(), {
    readyState: "connecting", bufferedAmount: 0, close() { channel.dispatchEvent(new Event("close")); },
  });
  let closed = false;
  const peer = Object.assign(new EventTarget(), {
    createDataChannel(label: string, options: RTCDataChannelInit) {
      assert.equal(label, "ling-peer");
      assert.deepEqual(options, { ordered: true, protocol: "ling-peer.v1", negotiated: true, id: 0 });
      return channel;
    },
    async setRemoteDescription(description: RTCSessionDescriptionInit) {
      assert.equal(description.type, "offer");
    },
    async createAnswer() { return { type: "answer", sdp: "v=0\r\ns=phone-fixture\r\n" }; },
    async setLocalDescription() { channel.readyState = "open"; },
    close() { closed = true; },
  });
  const connection = await connectLingServerDataChannel({
    ...fixture.options, features, createPeerConnection: () => peer as unknown as RTCPeerConnection,
  });
  assert.deepEqual(connection.route.features, features);
  assert.deepEqual(fixture.requests.map(request => request.operation.kind), ["transport_config", "poll", "publish"]);
  connection.close();
  assert.equal(closed, true);
});
