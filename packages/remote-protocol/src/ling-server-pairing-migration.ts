import {
  LING_SERVER_PAIRING_MIGRATION_LIFETIME_MS_V1,
  LING_SERVER_PAIRING_MIGRATION_MAX_RECEIPTS_V1,
  REMOTE_PROTOCOL_VERSION,
  type LingServerConfirmedPairingMigrationV1,
  type LingServerPairingIdentityV1,
  type LingServerPairingMigrationPublicationRequestV1,
  type LingServerPairingPinChallengeV1,
  type LingServerPairingPinProofV1,
  type LingServerPairingPinRequestV1,
  type LingServerPeerBindingV1,
  type LingServerRoutingProfileV1,
} from "@ling-stack/contracts";
import { domainSeparatedCanonicalBytes } from "./canonical.js";
import { RemoteProtocolError } from "./errors.js";
import {
  assertStrictKeys, expectArray, expectEs256Signature, expectHttpsOrigin, expectIdentifier, expectLiteral,
  expectNonce, expectRecord, expectRfc3339, expectSafeInteger, expectSha256, expectString, validateP256PublicJwk,
} from "./validation/primitives.js";

export function lingServerPairingMigrationSigningBytes(
  input: Omit<LingServerConfirmedPairingMigrationV1, "status" | "gatewaySignature">,
): Uint8Array {
  return domainSeparatedCanonicalBytes("ling.server.pairing_migration.v1", input);
}

export function lingServerPairingPinChallengeBytes(challenge: LingServerPairingPinChallengeV1): Uint8Array {
  return domainSeparatedCanonicalBytes("ling.server.pairing_pin_challenge.v1", challenge);
}

export function lingServerPairingPinProofBytes(proof: Omit<LingServerPairingPinProofV1, "applicationSignature">): Uint8Array {
  return domainSeparatedCanonicalBytes("ling.server.pairing_pin_proof.v1", proof);
}

export function validateLingServerPairingPinRequestV1(value: unknown): LingServerPairingPinRequestV1 {
  const path = "$pairingPinRequest";
  const request = expectRecord(value, path);
  assertStrictKeys(request, ["challenge", "mobilePublicKeyJwk", "mobileSignature"], [], path);
  return {
    challenge: readPinChallenge(request.challenge, `${path}.challenge`),
    mobilePublicKeyJwk: validateP256PublicJwk(request.mobilePublicKeyJwk, `${path}.mobilePublicKeyJwk`),
    mobileSignature: expectEs256Signature(request.mobileSignature, `${path}.mobileSignature`),
  };
}

export function validateLingServerPairingPinProofV1(value: unknown): LingServerPairingPinProofV1 {
  const path = "$pairingPinProof";
  const proof = expectRecord(value, path);
  assertStrictKeys(proof, ["challenge", "routingProfile", "binding", "issuedAt", "applicationPublicKeyJwk", "applicationSignature"], [], path);
  return {
    challenge: readPinChallenge(proof.challenge, `${path}.challenge`),
    routingProfile: readRoutingProfile(proof.routingProfile, `${path}.routingProfile`),
    binding: readActivePeerBinding(proof.binding, `${path}.binding`),
    issuedAt: expectRfc3339(proof.issuedAt, `${path}.issuedAt`),
    applicationPublicKeyJwk: validateP256PublicJwk(proof.applicationPublicKeyJwk, `${path}.applicationPublicKeyJwk`),
    applicationSignature: expectEs256Signature(proof.applicationSignature, `${path}.applicationSignature`),
  };
}

export function validateLingServerPairingMigrationPublicationRequestV1(value: unknown): LingServerPairingMigrationPublicationRequestV1 {
  const path = "$pairingPublication";
  const publication = expectRecord(value, path);
  assertStrictKeys(publication, ["confirmation", "gatewayPublicKeyJwk"], [], path);
  return {
    confirmation: validateLingServerConfirmedPairingMigrationV1(publication.confirmation),
    gatewayPublicKeyJwk: validateP256PublicJwk(publication.gatewayPublicKeyJwk, `${path}.gatewayPublicKeyJwk`),
  };
}

