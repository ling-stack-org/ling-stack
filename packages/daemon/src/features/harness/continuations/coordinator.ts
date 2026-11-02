import { createHash, randomUUID } from "node:crypto";
import type {
  ConversationContextProjectionMetadata,
  ConversationDomainRef,
  RunnerContinuationOrigin,
  RunnerContinuationState,
  RunnerContinuationV1,
} from "@ling-stack/contracts";
import {
  createWorkUnitAttemptId,
  runnerContinuationIdempotencyKey,
  toRuntimeAttemptFence,
  type EffectiveRunPolicySnapshot,
  type ApprovalResumeContinuationPreparation,
  type PreparedContinuation,
  type RunSession,
  type RunStore,
  type RuntimeInstance,
  type WorkUnit,
  type WorkUnitAttempt,
} from "@ling-stack/core";
import type { PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type { RegisteredRunner } from "../../../runtime/runners.js";
import type { RunRequest } from "../../runs/schemas.js";
import type { PreparedRunnerInput } from "../../runs/prepared-runner-input.js";
import {
  captureRunnerContinuationReplayPackage,
  createRunnerContinuationReplayArtifact,
  type RunnerReplayApprovalEvidenceV1,
} from "./replay-package.js";

const CONTINUATION_LEASE_RECOVERY_MARGIN_MS = 60_000;

export interface RunnerContinuationContextIdentity {
  readonly contextViewId: string;
  readonly contextViewCreatedAt: string;
  readonly projectionVersion: string;
  readonly sourceRefs: readonly ConversationDomainRef[];
}

export interface PreparedRunnerContinuationExecution {
  readonly continuation: RunnerContinuationV1;
  readonly attempt: WorkUnitAttempt;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly claimExpiresAt: string;
}

export interface ExistingRunContinuationPlan {
  readonly preparation: ApprovalResumeContinuationPreparation;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly claimExpiresAt: string;
}

export function resolveHarnessContinuationOrigin(request: RunRequest): RunnerContinuationOrigin | undefined {
  if (request.harnessContinuationOrigin) return request.harnessContinuationOrigin;
  switch (request.continuationReason) {
    case "manual_resume": return "manual_resume";
    case "queue_followup": return "queued_followup";
    case "interrupt_redirect": return "interrupt_redirect";
    default: return undefined;
  }
}

/**
 * Produce a stable execution-view identity even when a conversation surface has
 * not materialized a ChannelContextView row. The basis is accepted Host input,
 * never a mutable recent-message window.
 */
export function resolveRunnerContinuationContext(input: {
  readonly request: RunRequest;
  readonly sourceRunId: string;
  readonly now: string;
}): RunnerContinuationContextIdentity {
  const projection = input.request.contextProjection;
  const contextViewId = projection?.contextViewId ?? `ctxrun_${fingerprint({
    sourceRunId: input.sourceRunId,
    threadId: input.request.threadId,
    turnId: input.request.turnId,
    acceptedSnapshotId: input.request.normalConversationAcceptedSnapshotId,
    preparedRequestRef: input.request.normalConversationPreparedRequestRef,
    projection: projection ? projectionFingerprintBasis(projection) : undefined,
    task: input.request.task,
  })}`;
  return {
    contextViewId,
    contextViewCreatedAt: projection?.contextViewCreatedAt ?? input.now,
    projectionVersion: projection?.projectionVersion ?? "continuity-v2:accepted-run-input-v1",
    sourceRefs: uniqueSourceRefs([
      ...(projection?.sourceRefs ?? []),
      { type: "run", id: input.sourceRunId },
      ...(input.request.threadId ? [{ type: "thread" as const, id: input.request.threadId }] : []),
      ...(input.request.turnId ? [{ type: "turn" as const, id: input.request.turnId }] : []),
    ]),
  };
}

/** Prepare the fresh physical Attempt and its durable replay evidence atomically. */
export function prepareNewRunContinuation(input: {
  readonly store: RunStore;
  readonly request: RunRequest;
  readonly run: RunSession;
  readonly workUnit: WorkUnit;
  readonly sourceRun: RunSession;
  readonly sourceAttempt: WorkUnitAttempt;
  readonly runtime: RuntimeInstance;
  readonly runner: RegisteredRunner;
  readonly requestedRunnerId: string;
  readonly fallbackReason?: WorkUnit["fallbackReason"];
  readonly policySnapshot: EffectiveRunPolicySnapshot;
  readonly execution: PreparedRunnerInput;
  readonly context: RunnerContinuationContextIdentity;
  readonly workspaceCwd: string;
  readonly now: string;
}): PreparedRunnerContinuationExecution {
  if (!input.sourceRun.workUnitId || input.sourceAttempt.workUnitId !== input.sourceRun.workUnitId) {
    throw new Error("Runner continuation source lineage is incomplete.");
  }
  if (input.run.parentRunId !== input.sourceRun.id || input.run.workUnitId !== input.workUnit.id) {
    throw new Error("Runner continuation target lineage is incomplete.");
  }
  const origin = resolveHarnessContinuationOrigin(input.request);
  if (!origin) throw new Error("Runner continuation origin is missing.");
  const rootRunId = resolveRootRunId(input.store, input.sourceRun.id);
  const capabilityRevision = input.runner.nativeResumeConformance.revision;
  const replayPackage = captureRunnerContinuationReplayPackage({
    runId: input.run.id,
    rootRunId,
    workUnitId: input.workUnit.id,
    sourceRunId: input.sourceRun.id,
    sourceWorkUnitId: input.sourceRun.workUnitId,
    origin,
    workspaceCwd: input.workspaceCwd,
    contextViewId: input.context.contextViewId,
    contextProjectionVersion: input.context.projectionVersion,
    contextSourceRefs: input.context.sourceRefs,
    sourceAttempt: input.sourceAttempt,
    runnerId: input.runner.id,
    runnerCapabilityRevision: capabilityRevision,
    policySnapshot: input.policySnapshot,
    execution: input.execution,
    artifactRefs: input.store.listArtifacts(input.sourceRun.id).map((artifact) => artifact.id),
  });
  const replayArtifact = createRunnerContinuationReplayArtifact({
    store: input.store,
    replayPackage,
    createdAt: input.now,
  });
  const prepared = input.store.prepareContinuationAndAttempt({
    runId: input.run.id,
    workUnitId: input.workUnit.id,
    sourceFence: toRuntimeAttemptFence(input.sourceAttempt),
    expectedTargetAttemptId: null,
    origin,
    // Production paths do not yet persist a verified native handle. Deterministic
    // replay is the only honest strategy until such a handle is supplied.
    strategy: "deterministic_replay",
    runnerId: input.runner.id,
    runnerCapabilityRevision: capabilityRevision,
    contextViewId: input.context.contextViewId,
    contextSnapshotArtifactId: replayArtifact.id,
    idempotencyKey: runnerContinuationIdempotencyKey({
      runId: input.run.id,
      sourceAttemptId: input.sourceAttempt.id,
      origin,
      generation: 0,
    }),
    generation: 0,
    targetAttempt: {
      runtimeInstanceId: input.runtime.runtimeInstanceId,
      runnerId: input.runner.id,
      requestedRunnerId: input.requestedRunnerId,
      effectiveRunnerId: input.runner.id,
      fallbackReason: input.fallbackReason,
      providerPresetId: input.run.providerPresetId,
    },
    now: input.now,
  });
  return {
    continuation: prepared.continuation,
    attempt: prepared.attempt,
    claimOwner: input.runtime.runtimeInstanceId,
    claimToken: `continuation-claim:${randomUUID()}`,
    claimExpiresAt: continuationClaimExpiry(input.workUnit, input.now),
  };
}

/** Prepare a replacement Attempt for approval, retry, or daemon recovery on the same logical Run. */
export function prepareExistingRunContinuation(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly workUnit: WorkUnit;
  readonly sourceAttempt: WorkUnitAttempt;
  readonly runtime: RuntimeInstance;
  readonly runner: RegisteredRunner;
  readonly origin: Extract<RunnerContinuationOrigin, "approval_resume" | "runner_retry" | "daemon_recovery">;
  readonly policySnapshot: EffectiveRunPolicySnapshot;
  readonly execution: PreparedRunnerInput;
  readonly workspaceCwd: string;
  readonly now: string;
  readonly idempotencyDiscriminator: string;
  readonly approvalEvidence?: readonly RunnerReplayApprovalEvidenceV1[];
}): PreparedRunnerContinuationExecution {
  const plan = prepareExistingRunContinuationPlan(input);
  const prepared = input.store.prepareContinuationAndAttempt(plan.preparation);
  return materializeExistingRunContinuation(plan, prepared);
}

