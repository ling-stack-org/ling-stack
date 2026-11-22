import {
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V1,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V2,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V3,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4,
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

export type RemoteSessionConnectionOptions =
  | { readonly http: RemoteHttpClient; readonly webSocketFactory: RemoteWebSocketFactory; readonly connectPeer?: never }
  | {
      readonly connectPeer: (signal: AbortSignal) => Promise<{
        readonly route: LingServerGatewayRouteV1;
        readonly transport: RemoteMessageChannel;
      }>;
      readonly http?: never;
      readonly webSocketFactory?: never;
    };

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
    const { route, transport } = await options.connectPeer(signal);
    try {
      context.assertCurrent();
      if (transport.readyState !== 1 || route.gatewayId !== binding.gatewayId
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

  const response = await options.http.postJson<unknown>(binding.gatewayOrigin, "/v1/auth/challenge", { deviceId: binding.deviceId }, { signal });
  const proof = await createRemoteSessionProof(context, response.body);
  context.assertCurrent();
  const socket = options.webSocketFactory(remoteWebSocketUrl(binding.gatewayOrigin), [
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
