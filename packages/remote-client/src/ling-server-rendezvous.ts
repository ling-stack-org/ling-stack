import {
  LING_SERVER_RENDEZVOUS_MAX_LIFETIME_MS_V1,
  type LingServerInstallationV1, type LingServerPeerBindingV1, type LingServerRendezvousRequestV1,
  type LingServerRendezvousScopeV1, type LingServerRouteAttemptV1, type LingServerTransportRouteV1,
} from "@ling-stack/contracts";
import {
  canonicalizeJson, encodeBase64Url, lingServerRendezvousReceiptBytes, lingServerRendezvousRequestBytes,
  lingServerRendezvousRoute, matchesPublicJwkFingerprint, validateLingServerOriginV1, validateLingServerRendezvousReceiptV1,
  validateLingServerSignalingInstanceV1, validateLingServerSignedRendezvousRequestV1,
} from "@ling-stack/remote-protocol";
import type { RemoteClock, RemoteDeviceKeyAdapter, RemoteDeviceKeyInfo, RemoteEntropy, RemoteHttpClient } from "./types.js";

export interface LingServerRendezvousOptions {
  readonly installation: LingServerInstallationV1;
  readonly binding: LingServerPeerBindingV1;
  readonly key: Pick<RemoteDeviceKeyInfo, "keyId" | "publicJwk">;
  readonly keys: Pick<RemoteDeviceKeyAdapter, "sign" | "verify">;
  readonly http: RemoteHttpClient;
  readonly entropy: Pick<RemoteEntropy, "randomBytes">;
  readonly clock: RemoteClock;
  readonly signal?: AbortSignal;
}

export interface LingServerRendezvousRoute {
  readonly route: LingServerRouteAttemptV1;
  readonly instanceId: string;
}

interface LingServerRendezvousPoll {
  readonly instanceId: string;
  readonly authorizedUntil: string;
  readonly offer?: LingServerRendezvousRoute;
}

export async function requestLingServerRoute(
  options: LingServerRendezvousOptions, preferred: LingServerTransportRouteV1,
): Promise<LingServerRendezvousRoute> {
  const routeAttemptId = `route_${encodeBase64Url(await options.entropy.randomBytes(18))}`;
  const { offer } = await exchange(options, { kind: "request_route", routeAttemptId, preferred });
  if (!offer) throw new Error("ling_server_rendezvous_offer_missing");
  return offer;
}

export async function pollLingServerRoute(options: LingServerRendezvousOptions): Promise<LingServerRendezvousPoll> {
  return await exchange(options, { kind: "poll_route" });
}

async function exchange(
  options: LingServerRendezvousOptions, operation: LingServerRendezvousRequestV1["operation"],
): Promise<LingServerRendezvousPoll> {
  const { installation, binding, signal, keys, key, http, clock, entropy } = options;
  const mobile = operation.kind === "request_route";
  const expectedFingerprint = mobile ? binding.mobileKeyFingerprint : binding.gatewayKeyFingerprint;
  if (installation.status !== "active" || binding.status !== "active" || binding.installationId !== installation.installationId
    || binding.mobileKeyFingerprint === binding.gatewayKeyFingerprint
    || !matchesPublicJwkFingerprint(key.publicJwk, expectedFingerprint)) {
    throw new Error("ling_server_rendezvous_binding_invalid");
  }
  signal?.throwIfAborted();
  const origin = validateLingServerOriginV1(installation.serverOrigin);
  const requestOptions = { signal, redirect: "error" as const };
  const instance = await http.getJson<unknown>(origin, "/v1/signaling/instance", requestOptions);
  signal?.throwIfAborted();
  if (instance.status !== 200) throw new Error("ling_server_rendezvous_unavailable");
  const { instanceId } = validateLingServerSignalingInstanceV1(instance.body);
  const scope: LingServerRendezvousScopeV1 = {
    version: 1, instanceId, installationId: installation.installationId, installationRevision: installation.revision,
    applicationKeyFingerprint: installation.applicationKeyFingerprint, bindingId: binding.bindingId,
    peerEpoch: binding.epoch, gatewayId: binding.gatewayId, mobileDeviceId: binding.mobileDeviceId,
  };
  const input: LingServerRendezvousRequestV1 = {
    ...scope, operation,
    nonce: encodeBase64Url(await entropy.randomBytes(32)),
    expiresAt: new Date(Date.parse(clock.now()) + (mobile ? 60_000 : 15_000)).toISOString(),
  };
  signal?.throwIfAborted();
  const signature = await keys.sign(key.keyId, lingServerRendezvousRequestBytes(input));
  const proof = validateLingServerSignedRendezvousRequestV1({ input, publicKeyJwk: key.publicJwk, signature });
  signal?.throwIfAborted();
  const response = await http.postJson<unknown>(origin, "/v1/rendezvous", proof, requestOptions);
  if (response.status !== 200) throw new Error("ling_server_rendezvous_unavailable");
  const { applicationSignature, ...receipt } = validateLingServerRendezvousReceiptV1(response.body);
  if (canonicalizeJson(receipt.request) !== canonicalizeJson(input)
    || !matchesPublicJwkFingerprint(receipt.applicationPublicKeyJwk, installation.applicationKeyFingerprint)
    || !await keys.verify(receipt.applicationPublicKeyJwk, lingServerRendezvousReceiptBytes(receipt), applicationSignature)) {
    throw new Error("ling_server_rendezvous_receipt_invalid");
  }
  assertLive(input.expiresAt, options);
  const authority = { instanceId, authorizedUntil: input.expiresAt };
  if (!receipt.offer) return authority;

  const { input: offerInput, publicKeyJwk, signature: offerSignature } = receipt.offer;
  const { nonce: _nonce, expiresAt, operation: _operation, ...offerScope } = offerInput;
  const route = lingServerRendezvousRoute(offerInput);
  if (!route || canonicalizeJson(offerScope) !== canonicalizeJson(scope)
    || (mobile && (canonicalizeJson(offerInput) !== canonicalizeJson(input) || offerSignature !== signature))
    || !matchesPublicJwkFingerprint(publicKeyJwk, binding.mobileKeyFingerprint)
    || !await keys.verify(publicKeyJwk, lingServerRendezvousRequestBytes(offerInput), offerSignature)) {
    throw new Error("ling_server_rendezvous_offer_invalid");
  }
  assertLive(input.expiresAt, options);
  assertLive(expiresAt, options);
  return { ...authority, offer: { route, instanceId } };
}

function assertLive(expiresAt: string, { clock, signal }: Pick<LingServerRendezvousOptions, "clock" | "signal">): void {
  signal?.throwIfAborted();
  const remaining = Date.parse(expiresAt) - Date.parse(clock.now());
  if (!(remaining > 0 && remaining <= LING_SERVER_RENDEZVOUS_MAX_LIFETIME_MS_V1)) {
    throw new Error("ling_server_rendezvous_expired");
  }
}
