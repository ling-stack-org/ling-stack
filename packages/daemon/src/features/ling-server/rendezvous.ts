import { createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import {
  LING_SERVER_RENDEZVOUS_MAX_LIFETIME_MS_V1,
  type LingServerRendezvousReceiptV1, type LingServerSignedRendezvousRequestV1, type RemoteP256PublicJwkV1,
} from "@ling-stack/contracts";
import { DeviceFabricError, type LingServerPeerRegistry } from "@ling-stack/core";
import {
  decodeBase64Url, encodeBase64Url, lingServerRendezvousReceiptBytes, lingServerRendezvousRequestBytes,
  lingServerRendezvousRoute, matchesPublicJwkFingerprint, validateLingServerSignedRendezvousRequestV1,
} from "@ling-stack/remote-protocol";

interface ActiveOffer {
  readonly request: LingServerSignedRendezvousRequestV1;
  readonly expiresAtMs: number;
  readonly acceptedAtMs: number;
}

export class LingServerRendezvous {
  readonly #offers = new Map<string, ActiveOffer>();
  readonly #nonces = new Map<string, number>();

  constructor(private readonly options: {
    readonly registry: LingServerPeerRegistry;
    readonly instanceId: string;
    readonly now: () => string;
    readonly identity: { readonly privateKey: KeyObject; readonly publicJwk: RemoteP256PublicJwkV1; readonly fingerprint: string };
    readonly relayAvailable: boolean;
  }) {}

  exchange(value: unknown): LingServerRendezvousReceiptV1 {
    const proof = validateLingServerSignedRendezvousRequestV1(value);
    const { input, publicKeyJwk, signature } = proof;
    const { registry, identity } = this.options;
    const now = Date.parse(this.options.now());
    const expiresAt = Date.parse(input.expiresAt);
    const binding = registry.requireActiveBinding(input.bindingId, input.peerEpoch);
    const installation = registry.getInstallation(binding.installationId);
    const route = lingServerRendezvousRoute(input);
    const peerKey = route ? binding.mobileKeyFingerprint : binding.gatewayKeyFingerprint;
    if (input.instanceId !== this.options.instanceId || input.installationId !== binding.installationId
      || input.installationRevision !== installation?.revision || input.applicationKeyFingerprint !== installation.applicationKeyFingerprint
      || input.applicationKeyFingerprint !== identity.fingerprint || input.gatewayId !== binding.gatewayId
      || input.mobileDeviceId !== binding.mobileDeviceId || expiresAt <= now || expiresAt - now > LING_SERVER_RENDEZVOUS_MAX_LIFETIME_MS_V1
      || !matchesPublicJwkFingerprint(publicKeyJwk, peerKey)
      || !verify("sha256", lingServerRendezvousRequestBytes(input), {
        key: createPublicKey({ key: publicKeyJwk, format: "jwk" }), dsaEncoding: "ieee-p1363",
      }, decodeBase64Url(signature))) {
      throw new DeviceFabricError("safety_denied", "rendezvous proof is outside the current pairing");
    }
    const nonce = JSON.stringify([binding.bindingId, binding.epoch, peerKey, input.nonce]);
    if ((this.#nonces.get(nonce) ?? 0) > now) throw new DeviceFabricError("revision_conflict", "rendezvous nonce was already used");
    if (this.#nonces.size >= 8_192 || this.#offers.size >= 128) this.purge(now);
    if (this.#nonces.size >= 8_192) throw new DeviceFabricError("lease_busy", "rendezvous request capacity reached");
    const previous = this.readOffer(binding.bindingId, binding.epoch, installation.revision, now);
    let offer = previous?.request;
    if (route) {
      if (route.preferred === "relay" && !this.options.relayAvailable) {
        throw new DeviceFabricError("resource_conflict", "rendezvous relay is unavailable");
      }
      if ((!previous && this.#offers.size >= 128) || (previous && now - previous.acceptedAtMs < 1_000)) {
        throw new DeviceFabricError("lease_busy", "rendezvous offer capacity reached");
      }
      // IDs belong to one negotiation. A consumed ID cannot replace a current offer.
      if (registry.getRoute(route.routeAttemptId)) throw new DeviceFabricError("revision_conflict", "rendezvous route was already used");
      registry.beginRoute(route);
      offer = proof;
      this.#offers.set(binding.bindingId, { request: proof, expiresAtMs: expiresAt, acceptedAtMs: now });
    }
    this.#nonces.set(nonce, expiresAt);
    const receipt = { request: input, applicationPublicKeyJwk: identity.publicJwk, ...(offer ? { offer } : {}) };
    return {
      ...receipt,
      applicationSignature: encodeBase64Url(sign("sha256", lingServerRendezvousReceiptBytes(receipt), {
        key: identity.privateKey, dsaEncoding: "ieee-p1363",
      })),
    };
  }

  purge(now = Date.parse(this.options.now())): void {
    for (const [nonce, expiry] of this.#nonces) if (expiry <= now) this.#nonces.delete(nonce);
    for (const [bindingId, { request, expiresAtMs }] of this.#offers) {
      const binding = this.options.registry.getBinding(bindingId);
      const installation = this.options.registry.getInstallation(request.input.installationId);
      if (expiresAtMs <= now || binding?.status !== "active" || installation?.status !== "active"
        || installation.revision !== request.input.installationRevision) {
        this.#offers.delete(bindingId);
      } else {
        this.readOffer(bindingId, binding.epoch, installation.revision, now);
      }
    }
  }

  private readOffer(bindingId: string, epoch: number, installationRevision: number, now: number): ActiveOffer | undefined {
    const offer = this.#offers.get(bindingId);
    if (!offer) return undefined;
    const { input } = offer.request;
    const requested = lingServerRendezvousRoute(input);
    const route = requested && this.options.registry.getRoute(requested.routeAttemptId);
    if (!requested || !route || route.preferred !== requested.preferred || route.status === "failed" || route.status === "expired"
      || epoch !== input.peerEpoch || installationRevision !== input.installationRevision || offer.expiresAtMs <= now) {
      this.#offers.delete(bindingId);
      return undefined;
    }
    return offer;
  }
}
