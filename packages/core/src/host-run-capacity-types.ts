export interface HostRunCapacityStoreOptions {
  readonly globalDatabasePath: string;
  readonly busyTimeoutMs?: number;
}

export interface HostRunCapacityPolicy {
  readonly revision: number;
  readonly maxConcurrentRuns: number;
  readonly installedAt: string;
}

export interface HostRunCapacityWorkspaceIdentity {
  readonly workspaceKey: string;
  readonly canonicalCwd: string;
  readonly databasePath: string;
  /** Opaque file identity supplied and verified by the workspace bridge. */
  readonly databaseFileIdentity: string;
}

export interface HostRunCapacityIntent extends HostRunCapacityWorkspaceIdentity {
  readonly intentId: string;
  readonly ownerKind: "attempt" | "workflow_start" | "delegation_spawn" | "approval_resume_pending" | "user_input_continuation";
  readonly ownerKey: string;
  readonly authorityDigest: string;
}

export type HostRunCapacityReleaseKind = "no_dispatch" | "stopped";

export interface HostRunCapacityReservation {
  readonly reservationId: string;
  readonly token: string;
  readonly intent: HostRunCapacityIntent;
  readonly policyRevision: number;
  readonly reservedAt: string;
  readonly state: "held" | "released";
  readonly releasedAt?: string;
  readonly releaseKind?: HostRunCapacityReleaseKind;
  readonly releaseProofDigest?: string;
}

export interface InstallHostRunCapacityPolicyInput {
  readonly expectedRevision: number;
  readonly maxConcurrentRuns: number;
  readonly installedAt: string;
}

export type InstallHostRunCapacityPolicyResult =
  | { readonly status: "installed" | "duplicate"; readonly policy: HostRunCapacityPolicy }
  | { readonly status: "changed" };

export interface ReserveHostRunCapacityInput {
  readonly intent: HostRunCapacityIntent;
  readonly now: string;
}

export type ReserveHostRunCapacityResult =
  | { readonly status: "reserved" | "duplicate" | "released"; readonly reservation: HostRunCapacityReservation }
  | { readonly status: "full"; readonly policy: HostRunCapacityPolicy }
  | { readonly status: "conflict" | "unconfigured" };

export interface ReleaseHostRunCapacityInput {
  readonly reservationId: string;
  readonly token: string;
  readonly intent: HostRunCapacityIntent;
  readonly kind: HostRunCapacityReleaseKind;
  readonly proofDigest: string;
  /** Canonical UTC release time, at or after the bound reservation's reservedAt. */
  readonly now: string;
}

export type ReleaseHostRunCapacityResult =
  | { readonly status: "released" | "duplicate"; readonly reservation: HostRunCapacityReservation }
  | { readonly status: "changed" };

export interface ListHeldHostRunCapacityInput {
  readonly afterReservationId?: string;
  readonly limit?: number;
}

export interface HostRunCapacityPage {
  readonly reservations: readonly HostRunCapacityReservation[];
  readonly nextCursor?: string;
}

export interface HostRunCapacityCounts {
  readonly held: number;
  readonly released: number;
  readonly total: number;
}
