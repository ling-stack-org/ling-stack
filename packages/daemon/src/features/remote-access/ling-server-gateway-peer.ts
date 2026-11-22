import { setTimeout as delay } from "node:timers/promises";
import type { LingServerGatewayRouteV1 } from "@ling-stack/contracts";
import {
  connectLingServerDataChannel, lingServerNativeGatewayFeatures, pollLingServerRoute, RemoteHttpStatusError,
  type LingServerDataChannelOptions, type LingServerRendezvousOptions, type LingServerRendezvousRoute,
} from "@ling-stack/remote-client";
import type { RemoteMessageChannel } from "@ling-stack/remote-protocol";

export class LingServerGatewayPeer {
  readonly #lifetime = new AbortController();
  readonly #tried = new Map<string, number>();
  #negotiation?: AbortController;
  #authority?: { readonly instanceId: string; readonly expiresAt: number };
  #authorityGeneration = 0;

  constructor(
    readonly migrationId: string,
    options: LingServerRendezvousOptions,
    createPeerConnection: NonNullable<LingServerDataChannelOptions["createPeerConnection"]>,
    accept: (route: LingServerGatewayRouteV1, channel: RemoteMessageChannel, authorityUntil: () => number) => void,
  ) {
    void this.poll(options, createPeerConnection, accept);
  }

  stop(): void {
    this.#lifetime.abort();
    this.#negotiation?.abort();
  }

  private async poll(
    options: LingServerRendezvousOptions,
    createPeerConnection: NonNullable<LingServerDataChannelOptions["createPeerConnection"]>,
    accept: (route: LingServerGatewayRouteV1, channel: RemoteMessageChannel, authorityUntil: () => number) => void,
  ): Promise<void> {
    const { signal } = this.#lifetime;
    while (!signal.aborted) {
      try {
        const poll = await pollLingServerRoute({ ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
        if (signal.aborted) return;
        if (this.#authority && this.#authority.instanceId !== poll.instanceId) this.invalidateAuthority();
        this.#authority = { instanceId: poll.instanceId, expiresAt: Date.parse(poll.authorizedUntil) };
        if (poll.offer) this.offer(poll.offer, options, createPeerConnection, accept);
      } catch (error) {
        if (error instanceof RemoteHttpStatusError && (error.status === 401 || error.status === 403)) this.invalidateAuthority();
      }
      await delay(2_000, undefined, { signal, ref: false }).catch(() => undefined);
    }
  }

  private offer(
    { route, instanceId }: LingServerRendezvousRoute,
    options: LingServerRendezvousOptions,
    createPeerConnection: NonNullable<LingServerDataChannelOptions["createPeerConnection"]>,
    accept: (route: LingServerGatewayRouteV1, channel: RemoteMessageChannel, authorityUntil: () => number) => void,
  ): void {
    const time = Date.parse(options.clock.now());
    for (const [key, expiry] of this.#tried) if (expiry <= time) this.#tried.delete(key);
    const key = JSON.stringify([instanceId, route.routeAttemptId]);
    if (this.#tried.has(key) || this.#tried.size >= 128) return;
    this.#tried.set(key, Date.parse(route.expiresAt));
    this.#negotiation?.abort();
    const controller = new AbortController();
    this.#negotiation = controller;
    const authorityGeneration = this.#authorityGeneration;
    const initialExpiry = Date.parse(route.expiresAt);
    void (async () => {
      const connection = await connectLingServerDataChannel({
        ...options, route, role: "gateway", features: lingServerNativeGatewayFeatures, deviceCollaboration: true,
        expectedInstanceId: instanceId, createPeerConnection, signal: controller.signal,
      });
      try {
        controller.signal.throwIfAborted();
        accept(connection.route, connection.transport, () => {
          if (this.#lifetime.signal.aborted || this.#authorityGeneration !== authorityGeneration || !this.#authority) return 0;
          return Math.max(initialExpiry, this.#authority.expiresAt);
        });
      } catch (error) {
        connection.close();
        throw error;
      }
    })().catch(() => undefined).finally(() => {
      if (this.#negotiation === controller) this.#negotiation = undefined;
    });
  }

  private invalidateAuthority(): void {
    this.#authority = undefined;
    this.#authorityGeneration += 1;
    this.#negotiation?.abort();
  }
}