/**
 * Capture replay evidence and build the exact SQLite preparation request without
 * mutating continuation or Attempt rows. Approval resume uses this so its
 * checkpoint CAS can own those writes in one transaction.
 */
export function prepareExistingRunContinuationPlan(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly workUnit: WorkUnit;
  readonly sourceAttempt: WorkUnitAttempt;
  readonly runtime: RuntimeInstance;
  readonly runner: RegisteredRunner;
  readonly origin: Extract<RunnerContinuationOrigin, "approval_resume" | "runner_retry" | "daemon_recovery">;
  readonly policySnapshot: EffectiveRunPolicySnapshot;
  readonly execution: PreparedRunnerInput;
  readonly workspaceCwd: string;
  readonly now: string;
  readonly idempotencyDiscriminator: string;
  readonly approvalEvidence?: readonly RunnerReplayApprovalEvidenceV1[];
  /** Verified suspension closure may include exact descendant stop artifacts. */
  readonly suspensionArtifactIds?: readonly string[];
}): ExistingRunContinuationPlan {
  if (!input.run.contextViewId || input.run.workUnitId !== input.workUnit.id
    || input.sourceAttempt.workUnitId !== input.workUnit.id
    || input.workUnit.activeAttemptId !== input.sourceAttempt.id) {
    throw new Error("Existing Runner continuation lineage is incomplete.");
  }
  if (input.origin === "approval_resume") {
    if (input.approvalEvidence?.length !== 1 || input.approvalEvidence[0]?.decision !== "approved") {
      throw new Error("Approval Runner continuation evidence is incomplete.");
    }
  } else if (input.approvalEvidence?.length) {
    throw new Error("Non-approval Runner continuation cannot carry approval evidence.");
  }
  const capabilityRevision = input.runner.nativeResumeConformance.revision;
  const turn = input.store.getLingTurnForRun(input.run.id);
  const context: RunnerContinuationContextIdentity = {
    contextViewId: input.run.contextViewId,
    contextViewCreatedAt: input.run.contextViewCreatedAt ?? input.run.createdAt,
    projectionVersion: "continuity-v2:stored-run-input-v1",
    sourceRefs: uniqueSourceRefs([
      { type: "run", id: input.run.id },
      ...(input.run.threadId ? [{ type: "thread" as const, id: input.run.threadId }] : []),
      ...(turn ? [{ type: "turn" as const, id: turn.id }] : []),
    ]),
  };
  const replayPackage = captureRunnerContinuationReplayPackage({
    runId: input.run.id,
    rootRunId: resolveRootRunId(input.store, input.run.id),
    workUnitId: input.workUnit.id,
    sourceRunId: input.run.id,
    sourceWorkUnitId: input.workUnit.id,
    origin: input.origin,
    workspaceCwd: input.workspaceCwd,
    contextViewId: context.contextViewId,
    contextProjectionVersion: context.projectionVersion,
    contextSourceRefs: context.sourceRefs,
    sourceAttempt: input.sourceAttempt,
    runnerId: input.runner.id,
    runnerCapabilityRevision: capabilityRevision,
    policySnapshot: input.policySnapshot,
    execution: input.execution,
    approvalEvidence: input.approvalEvidence,
    artifactRefs: [...new Set([
      ...input.store.listArtifacts(input.run.id).map((artifact) => artifact.id),
      ...(input.suspensionArtifactIds ?? []),
    ])],
  });
  const replayArtifact = createRunnerContinuationReplayArtifact({
    store: input.store,
    replayPackage,
    createdAt: input.now,
  });
  const targetAttemptId = createWorkUnitAttemptId();
  const preparation: ApprovalResumeContinuationPreparation = {
    runId: input.run.id,
    workUnitId: input.workUnit.id,
    sourceFence: toRuntimeAttemptFence(input.sourceAttempt),
    expectedTargetAttemptId: input.sourceAttempt.id,
    origin: input.origin,
    strategy: "deterministic_replay",
    runnerId: input.runner.id,
    runnerCapabilityRevision: capabilityRevision,
    contextViewId: context.contextViewId,
    contextSnapshotArtifactId: replayArtifact.id,
    idempotencyKey: `${runnerContinuationIdempotencyKey({
      runId: input.run.id,
      sourceAttemptId: input.sourceAttempt.id,
      origin: input.origin,
      generation: 0,
    })}:${input.idempotencyDiscriminator}`,
    generation: 0,
    targetAttempt: {
      id: targetAttemptId,
      runtimeInstanceId: input.runtime.runtimeInstanceId,
      runnerId: input.runner.id,
      requestedRunnerId: input.sourceAttempt.requestedRunnerId,
      effectiveRunnerId: input.runner.id,
      fallbackReason: input.sourceAttempt.fallbackReason,
      providerPresetId: input.sourceAttempt.providerPresetId,
    },
    now: input.now,
  };
  return {
    preparation,
    claimOwner: input.runtime.runtimeInstanceId,
    claimToken: `continuation-claim:${randomUUID()}`,
    claimExpiresAt: continuationClaimExpiry(input.workUnit, input.now),
  };
}

