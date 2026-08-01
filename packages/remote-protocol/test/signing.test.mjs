import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import test from "node:test";
import {
  REMOTE_SIGNING_DOMAINS_V1,
  authProofSigningBytes,
  pairingProofSigningBytes,
} from "../dist/index.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

test("V1 signing domains exclude the unprefixed public-key fingerprint", () => {
  assert.deepEqual(REMOTE_SIGNING_DOMAINS_V1, {
    pairingChallenge: "ling-remote-pair-challenge-v1",
    pairingProof: "ling-remote-pair-proof-v1",
    pairingAccepted: "ling-remote-pair-accepted-v1",
    authChallenge: "ling-remote-auth-challenge-v1",
    authProof: "ling-remote-auth-v1",
    command: "ling-remote-command-v1",
  });
});

function signP1363(bytes) {
  return sign("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" });
}

function verifyP1363(bytes, signature) {
  return verify("sha256", bytes, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
}

test("every auth-bound field mutation invalidates the ES256 proof", () => {
  const original = {
    gatewayOrigin: "https://ling-pc.example.ts.net",
    gatewayId: "gateway-1",
    challengeId: "challenge-1",
    candidateSessionId: "session-1",
    serverNonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    clientNonce: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    deviceId: "device-1",
    deviceEpoch: 7,
    protocolVersion: 1,
    resumeHash: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
  };
  const signature = signP1363(authProofSigningBytes(original));
  assert.equal(signature.length, 64);
  assert.equal(verifyP1363(authProofSigningBytes(original), signature), true);

  const mutations = {
    gatewayOrigin: "https://other.example.ts.net",
    gatewayId: "gateway-2",
    challengeId: "challenge-2",
    candidateSessionId: "session-2",
    serverNonce: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
    clientNonce: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ",
    deviceId: "device-2",
    deviceEpoch: 8,
    protocolVersion: 2,
    resumeHash: "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU",
  };
  for (const [field, value] of Object.entries(mutations)) {
    const mutated = { ...original, [field]: value };
    assert.equal(
      verifyP1363(authProofSigningBytes(mutated), signature),
      false,
      `${field} must be signature-bound`,
    );
  }
});

test("pairing HMAC and device signature bind the same canonical transcript", () => {
  const transcript = {
    gatewayOrigin: "https://ling-pc.example.ts.net",
    gatewayId: "gateway-1",
    pairingId: "pairing-1",
    serverNonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    clientNonce: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    deviceId: "device-1",
    displayName: "测试手机",
    platform: "ios",
    devicePublicKeyJwk: {
      kty: "EC",
      crv: "P-256",
      x: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
      y: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
    },
    devicePublicKeyFingerprint: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ",
    protocolVersion: 1,
  };
  const secret = Buffer.alloc(32, 7);
  const bytes = pairingProofSigningBytes(transcript);
  const hmac = createHmac("sha256", secret).update(bytes).digest();
  const signature = signP1363(bytes);

  const changedBytes = pairingProofSigningBytes({ ...transcript, displayName: "另一台手机" });
  const changedHmac = createHmac("sha256", secret).update(changedBytes).digest();
  assert.equal(createHash("sha256").update(hmac).digest("hex") === createHash("sha256").update(changedHmac).digest("hex"), false);
  assert.equal(verifyP1363(changedBytes, signature), false);
});
