import { isDeepStrictEqual } from "node:util";
import {
  captureRunProgressCheckpointLineage, delegationPreparedExecutionDigest, delegationPreparedExecutionJson, RunProgressCheckpointError,
  delegationTimestamp, toRuntimeAttemptFence,
  type ClaimedDelegatedChild, type DelegationPreparedExecution, type DelegationPreparedExecutionV1,
  type EffectiveRunPolicySnapshot, type RunProgressCheckpointBlockerCode, type RunProgressCheckpointWitness,
  type RunStore, type RuntimeAttemptFenceV1, type WorkUnitAttempt,
  type ReadRunFinalSettlementResult,
} from "@ling-stack/core";
import type { RunCompactionCheckpointBlockerCode } from "@ling-stack/contracts";
import { readCompactionRecoveryView, type PiRunnerCompactionRecovery, type PiRunnerOrdinaryProgressRecovery } from "@ling-stack/runner-pi";
import { readStoredEffectivePolicySnapshot } from "../../runs/existing-run-request.js";
import { readPreparedRunnerInput, type PreparedRunnerInput } from "../../runs/prepared-runner-input.js";
import type { RunRequest } from "../../runs/schemas.js";
import { assessRunCompactionRecovery } from "../continuations/run-compaction-recovery.js";

/** Core verifies this edge against persisted delegation ownership; it is not a public DTO grant. */
export interface DelegatedProgressRecoveryBinding {
  readonly reservationId: string;
  readonly targetFence: RuntimeAttemptFenceV1;
}

export type DelegatedRunRecoveryBlockerCode = RunProgressCheckpointBlockerCode | RunCompactionCheckpointBlockerCode
  | "delegation.preparation_changed" | "delegation.source_attempt_stale" | "delegation.lineage_invalid"
  | "delegation.recovery_required" | "delegation.deadline_exceeded";

export type DelegatedRunRecoveryAssessment =
  | { readonly kind: "blocked"; readonly code: DelegatedRunRecoveryBlockerCode }
  | { readonly kind: "verified"; readonly sourceAttempt: WorkUnitAttempt;
      readonly execution: PreparedRunnerInput; readonly prepared: DelegationPreparedExecution;
      readonly delegationBinding: DelegatedProgressRecoveryBinding;
      readonly ordinaryProgressRecovery: PiRunnerOrdinaryProgressRecovery;
      readonly ordinaryProgressWitness: RunProgressCheckpointWitness }
  | { readonly kind: "verified"; readonly sourceAttempt: WorkUnitAttempt;
      readonly execution: PreparedRunnerInput; readonly prepared: DelegationPreparedExecution;
      readonly delegationBinding: DelegatedProgressRecoveryBinding;
      readonly compactionRecovery: PiRunnerCompactionRecovery; readonly compactionCheckpointId: string }
  | { readonly kind: "verified"; readonly sourceAttempt: WorkUnitAttempt;
      readonly execution: PreparedRunnerInput; readonly prepared: DelegationPreparedExecution;
      readonly delegationBinding: DelegatedProgressRecoveryBinding;
      readonly finalSettlementRecovery: Extract<ReadRunFinalSettlementResult, { kind: "verified" }> };

/**
 * Reconstruct only the exact Host-committed SDK view of this existing child.
 * The original preparation supplies its model/tool schema, never a new prompt.
 * Reading the artifact alone cannot authorize recovery: Core must also verify
 * the checkpoint head, source effects and the new physical Attempt's binding.
 */
export function assessDelegatedRunRecovery(input: {
  readonly store: RunStore;
  readonly child: ClaimedDelegatedChild;
  readonly prepared: DelegationPreparedExecution | undefined;
  readonly policySnapshot: EffectiveRunPolicySnapshot;
  readonly now: string;
  /** Constructor-private stopped observation, not an HTTP or model capability. */
  readonly readFinalSettlementRecovery?: (sourceFence: RuntimeAttemptFenceV1, now: string) => ReadRunFinalSettlementResult;
}): DelegatedRunRecoveryAssessment {
  try {
    return input.store.readSnapshot(() => assessWithinSnapshot(input));
  } catch (error) {
    if (error instanceof DelegatedRecoveryBlocked) return { kind: "blocked", code: error.code };
    if (error instanceof RunProgressCheckpointError) return { kind: "blocked", code: error.code };
    throw error;
  }
}

