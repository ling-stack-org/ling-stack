import type { RunnerContinuationFailureCode, RunnerContinuationV1 } from "@ling-stack/contracts";
import {
  toRuntimeAttemptFence,
  type EffectiveRunPolicySnapshot,
  type RunStore,
  type RuntimeAttemptFenceV1,
} from "@ling-stack/core";
import type { PiRunnerResult, PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type { RunnerNativeResumeInputV1 } from "../../../context.js";
import {
  resolveRunnerNativeResumeGate,
  type RegisteredRunner,
  type RunnerNativeResumeGateBlocker,
} from "../../../runtime/runners.js";
import { restorePreparedRunnerOptions } from "../../runs/prepared-runner-input.js";
import { readRunnerNativeResumeHandleArtifact } from "./native-handle.js";
import {
  readRunnerContinuationReplayArtifact,
  runnerPolicySnapshotFingerprint,
  runnerWorkspaceIdentity,
  type RunnerContinuationReplayPackageV1,
} from "./replay-package.js";

type ReconstructionStore = Pick<RunStore, "getArtifact" | "getRun" | "getWorkUnit" | "getWorkUnitAttempt">;

export type RunnerReconstructionResult =
  | {
      readonly ok: true;
      readonly strategy: "native_resume" | "deterministic_replay";
      readonly replayFingerprint: string;
      readonly result: PiRunnerResult;
    }
  | {
      readonly ok: false;
      readonly failureCode: RunnerContinuationFailureCode;
      readonly fallbackAllowed: boolean;
      readonly blockers?: readonly RunnerNativeResumeGateBlocker[];
    };

/**
 * Reconstruct one already-fenced physical Attempt. This function never creates
 * Attempts or mutates continuation state; the durable coordinator owns those
 * commits and may atomically reprepare one deterministic replay generation.
 */
export async function executeRunnerContinuationReconstruction(input: {
  readonly store: ReconstructionStore;
  readonly continuation: RunnerContinuationV1;
  readonly runner: RegisteredRunner;
  readonly targetFence: RuntimeAttemptFenceV1;
  readonly workspaceCwd: string;
  readonly policySnapshot: EffectiveRunPolicySnapshot;
  readonly liveOptions: PiRunnerRunOptions;
}): Promise<RunnerReconstructionResult> {
  const replay = readRunnerContinuationReplayArtifact({ store: input.store, continuation: input.continuation });
  assertReplayLineage(input, replay);
  assertApprovalContinuationEvidence(input.continuation, replay, input.liveOptions);
  const options = restorePreparedRunnerOptions(replay.execution, input.liveOptions);
  const reboundOptions: PiRunnerRunOptions = {
    ...options,
    runId: input.continuation.runId,
    runnerAttemptId: input.targetFence.attemptId,
  };
  reboundOptions.signal?.throwIfAborted();

  if (input.continuation.strategy === "deterministic_replay") {
    return {
      ok: true,
      strategy: "deterministic_replay",
      replayFingerprint: replay.fingerprint,
      result: await input.runner.adapter.runTask(reboundOptions),
    };
  }

  const gate = resolveRunnerNativeResumeGate(input.runner, input.continuation.runnerCapabilityRevision);
  if (!gate.ok) return fallback(input.continuation, "continuation.runner_not_conformant", gate.blockers);
  const handleRef = input.continuation.runnerHandleRef;
  if (!handleRef) return fallback(input.continuation, "continuation.handle_missing");
  let handle;
  try { handle = readRunnerNativeResumeHandleArtifact({ store: input.store, artifactId: handleRef }); }
  catch { return fallback(input.continuation, "continuation.handle_missing"); }
  if (handle.sourceRunId !== replay.sourceRunId
    || handle.rootRunId !== replay.rootRunId
    || handle.sourceWorkUnitId !== replay.sourceWorkUnitId
    || handle.sourceAttemptId !== replay.sourceFence.attemptId
    || handle.workspaceIdentity !== replay.workspaceIdentity
    || handle.runnerId !== replay.runnerId
    || handle.runnerCapabilityRevision !== replay.runnerCapabilityRevision
    || handle.policySnapshotFingerprint !== replay.policySnapshotFingerprint) {
    return fallback(input.continuation, "continuation.handle_rejected");
  }
  const resumeTask = input.runner.adapter.resumeTask;
  if (!resumeTask) return fallback(input.continuation, "continuation.runner_not_conformant", ["resume_adapter_missing"]);
  const nativeInput: RunnerNativeResumeInputV1 = {
    schemaVersion: 1,
    runId: input.continuation.runId,
    rootRunId: replay.rootRunId,
    workUnitId: input.continuation.workUnitId,
    attemptId: input.targetFence.attemptId,
    sourceAttemptId: input.continuation.sourceAttemptId,
    runnerId: input.continuation.runnerId,
    runnerCapabilityRevision: input.continuation.runnerCapabilityRevision,
    contextViewId: input.continuation.contextViewId,
    workspaceIdentity: replay.workspaceIdentity,
    policySnapshotFingerprint: replay.policySnapshotFingerprint,
    handleRef: handle.opaqueHandle,
    options: reboundOptions,
  };
  try {
    return {
      ok: true,
      strategy: "native_resume",
      replayFingerprint: replay.fingerprint,
      result: await resumeTask(nativeInput),
    };
  } catch (error) {
    if (error instanceof RunnerNativeResumeRejectedError) {
      return fallback(input.continuation, error.code);
    }
    throw error;
  }
}

function assertApprovalContinuationEvidence(
  continuation: RunnerContinuationV1,
  replay: RunnerContinuationReplayPackageV1,
  liveOptions: PiRunnerRunOptions,
): void {
  const toolContinuation = liveOptions.approvedToolContinuation;
  if (continuation.origin !== "approval_resume") {
    if (toolContinuation) throw new RunnerReconstructionLineageError();
    return;
  }
  if (!toolContinuation) throw new RunnerReconstructionLineageError();
  const evidence = replay.approvalEvidence.find((item) => item.approvalId === toolContinuation.approvalId);
  if (!evidence
    || evidence.decision !== "approved"
    || evidence.sideEffectFingerprint !== toolContinuation.sideEffectFingerprint) {
    throw new RunnerReconstructionLineageError();
  }
}

export class RunnerNativeResumeRejectedError extends Error {
  constructor(readonly code: Extract<RunnerContinuationFailureCode, "continuation.handle_missing" | "continuation.handle_rejected">) {
    super(code);
    this.name = "RunnerNativeResumeRejectedError";
  }
}

function assertReplayLineage(
  input: Parameters<typeof executeRunnerContinuationReconstruction>[0],
  replay: RunnerContinuationReplayPackageV1,
): void {
  const continuation = input.continuation;
  const targetAttempt = input.store.getWorkUnitAttempt(input.targetFence.attemptId);
  const targetWorkUnit = input.store.getWorkUnit(continuation.workUnitId);
  const targetRun = input.store.getRun(continuation.runId);
  const sourceAttempt = input.store.getWorkUnitAttempt(replay.sourceFence.attemptId);
  const sourceWorkUnit = input.store.getWorkUnit(replay.sourceWorkUnitId);
  const sourceRun = input.store.getRun(replay.sourceRunId);
  if (!targetAttempt || !targetWorkUnit || !targetRun || !sourceAttempt || !sourceWorkUnit || !sourceRun
    || continuation.targetAttemptId !== targetAttempt.id
    || targetAttempt.workUnitId !== targetWorkUnit.id
    || targetWorkUnit.activeAttemptId !== targetAttempt.id
    || targetWorkUnit.linkedRunId !== targetRun.id
    || targetRun.workUnitId !== targetWorkUnit.id
    || targetRun.contextViewId !== replay.contextViewId
    || sourceAttempt.workUnitId !== sourceWorkUnit.id
    || sourceWorkUnit.linkedRunId !== sourceRun.id
    || sourceRun.workUnitId !== sourceWorkUnit.id
    || !sameFence(toRuntimeAttemptFence(targetAttempt), input.targetFence)
    || !sameFence(toRuntimeAttemptFence(sourceAttempt), replay.sourceFence)
    || resolveRootRunId(input.store, targetRun.id) !== replay.rootRunId
    || resolveRootRunId(input.store, sourceRun.id) !== replay.rootRunId
    || input.runner.id !== continuation.runnerId
    || replay.workspaceIdentity !== runnerWorkspaceIdentity(input.workspaceCwd)
    || replay.policySnapshotFingerprint !== runnerPolicySnapshotFingerprint(input.policySnapshot)) {
    throw new RunnerReconstructionLineageError();
  }
}

function resolveRootRunId(store: Pick<RunStore, "getRun">, startRunId: string): string {
  const visited = new Set<string>();
  let current = store.getRun(startRunId);
  if (!current) throw new RunnerReconstructionLineageError();
  for (let depth = 0; current.parentRunId; depth += 1) {
    if (depth >= 128 || visited.has(current.id)) throw new RunnerReconstructionLineageError();
    visited.add(current.id);
    const parent = store.getRun(current.parentRunId);
    if (!parent) throw new RunnerReconstructionLineageError();
    current = parent;
  }
  return current.id;
}

function fallback(
  continuation: RunnerContinuationV1,
  failureCode: RunnerContinuationFailureCode,
  blockers?: readonly RunnerNativeResumeGateBlocker[],
): RunnerReconstructionResult {
  return {
    ok: false,
    failureCode,
    fallbackAllowed: continuation.strategy === "native_resume" && continuation.generation === 0,
    ...(blockers && blockers.length > 0 ? { blockers } : {}),
  };
}

function sameFence(left: RuntimeAttemptFenceV1, right: RuntimeAttemptFenceV1): boolean {
  return left.workUnitId === right.workUnitId
    && left.attemptId === right.attemptId
    && left.runtimeInstanceId === right.runtimeInstanceId
    && left.fencingToken === right.fencingToken;
}

export class RunnerReconstructionLineageError extends Error {
  readonly code = "continuation.source_attempt_stale" as const;

  constructor() {
    super("Runner continuation lineage is stale.");
    this.name = "RunnerReconstructionLineageError";
  }
}
