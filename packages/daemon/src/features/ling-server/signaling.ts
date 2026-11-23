import { createPublicKey, randomUUID, verify } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  LING_SERVER_SIGNAL_LANE_LIMIT_V1, LING_SERVER_SIGNAL_PAGE_LIMIT_V1, LING_SERVER_SIGNAL_ROUTE_LIFETIME_MS_V1,
  type LingServerPeerRoleV1, type LingServerSignedSignalingV1, type LingServerSignalingResponseV1, type LingServerTransportRouteV1,
} from "@ling-stack/contracts";
import { DeviceFabricError, type LingServerPeerRegistry, type LingServerRelayCredentialIssuer } from "@ling-stack/core/ling-server-control";
import {
  decodeBase64Url, lingServerSignalingSigningBytes, matchesPublicJwkFingerprint, validateLingServerSignedSignalingV1,
} from "@ling-stack/remote-protocol";

const maxRoutes = 128;
const maxPayloadBytes = 16 * 1024 * 1024;
const maxLaneRequests = 1_024;

interface SignalLane {
  readonly messages: LingServerSignedSignalingV1[];
  readonly usedNonces: Set<string>;
}

interface RouteSignals {
  readonly routeAttemptId: string;
  readonly bindingId: string;
  readonly epoch: number;
  readonly preferredRoute: LingServerTransportRouteV1;
  readonly expiresAtMs: number;
  readonly lanes: Record<LingServerPeerRoleV1, SignalLane>;
  bytes: number;
}

export class LingServerSignaling {
  readonly instanceId = randomUUID();
  readonly #routes = new Map<string, RouteSignals>();
  #payloadBytes = 0;

  constructor(private readonly options: {
    readonly registry: LingServerPeerRegistry;
    readonly protocolMajor: number;
    readonly features: readonly string[];
    readonly stunUrls: readonly string[];
    readonly turnUrls: readonly string[];
    readonly relayIssuer?: LingServerRelayCredentialIssuer;
    readonly now: () => string;
  }) {}