export function materializeExistingRunContinuation(
  plan: ExistingRunContinuationPlan,
  prepared: PreparedContinuation,
): PreparedRunnerContinuationExecution {
  if (!prepared.replayed && prepared.attempt.id !== plan.preparation.targetAttempt.id) {
    throw new Error("Prepared Runner continuation Attempt identity changed.");
  }
  return {
    continuation: prepared.continuation,
    attempt: prepared.attempt,
    claimOwner: plan.claimOwner,
    claimToken: plan.claimToken,
    claimExpiresAt: plan.claimExpiresAt,
  };
}

export function claimPreparedRunnerContinuation(
  store: RunStore,
  execution: PreparedRunnerContinuationExecution,
  now: string,
): PreparedRunnerContinuationExecution {
  const claimed = store.claimRunnerContinuation({
    continuationId: execution.continuation.id,
    expectedRevision: execution.continuation.revision,
    claimOwner: execution.claimOwner,
    claimToken: execution.claimToken,
    claimExpiresAt: execution.claimExpiresAt,
    now,
  });
  if (!claimed.ok) throw new Error(`Runner continuation claim failed: ${claimed.code}`);
  return { ...execution, continuation: claimed.value };
}

/** Mark a prepared continuation as durable queued work after admission conflicts. */
export function deferPreparedRunnerContinuation(
  store: RunStore,
  execution: PreparedRunnerContinuationExecution,
  now: string,
): PreparedRunnerContinuationExecution {
  const deferred = store.deferRunnerContinuation({
    continuationId: execution.continuation.id,
    expectedRevision: execution.continuation.revision,
    now,
    nextAttemptAt: now,
  });
  if (!deferred.ok) {
    const current = store.getRunnerContinuation(execution.continuation.id);
    if (current
      && current.targetAttemptId === execution.attempt.id
      && ["prepared", "claimed", "running", "succeeded"].includes(current.state)) {
      return { ...execution, continuation: current };
    }
    throw new Error(`Runner continuation defer failed: ${deferred.code}`);
  }
  return { ...execution, continuation: deferred.value };
}

