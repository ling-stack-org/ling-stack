import {
  REMOTE_PROTOCOL_LIMITS,
  type RemoteAuthChallengeV1,
  type RemoteAuthProofV1,
  type RemotePairingAcceptedV1,
  type RemotePairingChallengeV1,
  type RemotePairingProofV1,
  type RemotePairingQrV1,
  type RemoteP256PublicJwkV1,
} from "@ling-stack/contracts";

import { decodeBase64Url, equalBytes } from "../canonical.js";
import { assertUniqueResumeStreamIds, fingerprintPublicJwkSync } from "../envelopes.js";
import { RemoteProtocolError } from "../errors.js";
import { parseJsonInput } from "./json-input.js";
import {
  assertStrictKeys,
  expectArray,
  expectBase64UrlBytes,
  expectEnum,
  expectEs256Signature,
  expectHttpsOrigin,
  expectIdentifier,
  expectLiteral,
  expectNonce,
  expectRecord,
  expectRfc3339,
  expectSafeInteger,
  expectSha256,
  expectString,
  validateP256PublicJwk,
  validateResumeCursor,
} from "./primitives.js";
import { assertExpiryWindow, validationNow, type RemoteValidationClockOptions } from "./time.js";

export function validateRemoteP256PublicJwkV1(value: unknown): RemoteP256PublicJwkV1 {
  return validateP256PublicJwk(value, "$jwk");
}

function assertPublicKeyFingerprint(
  jwk: RemoteP256PublicJwkV1,
  declaredFingerprint: string,
  path: string,
): void {
  const expectedFingerprint = fingerprintPublicJwkSync(jwk);
  if (!equalBytes(decodeBase64Url(declaredFingerprint), decodeBase64Url(expectedFingerprint))) {
    throw new RemoteProtocolError("invalid_field", "Public-key fingerprint does not match the JWK", path);
  }
}

export function validateRemotePairingQrV1(
  value: unknown,
  options: RemoteValidationClockOptions = {},
): RemotePairingQrV1 {
  const path = "$pairingQr";
  const record = expectRecord(value, path);
  assertStrictKeys(record, [
    "kind",
    "version",
    "gatewayId",
    "gatewayOrigin",
    "gatewayIdentityPublicKeyJwk",
    "gatewayIdentityFingerprint",
    "pairingId",
    "pairingSecret",
    "expiresAt",
  ], [], path);
  const expiresAt = expectRfc3339(record.expiresAt, `${path}.expiresAt`);
  const now = validationNow(options);
  const skew = options.maxClockSkewMs ?? REMOTE_PROTOCOL_LIMITS.maxClockSkewMs;
  const expiresAtMs = Date.parse(expiresAt);
  if (expiresAtMs < now - skew) {
    throw new RemoteProtocolError("command_expired", "Pairing QR has expired", `${path}.expiresAt`);
  }
  if (expiresAtMs > now + REMOTE_PROTOCOL_LIMITS.maxPairingLifetimeMs + skew) {
    throw new RemoteProtocolError("invalid_time", "Pairing QR expiry exceeds the protocol limit", `${path}.expiresAt`);
  }
  const gatewayIdentityPublicKeyJwk = validateP256PublicJwk(
    record.gatewayIdentityPublicKeyJwk,
    `${path}.gatewayIdentityPublicKeyJwk`,
  );
  const gatewayIdentityFingerprint = expectSha256(
    record.gatewayIdentityFingerprint,
    `${path}.gatewayIdentityFingerprint`,
  );
  assertPublicKeyFingerprint(
    gatewayIdentityPublicKeyJwk,
    gatewayIdentityFingerprint,
    `${path}.gatewayIdentityFingerprint`,
  );
  return {
    kind: expectLiteral(record.kind, "ling_remote_pairing", `${path}.kind`),
    version: expectLiteral(record.version, 1, `${path}.version`),
    gatewayId: expectIdentifier(record.gatewayId, `${path}.gatewayId`),
    gatewayOrigin: expectHttpsOrigin(record.gatewayOrigin, `${path}.gatewayOrigin`),
    gatewayIdentityPublicKeyJwk,
    gatewayIdentityFingerprint,
    pairingId: expectIdentifier(record.pairingId, `${path}.pairingId`),
    pairingSecret: expectNonce(record.pairingSecret, `${path}.pairingSecret`),
    expiresAt,
  };
}

