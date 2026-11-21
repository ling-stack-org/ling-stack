import {
  LING_SERVER_SIGNAL_LANE_LIMIT_V1, LING_SERVER_SIGNAL_PAGE_LIMIT_V1, LING_SERVER_SIGNAL_PAYLOAD_BYTES_V1,
  type LingServerSignalingInputV1, type LingServerSignalingOperationV1, type LingServerSignalingResponseV1,
  type LingServerSignedSignalingV1,
} from "@ling-stack/contracts";
import { domainSeparatedCanonicalBytes } from "./canonical.js";
import { RemoteProtocolError } from "./errors.js";
import {
  assertStrictKeys, expectArray, expectBoolean, expectEnum, expectEs256Signature, expectHttpsOrigin, expectIdentifier, expectLiteral,
  expectNonce, expectRecord, expectRfc3339, expectSafeInteger, expectSha256, expectString, validateP256PublicJwk,
} from "./validation/primitives.js";

const routes = ["lan", "direct", "relay"] as const;

export function validateLingServerOriginV1(value: unknown): string {
  return expectHttpsOrigin(value, "$lingServerOrigin");
}

export function validateLingServerSignalingInstanceV1(value: unknown): { readonly instanceId: string } {
  const path = "$signalingInstance";
  const instance = expectRecord(value, path);
  assertStrictKeys(instance, ["instanceId"], [], path);
  return { instanceId: expectIdentifier(instance.instanceId, `${path}.instanceId`) };
}

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
      preferredRoute: expectEnum(input.preferredRoute, routes, `${path}.preferredRoute`),
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

export function validateLingServerSignalingResponseV1(value: unknown): LingServerSignalingResponseV1 {
  const path = "$signalingResponse";
  const response = expectRecord(value, path);
  const kind = expectEnum(response.kind, ["published", "signals", "transport_config"], `${path}.kind`);
  if (kind === "published") {
    assertStrictKeys(response, ["kind", "sequence", "replayed"], [], path);
    return {
      kind,
      sequence: readSignalSequence(response.sequence, `${path}.sequence`, 1),
      replayed: expectBoolean(response.replayed, `${path}.replayed`),
    };
  }
  if (kind === "signals") {
    assertStrictKeys(response, ["kind", "messages", "latestSequence", "hasMore"], [], path);
    return {
      kind,
      messages: expectArray(response.messages, `${path}.messages`, validateLingServerSignedSignalingV1, { maxItems: LING_SERVER_SIGNAL_PAGE_LIMIT_V1 }),
      latestSequence: readSignalSequence(response.latestSequence, `${path}.latestSequence`, 0),
      hasMore: expectBoolean(response.hasMore, `${path}.hasMore`),
    };
  }

  assertStrictKeys(response, ["kind", "route", "stunUrls", "turnUrls"], ["relayCredential"], path);
  const route = expectEnum(response.route, routes, `${path}.route`);
  const stunUrls = expectArray(response.stunUrls, `${path}.stunUrls`, (url, field) => readIceUrl(url, field, "stun"), { maxItems: 16 });
  const turnUrls = expectArray(response.turnUrls, `${path}.turnUrls`, (url, field) => readIceUrl(url, field, "turn"), { maxItems: 16 });
  if (route !== "relay" && !Object.hasOwn(response, "relayCredential")) return { kind, route, stunUrls, turnUrls };
  const relayPath = `${path}.relayCredential`;
  const relay = expectRecord(response.relayCredential, relayPath);
  assertStrictKeys(relay, ["url", "username", "credential", "expiresAt"], [], relayPath);
  const url = readIceUrl(relay.url, `${relayPath}.url`, "turn");
  if (route !== "relay" || !turnUrls.includes(url)) {
    throw new RemoteProtocolError("invalid_field", "Relay credential is outside the configured route", relayPath);
  }
  return {
    kind, route, stunUrls, turnUrls,
    relayCredential: {
      url,
      username: expectString(relay.username, `${relayPath}.username`, { minBytes: 1, maxBytes: 1024 }),
      credential: expectString(relay.credential, `${relayPath}.credential`, { minBytes: 1, maxBytes: 256 }),
      expiresAt: expectRfc3339(relay.expiresAt, `${relayPath}.expiresAt`),
    },
  };
}

function readIceUrl(value: unknown, path: string, scheme: "stun" | "turn"): string {
  const url = expectString(value, path, { minBytes: 1, maxBytes: 2048 });
  const address = /^(stuns?|turns?):(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:.]+\])(?::[0-9]{1,5})?(?:\?transport=(udp|tcp))?$/u.exec(url);
  if (!address || !address[1].startsWith(scheme) || (scheme === "stun" && address[2] !== undefined)) {
    throw new RemoteProtocolError("invalid_field", "ICE server URL is invalid for this transport", path);
  }
  return url;
}

function readSignalSequence(value: unknown, path: string, minimum: number): number {
  return expectSafeInteger(value, path, { minimum, maximum: LING_SERVER_SIGNAL_LANE_LIMIT_V1 });
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
      afterSequence: readSignalSequence(operation.afterSequence, `${path}.afterSequence`, 0),
    };
  }
  assertStrictKeys(operation, ["kind", "sequence", "messageType", "payload"], [], path);
  const messageType = expectEnum(operation.messageType, ["offer", "answer", "ice_candidate"], `${path}.messageType`);
  return {
    kind, messageType,
    sequence: readSignalSequence(operation.sequence, `${path}.sequence`, 1),
    payload: expectString(operation.payload, `${path}.payload`, { minBytes: 1, maxBytes: LING_SERVER_SIGNAL_PAYLOAD_BYTES_V1 }),
  };
}
