import {
  REMOTE_PROTOCOL_VERSION,
  type RemotePairingAcceptedV1,
  type RemotePairingProofV1,
  type RemotePairingQrV1,
} from "@ling-stack/contracts";
import {
  decodeBase64Url,
  decodeRemotePairingQrV1,
  encodeBase64Url,
  fingerprintPublicJwkSync,
  hmacSha256,
  pairingAcceptedSigningBytes,
  pairingAcceptedSigningInput,
  pairingChallengeSigningBytes,
  pairingChallengeSigningInput,
  pairingProofSigningBytes,
  pairingProofSigningInput,
  validateRemotePairingAcceptedV1,
  validateRemotePairingChallengeV1,
} from "@ling-stack/remote-protocol";
import type {
  RemoteBindingStore,
  RemoteBindingV1,
  RemoteClock,
  RemoteDeviceKeyAdapter,
  RemoteEntropy,
  RemoteHttpClient,
} from "./types.js";

export interface RemotePendingPairing {
  readonly qr: RemotePairingQrV1;
  readonly proof: RemotePairingProofV1;
  readonly deviceKeyId: string;
}

export interface RemotePairingClientOptions {
  readonly http: RemoteHttpClient;
  readonly keys: RemoteDeviceKeyAdapter;
  readonly entropy: RemoteEntropy;
  readonly bindingStore: RemoteBindingStore;
  readonly clock: RemoteClock;
}

export class RemotePairingClient {
  constructor(private readonly options: RemotePairingClientOptions) {}

  async begin(encodedQr: string, input: {
    readonly displayName: string;
    readonly deviceId?: string;
  }): Promise<{ readonly pending: RemotePendingPairing; readonly binding?: RemoteBindingV1 }> {
    const nowMs = Date.parse(this.options.clock.now());
    const qr = decodeRemotePairingQrV1(encodedQr, { nowMs });
    await this.assertHealthPin(qr);
    const challengeResponse = await this.options.http.postJson<unknown>(qr.gatewayOrigin, "/v1/pairing/challenge", {
      pairingId: qr.pairingId,
    });
    const challenge = validateRemotePairingChallengeV1(challengeResponse.body, { nowMs: Date.parse(this.options.clock.now()) });
    if (challenge.gatewayId !== qr.gatewayId || challenge.pairingId !== qr.pairingId) {
      throw new Error("pairing_challenge_identity_mismatch");
    }
    const { gatewaySignature: _gatewaySignature, ...unsignedChallenge } = challenge;
    if (!await this.options.keys.verify(
      qr.gatewayIdentityPublicKeyJwk,
      pairingChallengeSigningBytes(pairingChallengeSigningInput(qr.gatewayOrigin, unsignedChallenge)),
      challenge.gatewaySignature,
    )) {
      throw new Error("pairing_gateway_signature_invalid");
    }

    const deviceId = input.deviceId ?? await this.options.entropy.randomId("iphone");
    const deviceKeyId = `ling.remote.device.${qr.gatewayId}`;
    const key = await this.options.keys.generateOrLoad(deviceKeyId);
    if (key.privateKeyExportable !== false) {
      throw new Error("remote_private_key_exportability_invariant_failed");
    }
    const unsignedProof = {
      version: REMOTE_PROTOCOL_VERSION,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      gatewayId: qr.gatewayId,
      pairingId: qr.pairingId,
      deviceId,
      displayName: input.displayName.trim(),
      platform: "ios" as const,
      devicePublicKeyJwk: key.publicJwk,
      devicePublicKeyFingerprint: fingerprintPublicJwkSync(key.publicJwk),
      serverNonce: challenge.serverNonce,
      clientNonce: encodeBase64Url(await this.options.entropy.randomBytes(32)),
    };
    const signingBytes = pairingProofSigningBytes(pairingProofSigningInput(qr.gatewayOrigin, unsignedProof));
    const proof: RemotePairingProofV1 = {
      ...unsignedProof,
      pairingHmac: encodeBase64Url(hmacSha256(decodeBase64Url(qr.pairingSecret), signingBytes)),
      deviceSignature: await this.options.keys.sign(deviceKeyId, signingBytes),
    };
    const pending = { qr, proof, deviceKeyId };
    const result = await this.submit(pending);
    return { pending, ...(result ? { binding: result } : {}) };
  }

  async submit(pending: RemotePendingPairing): Promise<RemoteBindingV1 | undefined> {
    const response = await this.options.http.postJson<unknown>(pending.qr.gatewayOrigin, "/v1/pairing/proof", pending.proof);
    const record = requireRecord(response.body);
    if (record.status === "confirmation_required") {
      return undefined;
    }
    if (record.status !== "accepted") {
      throw new Error("pairing_response_invalid");
    }
    const accepted = validateRemotePairingAcceptedV1(record.accepted);
    await this.assertAccepted(pending, accepted);
    const binding: RemoteBindingV1 = {
      version: 1,
      status: "active",
      gatewayId: pending.qr.gatewayId,
      gatewayOrigin: pending.qr.gatewayOrigin,
      gatewayIdentityPublicKeyJwk: pending.qr.gatewayIdentityPublicKeyJwk,
      gatewayIdentityFingerprint: pending.qr.gatewayIdentityFingerprint,
      deviceId: pending.proof.deviceId,
      deviceKeyId: pending.deviceKeyId,
      deviceEpoch: accepted.deviceEpoch,
      pairedAt: accepted.pairedAt,
    };
    await this.options.bindingStore.write(binding);
    return binding;
  }

  private async assertHealthPin(qr: RemotePairingQrV1): Promise<void> {
    const health = await this.options.http.getJson<unknown>(qr.gatewayOrigin, "/v1/health");
    const record = requireRecord(health.body);
    if (record.gatewayId !== qr.gatewayId || record.gatewayIdentityFingerprint !== qr.gatewayIdentityFingerprint) {
      throw new Error("gateway_identity_pin_mismatch");
    }
  }

  private async assertAccepted(pending: RemotePendingPairing, accepted: RemotePairingAcceptedV1): Promise<void> {
    if (
      accepted.gatewayId !== pending.qr.gatewayId
      || accepted.pairingId !== pending.qr.pairingId
      || accepted.deviceId !== pending.proof.deviceId
    ) {
      throw new Error("pairing_acceptance_identity_mismatch");
    }
    const { gatewaySignature: _gatewaySignature, ...unsignedAccepted } = accepted;
    const valid = await this.options.keys.verify(
      pending.qr.gatewayIdentityPublicKeyJwk,
      pairingAcceptedSigningBytes(pairingAcceptedSigningInput(pending.qr.gatewayOrigin, unsignedAccepted)),
      accepted.gatewaySignature,
    );
    if (!valid) {
      throw new Error("pairing_acceptance_signature_invalid");
    }
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("remote_response_invalid");
  }
  return value as Record<string, unknown>;
}