export function decodeRemotePairingQrV1(
  encoded: string,
  options: RemoteValidationClockOptions = {},
): RemotePairingQrV1 {
  const prefix = "ling-pair-v1:";
  if (!encoded.startsWith(prefix)) {
    throw new RemoteProtocolError("protocol_incompatible", "Pairing QR prefix is not supported");
  }
  const bytes = decodeBase64Url(encoded.slice(prefix.length));
  return validateRemotePairingQrV1(parseJsonInput(bytes, REMOTE_PROTOCOL_LIMITS.maxFrameBytes), options);
}

export function validateRemotePairingChallengeV1(
  value: unknown,
  options: RemoteValidationClockOptions = {},
): RemotePairingChallengeV1 {
  const path = "$pairingChallenge";
  const record = expectRecord(value, path);
  assertStrictKeys(record, [
    "version",
    "gatewayId",
    "pairingId",
    "serverNonce",
    "issuedAt",
    "expiresAt",
    "gatewaySignature",
  ], [], path);
  const issuedAt = expectRfc3339(record.issuedAt, `${path}.issuedAt`);
  const expiresAt = expectRfc3339(record.expiresAt, `${path}.expiresAt`);
  assertExpiryWindow(issuedAt, expiresAt, REMOTE_PROTOCOL_LIMITS.maxPairingLifetimeMs, options, path);
  return {
    version: expectLiteral(record.version, 1, `${path}.version`),
    gatewayId: expectIdentifier(record.gatewayId, `${path}.gatewayId`),
    pairingId: expectIdentifier(record.pairingId, `${path}.pairingId`),
    serverNonce: expectNonce(record.serverNonce, `${path}.serverNonce`),
    issuedAt,
    expiresAt,
    gatewaySignature: expectEs256Signature(record.gatewaySignature, `${path}.gatewaySignature`),
  };
}

export function validateRemotePairingProofV1(value: unknown): RemotePairingProofV1 {
  const path = "$pairingProof";
  const record = expectRecord(value, path);
  assertStrictKeys(record, [
    "version",
    "protocolVersion",
    "gatewayId",
    "pairingId",
    "deviceId",
    "displayName",
    "platform",
    "devicePublicKeyJwk",
    "devicePublicKeyFingerprint",
    "serverNonce",
    "clientNonce",
    "pairingHmac",
    "deviceSignature",
  ], [], path);
  const devicePublicKeyJwk = validateP256PublicJwk(record.devicePublicKeyJwk, `${path}.devicePublicKeyJwk`);
  const devicePublicKeyFingerprint = expectSha256(
    record.devicePublicKeyFingerprint,
    `${path}.devicePublicKeyFingerprint`,
  );
  assertPublicKeyFingerprint(
    devicePublicKeyJwk,
    devicePublicKeyFingerprint,
    `${path}.devicePublicKeyFingerprint`,
  );
  return {
    version: expectLiteral(record.version, 1, `${path}.version`),
    protocolVersion: expectLiteral(record.protocolVersion, 1, `${path}.protocolVersion`),
    gatewayId: expectIdentifier(record.gatewayId, `${path}.gatewayId`),
    pairingId: expectIdentifier(record.pairingId, `${path}.pairingId`),
    deviceId: expectIdentifier(record.deviceId, `${path}.deviceId`),
    displayName: expectString(record.displayName, `${path}.displayName`, {
      minBytes: 1,
      maxBytes: REMOTE_PROTOCOL_LIMITS.maxDisplayNameBytes,
    }),
    platform: expectEnum(record.platform, ["ios", "android"] as const, `${path}.platform`),
    devicePublicKeyJwk,
    devicePublicKeyFingerprint,
    serverNonce: expectNonce(record.serverNonce, `${path}.serverNonce`),
    clientNonce: expectNonce(record.clientNonce, `${path}.clientNonce`),
    pairingHmac: expectBase64UrlBytes(record.pairingHmac, 32, `${path}.pairingHmac`),
    deviceSignature: expectEs256Signature(record.deviceSignature, `${path}.deviceSignature`),
  };
}

