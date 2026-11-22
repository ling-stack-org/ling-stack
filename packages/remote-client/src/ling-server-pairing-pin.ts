import {
  REMOTE_PROTOCOL_LIMITS,
  type LingServerPairingPinChallengeV1,
  type LingServerPairingPinProofV1,
  type LingServerPairingPinRequestV1,
  type LingServerPeerBindingV1,
} from "@ling-stack/contracts";
import {
  canonicalizeJson,
  encodeBase64Url,
  lingServerPairingMigrationSigningBytes,
  lingServerPairingPinChallengeBytes,
  lingServerPairingPinProofBytes,
  matchesPublicJwkFingerprint,
  validateLingServerConfirmedPairingMigrationV1,
  validateLingServerPairingPinProofV1,
  validateRemoteP256PublicJwkV1,
} from "@ling-stack/remote-protocol";
import type { RemoteBindingV1, RemoteClock, RemoteDeviceKeyAdapter, RemoteEntropy, RemoteHttpClient } from "./types.js";

export interface LingServerPairingPinVerificationOptions {
  readonly confirmation: unknown;
  readonly binding: RemoteBindingV1;
  readonly http: RemoteHttpClient;
  readonly keys: Pick<RemoteDeviceKeyAdapter, "generateOrLoad" | "sign" | "verify">;
  readonly entropy: Pick<RemoteEntropy, "randomBytes">;
  readonly clock: RemoteClock;
  readonly signal?: AbortSignal;
}

export async function verifyLingServerPairingPin(options: LingServerPairingPinVerificationOptions): Promise<LingServerPairingPinProofV1> {
  const { binding, http, keys, entropy, clock, signal } = options;
  signal?.throwIfAborted();
  const { status: _status, gatewaySignature, ...confirmation } = validateLingServerConfirmedPairingMigrationV1(options.confirmation);
  const { migrationId, confirmationDigest, oldPairing, routingProfile } = confirmation;
  const gatewayPublicKey = validateRemoteP256PublicJwkV1(binding.gatewayIdentityPublicKeyJwk);
  if (binding.status !== "active" || binding.gatewayId !== oldPairing.gatewayId || binding.gatewayOrigin !== oldPairing.gatewayOrigin
    || binding.deviceId !== oldPairing.mobileDeviceId || binding.deviceEpoch !== oldPairing.deviceEpoch
    || binding.workspaceBindingId !== oldPairing.workspaceBindingId || binding.gatewayIdentityFingerprint !== oldPairing.gatewayKeyFingerprint
    || !matchesPublicJwkFingerprint(gatewayPublicKey, oldPairing.gatewayKeyFingerprint)) {
    throw new Error("ling_server_pairing_binding_mismatch");
  }
  const confirmed = await keys.verify(gatewayPublicKey, lingServerPairingMigrationSigningBytes(confirmation), gatewaySignature);
  signal?.throwIfAborted();
  if (!confirmed) throw new Error("ling_server_pairing_gateway_signature_invalid");

  const key = await keys.generateOrLoad(binding.deviceKeyId);
  signal?.throwIfAborted();
  const mobilePublicKeyJwk = validateRemoteP256PublicJwkV1(key.publicJwk);
  if (key.keyId !== binding.deviceKeyId || key.privateKeyExportable !== false
    || !matchesPublicJwkFingerprint(mobilePublicKeyJwk, oldPairing.mobileKeyFingerprint)) {
    throw new Error("ling_server_pairing_mobile_key_mismatch");
  }
  const nonce = await entropy.randomBytes(32);
  signal?.throwIfAborted();
  if (nonce.length !== 32) throw new Error("ling_server_pairing_invalid_nonce");
  const challenge: LingServerPairingPinChallengeV1 = { version: 1, migrationId, confirmationDigest, nonce: encodeBase64Url(nonce) };
  const mobileSignature = await keys.sign(binding.deviceKeyId, lingServerPairingPinChallengeBytes(challenge));
  signal?.throwIfAborted();
  const request: LingServerPairingPinRequestV1 = { challenge, mobilePublicKeyJwk, mobileSignature };
  const requestedAt = Date.parse(clock.now());
  if (!Number.isFinite(requestedAt)) throw new Error("ling_server_pairing_invalid_clock");
  const response = await http.postJson<unknown>(routingProfile.serverOrigin, "/v1/pairing-migrations/verify", request, { redirect: "error", signal });
  signal?.throwIfAborted();
  if (response.status !== 200) throw new Error("ling_server_pairing_pin_unavailable");

  const proof = validateLingServerPairingPinProofV1(response.body);
  const expectedBinding: LingServerPeerBindingV1 = {
    bindingId: routingProfile.bindingId,
    installationId: routingProfile.installationId,
    gatewayId: oldPairing.gatewayId,
    mobileDeviceId: oldPairing.mobileDeviceId,
    gatewayKeyFingerprint: oldPairing.gatewayKeyFingerprint,
    mobileKeyFingerprint: oldPairing.mobileKeyFingerprint,
    epoch: oldPairing.deviceEpoch,
    revision: 1,
    status: "active",
  };
  if (canonicalizeJson(proof.challenge) !== canonicalizeJson(challenge)
    || canonicalizeJson(proof.routingProfile) !== canonicalizeJson(routingProfile)
    || canonicalizeJson(proof.binding) !== canonicalizeJson(expectedBinding)) {
    throw new Error("ling_server_pairing_pin_scope_mismatch");
  }
  const { applicationSignature, ...unsignedProof } = proof;
  if (!matchesPublicJwkFingerprint(proof.applicationPublicKeyJwk, routingProfile.applicationKeyFingerprint)
    || !await keys.verify(proof.applicationPublicKeyJwk, lingServerPairingPinProofBytes(unsignedProof), applicationSignature)) {
    throw new Error("ling_server_pairing_pin_signature_invalid");
  }
  signal?.throwIfAborted();
  const issuedAt = Date.parse(proof.issuedAt);
  const skew = REMOTE_PROTOCOL_LIMITS.maxClockSkewMs;
  if (!(issuedAt >= Date.parse(confirmation.confirmedAt) && issuedAt >= requestedAt - skew
    && Math.abs(Date.parse(clock.now()) - issuedAt) <= skew)) {
    throw new Error("ling_server_pairing_pin_time_invalid");
  }
  return proof;
}
