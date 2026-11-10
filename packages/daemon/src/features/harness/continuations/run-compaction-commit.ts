import { createHash } from "node:crypto";
import type { RunCompactionCheckpointBlockerCode, RunCompactionCheckpointV1 } from "@ling-stack/contracts";
import type { EffectiveRunPolicySnapshot, RunSession, RunStore, RuntimeAttemptFenceV1, WorkUnitAttempt } from "@ling-stack/core";
import { assessRunCompactionRecovery } from "./run-compaction-recovery.js";
import { isValidCompactedModelView } from "./run-compaction-model-view.js";
import { runnerPolicySnapshotFingerprint } from "./replay-package.js";

export type RunCompactionCommitResult =
  | { readonly kind: "committed"; readonly checkpoint: RunCompactionCheckpointV1 }
  | { readonly kind: "blocked"; readonly code: RunCompactionCheckpointBlockerCode };

/**
 * Commit only a complete SDK-installed model view. The sealed artifact and
 * prepared row may survive an interrupted write; only the final CAS makes the
 * checkpoint eligible for recovery. Every partial state remains fail-closed.
 */
export function commitInstalledRunCompaction(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly attempt: WorkUnitAttempt;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly policySnapshot: EffectiveRunPolicySnapshot;
  readonly objective: string;
  readonly endEventSeq: number;
  readonly summary: string | undefined;
  readonly modelView: readonly unknown[] | undefined;
  readonly activeToolCallIds: readonly string[];
}): RunCompactionCommitResult {
  const { store, run, attempt, sourceFence } = input;
  if (!isValidCompactedModelView(input.summary, input.modelView)) return blocked("checkpoint.snapshot_unavailable");
  if (!store.isCurrentRunExecutionOwner(run.id, sourceFence, true)) return blocked("checkpoint.lineage_mismatch");
  const start = store.getLatestRunCompactionStart(run.id);
  const snapshotArtifactId = start?.data.checkpointArtifactId;
  if (!start || start.seq >= input.endEventSeq || start.data.attemptId !== attempt.id
    || typeof snapshotArtifactId !== "string" || start.data.policyVersion !== "pi_sdk_lifecycle_v1") {
    return blocked("checkpoint.lineage_mismatch");
  }
  const effectUnknown = input.activeToolCallIds.length > 0
    || store.listHarnessToolExecutions(run.id).some(execution =>
      execution.state === "unknown_outcome" || execution.state === "executing" || execution.state === "committing_evidence")
    || store.listHostCommandWriteBlockers(run.cwd).some(item => item.runId === run.id)
    || store.listApprovalRequests({ runId: run.id, status: "pending", limit: 1 }).length > 0
    || Boolean(store.findRequiredUserInputForAttempt({ sourceRunId: run.id, sourceFence }));
  if (effectUnknown) return blocked("checkpoint.effect_unknown");

  const payload = {
    schemaVersion: 1,
    boundary: "run-compaction-summary",
    runId: run.id,
    attemptId: attempt.id,
    sourceEventSeq: start.seq,
    summary: input.summary!,
    modelView: input.modelView!,
  };
  const digest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  const artifactId = `artifact_${run.id}_compaction_summary_${attempt.id}_${start.seq}`;
  let artifact = store.getArtifact(artifactId);
  if (artifact) {
    if (artifact.runId !== run.id || artifact.contentType !== "application/vnd.ling.run-compaction-summary+json"
      || artifact.contentSha256 !== digest) return blocked("checkpoint.lineage_mismatch");
  } else {
    artifact = store.createArtifact({
      id: artifactId,
      runId: run.id,
      type: "json",
      path: `${run.id}/compaction/${artifactId}.json`,
      title: "Host Run compaction model view",
      contentType: "application/vnd.ling.run-compaction-summary+json",
      sealedPayload: payload,
      createdAt: new Date().toISOString(),
    });
  }
  const latest = store.getLatestRunCompactionCheckpoint(run.id);
  if (latest && latest.sourceEventSeq > start.seq) return blocked("checkpoint.lineage_mismatch");
  const predecessorId = latest?.sourceEventSeq === start.seq ? latest.predecessorId : latest?.id;
  const now = new Date().toISOString();
  const checkpoint = store.createRunCompactionCheckpoint({
    runId: run.id,
    attemptId: attempt.id,
    sourceEventSeq: start.seq,
    ...(predecessorId ? { predecessorId } : {}),
    contextSnapshotArtifactId: snapshotArtifactId,
    summaryArtifactId: artifact.id,
    summaryContentSha256: digest,
    contextViewId: run.contextViewId,
    providerName: run.providerName,
    providerModel: run.providerModel,
    policyVersion: start.data.policyVersion,
    policySnapshotFingerprint: runnerPolicySnapshotFingerprint(input.policySnapshot),
    workspaceProvenanceWatermark: store.getLatestWorkspaceProvenanceWatermark(),
    objective: input.objective,
    createdAt: now,
  });
  const committed = checkpoint.state === "committed" ? checkpoint
    : store.transitionRunCompactionCheckpoint({ id: checkpoint.id, expectedRevision: checkpoint.revision,
      state: "committed", now });
  if (!committed) return blocked("checkpoint.lineage_mismatch");
  const assessment = assessRunCompactionRecovery({ store, run, sourceAttempt: attempt,
    policySnapshot: input.policySnapshot });
  return assessment.kind === "verified" ? { kind: "committed", checkpoint: committed }
    : blocked(assessment.kind === "blocked" ? assessment.code : "checkpoint.lineage_mismatch");
}

function blocked(code: RunCompactionCheckpointBlockerCode): RunCompactionCommitResult {
  return { kind: "blocked", code };
}
