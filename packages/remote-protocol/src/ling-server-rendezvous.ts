import type {
  LingServerRendezvousReceiptV1, LingServerRendezvousRequestV1, LingServerRouteAttemptV1, LingServerSignedRendezvousRequestV1,
} from "@ling-stack/contracts";
import { domainSeparatedCanonicalBytes } from "./canonical.js";
import {
  assertStrictKeys, expectEnum, expectEs256Signature, expectIdentifier, expectLiteral,
  expectNonce, expectRecord, expectRfc3339, expectSafeInteger, expectSha256, validateP256PublicJwk,
} from "./validation/primitives.js";

export function lingServerRendezvousRequestBytes(input: LingServerRendezvousRequestV1): Uint8Array {
  return domainSeparatedCanonicalBytes("ling.server.rendezvous.request.v1", input);
}

export function lingServerRendezvousReceiptBytes(receipt: Omit<LingServerRendezvousReceiptV1, "applicationSignature">): Uint8Array {
  return domainSeparatedCanonicalBytes("ling.server.rendezvous.receipt.v1", receipt);
}

export function validateLingServerSignedRendezvousRequestV1(value: unknown): LingServerSignedRendezvousRequestV1 {
  const path = "$rendezvousProof";
  const proof = expectRecord(value, path);
  assertStrictKeys(proof, ["input", "publicKeyJwk", "signature"], [], path);
  return {
    input: readRendezvousRequest(proof.input, `${path}.input`),
    publicKeyJwk: validateP256PublicJwk(proof.publicKeyJwk, `${path}.publicKeyJwk`),
    signature: expectEs256Signature(proof.signature, `${path}.signature`),
  };
}

export function validateLingServerRendezvousReceiptV1(value: unknown): LingServerRendezvousReceiptV1 {
  const path = "$rendezvousReceipt";
  const receipt = expectRecord(value, path);
  assertStrictKeys(receipt, ["request", "applicationPublicKeyJwk", "applicationSignature"], ["offer"], path);
  return {
    request: readRendezvousRequest(receipt.request, `${path}.request`),
    ...(receipt.offer === undefined ? {} : { offer: validateLingServerSignedRendezvousRequestV1(receipt.offer) }),
    applicationPublicKeyJwk: validateP256PublicJwk(receipt.applicationPublicKeyJwk, `${path}.applicationPublicKeyJwk`),
    applicationSignature: expectEs256Signature(receipt.applicationSignature, `${path}.applicationSignature`),
  };
}

export function lingServerRendezvousRoute(input: LingServerRendezvousRequestV1): LingServerRouteAttemptV1 | undefined {
  if (input.operation.kind !== "request_route") return undefined;
  return {
    bindingId: input.bindingId,
    peerEpoch: input.peerEpoch,
    routeAttemptId: input.operation.routeAttemptId,
    preferred: input.operation.preferred,
    status: "gathering",
    expiresAt: input.expiresAt,
  };
}

function readRendezvousRequest(value: unknown, path: string): LingServerRendezvousRequestV1 {
  const request = expectRecord(value, path);
  assertStrictKeys(request, [
    "version", "instanceId", "installationId", "installationRevision", "applicationKeyFingerprint",
    "bindingId", "peerEpoch", "gatewayId", "mobileDeviceId", "nonce", "expiresAt", "operation",
  ], [], path);
  const operationPath = `${path}.operation`;
  const operation = expectRecord(request.operation, operationPath);
  const kind = expectEnum(operation.kind, ["request_route", "poll_route"], `${operationPath}.kind`);
  assertStrictKeys(operation, kind === "request_route" ? ["kind", "routeAttemptId", "preferred"] : ["kind"], [], operationPath);
  return {
    version: expectLiteral(request.version, 1, `${path}.version`),
    instanceId: expectIdentifier(request.instanceId, `${path}.instanceId`),
    installationId: expectIdentifier(request.installationId, `${path}.installationId`),
    installationRevision: expectSafeInteger(request.installationRevision, `${path}.installationRevision`, { minimum: 1 }),
    applicationKeyFingerprint: expectSha256(request.applicationKeyFingerprint, `${path}.applicationKeyFingerprint`),
    bindingId: expectIdentifier(request.bindingId, `${path}.bindingId`),
    peerEpoch: expectSafeInteger(request.peerEpoch, `${path}.peerEpoch`, { minimum: 1 }),
    gatewayId: expectIdentifier(request.gatewayId, `${path}.gatewayId`),
    mobileDeviceId: expectIdentifier(request.mobileDeviceId, `${path}.mobileDeviceId`),
    nonce: expectNonce(request.nonce, `${path}.nonce`),
    expiresAt: expectRfc3339(request.expiresAt, `${path}.expiresAt`),
    operation: kind === "request_route" ? {
      kind, routeAttemptId: expectIdentifier(operation.routeAttemptId, `${operationPath}.routeAttemptId`),
      preferred: expectEnum(operation.preferred, ["lan", "direct", "relay"], `${operationPath}.preferred`),
    } : { kind },
  };
}
