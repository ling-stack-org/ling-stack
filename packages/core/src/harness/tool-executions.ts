import { createHash, randomUUID } from "node:crypto";
import type {
  HarnessToolExecutionFailureCode,
  HarnessToolExecutionState,
  HarnessToolExecutionV1,
} from "@ling-stack/contracts";
import type { RuntimeAttemptFenceV1 } from "../runtime-supervisor-types.js";
import { transitionHarnessEntity, type HarnessTransitionResult } from "./common.js";

const transitions: Readonly<Record<HarnessToolExecutionState, ReadonlySet<HarnessToolExecutionState>>> = {
  proposed: new Set(["prepared", "cancelled", "failed", "superseded"]),
  prepared: new Set(["approval_pending", "approved", "cancelled", "failed", "superseded"]),
  approval_pending: new Set(["approved", "denied", "cancelled", "superseded"]),
  approved: new Set(["claimed", "cancelled", "failed", "superseded"]),
  claimed: new Set(["executing", "cancelled", "failed", "superseded", "unknown_outcome"]),
  executing: new Set(["committing_evidence", "cancelled", "failed", "unknown_outcome"]),
  committing_evidence: new Set(["succeeded", "failed", "unknown_outcome"]),
  succeeded: new Set(),
  denied: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  superseded: new Set(),
  unknown_outcome: new Set(),
};

export function transitionHarnessToolExecution(input: {
  readonly current: HarnessToolExecutionV1;
  readonly expectedRevision: number;
  readonly nextState: HarnessToolExecutionState;
  readonly now: string;
}): HarnessTransitionResult<HarnessToolExecutionV1> {
  return transitionHarnessEntity({
    current: input.current,
    expectedRevision: input.expectedRevision,
    nextState: input.nextState,
    allowedNextStates: transitions[input.current.state],
    update: (revision, state) => ({ ...input.current, state, revision, updatedAt: input.now }),
  });
}

export function harnessToolExecutionIdempotencyKey(attemptId: string, toolCallId: string): string {
  return `harness-tool:${attemptId}:${toolCallId}`;
}

export function createHarnessToolExecutionId(): string {
  return `tool_execution_${randomUUID()}`;
}

export function digestHarnessToolValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value)), "utf8").digest("hex");
}

export type HarnessToolApprovalState = "allowed" | "approval_pending" | "denied";

export interface PrepareHarnessToolExecutionInput {
  readonly id?: string;
  readonly runId: string;
  readonly workUnitId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly continuationId?: string;
  readonly delegationStepId?: string;
  readonly supersedesExecutionId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly executorKind: HarnessToolExecutionV1["executorKind"];
  readonly requestDigest: string;
  readonly sideEffectFingerprint: string;
  readonly policySnapshotArtifactId: string;
  readonly approvalId?: string;
  readonly approvalState: HarnessToolApprovalState;
  readonly sandboxProfileId: string;
  readonly failureCode?: Extract<HarnessToolExecutionFailureCode, "tool.policy_denied" | "tool.approval_denied">;
  readonly resultSummary?: Readonly<Record<string, unknown>>;
  readonly now: string;
}

export interface PreparedHarnessToolExecution {
  readonly execution: HarnessToolExecutionV1;
  readonly replayed: boolean;
}

export type HarnessToolExecutionMutationCode =
  | "not_found"
  | "stale_revision"
  | "invalid_transition"
  | "lease_not_claimable"
  | "lease_mismatch"
  | "tool.stale_attempt"
  | "tool.evidence_invalid";

export type HarnessToolExecutionMutationResult =
  | { readonly ok: true; readonly value: HarnessToolExecutionV1; readonly replayed: boolean }
  | { readonly ok: false; readonly code: HarnessToolExecutionMutationCode };

export interface ResolveHarnessToolApprovalInput {
  readonly executionId: string;
  readonly expectedRevision: number;
  readonly approvalId: string;
  readonly nextState: Extract<HarnessToolExecutionState, "approved" | "denied" | "cancelled">;
  readonly failureCode?: Extract<HarnessToolExecutionFailureCode, "tool.approval_denied" | "tool.execution_cancelled">;
  readonly resultSummary?: Readonly<Record<string, unknown>>;
  readonly now: string;
}

export interface ClaimHarnessToolExecutionInput {
  readonly executionId: string;
  readonly expectedRevision: number;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly claimExpiresAt: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly now: string;
}

export interface StartHarnessToolExecutionInput {
  readonly executionId: string;
  readonly expectedRevision: number;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly now: string;
}

export interface FinishHarnessToolExecutionInput {
  readonly executionId: string;
  readonly expectedRevision: number;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly nextState: Extract<HarnessToolExecutionState, "succeeded" | "failed" | "cancelled" | "unknown_outcome">;
  readonly resultDigest: string;
  readonly resultSummary: Readonly<Record<string, unknown>>;
  readonly evidenceArtifactIds: readonly string[];
  readonly failureCode?: HarnessToolExecutionFailureCode;
  readonly now: string;
}

export interface FailApprovedHarnessToolExecutionInput {
  readonly executionId: string;
  readonly expectedRevision: number;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly nextState: Extract<HarnessToolExecutionState, "failed" | "cancelled" | "superseded">;
  readonly failureCode: HarnessToolExecutionFailureCode;
  readonly resultSummary?: Readonly<Record<string, unknown>>;
  readonly now: string;
}

export interface ReconcileAbandonedHarnessToolExecutionsInput {
  readonly now: string;
  readonly limit?: number;
}

export type HarnessToolExecutionStoreErrorCode =
  | "tool.invalid_input"
  | "tool.idempotency_conflict"
  | "tool.lineage_mismatch"
  | "tool.policy_snapshot_missing"
  | "tool.approval_invalid";

export class HarnessToolExecutionStoreError extends Error {
  constructor(readonly code: HarnessToolExecutionStoreErrorCode) {
    super(code);
    this.name = "HarnessToolExecutionStoreError";
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}