export function validateRemotePairingAcceptedV1(value: unknown): RemotePairingAcceptedV1 {
  const path = "$pairingAccepted";
  const record = expectRecord(value, path);
  assertStrictKeys(record, [
    "version",
    "gatewayId",
    "pairingId",
    "deviceId",
    "deviceEpoch",
    "protocolVersion",
    "pairedAt",
    "gatewaySignature",
  ], [], path);
  return {
    version: expectLiteral(record.version, 1, `${path}.version`),
    gatewayId: expectIdentifier(record.gatewayId, `${path}.gatewayId`),
    pairingId: expectIdentifier(record.pairingId, `${path}.pairingId`),
    deviceId: expectIdentifier(record.deviceId, `${path}.deviceId`),
    deviceEpoch: expectSafeInteger(record.deviceEpoch, `${path}.deviceEpoch`, { minimum: 1 }),
    protocolVersion: expectLiteral(record.protocolVersion, 1, `${path}.protocolVersion`),
    pairedAt: expectRfc3339(record.pairedAt, `${path}.pairedAt`),
    gatewaySignature: expectEs256Signature(record.gatewaySignature, `${path}.gatewaySignature`),
  };
}

export function validateRemoteAuthChallengeV1(
  value: unknown,
  options: RemoteValidationClockOptions = {},
): RemoteAuthChallengeV1 {
  const path = "$authChallenge";
  const record = expectRecord(value, path);
  assertStrictKeys(record, [
    "version",
    "gatewayId",
    "challengeId",
    "serverNonce",
    "candidateSessionId",
    "deviceEpoch",
    "issuedAt",
    "expiresAt",
    "supportedProtocolVersions",
    "gatewaySignature",
  ], [], path);
  const issuedAt = expectRfc3339(record.issuedAt, `${path}.issuedAt`);
  const expiresAt = expectRfc3339(record.expiresAt, `${path}.expiresAt`);
  assertExpiryWindow(issuedAt, expiresAt, 30_000, options, path);
  const supported = expectArray(
    record.supportedProtocolVersions,
    `${path}.supportedProtocolVersions`,
    (item, itemPath) => expectLiteral(item, 1, itemPath),
    { minItems: 1, maxItems: 1 },
  );
  return {
    version: expectLiteral(record.version, 1, `${path}.version`),
    gatewayId: expectIdentifier(record.gatewayId, `${path}.gatewayId`),
    challengeId: expectIdentifier(record.challengeId, `${path}.challengeId`),
    serverNonce: expectNonce(record.serverNonce, `${path}.serverNonce`),
    candidateSessionId: expectIdentifier(record.candidateSessionId, `${path}.candidateSessionId`),
    deviceEpoch: expectSafeInteger(record.deviceEpoch, `${path}.deviceEpoch`, { minimum: 1 }),
    issuedAt,
    expiresAt,
    supportedProtocolVersions: supported as unknown as readonly [1],
    gatewaySignature: expectEs256Signature(record.gatewaySignature, `${path}.gatewaySignature`),
  };
}

export function validateRemoteAuthProofV1(value: unknown): RemoteAuthProofV1 {
  const path = "$authProof";
  const record = expectRecord(value, path);
  assertStrictKeys(record, [
    "version",
    "gatewayId",
    "challengeId",
    "candidateSessionId",
    "deviceId",
    "deviceEpoch",
    "clientNonce",
    "protocolVersion",
    "resume",
    "signature",
  ], [], path);
  const resume = expectArray(record.resume, `${path}.resume`, validateResumeCursor, {
    maxItems: REMOTE_PROTOCOL_LIMITS.maxResumeCursors,
  });
  assertUniqueResumeStreamIds(resume, `${path}.resume`);
  return {
    version: expectLiteral(record.version, 1, `${path}.version`),
    gatewayId: expectIdentifier(record.gatewayId, `${path}.gatewayId`),
    challengeId: expectIdentifier(record.challengeId, `${path}.challengeId`),
    candidateSessionId: expectIdentifier(record.candidateSessionId, `${path}.candidateSessionId`),
    deviceId: expectIdentifier(record.deviceId, `${path}.deviceId`),
    deviceEpoch: expectSafeInteger(record.deviceEpoch, `${path}.deviceEpoch`, { minimum: 1 }),
    clientNonce: expectNonce(record.clientNonce, `${path}.clientNonce`),
    protocolVersion: expectLiteral(record.protocolVersion, 1, `${path}.protocolVersion`),
    resume,
    signature: expectEs256Signature(record.signature, `${path}.signature`),
  };
}
