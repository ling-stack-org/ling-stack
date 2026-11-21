import { LING_SERVER_SIGNAL_LANE_LIMIT_V1, type LingServerGatewayRouteV1, type LingServerSignalingResponseV1 } from "@ling-stack/contracts";
import { encodeBase64Url, encodeUtf8, sha256, type RemoteMessageChannel } from "@ling-stack/remote-protocol";
import { lingServerMessageChannel } from "./ling-server-message-channel.js";
import { LingServerSignalingClient, type LingServerSignalingClientOptions } from "./ling-server-signaling.js";

const channelLabel = "ling-peer";
const channelProtocol = "ling-peer.v1";
const pollIntervalMs = 350;

export interface LingServerDataChannelOptions extends LingServerSignalingClientOptions {
  readonly createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  readonly timeoutMs?: number;
}

export interface LingServerDataChannel {
  readonly channel: RTCDataChannel;
  readonly transport: RemoteMessageChannel;
  readonly route: LingServerGatewayRouteV1;
  close(): void;
}

/** Opens the transport for a single route. The Gateway session authenticates on this channel. */
export async function connectLingServerDataChannel(options: LingServerDataChannelOptions): Promise<LingServerDataChannel> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const remainingMs = Date.parse(options.route.expiresAt) - Date.parse(options.clock.now());
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new Error("ling_server_negotiation_deadline_invalid");
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("ling_server_negotiation_cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error("ling_server_negotiation_timed_out")), Math.min(timeoutMs, remainingMs));

  let peer: RTCPeerConnection | undefined;
  try {
    const signaling = await LingServerSignalingClient.open({ ...options, signal: controller.signal });
    const config = await signaling.transportConfig();
    const createPeer = options.createPeerConnection ?? (configuration => new RTCPeerConnection(configuration));
    peer = createPeer(iceConfiguration(config));
    return await negotiate(peer, signaling, options.role, controller);
  } catch (error) {
    peer?.close();
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

async function negotiate(
  peer: RTCPeerConnection,
  signaling: LingServerSignalingClient,
  role: LingServerSignalingClientOptions["role"],
  controller: AbortController,
): Promise<LingServerDataChannel> {
  const signal = controller.signal;
  const gateway = role === "gateway";
  let channel: RTCDataChannel | undefined;
  let transport: RemoteMessageChannel | undefined;
  let nextSequence = 1;
  let remoteSequence = 0;
  let hasRemoteDescription = false;
  let gatheredCandidates = 0;
  const descriptionDigests: Partial<Record<"offer" | "answer", string>> = {};
  const localCandidates: RTCIceCandidateInit[] = [];
  const gatherCandidate = (event: RTCPeerConnectionIceEvent) => {
    if (!event.candidate?.candidate) return;
    if (gatheredCandidates >= LING_SERVER_SIGNAL_LANE_LIMIT_V1 - 1) {
      controller.abort(new Error("ling_server_ice_candidate_limit_reached"));
      return;
    }
    gatheredCandidates += 1;
    localCandidates.push(event.candidate.toJSON());
  };
  const receiveChannel = (event: RTCDataChannelEvent) => {
    const incoming = event.channel;
    if (gateway || channel || incoming.label !== channelLabel || incoming.protocol !== channelProtocol
      || !incoming.ordered || incoming.maxRetransmits !== null || incoming.maxPacketLifeTime !== null) {
      incoming.close();
      controller.abort(new Error("ling_server_data_channel_invalid"));
      return;
    }
    channel = incoming;
    transport = lingServerMessageChannel(peer, incoming);
  };
  const checkState = () => {
    if (peer.connectionState === "failed" || peer.connectionState === "closed") {
      controller.abort(new Error("ling_server_peer_connection_failed"));
    }
  };
  const publish = async (messageType: "offer" | "answer" | "ice_candidate", payload: string) => {
    await signaling.publish({ kind: "publish", messageType, payload, sequence: nextSequence });
    nextSequence += 1;
  };
  const describe = async (description: RTCSessionDescriptionInit) => {
    await peer.setLocalDescription(description);
    if (!description.sdp || (description.type !== "offer" && description.type !== "answer")) {
      throw new Error("ling_server_local_description_invalid");
    }
    await publish(description.type, description.sdp);
    descriptionDigests[description.type] = digestDescription(description.sdp);
  };

  peer.addEventListener("icecandidate", gatherCandidate);
  peer.addEventListener("datachannel", receiveChannel);
  peer.addEventListener("connectionstatechange", checkState);
  try {
    if (gateway) {
      channel = peer.createDataChannel(channelLabel, { ordered: true, protocol: channelProtocol });
      transport = lingServerMessageChannel(peer, channel);
      await describe(await peer.createOffer());
    }

    for (;;) {
      signal.throwIfAborted();
      if (channel?.readyState === "open") {
        const { offer, answer } = descriptionDigests;
        if (!transport || !offer || !answer) throw new Error("ling_server_gateway_route_incomplete");
        return {
          channel,
          transport,
          route: signaling.gatewayRoute({ offerDigest: offer, answerDigest: answer }),
          close: () => transport?.close(),
        };
      }
      if (channel?.readyState === "closing" || channel?.readyState === "closed") {
        throw new Error("ling_server_data_channel_closed");
      }
      for (const candidate of localCandidates.splice(0)) await publish("ice_candidate", JSON.stringify(candidate));
      const page = await signaling.poll(remoteSequence);
      for (const message of page.messages) {
        if (message.messageType === "ice_candidate") {
          if (!hasRemoteDescription) throw new Error("ling_server_peer_description_required");
          await peer.addIceCandidate(readIceCandidate(message.payload));
        } else {
          if (hasRemoteDescription) throw new Error("ling_server_peer_description_duplicate");
          await peer.setRemoteDescription({ type: message.messageType, sdp: message.payload });
          descriptionDigests[message.messageType] = digestDescription(message.payload);
          hasRemoteDescription = true;
          if (!gateway) await describe(await peer.createAnswer());
        }
        remoteSequence = message.sequence;
      }
      if (!page.hasMore) await waitForNextPoll(signal);
    }
  } finally {
    peer.removeEventListener("icecandidate", gatherCandidate);
    peer.removeEventListener("datachannel", receiveChannel);
    peer.removeEventListener("connectionstatechange", checkState);
  }
}

function digestDescription(sdp: string): string {
  return encodeBase64Url(sha256(encodeUtf8(sdp)));
}

function iceConfiguration(config: Extract<LingServerSignalingResponseV1, { kind: "transport_config" }>): RTCConfiguration {
  const relay = config.relayCredential;
  if (relay) {
    return {
      iceTransportPolicy: "relay",
      iceServers: [{ urls: relay.url, username: relay.username, credential: relay.credential }],
    };
  }
  return { iceServers: config.route === "lan" || config.stunUrls.length === 0 ? [] : [{ urls: [...config.stunUrls] }] };
}

function readIceCandidate(payload: string): RTCIceCandidateInit {
  let input: unknown;
  try {
    input = JSON.parse(payload);
  } catch {
    throw new Error("ling_server_ice_candidate_invalid");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("ling_server_ice_candidate_invalid");
  const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = input as Record<string, unknown>;
  if (typeof candidate !== "string" || !candidate.startsWith("candidate:")
    || (sdpMid != null && typeof sdpMid !== "string")
    || (sdpMLineIndex != null && (typeof sdpMLineIndex !== "number" || !Number.isInteger(sdpMLineIndex) || sdpMLineIndex < 0 || sdpMLineIndex > 65_535))
    || (sdpMid == null && sdpMLineIndex == null)
    || (usernameFragment != null && typeof usernameFragment !== "string")) {
    throw new Error("ling_server_ice_candidate_invalid");
  }
  return { candidate, sdpMid, sdpMLineIndex, usernameFragment };
}

async function waitForNextPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, pollIntervalMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
