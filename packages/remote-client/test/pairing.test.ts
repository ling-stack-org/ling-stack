import assert from "node:assert/strict";
import test from "node:test";

import {
  RemotePairingClient,
} from "../dist/index.js";
import type { RemoteBindingV1, RemoteHttpClient } from "../dist/index.js";
import type { RemotePairingQrV1 } from "@ling-stack/contracts";
import {
  encodeBase64Url,
  encodePairingQrV1,
} from "../../remote-protocol/dist/index.js";
import { fixture } from "./canonical-signing-fixture.ts";

const now = "2026-07-31T10:00:00.000Z";
const expiresAt = "2026-07-31T10:05:00.000Z";

test("pairing pins the Gateway identity and persists only the accepted device binding", async () => {
  const qr: RemotePairingQrV1 = {
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
  let storedBinding: RemoteBindingV1 | undefined;
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
      getJson: async <T>(_origin: string, path: string) => {
        assert.equal(path, "/v1/health");
        return { status: 200, body: { gatewayId: qr.gatewayId, gatewayIdentityFingerprint: qr.gatewayIdentityFingerprint } as T };
      },
      postJson: async <T>(_origin: string, path: string, body: unknown) => {
        if (path === "/v1/pairing/challenge") {
          return { status: 200, body: challenge as T };
        }
        assert.equal(path, "/v1/pairing/proof");
        const proof = body as { deviceId?: string; pairingSecret?: string; clientNonce?: string };
        assert.equal(proof.deviceId, accepted.deviceId);
        assert.equal(proof.pairingSecret, undefined);
        assert.equal(proof.clientNonce, encodeBase64Url(new Uint8Array(32).fill(1)));
        proofSubmissions += 1;
        return proofSubmissions === 1
          ? { status: 202, body: { status: "confirmation_required" } as T }
          : { status: 200, body: { status: "accepted", accepted } as T };
      },
    } satisfies RemoteHttpClient,
  });

  const started = await client.begin(encodePairingQrV1(qr), { displayName: "My iPhone" });
  assert.equal(started.binding, undefined);
  assert.equal(storedBinding, undefined);
  const binding = await client.submit(started.pending);
  assert.ok(binding);
  assert.equal(binding.status, "active");
  assert.equal(binding.deviceEpoch, 7);
  assert.equal(binding.gatewayIdentityFingerprint, fixture.gatewayIdentity.fingerprint);
  assert.equal((storedBinding as unknown as RemoteBindingV1).deviceKeyId, `ling.remote.device.${qr.gatewayId}`);
});

test("pairing rejects a health endpoint that does not match the QR pin", async () => {
  const qr: RemotePairingQrV1 = {
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
      getJson: async <T>() => ({ status: 200, body: { gatewayId: qr.gatewayId, gatewayIdentityFingerprint: encodeBase64Url(new Uint8Array(32)) } as T }),
      postJson: async <T>() => { throw new Error("must_not_post"); },
    } satisfies RemoteHttpClient,
  });
  await assert.rejects(() => client.begin(encodePairingQrV1(qr), { displayName: "My iPhone" }), /pin_mismatch/u);
});
