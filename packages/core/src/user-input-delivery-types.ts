/** Host-only durable delivery state. A claim or reserved Run ID is NOT receiver acknowledgment. */
export interface UserInputDelivery {
  readonly deliveryId: string;
  readonly answerId: string;
  readonly requestId: string;
  readonly requestVersion: number;
  readonly threadId: string;
  readonly consumerWorkUnitId: string;
  readonly status: "pending" | "claimed" | "applied" | "failed" | "obsolete";
  readonly revision: number;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Stable intent, allocated once. Does not imply this Run has been created. */
  readonly successorRunId: string | null;
  readonly claim: { readonly ownerId: string; readonly token: string; readonly expiresAt: string } | null;
  readonly retryAt: string | null;
  readonly lastErrorCode: UserInputDeliveryRetryCode | null;
}
export type UserInputDeliveryRetryCode = "receiver_unavailable" | "receiver_rejected" | "recoverable_failure";
export interface UserInputDeliveryCursor {
  readonly createdAt: string;
  readonly deliveryId: string;
}
export interface ListDueUserInputDeliveries {
  /** Optional thread scope for UI/audit callers. Daemon recovery scans the workspace outbox. */
  readonly threadId?: string;
  readonly after?: UserInputDeliveryCursor;
  readonly limit?: number;
}
export interface ClaimUserInputDelivery {
  readonly threadId: string;
  readonly deliveryId: string;
  readonly expectedRevision: number;
  /** Host scheduler worker identity, never a model-supplied Agent selector. */
  readonly ownerId: string;
  readonly leaseMs: number;
}
export interface RetryUserInputDelivery {
  readonly threadId: string;
  readonly deliveryId: string;
  readonly expectedRevision: number;
  readonly ownerId: string;
  readonly claimToken: string;
  readonly retryAt: string;
  readonly errorCode: UserInputDeliveryRetryCode;
}
