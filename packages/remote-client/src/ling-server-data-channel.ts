import {
  LING_SERVER_NEGOTIATED_DATA_CHANNEL_FEATURE_V1, LING_SERVER_SIGNAL_LANE_LIMIT_V1,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V5,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V6, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V7, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V8,
  type LingServerGatewayRouteV1, type LingServerSignalingResponseV1,
} from "@ling-stack/contracts";
import { encodeBase64Url, encodeUtf8, sha256, type RemoteMessageChannel } from "@ling-stack/remote-protocol";
import { lingServerMessageChannel } from "./ling-server-message-channel.js";
import { LingServerSignalingClient, type LingServerSignalingClientOptions } from "./ling-server-signaling.js";

const channelLabel = "ling-peer";
const channelProtocol = "ling-peer.v1";
const deviceTaskSdpFeatures = [
  { feature: REMOTE_DEVICE_TASKS_SUBPROTOCOL_V6, attribute: "a=ling-device-tasks:6" },
  { feature: REMOTE_DEVICE_TASKS_SUBPROTOCOL_V7, attribute: "a=ling-device-tasks:7" },
  { feature: REMOTE_DEVICE_TASKS_SUBPROTOCOL_V8, attribute: "a=ling-device-tasks:8" },
] as const;
const pollIntervalMs = 350;

export const lingServerNativeGatewayFeatures = [
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V5,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4,
  LING_SERVER_NEGOTIATED_DATA_CHANNEL_FEATURE_V1,
] as const;

