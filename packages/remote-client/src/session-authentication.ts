import {
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V1,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V2,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V3,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V5,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V6,
  REMOTE_PROTOCOL_VERSION,
  type LingServerGatewayRouteV1,
  type RemoteAuthProofV1,
  type RemoteResumeCursorV1,
} from "@ling-stack/contracts";
import {
  authChallengeSigningBytes, authChallengeSigningInput, authProofSigningBytes, authProofSigningInput,
  encodeBase64Url, remoteWebSocketChannel, sha256, validateRemoteAuthChallengeV1, type RemoteMessageChannel,
} from "@ling-stack/remote-protocol";
import {
  remoteWebSocketUrl, type RemoteBindingV1, type RemoteClock, type RemoteDeviceKeyAdapter,
  type RemoteEntropy, type RemoteHttpClient, type RemoteWebSocketFactory,
} from "./types.js";

interface RemotePeerConnection {
  readonly route: LingServerGatewayRouteV1;
  readonly transport: RemoteMessageChannel;
}

type GatewayConnection = {
  readonly http: RemoteHttpClient;
  readonly webSocketFactory: RemoteWebSocketFactory;
};

export type RemoteSessionConnectionOptions =
  | (GatewayConnection & { readonly connectPeer?: never; readonly peerFallback?: never })
  | {
      readonly connectPeer: (signal: AbortSignal, binding: RemoteBindingV1) => Promise<RemotePeerConnection>;
      readonly http?: never;
      readonly webSocketFactory?: never;
      readonly peerFallback?: never;
    }
  | (GatewayConnection & {
      /** Return undefined when peer transport is unavailable. Errors remain terminal for this attempt. */
      readonly connectPeer: (signal: AbortSignal, binding: RemoteBindingV1) => Promise<RemotePeerConnection | undefined>;
      readonly peerFallback: true;
    });

export type RemoteSessionAuthentication =
  | { readonly route: LingServerGatewayRouteV1 }
  | { readonly proof: RemoteAuthProofV1 };

interface AuthenticationContext {
  readonly binding: RemoteBindingV1;
  readonly keys: RemoteDeviceKeyAdapter;
  readonly entropy: RemoteEntropy;
  readonly clock: RemoteClock;
  assertCurrent(): void;
  readResumeCursors(): Promise<readonly RemoteResumeCursorV1[]>;
}

export async function openRemoteSessionChannel(
  options: RemoteSessionConnectionOptions,
  context: AuthenticationContext,
  signal: AbortSignal,
): Promise<{ readonly channel: RemoteMessageChannel; readonly authentication: RemoteSessionAuthentication }> {
  const { binding, clock } = context;
  if (options.connectPeer) {
    const peer = await options.connectPeer(signal, binding);
    if (peer !== undefined) {
      const { route, transport } = peer;
      try {
        context.assertCurrent();
        const profile = binding.lingServerRoutingProfile;
        if ((profile && (profile.bindingId !== route.bindingId || profile.installationId !== route.installationId
          || profile.applicationKeyFingerprint !== route.applicationKeyFingerprint || profile.serverOrigin !== route.serverOrigin))
          || transport.readyState !== 1 || route.gatewayId !== binding.gatewayId
          || route.gatewayKeyFingerprint !== binding.gatewayIdentityFingerprint || route.mobileDeviceId !== binding.deviceId
          || route.peerEpoch !== binding.deviceEpoch || !(Date.parse(route.expiresAt) > Date.parse(clock.now()))) {
          throw new Error("remote_peer_binding_mismatch");
        }
        return { channel: transport, authentication: { route } };
      } catch (error) {
        transport.close(1008, "peer_binding_unavailable");
        throw error;
      }
    }
    if (!options.peerFallback) throw new Error("remote_peer_unavailable");
  }

  context.assertCurrent();
  signal.throwIfAborted();
  const response = await options.http.postJson<unknown>(binding.gatewayOrigin, "/v1/auth/challenge", { deviceId: binding.deviceId }, { signal });
  const proof = await createRemoteSessionProof(context, response.body);
  context.assertCurrent();
  const socket = options.webSocketFactory(remoteWebSocketUrl(binding.gatewayOrigin), [
    REMOTE_DEVICE_TASKS_SUBPROTOCOL_V6,
    REMOTE_DEVICE_TASKS_SUBPROTOCOL_V5,
    REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4,
    REMOTE_DEVICE_TASKS_SUBPROTOCOL_V3,
    REMOTE_DEVICE_TASKS_SUBPROTOCOL_V2,
    REMOTE_DEVICE_TASKS_SUBPROTOCOL_V1,
  ]);
  return { channel: remoteWebSocketChannel(socket), authentication: { proof } };
}

export async function createRemoteSessionProof(
  context: AuthenticationContext,
  value: unknown,
  route?: LingServerGatewayRouteV1,
): Promise<RemoteAuthProofV1> {
  context.assertCurrent();
  const { binding, keys, entropy, clock } = context;
  const challenge = validateRemoteAuthChallengeV1(value, { nowMs: Date.parse(clock.now()) });
  if (
    challenge.gatewayId !== binding.gatewayId
    || challenge.deviceEpoch !== binding.deviceEpoch
    || !challenge.supportedProtocolVersions.includes(REMOTE_PROTOCOL_VERSION)
    || (route && Date.parse(challenge.expiresAt) > Date.parse(route.expiresAt))
  ) {
    throw new Error("remote_auth_challenge_identity_mismatch");
  }
  const { gatewaySignature, ...unsignedChallenge } = challenge;
  const challengeValid = await keys.verify(
    binding.gatewayIdentityPublicKeyJwk,
    authChallengeSigningBytes(authChallengeSigningInput(binding.gatewayOrigin, unsignedChallenge), route),
    gatewaySignature,
  );
  context.assertCurrent();
  if (!challengeValid) throw new Error("remote_auth_gateway_signature_invalid");
  const resume = await context.readResumeCursors();
  context.assertCurrent();
  const clientNonce = encodeBase64Url(await entropy.randomBytes(32));
  context.assertCurrent();
  const unsignedProof: Omit<RemoteAuthProofV1, "signature"> = {
    version: REMOTE_PROTOCOL_VERSION,
    gatewayId: binding.gatewayId,
    challengeId: challenge.challengeId,
    candidateSessionId: challenge.candidateSessionId,
    deviceId: binding.deviceId,
    deviceEpoch: binding.deviceEpoch,
    clientNonce,
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    resume,
  };
  const signingInput = await authProofSigningInput(binding.gatewayOrigin, unsignedChallenge, unsignedProof, sha256);
  context.assertCurrent();
  const signature = await keys.sign(binding.deviceKeyId, authProofSigningBytes(signingInput, route));
  context.assertCurrent();
  return { ...unsignedProof, signature };
}
