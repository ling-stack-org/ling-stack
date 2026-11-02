import type { DelegationBudgetV1 } from "@ling-stack/contracts";
import type { CreateRunArtifactInput, CreateRunInput, RunArtifact, RunSession } from "../run-types.js";
import type { CreateWorkUnitInput, RuntimeAttemptFenceV1, WorkUnit } from "../runtime-supervisor-types.js";
import type { DelegationPriceScope, DelegationRootBudgetSnapshot, DelegationTokenPriceSnapshot } from "./delegation-authority.js";

export type DelegationWriteErrorCode = `delegation.${
  "invalid_input" | "source_attempt_stale" | "parent_not_running" | "root_budget_missing"
  | "root_budget_conflict" | "lineage_invalid" | "workflow_lineage_invalid" | "authority_invalid"
  | "capability_escalation" | "price_unknown" | "price_scope_conflict" | "deadline_exceeded"
  | "budget_exhausted" | "depth_exceeded" | "cycle_detected" | "idempotency_conflict"
  | "persisted_fact_invalid" | "settlement_conflict" | "settlement_incomplete"}`;

export class DelegationWriteError extends Error {
  constructor(readonly code: DelegationWriteErrorCode) {
    super(code);
    this.name = "DelegationWriteError";
  }
}

/** Canonical roots are resolved by the Host (including symlinks), never by a model. */
export interface DelegationWorkspaceGrant {
  readonly path: string;
  readonly access: "read" | "write";
}

export interface DelegationExecutionAuthority {
  readonly schemaVersion: 1;
  readonly authoritySetId: string;
  readonly sourceRevision: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly participantId?: string;
  readonly participantIds: readonly string[];
  readonly runnerIds: readonly string[];
  /** Absolute delegation-tree depth limit from resolved Host configuration. */
  readonly maxDepth: number;
  readonly sandbox: "read_only" | "workspace_write" | "full_access";
  readonly mayEscalate: boolean;
  readonly tools: readonly string[];
  readonly toolDecisions: Readonly<Record<string, "deny" | "ask" | "allow">>;
  readonly workspaceRoots: readonly DelegationWorkspaceGrant[];
  readonly providers: readonly DelegationPriceScope[];
  readonly networkScopes: readonly string[];
  /** References only. Plaintext credentials and arbitrary headers are not accepted. */
  readonly secretRefs: readonly string[];
}

export interface DelegationAuthorityCapture {
  readonly rootRunId: string;
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly authority: DelegationExecutionAuthority;
  readonly budget?: DelegationBudgetV1;
  readonly price?: DelegationTokenPriceSnapshot;
  readonly currency: string;
  readonly provider: DelegationPriceScope;
  readonly runnerId: string;
}

export interface DelegationUsageReceipt {
  readonly kind: "measured" | "cancelled_before_dispatch" | "unknown";
  readonly runId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
}

export interface DelegationChildReceipt {
  readonly kind: "verified_usage" | "no_dispatch" | "unknown";
  readonly childRunId: string;
  /** Required for terminal usage; a stale Attempt cannot settle a resumed Run. */
  readonly sourceFence?: RuntimeAttemptFenceV1;
}

/**
 * Constructor-only custody bridge. The production Host issues opaque objects in
 * a private WeakMap; DTO shape/digest/artifact identity never authenticates one.
 * None of these operations belong on the public RunStore mutation interface.
 */
export interface DelegationWriteAuthorityPorts {
  readonly readCapture: (capture: unknown) => DelegationAuthorityCapture;
  readonly readCurrentAuthority: (runId: string, fence: RuntimeAttemptFenceV1) => DelegationExecutionAuthority;
  readonly readUsageReceipt: (receipt: unknown) => DelegationUsageReceipt;
  readonly readChildReceipt: (receipt: unknown) => DelegationChildReceipt;
}

export interface DelegationWriteStorePorts extends DelegationWriteAuthorityPorts {
  readonly getRun: (id: string) => RunSession | undefined;
  readonly getWorkUnit: (id: string) => WorkUnit | undefined;
  readonly createRunWithinTransaction: (input: CreateRunInput) => RunSession;
  readonly createWorkUnitWithinTransaction: (input: CreateWorkUnitInput) => WorkUnit;
  readonly linkWorkUnitRunWithinTransaction: (workUnitId: string, runId: string, now: string) => number;
  readonly createArtifactWithinTransaction: (input: CreateRunArtifactInput) => RunArtifact;
  readonly getArtifact: (id: string) => RunArtifact | undefined;
}

export interface DelegationRootBudgetRecord extends DelegationRootBudgetSnapshot {
  readonly schemaVersion: 1;
  readonly authorityArtifactId: string;
  readonly authorityDigest: string;
  readonly priceArtifactId?: string;
  readonly priceDigest?: string;
  readonly createdAt: string;
}

export interface DelegationBudgetReservation {
  readonly id: string;
  readonly rootRunId: string;
  readonly delegationStepId: string;
  readonly parentReservationId?: string;
  readonly childRunId: string;
  readonly requestDigest: string;
  readonly tokenReserved?: number;
  readonly costReservedMicros?: number;
  readonly deadlineAt: string;
  readonly state: "reserved" | "settled" | "released" | "unresolved";
  readonly settledTokenUsage?: number;
  readonly settledCostMicros?: number;
  readonly settlementDigest?: string;
  readonly failureCode?: "delegation.usage_unknown";
  readonly idempotencyKey: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly settledAt?: string;
}

export interface DelegationBudgetCharge {
  readonly id: string;
  readonly rootRunId: string;
  readonly reservationId?: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly requestDigest: string;
  readonly priceArtifactId?: string;
  readonly priceDigest?: string;
  readonly reservedTokens?: number;
  readonly reservedCostMicros?: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly actualCostMicros?: number;
  readonly state: "reserved" | "measured" | "cancelled_before_dispatch" | "unresolved";
  readonly idempotencyKey: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly settledAt?: string;
}

export interface PrepareDelegatedChildInput {
  readonly parentRunId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly spawnCallId: string;
  readonly objective: string;
  readonly requestedBudget: DelegationBudgetV1;
  readonly required: boolean;
  readonly capture: unknown;
  readonly now: string;
}

export interface PreparedDelegatedChild {
  readonly stepId: string;
  readonly reservation: DelegationBudgetReservation;
  readonly childRun: RunSession;
  readonly childWorkUnit: WorkUnit;
  readonly replayed: boolean;
}

export interface ReserveDelegationModelInvocationInput {
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly invocationId: string;
  /** Exact safe upper bound supplied by the actual Provider adapter. */
  readonly reservedTokens?: number;
  readonly reservedCostMicros?: number;
  readonly capture: unknown;
  readonly now: string;
}