export interface LingServerDataChannelOptions extends LingServerSignalingClientOptions {
  readonly createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  readonly timeoutMs?: number;
  readonly deviceCollaboration?: boolean;
  readonly deviceArtifacts?: boolean;
  readonly androidApkArtifacts?: boolean;
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
  const signal = controller.signal;
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const cancel = () => controller.abort(new Error("ling_server_negotiation_cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error("ling_server_negotiation_timed_out")), Math.min(timeoutMs, remainingMs));

  let peer: RTCPeerConnection | undefined;
  const open = async () => {
    const signaling = await LingServerSignalingClient.open({ ...options, signal });
    const config = await signaling.transportConfig();
    signal.throwIfAborted();
    const createPeer = options.createPeerConnection ?? (configuration => new RTCPeerConnection(configuration));
    peer = createPeer(iceConfiguration(config));
    const negotiatedChannel = options.features?.includes(LING_SERVER_NEGOTIATED_DATA_CHANNEL_FEATURE_V1) === true;
    const features = deviceTaskSdpFeatures.slice(0, options.androidApkArtifacts ? 3
      : options.deviceArtifacts ? 2 : options.deviceCollaboration ? 1 : 0);
    return await negotiate(peer, signaling, options.role, controller, negotiatedChannel, features);
  };
  try {
    const connected = await Promise.race([aborted, open()]);
    signal.throwIfAborted();
    return connected;
  } catch (error) {
    peer?.close();
    throw signal.aborted ? signal.reason : error;
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
  negotiatedChannel: boolean,
  features: readonly (typeof deviceTaskSdpFeatures)[number][],
): Promise<LingServerDataChannel> {
  const signal = controller.signal;
  signal.throwIfAborted();
  const gateway = role === "gateway";
  let channel: RTCDataChannel | undefined;
  let transport: RemoteMessageChannel | undefined;
  let nextSequence = 1;
  let remoteSequence = 0;
  let hasRemoteDescription = false;
  let advertisedFeatures: typeof features = [];
  let peerAdvertisedFeatures: typeof features = [];
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
    if (negotiatedChannel || gateway || channel || incoming.label !== channelLabel || incoming.protocol !== channelProtocol
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
    signal.throwIfAborted();
    await peer.setLocalDescription(description);
    if (!description.sdp || (description.type !== "offer" && description.type !== "answer")) {
      throw new Error("ling_server_local_description_invalid");
    }
    // The signed descriptions advertise features independently of the existing signaling scope.
    advertisedFeatures = /^m=application\s/mu.test(description.sdp) ? features : [];
    const sdp = addSdpAttributes(description.sdp, advertisedFeatures.map(item => item.attribute));
    await publish(description.type, sdp);
    descriptionDigests[description.type] = digestDescription(sdp);
  };
  const detach = () => {
    peer.removeEventListener("icecandidate", gatherCandidate);
    peer.removeEventListener("datachannel", receiveChannel);
    peer.removeEventListener("connectionstatechange", checkState);
  };

  peer.addEventListener("icecandidate", gatherCandidate);
  peer.addEventListener("datachannel", receiveChannel);
  peer.addEventListener("connectionstatechange", checkState);
  signal.addEventListener("abort", detach, { once: true });
  try {
    if (negotiatedChannel || gateway) {
      channel = peer.createDataChannel(channelLabel, {
        ordered: true, protocol: channelProtocol,
        ...(negotiatedChannel ? { negotiated: true, id: 0 } : {}),
      });
      transport = lingServerMessageChannel(peer, channel);
      if (gateway) await describe(await peer.createOffer());
    }

    for (;;) {
      signal.throwIfAborted();
      if (channel?.readyState === "open") {
        const { offer, answer } = descriptionDigests;
        if (!transport || !offer || !answer) throw new Error("ling_server_gateway_route_incomplete");
        const route = signaling.gatewayRoute({ offerDigest: offer, answerDigest: answer });
        const agreedFeatures = advertisedFeatures.filter(item => peerAdvertisedFeatures.includes(item)).map(item => item.feature);
        return {
          channel,
          transport,
          route: { ...route, features: [...new Set([...route.features, ...agreedFeatures])] },
          close: () => transport?.close(),
        };
      }
      if (channel?.readyState === "closing" || channel?.readyState === "closed") {
        throw new Error("ling_server_data_channel_closed");
      }
      for (const candidate of localCandidates.splice(0)) await publish("ice_candidate", JSON.stringify(candidate));
      const page = await signaling.poll(remoteSequence);
      for (const message of page.messages) {
        signal.throwIfAborted();
        if (message.messageType === "ice_candidate") {
          if (!hasRemoteDescription) throw new Error("ling_server_peer_description_required");
          await peer.addIceCandidate(readIceCandidate(message.payload));
        } else {
          if (hasRemoteDescription) throw new Error("ling_server_peer_description_duplicate");
          const lines = message.payload.split(/\r?\n/u);
          peerAdvertisedFeatures = deviceTaskSdpFeatures.filter(item => lines.includes(item.attribute));
          const remoteSdp = peerAdvertisedFeatures.length
            ? lines.filter(line => !peerAdvertisedFeatures.some(item => item.attribute === line)).join(message.payload.includes("\r\n") ? "\r\n" : "\n")
            : message.payload;
          await peer.setRemoteDescription({ type: message.messageType, sdp: remoteSdp });
          signal.throwIfAborted();
          descriptionDigests[message.messageType] = digestDescription(message.payload);
          hasRemoteDescription = true;
          if (!gateway) await describe(await peer.createAnswer());
        }
        remoteSequence = message.sequence;
      }
      if (!page.hasMore) await waitForNextPoll(signal);
    }
  } finally {
    signal.removeEventListener("abort", detach);
    detach();
  }
}

function addSdpAttributes(sdp: string, attributes: readonly string[]): string {
  if (!attributes.length) return sdp;
  const newline = sdp.includes("\r\n") ? "\r\n" : "\n";
  return sdp + (sdp.endsWith(newline) ? "" : newline) + attributes.join(newline) + newline;
}

function digestDescription(sdp: string): string {
  return encodeBase64Url(sha256(encodeUtf8(sdp)));
}

function iceConfiguration(config: Extract<LingServerSignalingResponseV1, { kind: "transport_config" }>): RTCConfiguration {
  const relay = config.relayCredential;
  if (relay) {
    const urls = [...new Set([relay.url, ...config.turnUrls])];
    return {
      iceTransportPolicy: "relay",
      iceServers: [{ urls, username: relay.username, credential: relay.credential }],
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