function assessWithinSnapshot(input: Parameters<typeof assessDelegatedRunRecovery>[0]): DelegatedRunRecoveryAssessment {
  const { store, child } = input;
  const at = delegationTimestamp(input.now);
  const run = store.getRun(child.run.id), unit = store.getWorkUnit(child.workUnit.id);
  const target = store.getWorkUnitAttempt(child.attempt.id);
  const step = store.getDelegationStep(child.step.id);
  if (!run || !unit || !target || !step || run.id !== child.run.id || run.workUnitId !== unit.id
    || run.status !== "running" || run.endedAt || run.parentRunId !== child.step.parentRunId
    || run.threadId !== child.run.threadId || run.channelId !== child.run.channelId
    || run.workflowStepId !== child.run.workflowStepId || run.teammateId !== child.run.teammateId
    || !isDeepStrictEqual(run.taskSnapshot, child.run.taskSnapshot)
    || unit.ownerType !== "delegation_step" || unit.ownerId !== step.id || unit.linkedRunId !== run.id
    || unit.activeAttemptId !== target.id || unit.endedAt || !["claimed", "running"].includes(unit.status)
    || !isDeepStrictEqual(toRuntimeAttemptFence(target), toRuntimeAttemptFence(child.attempt))
    || target.workUnitId !== unit.id || target.attemptNumber < 2 || target.endedAt || target.abortRequestedAt
    || !["created", "started"].includes(target.status)
    || step.rootRunId !== child.step.rootRunId || step.parentRunId !== run.parentRunId
    || step.childRunId !== run.id || !["resuming", "running"].includes(step.state)
    || target.status === "created" && (unit.status !== "claimed" || step.state !== "resuming")
    || target.status === "started" && (unit.status !== "running" || step.state !== "running")) {
    return blocked("delegation.source_attempt_stale");
  }
  if (child.reservation.state !== "reserved" || at >= child.reservation.deadlineAt) return blocked("delegation.deadline_exceeded");
  const attempts = store.listWorkUnitAttempts(unit.id);
  const first = attempts.filter(attempt => attempt.attemptNumber === 1);
  const previous = attempts.filter(attempt => attempt.attemptNumber === target.attemptNumber - 1);
  if (first.length !== 1 || previous.length !== 1 || attempts.some(attempt => attempt.attemptNumber > target.attemptNumber)
    || previous[0]!.status !== "cancelled" || previous[0]!.errorCode !== "delegation_interrupted"
    || !previous[0]!.endedAt || !previous[0]!.abortRequestedAt || previous[0]!.endedAt! > target.createdAt
    || previous[0]!.workUnitId !== unit.id) return blocked("delegation.recovery_required");
  const sourceAttempt = previous[0]!, sourceFence = toRuntimeAttemptFence(sourceAttempt);
  const completion = store.getHostAttemptCompletion({ runId: run.id, ...sourceFence });
  if (!completion?.drainedAt || !completion.effectCoverage || completion.drainedAt > target.createdAt
    || !isDeepStrictEqual(completion.source, { runId: run.id, ...sourceFence })) return blocked("delegation.recovery_required");
  // Released source capacity is verified again in Core's exact edge check.
  if (store.listResourceLeases({ workUnitId: unit.id, attemptId: sourceAttempt.id, status: "active", limit: 1 }).length
    || store.listRuntimeSemaphoreSlots({ workUnitId: unit.id, status: "active", limit: 10_000 })
      .some(slot => slot.attemptId === sourceAttempt.id)) return blocked("delegation.recovery_required");

  const prepared = readOriginalPreparation(store, child, input.prepared, first[0]!);
  const payload = prepared.payload;
  if (!isDeepStrictEqual(payload.effectivePolicySnapshot, input.policySnapshot)
    || !isDeepStrictEqual(readStoredEffectivePolicySnapshot(run.requestSnapshot), input.policySnapshot)) {
    return blocked("checkpoint.permission_drift");
  }
  let execution: PreparedRunnerInput;
  try {
    const task = payload.requestSnapshot.task as RunRequest["task"];
    execution = readPreparedRunnerInput(payload.runnerExecutionInput, { cwd: run.cwd, task });
    const snapshot = run.requestSnapshot as Record<string, unknown>;
    const durable = readPreparedRunnerInput(snapshot.runnerExecutionInput, { cwd: run.cwd, task });
    if (!isDeepStrictEqual(execution, durable)) return blocked("delegation.preparation_changed");
  } catch { return blocked("delegation.preparation_changed"); }
  if (execution.runnerId !== "pi" || execution.input.provider.provider !== run.providerName
    || execution.input.provider.model !== run.providerModel || !run.contextViewId || !run.contextViewCreatedAt) {
    return blocked("delegation.preparation_changed");
  }
  const delegationBinding = { reservationId: child.reservation.id, targetFence: toRuntimeAttemptFence(target) };
  const settlement = input.readFinalSettlementRecovery?.(sourceFence, input.now);
  if (settlement?.kind === "blocked") return settlement;
  if (settlement?.kind === "verified") {
    const { lineage } = captureRunProgressCheckpointLineage(store, run, input.policySnapshot);
    if (!isDeepStrictEqual(settlement.witness.settlement.sourceFence, sourceFence)
      || !isDeepStrictEqual(settlement.witness.settlement.lineage, lineage)
      || !hasAcceptedTaskAnchor(settlement.modelView, execution.preparedInput.userPrompt)) return blocked("checkpoint.lineage_mismatch");
    return { kind: "verified", sourceAttempt, execution, prepared, delegationBinding,
      finalSettlementRecovery: structuredClone(settlement) };
  }
  const compaction = assessRunCompactionRecovery({ store, run, sourceAttempt, policySnapshot: input.policySnapshot,
    recoveryBookkeepingAttemptId: target.id });
  if (compaction.kind === "blocked") return compaction;
  if (compaction.kind === "verified") {
    try {
      const recovery = { schemaVersion: 1 as const, modelView: compaction.modelView };
      const modelView = readCompactionRecoveryView(recovery);
      if (!hasAcceptedTaskAnchor(modelView, execution.preparedInput.userPrompt)) return blocked("checkpoint.snapshot_unavailable");
      return { kind: "verified", sourceAttempt, execution, prepared, delegationBinding,
        compactionRecovery: { schemaVersion: 1, modelView }, compactionCheckpointId: compaction.checkpoint.id };
    } catch { return blocked("checkpoint.snapshot_unavailable"); }
  }
  const { lineage } = captureRunProgressCheckpointLineage(store, run, input.policySnapshot);
  const progress = store.readRunProgressCheckpointForRecovery({ runId: run.id, sourceFence,
    expectedLineage: lineage, delegationBinding });
  if (progress.kind === "blocked") return progress;
  // A pristine/partial transcript is not a checkpoint. Do not reconstruct it by
  // prompting the original instruction after an uncertain model invocation.
  if (progress.kind !== "verified") return blocked("checkpoint.missing");
  if (progress.checkpoint.runId !== run.id || !isDeepStrictEqual(progress.witness.sourceFence, sourceFence)
    || !isDeepStrictEqual(progress.witness.lineage, lineage)
    || progress.witness.checkpointId !== progress.checkpoint.id
    || !hasAcceptedTaskAnchor(progress.modelView, execution.preparedInput.userPrompt)) return blocked("checkpoint.lineage_mismatch");
  return { kind: "verified", sourceAttempt, execution, prepared, delegationBinding,
    ordinaryProgressRecovery: { schemaVersion: 1, modelView: structuredClone(progress.modelView) },
    ordinaryProgressWitness: structuredClone(progress.witness) };
}

