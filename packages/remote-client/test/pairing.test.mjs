import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RemotePairingClient,
} from "../dist/index.js";
import {
  encodeBase64Url,
  encodePairingQrV1,
} from "../../remote-protocol/dist/index.js";

const fixture = JSON.parse(await readFile(new URL("../../remote-protocol/fixtures/v1/canonical-signing.json", import.meta.url), "utf8"));
const now = "2026-07-31T10:00:00.000Z";
const expiresAt = "2026-07-31T10:05:00.000Z";

test("pairing pins the Gateway identity and persists only the accepted device binding", async () => {
  const qr = {
    kind: "ling_remote_pairing",
    version: 1,
    gatewayId: "gateway-fixture-1",
    gatewayOrigin: "https://ling-pc.example.ts.net",
    gatewayIdentityPublicKeyJwk: fixture.gatewayIdentity.publicKeyJwk,
    gatewayIdentityFingerprint: fixture.gatewayIdentity.fingerprint,
    pairingId: "pairing-fixture-1",
    pairingSecret: fixture.pairingProof.pairingSecretBase64Url,
    expiresAt,
  };
  const challenge = {
    version: 1,
    gatewayId: qr.gatewayId,
    pairingId: qr.pairingId,
    serverNonce: fixture.pairingChallenge.input.serverNonce,
    issuedAt: now,
    expiresAt,
    gatewaySignature: fixture.pairingChallenge.signatureBase64Url,
  };
  const accepted = {
    version: 1,
    gatewayId: qr.gatewayId,
    pairingId: qr.pairingId,
    deviceId: "iphone-fixture-1",
    deviceEpoch: 7,
    protocolVersion: 1,
    pairedAt: "2026-07-31T10:00:10.000Z",
    gatewaySignature: fixture.pairingAccepted.signatureBase64Url,
  };
  let proofSubmissions = 0;
  let storedBinding;
  const client = new RemotePairingClient({
    clock: { now: () => now },
    entropy: {
      randomBytes: (length) => new Uint8Array(length).fill(1),
      randomId: () => "iphone-fixture-1",
    },
    keys: {
      generateOrLoad: async (keyId) => ({
        keyId,
        publicJwk: fixture.deviceIdentity.publicKeyJwk,
        hardwareBacked: true,
        privateKeyExportable: false,
      }),
      sign: async () => fixture.pairingProof.signatureBase64Url,
      verify: async () => true,
      delete: async () => undefined,
    },
    bindingStore: {
      read: async () => storedBinding,
      write: async (binding) => { storedBinding = binding; },
      remove: async () => { storedBinding = undefined; },
    },
    http: {
      getJson: async (_origin, path) => {
        assert.equal(path, "/v1/health");
        return { status: 200, body: { gatewayId: qr.gatewayId, gatewayIdentityFingerprint: qr.gatewayIdentityFingerprint } };
      },
      postJson: async (_origin, path, body) => {
        if (path === "/v1/pairing/challenge") {
          return { status: 200, body: challenge };
        }
        assert.equal(path, "/v1/pairing/proof");
        assert.equal(body.deviceId, accepted.deviceId);
        assert.equal(body.pairingSecret, undefined);
        assert.equal(body.clientNonce, encodeBase64Url(new Uint8Array(32).fill(1)));
        proofSubmissions += 1;
        return proofSubmissions === 1
          ? { status: 202, body: { status: "confirmation_required" } }
          : { status: 200, body: { status: "accepted", accepted } };
      },
    },
  });

  const started = await client.begin(encodePairingQrV1(qr), { displayName: "My iPhone" });
  assert.equal(started.binding, undefined);
  assert.equal(storedBinding, undefined);
  const binding = await client.submit(started.pending);
  assert.equal(binding.status, "active");
  assert.equal(binding.deviceEpoch, 7);
  assert.equal(binding.gatewayIdentityFingerprint, fixture.gatewayIdentity.fingerprint);
  assert.equal(storedBinding.deviceKeyId, `ling.remote.device.${qr.gatewayId}`);
});

test("pairing rejects a health endpoint that does not match the QR pin", async () => {
  const qr = {
    kind: "ling_remote_pairing",
    version: 1,
    gatewayId: "gateway-fixture-1",
    gatewayOrigin: "https://ling-pc.example.ts.net",
    gatewayIdentityPublicKeyJwk: fixture.gatewayIdentity.publicKeyJwk,
    gatewayIdentityFingerprint: fixture.gatewayIdentity.fingerprint,
    pairingId: "pairing-fixture-1",
    pairingSecret: fixture.pairingProof.pairingSecretBase64Url,
    expiresAt,
  };
  const client = new RemotePairingClient({
    clock: { now: () => now },
    entropy: { randomBytes: () => new Uint8Array(32), randomId: () => "iphone-fixture-1" },
    keys: {
      generateOrLoad: async () => { throw new Error("must_not_generate_key"); },
      sign: async () => "",
      verify: async () => false,
      delete: async () => undefined,
    },
    bindingStore: { read: async () => undefined, write: async () => undefined, remove: async () => undefined },
    http: {
      getJson: async () => ({ status: 200, body: { gatewayId: qr.gatewayId, gatewayIdentityFingerprint: encodeBase64Url(new Uint8Array(32)) } }),
      postJson: async () => { throw new Error("must_not_post"); },
    },
  });
  await assert.rejects(() => client.begin(encodePairingQrV1(qr), { displayName: "My iPhone" }), /pin_mismatch/u);
});