/** Rebind ephemeral claim credentials for one durable, explicitly scheduled continuation. */
export function restoreScheduledRunnerContinuationExecution(input: {
  readonly store: RunStore;
  readonly continuation: RunnerContinuationV1;
  readonly runtime: RuntimeInstance;
  readonly now: string;
}): PreparedRunnerContinuationExecution | undefined {
  if (input.continuation.state !== "prepared"
    || !input.continuation.nextAttemptAt
    || input.continuation.nextAttemptAt > input.now
    || !input.continuation.targetAttemptId) {
    return undefined;
  }
  const workUnit = input.store.getWorkUnit(input.continuation.workUnitId);
  const attempt = input.store.getWorkUnitAttempt(input.continuation.targetAttemptId);
  if (!workUnit
    || !attempt
    || workUnit.status !== "queued"
    || workUnit.activeAttemptId !== attempt.id
    || attempt.workUnitId !== workUnit.id
    || attempt.status !== "created") {
    return undefined;
  }
  return {
    continuation: input.continuation,
    attempt,
    claimOwner: input.runtime.runtimeInstanceId,
    claimToken: `continuation-claim:${randomUUID()}`,
    claimExpiresAt: continuationClaimExpiry(workUnit, input.now),
  };
}

export function startPreparedRunnerContinuation(
  store: RunStore,
  execution: PreparedRunnerContinuationExecution,
  now: string,
): PreparedRunnerContinuationExecution {
  const started = store.startRunnerContinuation({
    continuationId: execution.continuation.id,
    expectedRevision: execution.continuation.revision,
    claimOwner: execution.claimOwner,
    claimToken: execution.claimToken,
    targetFence: toRuntimeAttemptFence(execution.attempt),
    now,
  });
  if (!started.ok) throw new Error(`Runner continuation start failed: ${started.code}`);
  return { ...execution, continuation: started.value };
}

