import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import test from "node:test";

import type { LingServerSignalingInputV1, RemoteP256PublicJwkV1 } from "@ling-stack/contracts";
import {
  fingerprintPublicJwkSync, lingServerSignalingSigningBytes, validateRemoteP256PublicJwkV1,
  validateLingServerSignedSignalingV1,
} from "@ling-stack/remote-protocol";
import { connectLingServerDataChannel, LingServerSignalingClient, type LingServerSignalingClientOptions } from "../dist/index.js";

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
  let response: unknown;
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
        return { status: 200, body: response as T };
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
    setResponse(value: unknown) { response = value; },
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
