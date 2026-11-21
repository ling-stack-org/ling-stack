import {
  LING_SERVER_SIGNAL_ROUTE_LIFETIME_MS_V1, REMOTE_PROTOCOL_VERSION,
  type LingServerInstallationV1, type LingServerPeerBindingV1, type LingServerPeerRoleV1,
  type LingServerRouteAttemptV1, type LingServerSignalingInputV1, type LingServerSignalingOperationV1,
  type LingServerSignalingResponseV1, type LingServerSignedSignalingV1,
} from "@ling-stack/contracts";
import {
  canonicalizeJson, encodeBase64Url, lingServerSignalingSigningBytes, matchesPublicJwkFingerprint,
  validateLingServerOriginV1, validateLingServerSignalingInstanceV1, validateLingServerSignalingResponseV1,
  validateLingServerSignedSignalingV1,
} from "@ling-stack/remote-protocol";
import type { RemoteClock, RemoteDeviceKeyAdapter, RemoteDeviceKeyInfo, RemoteEntropy, RemoteHttpClient } from "./types.js";

type SignalingScope = Omit<LingServerSignalingInputV1, "operation">;
type PublishedSignal = Extract<LingServerSignalingOperationV1, { kind: "publish" }>;

export interface LingServerSignalingClientOptions {
  readonly installation: LingServerInstallationV1;
  readonly binding: LingServerPeerBindingV1;
  readonly route: LingServerRouteAttemptV1;
  readonly role: LingServerPeerRoleV1;
  readonly key: Pick<RemoteDeviceKeyInfo, "keyId" | "publicJwk">;
  readonly keys: Pick<RemoteDeviceKeyAdapter, "sign" | "verify">;
  readonly http: RemoteHttpClient;
  readonly entropy: Pick<RemoteEntropy, "randomBytes">;
  readonly clock: RemoteClock;
  readonly protocolMajor?: number;
  readonly features?: readonly string[];
  readonly signal?: AbortSignal;
}

/** Exchanges signaling for one negotiated route using locally pinned pairing records. */
export class LingServerSignalingClient {
  readonly #peerScope: string;

  private constructor(
    private readonly options: LingServerSignalingClientOptions,
    private readonly origin: string,
    private readonly scope: SignalingScope,
    private readonly peerFingerprint: string,
  ) {
    this.#peerScope = canonicalizeJson({ ...scope, role: scope.role === "gateway" ? "mobile" : "gateway" });
  }

  static async open(options: LingServerSignalingClientOptions): Promise<LingServerSignalingClient> {
    const { installation, binding, route, key, role } = options;
    if (installation.status !== "active" || binding.status !== "active"
      || binding.installationId !== installation.installationId || route.bindingId !== binding.bindingId
      || (route.peerEpoch ?? 1) !== binding.epoch || route.status === "failed" || route.status === "expired") {
      throw new Error("ling_server_route_scope_mismatch");
    }
    const localFingerprint = role === "gateway" ? binding.gatewayKeyFingerprint : binding.mobileKeyFingerprint;
    const peerFingerprint = role === "gateway" ? binding.mobileKeyFingerprint : binding.gatewayKeyFingerprint;
    if (localFingerprint === peerFingerprint || !matchesPublicJwkFingerprint(key.publicJwk, localFingerprint)) {
      throw new Error("ling_server_local_key_mismatch");
    }
    const origin = validateLingServerOriginV1(installation.serverOrigin);
    const scope = {
      version: 1, installationId: installation.installationId, applicationKeyFingerprint: installation.applicationKeyFingerprint,
      bindingId: binding.bindingId, routeAttemptId: route.routeAttemptId, preferredRoute: route.preferred,
      peerEpoch: binding.epoch, gatewayId: binding.gatewayId, mobileDeviceId: binding.mobileDeviceId, role,
      protocolMajor: options.protocolMajor ?? REMOTE_PROTOCOL_VERSION, features: [...(options.features ?? [])],
      expiresAt: route.expiresAt,
    } as const;
    assertRouteLive(options, scope.expiresAt);
    const { body, status } = await options.http.getJson<unknown>(origin, "/v1/signaling/instance", {
      signal: options.signal, redirect: "error",
    });
    assertRouteLive(options, scope.expiresAt);
    if (status !== 200) throw new Error("ling_server_signaling_unavailable");
    const { instanceId } = validateLingServerSignalingInstanceV1(body);
    return new LingServerSignalingClient(options, origin, { ...scope, instanceId }, peerFingerprint);
  }

