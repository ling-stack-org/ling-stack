import fixture from "@ling-stack/remote-protocol/fixtures/v1/canonical-signing.json";
import {
  authChallengeSigningBytes,
  authProofSigningBytes,
  canonicalizeJson,
  decodeBase64Url,
  encodeBase64Url,
  equalBytes,
  hmacSha256,
  matchesPublicJwkFingerprint,
  pairingAcceptedSigningBytes,
  pairingChallengeSigningBytes,
  pairingProofSigningBytes,
  validateRemoteP256PublicJwkV1,
} from "@ling-stack/remote-protocol";
import type { RemoteP256PublicJwkV1 } from "@ling-stack/contracts";

import { nativeSecureDeviceKeyAdapter } from "./native-adapter";

const FIXTURE_KEY_ID = "ling.remote.secure-key-fixture.v1";

export interface SecureDeviceKeyFixtureResult {
  readonly backend: string;
  readonly securityLevel: string;
  readonly hardwareBacked: boolean;
  readonly privateKeyExportable: false;
  readonly canonicalFixtureMatched: true;
  readonly allSigningFixturesVerified: true;
  readonly pairingHmacVerified: true;
  readonly gatewayFingerprintVerified: true;
  readonly changedGatewayFingerprintRejected: true;
  readonly fixedGatewaySignatureVerified: true;
  readonly fixedDeviceSignatureVerified: true;
  readonly signatureVerified: true;
  readonly mutatedMessageRejected: true;
  readonly reloadPublicKeyStable: true;
  readonly deleteInvalidatedKey: true;
  readonly regenerationRotatedPublicKey: true;
  /** Copy these three fields to the Node verifier to close native-sign -> Node-verify. */
  readonly nodeInteropEvidence: {
    readonly publicJwk: RemoteP256PublicJwkV1;
    readonly messageBase64Url: string;
    readonly signatureBase64Url: string;
  };
}

