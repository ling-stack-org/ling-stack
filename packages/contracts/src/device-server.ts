import type { JsonValue } from "./device.js";
import type { RemoteP256PublicJwkV1 } from "./remote-access.js";

export const LING_SERVER_PEER_FRAME_DEFAULT_BYTES_V1 = 256 * 1024;
export const LING_SERVER_PEER_FRAME_MAX_BYTES_V1 = 4 * 1024 * 1024;

export interface LingServerInstallationV1 {
  readonly installationId: string;
  readonly serverOrigin: string;
  readonly applicationKeyFingerprint: string;
  readonly revision: number;
  readonly status: "active" | "draining" | "revoked";
}

export interface LingServerPeerBindingV1 {
  readonly bindingId: string;
  readonly installationId: string;
  readonly gatewayId: string;
  readonly mobileDeviceId: string;
  readonly gatewayKeyFingerprint: string;
  readonly mobileKeyFingerprint: string;
  readonly epoch: number;
  readonly revision: number;
  readonly status: "active" | "revoked";
}

export interface LingServerRouteAttemptV1 {
  readonly routeAttemptId: string;
  readonly bindingId: string;
  readonly peerEpoch?: number;
  readonly preferred: "lan" | "direct" | "relay";
  readonly selected?: "lan" | "direct" | "relay";
  readonly status: "gathering" | "checking" | "connected" | "failed" | "expired";
  readonly expiresAt: string;
}

export interface LingServerPeerSessionV1 {
  readonly sessionId: string;
  readonly bindingId: string;
  readonly peerEpoch: number;
  readonly localRole?: LingServerPeerRoleV1;
  readonly routeAttemptId: string;
  readonly route: "lan" | "direct" | "relay";
  readonly transportGeneration: number;
  readonly sendSequence: number;
  readonly receivedSequence: number;
  readonly status: "open" | "replaced" | "closed";
  readonly openedAt: string;
  readonly lastSeenAt: string;
}

export interface LingServerPeerFrameV1 {
  readonly frameId: string;
  readonly sessionId: string;
  readonly bindingId: string;
  readonly peerEpoch: number;
  readonly transportGeneration: number;
  readonly sequence: number;
  readonly direction: "to_gateway" | "to_mobile";
  readonly kind: "conversation" | "device_task" | "developer" | "receipt" | "control";
  readonly commandId?: string;
  readonly payload: JsonValue;
  readonly sentAt: string;
}

export interface LingServerPeerResumeCursorV1 {
  readonly transportGeneration: number;
  readonly direction: LingServerPeerFrameV1["direction"];
  readonly sequence: number;
}

export interface LingServerCommandReceiptV1 {
  readonly commandId: string;
  readonly payloadDigest: string;
  readonly status: "accepted" | "completed" | "failed" | "unknown";
  readonly result?: JsonValue;
  readonly recordedAt: string;
}

export type LingServerPeerRoleV1 = "gateway" | "mobile";
export type LingServerTransportRouteV1 = "lan" | "direct" | "relay";

export const LING_SERVER_SIGNAL_PAYLOAD_BYTES_V1 = 32 * 1024;
export const LING_SERVER_SIGNAL_LANE_LIMIT_V1 = 96;
export const LING_SERVER_SIGNAL_PAGE_LIMIT_V1 = 8;
export const LING_SERVER_SIGNAL_ROUTE_LIFETIME_MS_V1 = 5 * 60_000;

export type LingServerSignalingOperationV1 =
  | { readonly kind: "publish"; readonly sequence: number; readonly messageType: "offer" | "answer" | "ice_candidate"; readonly payload: string }
  | { readonly kind: "poll"; readonly nonce: string; readonly afterSequence: number }
  | { readonly kind: "transport_config"; readonly nonce: string };

export interface LingServerSignalingInputV1 {
  readonly version: 1;
  readonly instanceId: string;
  readonly installationId: string;
  readonly applicationKeyFingerprint: string;
  readonly bindingId: string;
  readonly routeAttemptId: string;
  readonly preferredRoute: LingServerTransportRouteV1;
  readonly peerEpoch: number;
  readonly gatewayId: string;
  readonly mobileDeviceId: string;
  readonly role: LingServerPeerRoleV1;
  readonly protocolMajor: number;
  readonly features: readonly string[];
  readonly expiresAt: string;
  readonly operation: LingServerSignalingOperationV1;
}

export interface LingServerSignedSignalingV1 {
  readonly input: LingServerSignalingInputV1;
  readonly publicKeyJwk: RemoteP256PublicJwkV1;
  readonly signature: string;
}

export type LingServerSignalingResponseV1 =
  | { readonly kind: "published"; readonly sequence: number; readonly replayed: boolean }
  | { readonly kind: "signals"; readonly messages: readonly LingServerSignedSignalingV1[]; readonly latestSequence: number; readonly hasMore: boolean }
  | {
      readonly kind: "transport_config";
      readonly route: LingServerTransportRouteV1;
      readonly stunUrls: readonly string[];
      readonly turnUrls: readonly string[];
      readonly relayCredential?: LingServerRelayCredentialV1;
    };

export interface LingServerRelayCredentialV1 {
  readonly url: string;
  readonly username: string;
  readonly credential: string;
  readonly expiresAt: string;
}

/** Ephemeral configuration handed to a native WebRTC or equivalent transport adapter. */
export interface LingServerPeerTransportConfigV1 {
  readonly schemaVersion: 1;
  readonly bindingId: string;
  readonly routeAttemptId: string;
  readonly role: LingServerPeerRoleV1;
  readonly route: LingServerTransportRouteV1;
  readonly peerEpoch: number;
  readonly serverOrigin: string;
  readonly applicationKeyFingerprint: string;
  readonly localKeyFingerprint: string;
  readonly remoteKeyFingerprint: string;
  readonly protocolMajor: number;
  readonly features: readonly string[];
  readonly stunUrls: readonly string[];
  readonly turnUrls: readonly string[];
  readonly relayCredential?: LingServerRelayCredentialV1;
  readonly expiresAt: string;
  readonly maxFrameBytes: number;
}

export type LingServerTransportDiagnosticCheckIdV1 =
  | "control_reachability"
  | "peer_presence"
  | "signaling"
  | "candidate_gathering"
  | "peer_handshake"
  | "cursor_resume"
  | "relay_quota"
  | "revocation";

export type LingServerTransportDiagnosticStatusV1 = "pass" | "fail" | "unknown";

export interface LingServerTransportDiagnosticCheckV1 {
  readonly id: LingServerTransportDiagnosticCheckIdV1;
  readonly status: LingServerTransportDiagnosticStatusV1;
  readonly code: string;
  readonly latencyMs?: number;
}

/** Redacted, persisted route diagnostics. Credentials and candidate payloads never enter this record. */
export interface LingServerTransportDiagnosticsV1 {
  readonly diagnosticId: string;
  readonly bindingId: string;
  readonly routeAttemptId: string;
  readonly peerEpoch: number;
  readonly transportGeneration?: number;
  readonly selectedRoute?: LingServerTransportRouteV1;
  readonly checks: readonly LingServerTransportDiagnosticCheckV1[];
  readonly localCandidateCount?: number;
  readonly remoteCandidateCount?: number;
  readonly requestedResumeSequence?: number;
  readonly replayedFrameCount?: number;
  readonly requiresSnapshot?: boolean;
  readonly generatedAt: string;
}
