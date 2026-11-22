import {
  connectLingServerDataChannel, lingServerNativeGatewayFeatures, RemoteHttpStatusError, requestLingServerRoute,
  type LingServerDataChannel, type LingServerDataChannelOptions, type LingServerRendezvousOptions, type RemoteBindingV1,
  type RemoteDeviceKeyAdapter,
} from "@ling-stack/remote-client";
import { fingerprintPublicJwkSync } from "@ling-stack/remote-protocol";

type MobilePeerOptions = Pick<LingServerRendezvousOptions, "clock" | "entropy" | "http"> & {
  readonly keys: RemoteDeviceKeyAdapter;
  readonly createPeerConnection: () => Promise<NonNullable<LingServerDataChannelOptions["createPeerConnection"]>>;
};

const routeBudgetMs = 12_000;

export async function connectMobileLingServerPeer(binding: RemoteBindingV1, signal: AbortSignal,
  options: MobilePeerOptions): Promise<LingServerDataChannel | undefined> {
  const profile = binding.lingServerRoutingProfile;
  if (!profile || binding.status !== "active") return undefined;
  signal.throwIfAborted();
  let createPeerConnection: Awaited<ReturnType<MobilePeerOptions["createPeerConnection"]>>;
  try {
    createPeerConnection = await options.createPeerConnection();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.message === "mobile_webrtc_native_module_unavailable") return undefined;
    throw error;
  }

  const key = await options.keys.generateOrLoad(binding.deviceKeyId);
  signal.throwIfAborted();
  const requestOptions = {
    ...options, key,
    installation: { installationId: profile.installationId, serverOrigin: profile.serverOrigin,
      applicationKeyFingerprint: profile.applicationKeyFingerprint, revision: profile.installationRevision, status: "active" },
    binding: { bindingId: profile.bindingId, installationId: profile.installationId,
      gatewayId: binding.gatewayId, mobileDeviceId: binding.deviceId, epoch: binding.deviceEpoch,
      gatewayKeyFingerprint: binding.gatewayIdentityFingerprint, mobileKeyFingerprint: fingerprintPublicJwkSync(key.publicJwk),
      revision: 1, status: "active" },
  } as const satisfies LingServerRendezvousOptions;

  for (const preferred of ["direct", "relay"] as const) {
    const deadline = new AbortController();
    const cancel = () => deadline.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, routeBudgetMs);
    try {
      signal.throwIfAborted();
      const { route, instanceId } = await requestLingServerRoute({ ...requestOptions, signal: deadline.signal }, preferred);
      return await connectLingServerDataChannel({
        ...requestOptions, route, role: "mobile", expectedInstanceId: instanceId, createPeerConnection,
        features: lingServerNativeGatewayFeatures, signal: deadline.signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      if (!deadline.signal.aborted && !isUnavailablePeerRoute(error)) throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
  }
  return undefined;
}

function isUnavailablePeerRoute(error: unknown): boolean {
  if (error instanceof RemoteHttpStatusError) return error.status === 404 || error.status === 503;
  if (!(error instanceof Error)) return false;
  // Fetch rejects for lookup, transport and TLS reachability without an HTTP response.
  if (error instanceof TypeError && /^(Network request failed|Failed to fetch|fetch failed)$/u.test(error.message)) return true;
  return ["ling_server_peer_connection_failed", "ling_server_data_channel_closed", "ling_server_negotiation_timed_out"].includes(error.message);
}
