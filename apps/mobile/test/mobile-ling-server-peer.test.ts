import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import test from "node:test";

import {
  createFetchRemoteHttpClient,
  type RemoteBindingV1,
  type RemoteDeviceKeyAdapter,
} from "@ling-stack/remote-client";
import {
  fingerprintPublicJwkSync,
  lingServerRendezvousReceiptBytes,
  lingServerSignalingSigningBytes,
  validateLingServerSignedRendezvousRequestV1,
  validateLingServerSignedSignalingV1,
  validateRemoteP256PublicJwkV1,
} from "@ling-stack/remote-protocol";
import { connectMobileLingServerPeer } from "../src/remote/mobile-ling-server-peer.ts";

const now = "2026-11-22T12:00:00.000Z";
const origin = "https://server.fixture.example";
const relay = "turns:relay.fixture.example:443?transport=tcp";

test("the mobile connector selects the relay after a direct route is unavailable", async t => {
  const fixture = createFixture("relay");
  const channel = await connectMobileLingServerPeer(fixture.binding, new AbortController().signal, fixture.options);
  assert.ok(channel);
  t.after(() => channel.close());
  assert.deepEqual(fixture.requestedRoutes, ["direct", "relay"]);
  assert.equal(channel.transport.readyState, 1);
  assert.equal(channel.route.preferredRoute, "relay");
  assert.deepEqual(fixture.ice, [{
    iceTransportPolicy: "relay",
    iceServers: [{ urls: [relay], username: "relay-fixture", credential: "fixture-credential" }],
  }]);
});

test("the mobile connector permits Gateway fallback when both routes are unavailable", async () => {
  const fixture = createFixture("unavailable");
  assert.equal(await connectMobileLingServerPeer(fixture.binding, new AbortController().signal, fixture.options), undefined);
  assert.deepEqual(fixture.requestedRoutes, ["direct", "relay"]);
  assert.deepEqual(fixture.ice, []);
});

test("a mismatched rendezvous proof terminates the attempt before transport fallback", async () => {
  const fixture = createFixture("wrong_signature");
  await assert.rejects(connectMobileLingServerPeer(fixture.binding, new AbortController().signal, fixture.options),
    /ling_server_rendezvous_receipt_invalid/u);
  assert.deepEqual(fixture.requestedRoutes, ["direct"]);
  assert.deepEqual(fixture.ice, []);
});

test("the mobile connector rejects a redirected signaling request", async () => {
  const fixture = createFixture("redirect");
  await assert.rejects(connectMobileLingServerPeer(fixture.binding, new AbortController().signal, fixture.options),
    /remote_http_redirect_refused/u);
  assert.deepEqual(fixture.requestedRoutes, []);
});

function createFixture(scenario: "relay" | "unavailable" | "wrong_signature" | "redirect") {
  const gateway = testKey();
  const mobile = testKey();
  const application = testKey();
  const binding: RemoteBindingV1 = {
    version: 1, status: "active", gatewayId: "gateway",
    gatewayOrigin: "https://gateway.fixture.example", gatewayIdentityPublicKeyJwk: gateway.jwk,
    gatewayIdentityFingerprint: gateway.fingerprint, deviceId: "phone", deviceKeyId: "phone-key",
    deviceEpoch: 1, pairedAt: now,
    lingServerRoutingProfile: {
      schemaVersion: 1, bindingId: "binding", installationId: "installation", installationRevision: 1,
      serverOrigin: origin, applicationKeyFingerprint: application.fingerprint, signalingProtocolMajor: 1, gatewayProtocolMajor: 1,
    },
  };
  const requestedRoutes: string[] = [];
  const ice: RTCConfiguration[] = [];
  const http = createFetchRemoteHttpClient(async (url, init) => {
    assert.ok(url instanceof URL);
    assert.equal(url.origin, origin);
    assert.equal(init?.redirect, "manual");
    if (url.pathname === "/v1/signaling/instance") {
      return scenario === "redirect"
        ? new Response(null, { status: 307, headers: { Location: "https://another.fixture.example" } })
        : Response.json({ instanceId: "fixture-instance" });
    }
    assert.equal(typeof init?.body, "string");
    const body: unknown = JSON.parse(init!.body as string);
    if (url.pathname === "/v1/rendezvous") {
      const proof = validateLingServerSignedRendezvousRequestV1(body);
      assert.equal(proof.input.operation.kind, "request_route");
      const { preferred } = proof.input.operation;
      requestedRoutes.push(preferred);
      if (scenario === "unavailable" || (scenario === "relay" && preferred === "direct")) {
        return new Response("Service unavailable", { status: 503 });
      }
      const receipt = { request: proof.input, offer: proof, applicationPublicKeyJwk: application.jwk };
      const signer = scenario === "wrong_signature" ? gateway : application;
      return Response.json({ ...receipt, applicationSignature: signer.sign(lingServerRendezvousReceiptBytes(receipt)) });
    }
    assert.equal(url.pathname, "/v1/signaling");
    const { input: { operation, ...scope } } = validateLingServerSignedSignalingV1(body);
    assert.equal(scope.preferredRoute, "relay");
    if (operation.kind === "transport_config") {
      return Response.json({ kind: "transport_config", route: "relay", stunUrls: [], turnUrls: [relay],
        relayCredential: { url: relay, username: "relay-fixture", credential: "fixture-credential", expiresAt: scope.expiresAt } });
    }
    if (operation.kind === "publish") {
      assert.equal(operation.messageType, "answer");
      return Response.json({ kind: "published", sequence: 1, replayed: false });
    }
    const input = { ...scope, role: "gateway" as const, operation: {
      kind: "publish" as const, messageType: "offer" as const, sequence: 1, payload: "v=0\r\ns=fixture\r\n",
    } };
    return Response.json({ kind: "signals", latestSequence: 1, hasMore: false,
      messages: [{ input, publicKeyJwk: gateway.jwk, signature: gateway.sign(lingServerSignalingSigningBytes(input)) }] });
  });
  const keys: RemoteDeviceKeyAdapter = {
    async generateOrLoad(keyId) { return { keyId, publicJwk: mobile.jwk, hardwareBacked: false, privateKeyExportable: false }; },
    async sign(_, bytes) { return mobile.sign(bytes); },
    async verify(jwk, bytes, signature) {
      return verify("sha256", bytes, { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"));
    },
    async delete() {},
  };
  return { requestedRoutes, ice, binding, options: {
    http, keys, entropy: { randomBytes }, clock: { now: () => now },
    async createPeerConnection() {
      return (config: RTCConfiguration) => {
        ice.push(config);
        return new FixturePeer() as unknown as RTCPeerConnection;
      };
    },
  } };
}

function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = validateRemoteP256PublicJwkV1(publicKey.export({ format: "jwk" }));
  return {
    jwk, fingerprint: fingerprintPublicJwkSync(jwk),
    sign: (bytes: Uint8Array) => sign("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"),
  };
}

class FixtureChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";

  close() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

class FixturePeer extends EventTarget {
  readonly channel = new FixtureChannel();

  createDataChannel() { return this.channel; }
  async setRemoteDescription() {}
  async createAnswer() { return { type: "answer", sdp: "v=0\r\ns=fixture-answer\r\n" }; }
  async setLocalDescription() { this.channel.readyState = "open"; }
  close() {}
}
