import {
  LING_SERVER_SIGNAL_PAYLOAD_BYTES_V1,
  type LingServerSignalingInputV1, type LingServerSignalingOperationV1, type LingServerSignedSignalingV1,
} from "@ling-stack/contracts";
import { domainSeparatedCanonicalBytes } from "./canonical.js";
import { RemoteProtocolError } from "./errors.js";
import {
  assertStrictKeys, expectArray, expectEnum, expectEs256Signature, expectIdentifier, expectLiteral,
  expectNonce, expectRecord, expectRfc3339, expectSafeInteger, expectSha256, expectString, validateP256PublicJwk,
} from "./validation/primitives.js";

export function lingServerSignalingSigningBytes(input: LingServerSignalingInputV1): Uint8Array {
  return domainSeparatedCanonicalBytes("ling.server.signaling.v1", input);
}

export function validateLingServerSignedSignalingV1(value: unknown): LingServerSignedSignalingV1 {
  const signed = expectRecord(value, "$signal");
  assertStrictKeys(signed, ["input", "publicKeyJwk", "signature"], [], "$signal");
  const path = "$signal.input";
  const input = expectRecord(signed.input, path);
  assertStrictKeys(input, [
    "version", "instanceId", "installationId", "applicationKeyFingerprint", "bindingId", "routeAttemptId", "preferredRoute",
    "peerEpoch", "gatewayId", "mobileDeviceId", "role", "protocolMajor", "features", "expiresAt", "operation",
  ], [], path);
  const features = expectArray(input.features, `${path}.features`, expectIdentifier, { maxItems: 32 });
  if (new Set(features).size !== features.length) {
    throw new RemoteProtocolError("invalid_field", "Signaling feature ids must be unique", `${path}.features`);
  }
  return {
    input: {
      version: expectLiteral(input.version, 1, `${path}.version`),
      instanceId: expectIdentifier(input.instanceId, `${path}.instanceId`),
      installationId: expectIdentifier(input.installationId, `${path}.installationId`),
      applicationKeyFingerprint: expectSha256(input.applicationKeyFingerprint, `${path}.applicationKeyFingerprint`),
      bindingId: expectIdentifier(input.bindingId, `${path}.bindingId`),
      routeAttemptId: expectIdentifier(input.routeAttemptId, `${path}.routeAttemptId`),
      preferredRoute: expectEnum(input.preferredRoute, ["lan", "direct", "relay"], `${path}.preferredRoute`),
      peerEpoch: expectSafeInteger(input.peerEpoch, `${path}.peerEpoch`, { minimum: 1 }),
      gatewayId: expectIdentifier(input.gatewayId, `${path}.gatewayId`),
      mobileDeviceId: expectIdentifier(input.mobileDeviceId, `${path}.mobileDeviceId`),
      role: expectEnum(input.role, ["gateway", "mobile"], `${path}.role`),
      protocolMajor: expectSafeInteger(input.protocolMajor, `${path}.protocolMajor`, { minimum: 1 }),
      features,
      expiresAt: expectRfc3339(input.expiresAt, `${path}.expiresAt`),
      operation: readSignalingOperation(input.operation, `${path}.operation`),
    },
    publicKeyJwk: validateP256PublicJwk(signed.publicKeyJwk, "$signal.publicKeyJwk"),
    signature: expectEs256Signature(signed.signature, "$signal.signature"),
  };
}

function readSignalingOperation(value: unknown, path: string): LingServerSignalingOperationV1 {
  const operation = expectRecord(value, path);
  const kind = expectEnum(operation.kind, ["publish", "poll", "transport_config"], `${path}.kind`);
  if (kind === "transport_config") {
    assertStrictKeys(operation, ["kind", "nonce"], [], path);
    return { kind, nonce: expectNonce(operation.nonce, `${path}.nonce`) };
  }
  if (kind === "poll") {
    assertStrictKeys(operation, ["kind", "nonce", "afterSequence"], [], path);
    return {
      kind, nonce: expectNonce(operation.nonce, `${path}.nonce`),
      afterSequence: expectSafeInteger(operation.afterSequence, `${path}.afterSequence`, { minimum: 0 }),
    };
  }
  assertStrictKeys(operation, ["kind", "sequence", "messageType", "payload"], [], path);
  const messageType = expectEnum(operation.messageType, ["offer", "answer", "ice_candidate"], `${path}.messageType`);
  return {
    kind, messageType,
    sequence: expectSafeInteger(operation.sequence, `${path}.sequence`, { minimum: 1 }),
    payload: expectString(operation.payload, `${path}.payload`, { minBytes: 1, maxBytes: LING_SERVER_SIGNAL_PAYLOAD_BYTES_V1 }),
  };
}