export function validateLingServerConfirmedPairingMigrationV1(value: unknown): LingServerConfirmedPairingMigrationV1 {
  const path = "$pairingConfirmation";
  const confirmation = expectRecord(value, path);
  assertStrictKeys(confirmation, [
    "schemaVersion", "migrationId", "oldPairing", "routingProfile", "retainedReceipts", "confirmationDigest",
    "createdAt", "expiresAt", "status", "confirmedAt", "gatewaySignature",
  ], [], path);
  const createdAt = expectRfc3339(confirmation.createdAt, `${path}.createdAt`);
  const expiresAt = expectRfc3339(confirmation.expiresAt, `${path}.expiresAt`);
  const confirmedAt = expectRfc3339(confirmation.confirmedAt, `${path}.confirmedAt`);
  if (createdAt > confirmedAt || confirmedAt >= expiresAt
    || Date.parse(expiresAt) - Date.parse(createdAt) > LING_SERVER_PAIRING_MIGRATION_LIFETIME_MS_V1) {
    throw new RemoteProtocolError("invalid_time", "Pairing confirmation is outside its approval window", path);
  }
  const retainedReceipts = expectArray(confirmation.retainedReceipts, `${path}.retainedReceipts`, (value, entryPath) => {
    const entry = expectRecord(value, entryPath);
    assertStrictKeys(entry, ["commandId", "payloadDigest"], [], entryPath);
    return {
      commandId: expectIdentifier(entry.commandId, `${entryPath}.commandId`),
      payloadDigest: expectSha256(entry.payloadDigest, `${entryPath}.payloadDigest`),
    };
  }, { maxItems: LING_SERVER_PAIRING_MIGRATION_MAX_RECEIPTS_V1 });
  if (new Set(retainedReceipts.map(receipt => receipt.commandId)).size !== retainedReceipts.length) {
    throw new RemoteProtocolError("invalid_field", "Retained command ids must be unique", `${path}.retainedReceipts`);
  }
  return {
    schemaVersion: expectLiteral(confirmation.schemaVersion, 1, `${path}.schemaVersion`),
    migrationId: expectIdentifier(confirmation.migrationId, `${path}.migrationId`),
    oldPairing: readPairingIdentity(confirmation.oldPairing, `${path}.oldPairing`),
    routingProfile: readRoutingProfile(confirmation.routingProfile, `${path}.routingProfile`),
    retainedReceipts,
    confirmationDigest: readConfirmationDigest(confirmation.confirmationDigest, `${path}.confirmationDigest`),
    createdAt,
    expiresAt,
    status: expectLiteral(confirmation.status, "confirmed", `${path}.status`),
    confirmedAt,
    gatewaySignature: expectEs256Signature(confirmation.gatewaySignature, `${path}.gatewaySignature`),
  };
}

function readPinChallenge(value: unknown, path: string): LingServerPairingPinChallengeV1 {
  const challenge = expectRecord(value, path);
  assertStrictKeys(challenge, ["version", "migrationId", "confirmationDigest", "nonce"], [], path);
  return {
    version: expectLiteral(challenge.version, 1, `${path}.version`),
    migrationId: expectIdentifier(challenge.migrationId, `${path}.migrationId`),
    confirmationDigest: readConfirmationDigest(challenge.confirmationDigest, `${path}.confirmationDigest`),
    nonce: expectNonce(challenge.nonce, `${path}.nonce`),
  };
}

function readConfirmationDigest(value: unknown, path: string): string {
  const digest = expectString(value, path, { minBytes: 64, maxBytes: 64 });
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new RemoteProtocolError("invalid_field", "Expected a hexadecimal confirmation digest", path);
  }
  return digest;
}

