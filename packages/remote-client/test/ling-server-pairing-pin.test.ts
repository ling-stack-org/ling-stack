import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import test from "node:test";
import type {
  LingServerConfirmedPairingMigrationV1,
  LingServerPairingPinProofV1,
  LingServerPairingPinRequestV1,
  LingServerPeerBindingV1,
  RemoteP256PublicJwkV1,
} from "@ling-stack/contracts";
import {
  fingerprintPublicJwkSync,
  lingServerPairingMigrationSigningBytes,
  lingServerPairingPinChallengeBytes,
  lingServerPairingPinProofBytes,
  validateLingServerPairingPinRequestV1,
  validateRemoteP256PublicJwkV1,
} from "@ling-stack/remote-protocol";
import {
  RemoteSessionClient, verifyLingServerPairingPin, type LingServerPairingPinVerificationOptions,
  type RemoteBindingV1, type RemoteDeviceKeyAdapter, type RemoteHttpClient,
} from "../dist/index.js";

const now = "2026-11-22T10:04:00.000Z";

function generateKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = validateRemoteP256PublicJwkV1(publicKey.export({ format: "jwk" }));
  return {
    publicJwk,
    fingerprint: fingerprintPublicJwkSync(publicJwk),
    sign(bytes: Uint8Array) {
      return sign("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    },
  };
}

function verifySignature(jwk: RemoteP256PublicJwkV1, bytes: Uint8Array, signature: string) {
  const key = createPublicKey({ format: "jwk", key: jwk });
  return verify("sha256", bytes, { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
}

function createFixture() {
  const gateway = generateKey();
  const mobile = generateKey();
  const application = generateKey();
  const binding: RemoteBindingV1 = {
    version: 1, status: "active", gatewayId: "gateway-a", gatewayOrigin: "https://gateway.example",
    gatewayIdentityPublicKeyJwk: gateway.publicJwk, gatewayIdentityFingerprint: gateway.fingerprint,
    deviceId: "phone-a", deviceKeyId: "secret-key-id", deviceEpoch: 7,
    pairedAt: "2026-11-22T10:00:00.000Z", workspaceBindingId: "workspace-a",
  };
  const oldPairing = {
    gatewayId: binding.gatewayId, gatewayOrigin: binding.gatewayOrigin, gatewayKeyFingerprint: gateway.fingerprint,
    mobileDeviceId: binding.deviceId, mobileKeyFingerprint: mobile.fingerprint, deviceEpoch: binding.deviceEpoch,
    workspaceBindingId: "workspace-a",
  };
  const unsigned = {
    schemaVersion: 1, migrationId: "migration-a", confirmationDigest: "1".repeat(64),
    createdAt: "2026-11-22T10:00:00.000Z", confirmedAt: "2026-11-22T10:00:30.000Z", expiresAt: "2026-11-22T10:05:00.000Z",
    retainedReceipts: [], oldPairing,
    routingProfile: {
      schemaVersion: 1, bindingId: "link-a", installationId: "installation-a", installationRevision: 2,
      serverOrigin: "https://server.example", applicationKeyFingerprint: application.fingerprint,
      gatewayProtocolMajor: 1, signalingProtocolMajor: 1,
    },
  } as const;
  function makeConfirmation(changes: Partial<Omit<LingServerConfirmedPairingMigrationV1, "status" | "gatewaySignature">> = {}): LingServerConfirmedPairingMigrationV1 {
    const record = { ...unsigned, ...changes };
    return { ...record, status: "confirmed", gatewaySignature: gateway.sign(lingServerPairingMigrationSigningBytes(record)) };
  }
  const confirmation = makeConfirmation();
  const requests: LingServerPairingPinRequestV1[] = [];
  let localKey = mobile.publicJwk;
  const keys: RemoteDeviceKeyAdapter = {
    async generateOrLoad(keyId) {
      assert.equal(keyId, binding.deviceKeyId);
      return { keyId, publicJwk: localKey, hardwareBacked: true, privateKeyExportable: false };
    },
    async sign(keyId, bytes) {
      assert.equal(keyId, binding.deviceKeyId);
      return mobile.sign(bytes);
    },
    async verify(jwk, bytes, signature) { return verifySignature(jwk, bytes, signature); },
    async delete() {},
  };
  function makeProof(
    request: LingServerPairingPinRequestV1,
    record = confirmation,
    changes: Partial<Omit<LingServerPairingPinProofV1, "applicationSignature">> = {},
    signer = application,
  ): LingServerPairingPinProofV1 {
    const peer: LingServerPeerBindingV1 = {
      bindingId: record.routingProfile.bindingId, installationId: record.routingProfile.installationId,
      gatewayId: record.oldPairing.gatewayId, mobileDeviceId: record.oldPairing.mobileDeviceId, epoch: record.oldPairing.deviceEpoch,
      gatewayKeyFingerprint: record.oldPairing.gatewayKeyFingerprint, mobileKeyFingerprint: record.oldPairing.mobileKeyFingerprint,
      revision: 1, status: "active",
    };
    const proof = {
      challenge: request.challenge, binding: peer, routingProfile: record.routingProfile,
      issuedAt: now, applicationPublicKeyJwk: signer.publicJwk, ...changes,
    };
    return { ...proof, applicationSignature: signer.sign(lingServerPairingPinProofBytes(proof)) };
  }
  let respond = (request: LingServerPairingPinRequestV1): LingServerPairingPinProofV1 | Promise<LingServerPairingPinProofV1> => makeProof(request);
  const http: RemoteHttpClient = {
    async getJson() { throw new Error("unexpected GET"); },
    async postJson<T>(origin: string, path: string, body: unknown, options?: Pick<RequestInit, "signal" | "redirect">) {
      assert.equal(origin, confirmation.routingProfile.serverOrigin);
      assert.equal(path, "/v1/pairing-migrations/verify");
      assert.equal(options?.redirect, "error");
      const request = validateLingServerPairingPinRequestV1(body);
      assert.deepEqual(request.mobilePublicKeyJwk, mobile.publicJwk);
      assert.equal(verifySignature(mobile.publicJwk, lingServerPairingPinChallengeBytes(request.challenge), request.mobileSignature), true);
      requests.push(request);
      return { status: 200, body: await respond(request) as T };
    },
  };
  const clock = { now: () => now };
  const entropy = { randomBytes, randomId: (prefix: string) => `${prefix}-fixture` };
  const options: LingServerPairingPinVerificationOptions = { binding, confirmation, keys, http, clock, entropy };
  let saved: RemoteBindingV1 | undefined = binding;
  let failAfterNextWrite = false;
  const writes: RemoteBindingV1[] = [];
  const client = new RemoteSessionClient({
    binding, keys, http, clock, entropy, autoReconnect: false,
    webSocketFactory: () => { throw new Error("unexpected transport cutover"); },
    bindingStore: {
      read: async () => saved,
      write: async next => {
        writes.push(next);
        saved = next;
        if (failAfterNextWrite) {
          failAfterNextWrite = false;
          throw new Error("fixture_storage_reply_lost");
        }
      },
      remove: async () => { saved = undefined; },
    },
    cacheStore: { read: async () => undefined, write: async () => {}, remove: async () => {} },
  });
  return {
    options, requests, makeProof, makeConfirmation, client, writes,
    setResponder(responder: typeof respond) { respond = responder; },
    setLocalKey(key: RemoteP256PublicJwkV1) { localKey = key; },
    loseNextStorageReply() { failAfterNextWrite = true; },
    get saved() { return saved; },
    set saved(value) { saved = value; },
  };
}

test("the paired phone proves its key and verifies the published server pin without switching transport", async () => {
  const fixture = createFixture();
  const confirmation = fixture.makeConfirmation();
  const proof = await verifyLingServerPairingPin(fixture.options);
  assert.deepEqual(proof.routingProfile, confirmation.routingProfile);
  assert.equal(proof.binding.epoch, fixture.options.binding.deviceEpoch);
  assert.deepEqual(fixture.saved, fixture.options.binding);
  assert.deepEqual(fixture.writes, []);

  const expected = { ...fixture.options.binding, lingServerRoutingProfile: confirmation.routingProfile };
  const observedBindings: (RemoteBindingV1 | undefined)[] = [];
  fixture.client.subscribe(() => observedBindings.push(fixture.client.activeBinding));
  assert.deepEqual(await fixture.client.confirmLingServerPairingPin(confirmation), expected);
  assert.deepEqual(await fixture.client.confirmLingServerPairingPin(confirmation), expected);
  assert.deepEqual(fixture.saved, expected);
  assert.deepEqual(fixture.writes, [expected]);
  assert.deepEqual(observedBindings, [fixture.options.binding, expected]);
  assert.equal(fixture.client.state.connection, "disconnected");
  assert.equal(new Set(fixture.requests.map(request => request.challenge.nonce)).size, fixture.requests.length);
});

test("retrying after a lost storage response restores the already committed pin", async () => {
  const fixture = createFixture();
  const confirmation = fixture.makeConfirmation();
  fixture.loseNextStorageReply();
  await assert.rejects(fixture.client.confirmLingServerPairingPin(confirmation), /fixture_storage_reply_lost/u);
  assert.equal(fixture.client.activeBinding?.lingServerRoutingProfile, undefined);
  assert.deepEqual(fixture.saved?.lingServerRoutingProfile, confirmation.routingProfile);
  assert.deepEqual(await fixture.client.confirmLingServerPairingPin(confirmation), fixture.saved);
  assert.deepEqual(fixture.client.activeBinding, fixture.saved);
  assert.equal(fixture.writes.length, 1);
});

test("untrusted Gateway records or mismatched local pairing authority never send a pin request", async () => {
  const fixture = createFixture();
  const { binding } = fixture.options;
  for (const candidate of [
    { ...binding, status: "revoked" as const }, { ...binding, deviceEpoch: binding.deviceEpoch + 1 },
    { ...binding, workspaceBindingId: "other-workspace" }, { ...binding, gatewayIdentityPublicKeyJwk: generateKey().publicJwk },
  ]) {
    await assert.rejects(verifyLingServerPairingPin({ ...fixture.options, binding: candidate }), /pairing_binding_mismatch/u);
  }
  const confirmed = fixture.makeConfirmation();
  const confirmation = { ...confirmed, routingProfile: { ...confirmed.routingProfile, serverOrigin: "https://untrusted.example" } };
  await assert.rejects(verifyLingServerPairingPin({ ...fixture.options, confirmation }), /gateway_signature_invalid/u);
  fixture.setLocalKey(generateKey().publicJwk);
  await assert.rejects(verifyLingServerPairingPin(fixture.options), /mobile_key_mismatch/u);
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(fixture.writes, []);
});

test("a pin reply must have the current nonce, exact routing and binding scope, fresh time and pinned signature", async () => {
  const fixture = createFixture();
  const prior = await verifyLingServerPairingPin(fixture.options);
  const untrusted = generateKey();
  const cases: readonly [
    respond: (request: LingServerPairingPinRequestV1) => LingServerPairingPinProofV1,
    error: RegExp,
  ][] = [
    [() => prior, /pin_scope_mismatch/u],
    [request => fixture.makeProof(request, undefined, { binding: { ...prior.binding, epoch: prior.binding.epoch + 1 } }), /pin_scope_mismatch/u],
    [request => fixture.makeProof(request, undefined, { routingProfile: { ...prior.routingProfile, installationRevision: 3 } }), /pin_scope_mismatch/u],
    [request => fixture.makeProof(request, undefined, {}, untrusted), /pin_signature_invalid/u],
    [request => ({ ...fixture.makeProof(request), applicationSignature: prior.applicationSignature }), /pin_signature_invalid/u],
    [request => fixture.makeProof(request, undefined, { issuedAt: "2026-11-22T10:03:00.000Z" }), /pin_time_invalid/u],
    [request => fixture.makeProof(request, undefined, { issuedAt: "2026-11-22T10:05:00.000Z" }), /pin_time_invalid/u],
  ];
  for (const [respond, error] of cases) {
    fixture.setResponder(respond);
    await assert.rejects(fixture.client.confirmLingServerPairingPin(fixture.makeConfirmation()), error);
  }
  assert.deepEqual(fixture.writes, []);
});

test("a late verification cannot persist a pin after cancellation or removal of the paired binding", async () => {
  for (const invalidate of ["abort", "revoke", "replace_storage"] as const) {
    const fixture = createFixture();
    const requestArrived = deferred<LingServerPairingPinRequestV1>();
    const response = deferred<LingServerPairingPinProofV1>();
    const abort = new AbortController();
    fixture.setResponder(request => {
      requestArrived.resolve(request);
      return response.promise;
    });
    const confirmation = fixture.client.confirmLingServerPairingPin(fixture.makeConfirmation(), { signal: abort.signal });
    const request = await requestArrived.promise;
    if (invalidate === "abort") abort.abort(new Error("cancelled_fixture"));
    if (invalidate === "revoke") await fixture.client.unpair();
    if (invalidate === "replace_storage") fixture.saved = { ...fixture.options.binding, workspaceBindingId: "other-workspace" };
    response.resolve(fixture.makeProof(request));
    await assert.rejects(confirmation, invalidate === "abort" ? /cancelled_fixture/u : /pairing_binding_changed/u);
    assert.ok(fixture.writes.every(binding => binding.status === "revoked"));
    assert.equal(fixture.saved?.lingServerRoutingProfile, undefined);
    if (invalidate === "revoke") assert.equal(fixture.client.activeBinding, undefined);
  }
});

test("a competing confirmation cannot overwrite the server profile confirmed first", async () => {
  const fixture = createFixture();
  const first = fixture.makeConfirmation();
  const second = fixture.makeConfirmation({
    migrationId: "migration-b", confirmationDigest: "2".repeat(64),
    routingProfile: { ...first.routingProfile, bindingId: "link-b" },
  });
  const firstRequest = deferred<LingServerPairingPinRequestV1>();
  const releaseFirst = deferred<LingServerPairingPinProofV1>();
  fixture.setResponder(request => {
    if (request.challenge.migrationId === second.migrationId) return fixture.makeProof(request, second);
    firstRequest.resolve(request);
    return releaseFirst.promise;
  });
  const pending = fixture.client.confirmLingServerPairingPin(first);
  const request = await firstRequest.promise;
  const confirmed = await fixture.client.confirmLingServerPairingPin(second);
  releaseFirst.resolve(fixture.makeProof(request, first));
  await assert.rejects(pending, /pairing_profile_changed/u);
  assert.deepEqual(fixture.writes, [confirmed]);
  assert.deepEqual(confirmed.lingServerRoutingProfile, second.routingProfile);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