  async publish(signal: PublishedSignal): Promise<{ readonly replayed: boolean }> {
    const { sequence } = signal;
    const response = await this.exchange(signal);
    if (response.kind !== "published" || response.sequence !== sequence) throw new Error("ling_server_signaling_receipt_mismatch");
    return { replayed: response.replayed };
  }

  async poll(afterSequence: number): Promise<{
    readonly messages: readonly PublishedSignal[];
    readonly latestSequence: number;
    readonly hasMore: boolean;
  }> {
    const response = await this.exchange({ kind: "poll", afterSequence, nonce: await this.nonce() });
    if (response.kind !== "signals") throw new Error("ling_server_signaling_response_mismatch");
    const { messages, latestSequence, hasMore } = response;
    const end = afterSequence + messages.length;
    if (end > latestSequence || hasMore !== (end < latestSequence) || (hasMore && messages.length === 0)) {
      throw new Error("ling_server_signaling_cursor_mismatch");
    }

    const verified: PublishedSignal[] = [];
    for (const { input, publicKeyJwk, signature } of messages) {
      const { operation, ...peerScope } = input;
      if (operation.kind !== "publish" || operation.sequence !== afterSequence + verified.length + 1
        || (operation.messageType === "offer" && input.role !== "gateway")
        || (operation.messageType === "answer" && input.role !== "mobile")
        || canonicalizeJson(peerScope) !== this.#peerScope) {
        throw new Error("ling_server_signaling_peer_scope_mismatch");
      }
      if (!matchesPublicJwkFingerprint(publicKeyJwk, this.peerFingerprint)
        || !await this.options.keys.verify(publicKeyJwk, lingServerSignalingSigningBytes(input), signature)) {
        throw new Error("ling_server_signaling_peer_signature_invalid");
      }
      verified.push(operation);
    }
    assertRouteLive(this.options, this.scope.expiresAt);
    return { messages: verified, latestSequence, hasMore };
  }

  async transportConfig(): Promise<Extract<LingServerSignalingResponseV1, { kind: "transport_config" }>> {
    const response = await this.exchange({ kind: "transport_config", nonce: await this.nonce() });
    if (response.kind !== "transport_config" || response.route !== this.scope.preferredRoute) {
      throw new Error("ling_server_transport_route_mismatch");
    }
    if (response.relayCredential) {
      const expiresAt = Date.parse(response.relayCredential.expiresAt);
      if (expiresAt <= Date.parse(this.options.clock.now()) || expiresAt > Date.parse(this.scope.expiresAt)) {
        throw new Error("ling_server_relay_credential_expiry_invalid");
      }
    }
    return response;
  }

  private async nonce(): Promise<string> {
    return encodeBase64Url(await this.options.entropy.randomBytes(32));
  }

  private async exchange(operation: LingServerSignalingOperationV1): Promise<LingServerSignalingResponseV1> {
    const { clock, key, keys, http, signal } = this.options;
    assertRouteLive({ clock, signal }, this.scope.expiresAt);
    const input = { ...this.scope, operation };
    const signature = await keys.sign(key.keyId, lingServerSignalingSigningBytes(input));
    const proof: LingServerSignedSignalingV1 = validateLingServerSignedSignalingV1({ input, publicKeyJwk: key.publicJwk, signature });
    assertRouteLive({ clock, signal }, this.scope.expiresAt);
    const { body, status } = await http.postJson<unknown>(this.origin, "/v1/signaling", proof, { signal, redirect: "error" });
    assertRouteLive({ clock, signal }, this.scope.expiresAt);
    if (status !== 200) throw new Error("ling_server_signaling_unavailable");
    return validateLingServerSignalingResponseV1(body);
  }
}

function assertRouteLive(options: Pick<LingServerSignalingClientOptions, "clock" | "signal">, expiresAt: string): void {
  if (options.signal?.aborted) throw new Error("ling_server_signaling_cancelled");
  const remainingMs = Date.parse(expiresAt) - Date.parse(options.clock.now());
  if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > LING_SERVER_SIGNAL_ROUTE_LIFETIME_MS_V1) {
    throw new Error("ling_server_signaling_expiry_invalid");
  }
}