function readActivePeerBinding(value: unknown, path: string): LingServerPeerBindingV1 {
  const binding = expectRecord(value, path);
  assertStrictKeys(binding, [
    "bindingId", "installationId", "gatewayId", "mobileDeviceId", "gatewayKeyFingerprint", "mobileKeyFingerprint", "epoch", "revision", "status",
  ], [], path);
  return {
    bindingId: expectIdentifier(binding.bindingId, `${path}.bindingId`),
    installationId: expectIdentifier(binding.installationId, `${path}.installationId`),
    gatewayId: expectIdentifier(binding.gatewayId, `${path}.gatewayId`),
    mobileDeviceId: expectIdentifier(binding.mobileDeviceId, `${path}.mobileDeviceId`),
    gatewayKeyFingerprint: expectSha256(binding.gatewayKeyFingerprint, `${path}.gatewayKeyFingerprint`),
    mobileKeyFingerprint: expectSha256(binding.mobileKeyFingerprint, `${path}.mobileKeyFingerprint`),
    epoch: expectSafeInteger(binding.epoch, `${path}.epoch`, { minimum: 1 }),
    revision: expectSafeInteger(binding.revision, `${path}.revision`, { minimum: 1 }),
    status: expectLiteral(binding.status, "active", `${path}.status`),
  };
}

function readPairingIdentity(value: unknown, path: string): LingServerPairingIdentityV1 {
  const pairing = expectRecord(value, path);
  assertStrictKeys(pairing, [
    "gatewayId", "gatewayOrigin", "mobileDeviceId", "gatewayKeyFingerprint", "mobileKeyFingerprint", "deviceEpoch", "workspaceBindingId",
  ], [], path);
  const gatewayKeyFingerprint = expectSha256(pairing.gatewayKeyFingerprint, `${path}.gatewayKeyFingerprint`);
  const mobileKeyFingerprint = expectSha256(pairing.mobileKeyFingerprint, `${path}.mobileKeyFingerprint`);
  if (gatewayKeyFingerprint === mobileKeyFingerprint) {
    throw new RemoteProtocolError("invalid_field", "Gateway and Mobile keys must differ", path);
  }
  return {
    gatewayId: expectIdentifier(pairing.gatewayId, `${path}.gatewayId`),
    gatewayOrigin: expectHttpsOrigin(pairing.gatewayOrigin, `${path}.gatewayOrigin`),
    mobileDeviceId: expectIdentifier(pairing.mobileDeviceId, `${path}.mobileDeviceId`),
    gatewayKeyFingerprint,
    mobileKeyFingerprint,
    deviceEpoch: expectSafeInteger(pairing.deviceEpoch, `${path}.deviceEpoch`, { minimum: 1 }),
    workspaceBindingId: expectIdentifier(pairing.workspaceBindingId, `${path}.workspaceBindingId`),
  };
}

function readRoutingProfile(value: unknown, path: string): LingServerRoutingProfileV1 {
  const profile = expectRecord(value, path);
  assertStrictKeys(profile, [
    "schemaVersion", "bindingId", "installationId", "installationRevision", "serverOrigin", "applicationKeyFingerprint",
    "signalingProtocolMajor", "gatewayProtocolMajor",
  ], [], path);
  return {
    schemaVersion: expectLiteral(profile.schemaVersion, 1, `${path}.schemaVersion`),
    bindingId: expectIdentifier(profile.bindingId, `${path}.bindingId`),
    installationId: expectIdentifier(profile.installationId, `${path}.installationId`),
    installationRevision: expectSafeInteger(profile.installationRevision, `${path}.installationRevision`, { minimum: 1 }),
    serverOrigin: expectHttpsOrigin(profile.serverOrigin, `${path}.serverOrigin`),
    applicationKeyFingerprint: expectSha256(profile.applicationKeyFingerprint, `${path}.applicationKeyFingerprint`),
    signalingProtocolMajor: expectLiteral(profile.signalingProtocolMajor, 1, `${path}.signalingProtocolMajor`),
    gatewayProtocolMajor: expectLiteral(profile.gatewayProtocolMajor, REMOTE_PROTOCOL_VERSION, `${path}.gatewayProtocolMajor`),
  };
}
