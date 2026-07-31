import assert from "node:assert/strict";
import { createHash, createHmac, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  authChallengeSigningBytes,
  authProofSigningBytes,
  commandHashBytes,
  decodeBase64Url,
  encodeBase64Url,
  hashResumeCursors,
  pairingAcceptedSigningBytes,
  pairingChallengeSigningBytes,
  pairingProofSigningBytes,
} from "../dist/index.js";

const fixture = JSON.parse(await readFile(
  new URL("../fixtures/v1/canonical-signing.json", import.meta.url),
  "utf8",
));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const gatewayKey = createPublicKey({ key: fixture.gatewayIdentity.publicKeyJwk, format: "jwk" });
const deviceKey = createPublicKey({ key: fixture.deviceIdentity.publicKeyJwk, format: "jwk" });

function verifyFixture(fixturePart, signingBytes, key) {
  assert.equal(encodeBase64Url(signingBytes), fixturePart.signingBytesBase64Url);
  assert.equal(verify(
    "sha256",
    signingBytes,
    { key, dsaEncoding: "ieee-p1363" },
    decodeBase64Url(fixturePart.signatureBase64Url),
  ), true);
}

function assertEveryMutationFails({ fixturePart, signingBytesFor, key, mutations }) {
  const signature = decodeBase64Url(fixturePart.signatureBase64Url);
  for (const [field, value] of Object.entries(mutations)) {
    const bytes = signingBytesFor({ ...fixturePart.input, [field]: value });
    assert.equal(
      verify("sha256", bytes, { key, dsaEncoding: "ieee-p1363" }, signature),
      false,
      `${field} must be signature-bound`,
    );
  }
}

test("shared pairing and auth challenge fixtures match bytes and ES256 signatures", () => {
  verifyFixture(
    fixture.pairingChallenge,
    pairingChallengeSigningBytes(fixture.pairingChallenge.input),
    gatewayKey,
  );
  verifyFixture(
    fixture.pairingProof,
    pairingProofSigningBytes(fixture.pairingProof.input),
    deviceKey,
  );
  verifyFixture(
    fixture.pairingAccepted,
    pairingAcceptedSigningBytes(fixture.pairingAccepted.input),
    gatewayKey,
  );
  verifyFixture(
    fixture.authChallenge,
    authChallengeSigningBytes(fixture.authChallenge.input),
    gatewayKey,
  );
  verifyFixture(
    fixture.authProof,
    authProofSigningBytes(fixture.authProof.input),
    deviceKey,
  );
});

test("pairing proof HMAC uses the exact same canonical transcript", () => {
  const bytes = pairingProofSigningBytes(fixture.pairingProof.input);
  const hmac = createHmac(
    "sha256",
    decodeBase64Url(fixture.pairingProof.pairingSecretBase64Url),
  ).update(bytes).digest();
  assert.equal(encodeBase64Url(hmac), fixture.pairingProof.hmacBase64Url);
});

test("every pairing challenge field is signature-bound", () => {
  assertEveryMutationFails({
    fixturePart: fixture.pairingChallenge,
    signingBytesFor: pairingChallengeSigningBytes,
    key: gatewayKey,
    mutations: {
      gatewayOrigin: "https://other.example.ts.net",
      gatewayId: "gateway-other",
      pairingId: "pairing-other",
      serverNonce: fixture.pairingProof.input.clientNonce,
      issuedAt: "2026-07-19T10:00:01.000Z",
      expiresAt: "2026-07-19T10:04:59.000Z",
      protocolVersion: 2,
    },
  });
});

test("every pairing proof field is signature-bound", () => {
  assertEveryMutationFails({
    fixturePart: fixture.pairingProof,
    signingBytesFor: pairingProofSigningBytes,
    key: deviceKey,
    mutations: {
      gatewayOrigin: "https://other.example.ts.net",
      gatewayId: "gateway-other",
      pairingId: "pairing-other",
      serverNonce: fixture.authProof.input.clientNonce,
      clientNonce: fixture.authProof.input.serverNonce,
      deviceId: "device-other",
      displayName: "另一台手机",
      platform: "android",
      devicePublicKeyJwk: fixture.gatewayIdentity.publicKeyJwk,
      devicePublicKeyFingerprint: fixture.gatewayIdentity.fingerprint,
      protocolVersion: 2,
    },
  });
});

test("every pairing accepted and auth challenge field is signature-bound", () => {
  assertEveryMutationFails({
    fixturePart: fixture.pairingAccepted,
    signingBytesFor: pairingAcceptedSigningBytes,
    key: gatewayKey,
    mutations: {
      gatewayOrigin: "https://other.example.ts.net",
      gatewayId: "gateway-other",
      pairingId: "pairing-other",
      deviceId: "device-other",
      deviceEpoch: 8,
      protocolVersion: 2,
      pairedAt: "2026-07-19T10:00:11.000Z",
    },
  });
  assertEveryMutationFails({
    fixturePart: fixture.authChallenge,
    signingBytesFor: authChallengeSigningBytes,
    key: gatewayKey,
    mutations: {
      gatewayOrigin: "https://other.example.ts.net",
      gatewayId: "gateway-other",
      challengeId: "challenge-other",
      candidateSessionId: "session-other",
      serverNonce: fixture.authProof.input.clientNonce,
      deviceEpoch: 8,
      issuedAt: "2026-07-19T10:01:01.000Z",
      expiresAt: "2026-07-19T10:01:29.000Z",
      supportedProtocolVersions: [2],
    },
  });
});

test("resume and durable command hash fixtures are stable and semantic", async () => {
  assert.equal(
    await hashResumeCursors(fixture.resume.cursors, sha256),
    fixture.resume.hashBase64Url,
  );
  assert.equal(
    await hashResumeCursors([...fixture.resume.cursors].reverse(), sha256),
    fixture.resume.hashBase64Url,
  );
  assert.notEqual(
    await hashResumeCursors([
      { ...fixture.resume.cursors[0], lastAckServerSeq: fixture.resume.cursors[0].lastAckServerSeq + 1 },
      fixture.resume.cursors[1],
    ], sha256),
    fixture.resume.hashBase64Url,
  );
  await assert.rejects(
    () => hashResumeCursors([fixture.resume.cursors[0], fixture.resume.cursors[0]], sha256),
    /cannot repeat a stream/,
  );

  const commandBytes = commandHashBytes(fixture.command.input);
  assert.equal(encodeBase64Url(commandBytes), fixture.command.hashInputBytesBase64Url);
  assert.equal(encodeBase64Url(sha256(commandBytes)), fixture.command.hashBase64Url);
  for (const [field, value] of Object.entries({
    gatewayId: "gateway-other",
    deviceEpoch: 8,
    commandKind: "conversation.other",
    workspaceId: "workspace-other",
    conversationId: "conversation-other",
    body: "changed",
    issuedAt: "2026-07-19T10:00:01.000Z",
    retryUntil: "2026-07-19T10:59:59.000Z",
    remotePolicyVersion: 2,
  })) {
    assert.notEqual(
      encodeBase64Url(sha256(commandHashBytes({ ...fixture.command.input, [field]: value }))),
      fixture.command.hashBase64Url,
      `${field} must be command-hash-bound`,
    );
  }
});
