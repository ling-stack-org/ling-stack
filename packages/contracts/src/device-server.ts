import type { JsonValue } from "./device.js";

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
  readonly preferred: "lan" | "direct" | "relay";
  readonly selected?: "lan" | "direct" | "relay";
  readonly status: "gathering" | "checking" | "connected" | "failed" | "expired";
  readonly expiresAt: string;
}

export interface LingServerPeerSessionV1 {
  readonly sessionId: string;
  readonly bindingId: string;
  readonly peerEpoch: number;
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

export interface LingServerCommandReceiptV1 {
  readonly commandId: string;
  readonly payloadDigest: string;
  readonly status: "accepted" | "completed" | "failed" | "unknown";
  readonly result?: JsonValue;
  readonly recordedAt: string;
}