function readOriginalPreparation(store: RunStore, child: ClaimedDelegatedChild,
  plan: DelegationPreparedExecution | undefined, first: WorkUnitAttempt): DelegationPreparedExecution {
  if (!plan) return fail("delegation.preparation_changed");
  const artifact = store.getArtifact(plan.artifactId);
  if (!artifact || artifact.runId !== child.run.id || artifact.path !== "sqlite:delegation-execution"
    || artifact.contentSha256 !== plan.digest) return fail("delegation.preparation_changed");
  let payload: DelegationPreparedExecutionV1;
  try { payload = JSON.parse(delegationPreparedExecutionJson(artifact.sealedPayload as DelegationPreparedExecutionV1)) as DelegationPreparedExecutionV1; }
  catch { return fail("delegation.preparation_changed"); }
  const request = payload.requestSnapshot;
  if (delegationPreparedExecutionDigest(payload) !== plan.digest || !isDeepStrictEqual(payload, plan.payload)
    || payload.schemaVersion !== 1 || payload.kind !== "delegation.execution.v1" || payload.runnerId !== "pi"
    || payload.childRunId !== child.run.id || payload.stepId !== child.step.id || payload.reservationId !== child.reservation.id
    || payload.rootRunId !== child.step.rootRunId || payload.parentRunId !== child.step.parentRunId
    || !isDeepStrictEqual(payload.sourceFence, toRuntimeAttemptFence(first))
    || request.cwd !== child.run.cwd || request.parentRunId !== child.run.parentRunId
    || request.threadId !== child.run.threadId || request.workflowStepId !== child.run.workflowStepId
    || request.teammateId !== child.run.teammateId || request.providerPresetId !== child.run.providerPresetId
    || !isDeepStrictEqual(request.task, child.run.taskSnapshot)) return fail("delegation.preparation_changed");
  return { artifactId: artifact.id, digest: plan.digest, payload };
}

function hasAcceptedTaskAnchor(view: readonly unknown[], prompt: string): boolean {
  return Boolean(prompt.trim()) && view.some(message => {
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "user" || !("content" in message)) return false;
    if (typeof message.content === "string") return message.content === prompt;
    return Array.isArray(message.content) && message.content.length > 0
      && message.content.every(block => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
      && message.content.map((block: { text: string }) => block.text).join("") === prompt;
  });
}

class DelegatedRecoveryBlocked extends Error {
  constructor(readonly code: DelegatedRunRecoveryBlockerCode) { super(code); }
}
function fail(code: DelegatedRunRecoveryBlockerCode): never { throw new DelegatedRecoveryBlocked(code); }
function blocked(code: DelegatedRunRecoveryBlockerCode): DelegatedRunRecoveryAssessment { return { kind: "blocked", code }; }