export async function runSecureDeviceKeyFixture(): Promise<SecureDeviceKeyFixtureResult> {
  const gatewayPublicJwk = validateRemoteP256PublicJwkV1(fixture.gatewayIdentity.publicKeyJwk);
  const fixedDevicePublicJwk = validateRemoteP256PublicJwkV1(fixture.deviceIdentity.publicKeyJwk);
  if (!matchesPublicJwkFingerprint(gatewayPublicJwk, fixture.gatewayIdentity.fingerprint)) {
    throw new Error("gateway_fingerprint_mismatch");
  }
  if (matchesPublicJwkFingerprint(gatewayPublicJwk, fixture.deviceIdentity.fingerprint)) {
    throw new Error("changed_gateway_fingerprint_accepted");
  }

  const signingFixtures = [
    {
      name: "pairing_challenge",
      bytes: pairingChallengeSigningBytes({ ...fixture.pairingChallenge.input, protocolVersion: 1 }),
      expectedBytes: fixture.pairingChallenge.signingBytesBase64Url,
      signature: fixture.pairingChallenge.signatureBase64Url,
      publicJwk: gatewayPublicJwk,
    },
    {
      name: "pairing_proof",
      bytes: pairingProofSigningBytes({
        ...fixture.pairingProof.input,
        protocolVersion: 1,
        platform: "ios",
        devicePublicKeyJwk: fixedDevicePublicJwk,
      }),
      expectedBytes: fixture.pairingProof.signingBytesBase64Url,
      signature: fixture.pairingProof.signatureBase64Url,
      publicJwk: fixedDevicePublicJwk,
    },
    {
      name: "pairing_accepted",
      bytes: pairingAcceptedSigningBytes({ ...fixture.pairingAccepted.input, protocolVersion: 1 }),
      expectedBytes: fixture.pairingAccepted.signingBytesBase64Url,
      signature: fixture.pairingAccepted.signatureBase64Url,
      publicJwk: gatewayPublicJwk,
    },
    {
      name: "auth_challenge",
      bytes: authChallengeSigningBytes({
        ...fixture.authChallenge.input,
        supportedProtocolVersions: [1],
      }),
      expectedBytes: fixture.authChallenge.signingBytesBase64Url,
      signature: fixture.authChallenge.signatureBase64Url,
      publicJwk: gatewayPublicJwk,
    },
    {
      name: "auth_proof",
      bytes: authProofSigningBytes({ ...fixture.authProof.input, protocolVersion: 1 }),
      expectedBytes: fixture.authProof.signingBytesBase64Url,
      signature: fixture.authProof.signatureBase64Url,
      publicJwk: fixedDevicePublicJwk,
    },
  ] as const;

  for (const signingFixture of signingFixtures) {
    if (encodeBase64Url(signingFixture.bytes) !== signingFixture.expectedBytes) {
      throw new Error(`${signingFixture.name}_canonical_fixture_mismatch`);
    }
    if (!await nativeSecureDeviceKeyAdapter.verify(
      signingFixture.publicJwk,
      signingFixture.bytes,
      signingFixture.signature,
    )) {
      throw new Error(`${signingFixture.name}_fixed_signature_verification_failed`);
    }
  }

  const pairingProofBytes = signingFixtures[1].bytes;
  const pairingHmac = hmacSha256(
    decodeBase64Url(fixture.pairingProof.pairingSecretBase64Url),
    pairingProofBytes,
  );
  if (!equalBytes(pairingHmac, decodeBase64Url(fixture.pairingProof.hmacBase64Url))) {
    throw new Error("pairing_proof_hmac_fixture_mismatch");
  }

  const canonicalBytes = signingFixtures[4].bytes;

  await nativeSecureDeviceKeyAdapter.delete(FIXTURE_KEY_ID);
  try {
    const initial = await nativeSecureDeviceKeyAdapter.generateOrLoad(FIXTURE_KEY_ID);
    const reloaded = await nativeSecureDeviceKeyAdapter.generateOrLoad(FIXTURE_KEY_ID);
    if (canonicalizeJson(initial.publicJwk) !== canonicalizeJson(reloaded.publicJwk)) {
      throw new Error("secure_key_reload_changed_public_key");
    }

    const signature = await nativeSecureDeviceKeyAdapter.sign(FIXTURE_KEY_ID, canonicalBytes);
    if (!await nativeSecureDeviceKeyAdapter.verify(initial.publicJwk, canonicalBytes, signature)) {
      throw new Error("native_signature_verification_failed");
    }

    const mutated = canonicalBytes.slice();
    mutated[mutated.length - 1] ^= 1;
    if (await nativeSecureDeviceKeyAdapter.verify(initial.publicJwk, mutated, signature)) {
      throw new Error("mutated_message_signature_accepted");
    }

    await nativeSecureDeviceKeyAdapter.delete(FIXTURE_KEY_ID);
    let deletedKeyRejected = false;
    try {
      await nativeSecureDeviceKeyAdapter.sign(FIXTURE_KEY_ID, canonicalBytes);
    } catch {
      deletedKeyRejected = true;
    }
    if (!deletedKeyRejected) {
      throw new Error("deleted_secure_key_still_signed");
    }

    const regenerated = await nativeSecureDeviceKeyAdapter.generateOrLoad(FIXTURE_KEY_ID);
    if (canonicalizeJson(initial.publicJwk) === canonicalizeJson(regenerated.publicJwk)) {
      throw new Error("secure_key_regeneration_did_not_rotate_identity");
    }
    const regeneratedSignature = await nativeSecureDeviceKeyAdapter.sign(FIXTURE_KEY_ID, canonicalBytes);

    return {
      backend: regenerated.backend,
      securityLevel: regenerated.securityLevel,
      hardwareBacked: regenerated.hardwareBacked,
      privateKeyExportable: regenerated.privateKeyExportable,
      canonicalFixtureMatched: true,
      allSigningFixturesVerified: true,
      pairingHmacVerified: true,
      gatewayFingerprintVerified: true,
      changedGatewayFingerprintRejected: true,
      fixedGatewaySignatureVerified: true,
      fixedDeviceSignatureVerified: true,
      signatureVerified: true,
      mutatedMessageRejected: true,
      reloadPublicKeyStable: true,
      deleteInvalidatedKey: true,
      regenerationRotatedPublicKey: true,
      nodeInteropEvidence: {
        publicJwk: regenerated.publicJwk,
        messageBase64Url: encodeBase64Url(canonicalBytes),
        signatureBase64Url: regeneratedSignature,
      },
    };
  } finally {
    await nativeSecureDeviceKeyAdapter.delete(FIXTURE_KEY_ID);
  }
}