  exchange(value: unknown): LingServerSignalingResponseV1 {
    const signed = validateLingServerSignedSignalingV1(value);
    const { input } = signed;
    const { registry } = this.options;
    const now = Date.parse(this.options.now());
    const binding = registry.requireActiveBinding(input.bindingId, input.peerEpoch);
    const installation = registry.getInstallation(binding.installationId);
    const route = registry.requireRoute(input.routeAttemptId);
    const expiresAtMs = Date.parse(route.expiresAt);
    if (input.instanceId !== this.instanceId || input.installationId !== binding.installationId
      || installation?.applicationKeyFingerprint !== input.applicationKeyFingerprint
      || route.bindingId !== binding.bindingId || route.preferred !== input.preferredRoute || route.status === "failed" || route.status === "expired"
      || !((route.peerEpoch ?? 1) === binding.epoch && expiresAtMs > now && expiresAtMs - now <= LING_SERVER_SIGNAL_ROUTE_LIFETIME_MS_V1)
      || Date.parse(input.expiresAt) !== expiresAtMs
      || input.gatewayId !== binding.gatewayId || input.mobileDeviceId !== binding.mobileDeviceId
      || input.protocolMajor !== this.options.protocolMajor || input.features.some(feature => !this.options.features.includes(feature))) {
      throw new DeviceFabricError("safety_denied", "signaling proof is outside the current route");
    }
    const expectedPeerKey = input.role === "gateway" ? binding.gatewayKeyFingerprint : binding.mobileKeyFingerprint;
    if (!matchesPublicJwkFingerprint(signed.publicKeyJwk, expectedPeerKey) || !verifyProof(signed)) {
      throw new DeviceFabricError("safety_denied", "signaling proof could not be verified");
    }
    const key = JSON.stringify([binding.bindingId, binding.epoch, route.routeAttemptId, route.preferred]);
    let signals = this.#routes.get(key);
    if (!signals) {
      this.purge(now);
      if (this.#routes.size >= maxRoutes) throw new DeviceFabricError("lease_busy", "signaling route limit reached");
      signals = {
        routeAttemptId: route.routeAttemptId, bindingId: binding.bindingId, epoch: binding.epoch,
        preferredRoute: route.preferred, expiresAtMs, bytes: 0,
        lanes: { gateway: { messages: [], usedNonces: new Set() }, mobile: { messages: [], usedNonces: new Set() } },
      };
      this.#routes.set(key, signals);
    }

    const lane = signals.lanes[input.role];
    const operation = input.operation;
    if (operation.kind !== "publish") {
      if (lane.usedNonces.has(operation.nonce)) throw new DeviceFabricError("revision_conflict", "signaling request proof was already used");
      if (lane.usedNonces.size >= maxLaneRequests) throw new DeviceFabricError("lease_busy", "signaling request quota reached");
    }
    if (operation.kind === "transport_config") {
      const relayCredential = route.preferred === "relay" ? this.options.relayIssuer?.issue({ binding, route, role: input.role }) : undefined;
      if (route.preferred === "relay" && !relayCredential) throw new DeviceFabricError("resource_conflict", "relay configuration is unavailable");
      lane.usedNonces.add(operation.nonce);
      return {
        kind: "transport_config", route: route.preferred, stunUrls: this.options.stunUrls, turnUrls: this.options.turnUrls,
        ...(relayCredential ? { relayCredential } : {}),
      };
    }
    if (operation.kind === "poll") {
      const peerLane = signals.lanes[input.role === "gateway" ? "mobile" : "gateway"];
      if (operation.afterSequence > peerLane.messages.length) {
        throw new DeviceFabricError("revision_conflict", "signaling cursor is outside the peer lane");
      }
      lane.usedNonces.add(operation.nonce);
      const latestSequence = peerLane.messages.length;
      const end = operation.afterSequence + LING_SERVER_SIGNAL_PAGE_LIMIT_V1;
      return { kind: "signals", messages: peerLane.messages.slice(operation.afterSequence, end), latestSequence, hasMore: end < latestSequence };
    }
    if ((operation.messageType === "offer" && input.role !== "gateway")
      || (operation.messageType === "answer" && input.role !== "mobile")) {
      throw new DeviceFabricError("safety_denied", "signaling message does not match the peer role");
    }
    const { sequence } = operation;
    const previous = lane.messages[sequence - 1];
    if (previous) {
      if (!isDeepStrictEqual(previous.input, input)) throw new DeviceFabricError("revision_conflict", "signaling sequence is already occupied");
      return { kind: "published", sequence, replayed: true };
    }
    if (sequence !== lane.messages.length + 1) throw new DeviceFabricError("revision_conflict", "signaling sequence is not contiguous");
    if (operation.messageType !== "ice_candidate" && lane.messages.some(message => message.input.operation.kind === "publish"
      && message.input.operation.messageType === operation.messageType)) {
      throw new DeviceFabricError("revision_conflict", "a new negotiation requires another signaling route");
    }
    if (operation.messageType === "answer" && !signals.lanes.gateway.messages.some(message => message.input.operation.kind === "publish"
      && message.input.operation.messageType === "offer")) {
      throw new DeviceFabricError("revision_conflict", "the route has no offer for this answer");
    }
    const payloadBytes = Buffer.byteLength(operation.payload, "utf8");
    if (lane.messages.length >= LING_SERVER_SIGNAL_LANE_LIMIT_V1 || this.#payloadBytes + payloadBytes > maxPayloadBytes) {
      throw new DeviceFabricError("lease_busy", "signaling mailbox capacity reached");
    }
    lane.messages.push(signed);
    signals.bytes += payloadBytes;
    this.#payloadBytes += payloadBytes;
    return { kind: "published", sequence, replayed: false };
  }

  purge(now = Date.parse(this.options.now())): void {
    for (const [key, signals] of this.#routes) {
      const binding = this.options.registry.getBinding(signals.bindingId);
      const route = this.options.registry.getRoute(signals.routeAttemptId);
      if (signals.expiresAtMs <= now || binding?.status !== "active" || binding.epoch !== signals.epoch
        || this.options.registry.getInstallation(binding.installationId)?.status !== "active"
        || !route || route.preferred !== signals.preferredRoute || route.status === "failed" || route.status === "expired") {
        this.#routes.delete(key);
        this.#payloadBytes -= signals.bytes;
      }
    }
  }
}

function verifyProof(signed: LingServerSignedSignalingV1): boolean {
  try {
    return verify("sha256", lingServerSignalingSigningBytes(signed.input), {
      key: createPublicKey({ key: signed.publicKeyJwk, format: "jwk" }),
      dsaEncoding: "ieee-p1363",
    }, decodeBase64Url(signed.signature));
  } catch {
    return false;
  }
}
