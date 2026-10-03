import type { RuntimeAttemptFenceV1 } from "./runtime-supervisor-types.js";

/** Original dispatch identity. A successor's active fence must never replace this source. */
export interface HostOperationSource extends RuntimeAttemptFenceV1 { readonly runId: string }
export type HostOperationKind = "command" | "file_mutation" | "mcp" | "plugin" | "media" | "host_capability"
  | "approval" | "permission" | "approval_review" | "hydration" | "sdk_tool" | "cleanup";
declare const hostOperationTicket: unique symbol;
/** Only the admitting store owns this live capability. IDs and persisted rows are not replay authority. */
export interface HostOperationTicket {
  readonly operationId: string;
  readonly [hostOperationTicket]: true;
}
export interface AdmitHostOperationInput {
  readonly operationId: string;
  readonly source: HostOperationSource;
  readonly kind: HostOperationKind;
  readonly toolCallId: string;
  readonly parentOperationId?: string;
  readonly producerId?: string;
  readonly admittedAt?: string;
}
/** Exact immutable domain identity, not a guessed match by toolCallId. */
export type HostOperationEvidenceRef =
  | { readonly kind: "harness_tool_execution"; readonly id: string }
  | { readonly kind: "host_command"; readonly id: string }
  | { readonly kind: "media_chain_execution"; readonly id: string }
  | { readonly kind: "media_transport_execution"; readonly id: string };
export type HostOperationSettlementInput =
  | { readonly kind: "known_no_start"; readonly settledAt?: string }
  | { readonly kind: "file_completed"; readonly settledAt?: string }
  | { readonly kind: "media_response_completed"; readonly settledAt?: string }
  | { readonly kind: "media_remote_terminal"; readonly settledAt?: string }
  | { readonly kind: "media_chain_completed"; readonly settledAt?: string }
  | { readonly kind: "unknown_outcome"; readonly code: string; readonly settledAt?: string };
export interface HostOperationRecord {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly source: HostOperationSource;
  readonly kind: HostOperationKind;
  readonly toolCallId: string;
  readonly parentOperationId?: string;
  readonly producerId?: string;
  readonly phase: "admitted" | "launched" | "safe" | "unknown_outcome";
  readonly evidenceRef?: HostOperationEvidenceRef;
  readonly admittedAt: string;
  readonly launchedAt?: string;
  readonly settledAt?: string;
  readonly settlementKind?: HostOperationSettlementInput["kind"];
  readonly evidenceDigest?: string;
  readonly code?: string;
  readonly revision: number;
}
export class HostOperationJournalError extends Error {
  constructor(readonly code: string) { super(code); this.name = "HostOperationJournalError"; }
}
