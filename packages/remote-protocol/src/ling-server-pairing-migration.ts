import {
  LING_SERVER_PAIRING_MIGRATION_LIFETIME_MS_V1,
  LING_SERVER_PAIRING_MIGRATION_MAX_RECEIPTS_V1,
  REMOTE_PROTOCOL_VERSION,
  type LingServerConfirmedPairingMigrationV1,
  type LingServerPairingIdentityV1,
  type LingServerPairingMigrationPublicationRequestV1,
  type LingServerRoutingProfileV1,
} from "@ling-stack/contracts";
import { domainSeparatedCanonicalBytes } from "./canonical.js";
import { RemoteProtocolError } from "./errors.js";
import {
  assertStrictKeys, expectArray, expectEs256Signature, expectHttpsOrigin, expectIdentifier, expectLiteral,
  expectRecord, expectRfc3339, expectSafeInteger, expectSha256, expectString, validateP256PublicJwk,
} from "./validation/primitives.js";

export function lingServerPairingMigrationSigningBytes(
  input: Omit<LingServerConfirmedPairingMigrationV1, "status" | "gatewaySignature">,
): Uint8Array {
  return domainSeparatedCanonicalBytes("ling.server.pairing_migration.v1", input);
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
  const confirmationDigest = expectString(confirmation.confirmationDigest, `${path}.confirmationDigest`, { minBytes: 64, maxBytes: 64 });
  if (!/^[0-9a-f]{64}$/u.test(confirmationDigest)) {
    throw new RemoteProtocolError("invalid_field", "Expected a hexadecimal confirmation digest", `${path}.confirmationDigest`);
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
    confirmationDigest,
    createdAt,
    expiresAt,
    status: expectLiteral(confirmation.status, "confirmed", `${path}.status`),
    confirmedAt,
    gatewaySignature: expectEs256Signature(confirmation.gatewaySignature, `${path}.gatewaySignature`),
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
