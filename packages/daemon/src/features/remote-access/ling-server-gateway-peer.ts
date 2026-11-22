import { setTimeout as delay } from "node:timers/promises";
import type { LingServerGatewayRouteV1 } from "@ling-stack/contracts";
import {
  connectLingServerDataChannel, lingServerNativeGatewayFeatures, pollLingServerRoute,
  type LingServerDataChannelOptions, type LingServerRendezvousOptions, type LingServerRendezvousRoute,
} from "@ling-stack/remote-client";
import type { RemoteMessageChannel } from "@ling-stack/remote-protocol";

export class LingServerGatewayPeer {
  readonly #lifetime = new AbortController();
  readonly #tried = new Map<string, number>();
  #negotiation?: AbortController;

  constructor(
    readonly migrationId: string,
    options: LingServerRendezvousOptions,
    createPeerConnection: NonNullable<LingServerDataChannelOptions["createPeerConnection"]>,
    accept: (route: LingServerGatewayRouteV1, channel: RemoteMessageChannel) => void,
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
    accept: (route: LingServerGatewayRouteV1, channel: RemoteMessageChannel) => void,
  ): Promise<void> {
    const { signal } = this.#lifetime;
    while (!signal.aborted) {
      try {
        const offer = await pollLingServerRoute({ ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
        if (offer && !signal.aborted) this.offer(offer, options, createPeerConnection, accept);
      } catch {
        // Ling Server reachability cannot interrupt the Gateway listener.
      }
      await delay(2_000, undefined, { signal, ref: false }).catch(() => undefined);
    }
  }

  private offer(
    { route, instanceId }: LingServerRendezvousRoute,
    options: LingServerRendezvousOptions,
    createPeerConnection: NonNullable<LingServerDataChannelOptions["createPeerConnection"]>,
    accept: (route: LingServerGatewayRouteV1, channel: RemoteMessageChannel) => void,
  ): void {
    const time = Date.parse(options.clock.now());
    for (const [key, expiry] of this.#tried) if (expiry <= time) this.#tried.delete(key);
    const key = JSON.stringify([instanceId, route.routeAttemptId]);
    if (this.#tried.has(key) || this.#tried.size >= 128) return;
    this.#tried.set(key, Date.parse(route.expiresAt));
    this.#negotiation?.abort();
    const controller = new AbortController();
    this.#negotiation = controller;
    void (async () => {
      const connection = await connectLingServerDataChannel({
        ...options, route, role: "gateway", features: lingServerNativeGatewayFeatures,
        expectedInstanceId: instanceId, createPeerConnection, signal: controller.signal,
      });
      try {
        controller.signal.throwIfAborted();
        accept(connection.route, connection.transport);
      } catch (error) {
        connection.close();
        throw error;
      }
    })().catch(() => undefined).finally(() => {
      if (this.#negotiation === controller) this.#negotiation = undefined;
    });
  }
}
