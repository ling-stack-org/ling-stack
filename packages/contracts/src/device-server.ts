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
