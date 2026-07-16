export const COMPUTER_USE_RUNTIME_STATUSES = [
  "starting",
  "running",
  "waiting_for_approval",
  "paused",
  "stopping",
  "succeeded",
  "failed",
  "cancelled",
] as const;

/**
 * Header used by trusted native clients when a Computer Use request has no
 * browser Origin. The value is an installation-scoped secret; it must never
 * be placed in a URL or exposed to the Web renderer.
 */
export const COMPUTER_USE_ROUTE_TOKEN_HEADER = "X-Ling-Computer-Use-Token" as const;

export type ComputerUseRuntimeStatus = (typeof COMPUTER_USE_RUNTIME_STATUSES)[number];

export type ComputerUseTargetKind = "application" | "window" | "display" | "browser";

export interface ComputerUseTargetMetadata {
  readonly kind: ComputerUseTargetKind;
  readonly displayName: string;
  readonly applicationId?: string;
}

/**
 * Renderer-safe reference to a Desktop-owned preview source.
 *
 * descriptorId is deliberately opaque. Native handles, Electron desktop source IDs,
 * capture credentials, and platform window numbers must never be serialized here.
 */
export interface ComputerUsePreviewDescriptorReference {
  readonly descriptorId: string;
  readonly revision: number;
  readonly aspectRatio?: number;
  readonly cursorAvailable: boolean;
}

export interface ComputerUseApprovalRequired {
  readonly approvalId: string;
  readonly summary: string;
}

export interface ComputerUseFailure {
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
}

export interface ComputerUsePreviewProjection {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly workUnitId?: string;
  readonly status: ComputerUseRuntimeStatus;
  readonly target: ComputerUseTargetMetadata;
  readonly preview?: ComputerUsePreviewDescriptorReference;
  readonly approvalRequired?: ComputerUseApprovalRequired;
  readonly failure?: ComputerUseFailure;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string;
}

export interface ComputerUsePreviewListResponse {
  readonly cwd: string;
  readonly projections: readonly ComputerUsePreviewProjection[];
}

export interface ComputerUsePreviewSnapshotResponse extends ComputerUsePreviewListResponse {
  readonly latestSeq: number;
}

export interface ComputerUsePreviewEvent {
  readonly seq: number;
  readonly kind: "upsert" | "remove";
  readonly sessionId: string;
  readonly projection?: ComputerUsePreviewProjection;
  readonly occurredAt: string;
}

export interface ComputerUsePreviewEventsResponse {
  readonly cwd: string;
  readonly afterSeq: number;
  readonly latestSeq: number;
  readonly events: readonly ComputerUsePreviewEvent[];
}

export interface StopComputerUseRequest {
  readonly reason?: string;
}

export interface StopComputerUseResponse {
  readonly sessionId: string;
  readonly accepted: boolean;
  readonly acknowledged: boolean;
  readonly auditId: string;
  readonly projection: ComputerUsePreviewProjection;
  readonly reason?: string;
  readonly acknowledgedAt?: string;
}

export function isComputerUseRuntimeStatus(value: unknown): value is ComputerUseRuntimeStatus {
  return typeof value === "string" && (COMPUTER_USE_RUNTIME_STATUSES as readonly string[]).includes(value);
}

export function isTerminalComputerUseStatus(status: ComputerUseRuntimeStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