export function finishPreparedRunnerContinuation(input: {
  readonly store: RunStore;
  readonly execution: PreparedRunnerContinuationExecution;
  readonly nextState: Extract<RunnerContinuationState, "succeeded" | "failed" | "cancelled" | "recovery_pending">;
  readonly now: string;
}): PreparedRunnerContinuationExecution {
  const finished = input.store.finishRunnerContinuation({
    continuationId: input.execution.continuation.id,
    expectedRevision: input.execution.continuation.revision,
    claimOwner: input.execution.claimOwner,
    claimToken: input.execution.claimToken,
    targetFence: toRuntimeAttemptFence(input.execution.attempt),
    nextState: input.nextState,
    now: input.now,
  });
  if (!finished.ok) throw new Error(`Runner continuation finish failed: ${finished.code}`);
  return { ...input.execution, continuation: finished.value };
}

function continuationClaimExpiry(workUnit: WorkUnit, now: string): string {
  const ttl = workUnit.timeoutPolicy.hardTimeoutMs
    + workUnit.timeoutPolicy.cancelGraceMs
    + CONTINUATION_LEASE_RECOVERY_MARGIN_MS;
  return new Date(Date.parse(now) + ttl).toISOString();
}

function resolveRootRunId(store: Pick<RunStore, "getRun">, startRunId: string): string {
  const visited = new Set<string>();
  let current = store.getRun(startRunId);
  if (!current) throw new Error("Runner continuation source Run is missing.");
  for (let depth = 0; current.parentRunId; depth += 1) {
    if (depth >= 128 || visited.has(current.id)) throw new Error("Runner continuation Run lineage is cyclic.");
    visited.add(current.id);
    const parent = store.getRun(current.parentRunId);
    if (!parent) throw new Error("Runner continuation parent Run is missing.");
    current = parent;
  }
  return current.id;
}

function projectionFingerprintBasis(projection: ConversationContextProjectionMetadata): unknown {
  return {
    projectionVersion: projection.projectionVersion,
    sourceStateFingerprint: projection.sourceStateFingerprint,
    threadId: projection.threadId,
    turnId: projection.turnId,
    segmentId: projection.segmentId,
    throughItemSequence: projection.throughItemSequence,
    summaryIds: projection.summaryIds,
    sourceRefs: projection.sourceRefs,
    policyVersion: projection.policyVersion,
    visibilityFingerprint: projection.visibilityFingerprint,
  };
}

function uniqueSourceRefs(refs: readonly ConversationDomainRef[]): readonly ConversationDomainRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
