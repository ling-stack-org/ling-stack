import { createHash } from "node:crypto";
import type { RunCompactionCheckpointBlockerCode, RunEventEnvelope } from "@ling-stack/contracts";
import type { EffectiveRunPolicySnapshot, RunSession, RunStore, RuntimeAttemptFenceV1, WorkUnitAttempt } from "@ling-stack/core";
import { isValidCompactedModelView } from "./run-compaction-model-view.js";
import { assessRunCompactionRecovery } from "./run-compaction-recovery.js";
import { runnerPolicySnapshotFingerprint } from "./replay-package.js";

export type RunCompactionProgressResult =
  | { readonly kind: "not_needed" }
  | { readonly kind: "committed"; readonly checkpointId: string }
  | { readonly kind: "blocked"; readonly code: RunCompactionCheckpointBlockerCode };

/** Seal the exact SDK view after a settled tool round, before the next provider request. */
export function commitRunCompactionProgress(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly attempt: WorkUnitAttempt;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly policySnapshot: EffectiveRunPolicySnapshot;
  readonly modelView: readonly unknown[] | undefined;
  readonly activeToolCallIds: readonly string[];
  /** Only a Host-verified daemon continuation may advance an older Attempt's view. */
  readonly allowRecoveredAttemptHandoff?: boolean;
}): RunCompactionProgressResult {
  const { store, run, attempt, sourceFence } = input;
  const start = store.getLatestRunCompactionStart(run.id);
  if (!start) return { kind: "not_needed" };
  const previous = store.getLatestRunCompactionCheckpoint(run.id);
  if (!previous || previous.state !== "committed" || previous.sourceEventSeq < start.seq
    || (previous.attemptId !== attempt.id && !input.allowRecoveredAttemptHandoff)
    || (previous.sourceEventSeq === start.seq && start.data.attemptId !== previous.attemptId)
    || previous.contextSnapshotArtifactId !== start.data.checkpointArtifactId
    || previous.policyVersion !== start.data.policyVersion
    || previous.contextViewId !== run.contextViewId
    || previous.providerName !== run.providerName || previous.providerModel !== run.providerModel
    || previous.policySnapshotFingerprint !== runnerPolicySnapshotFingerprint(input.policySnapshot)
    || !store.isCurrentRunExecutionOwner(run.id, sourceFence, true)) {
    return blocked("checkpoint.lineage_mismatch");
  }
  if (input.activeToolCallIds.length > 0
    || store.listHostOperationBlockers({ runId: run.id, ...sourceFence }).length > 0) {
    return blocked("checkpoint.effect_unknown");
  }
  const events = eventsAfter(store, run.id, previous.sourceEventSeq);
  if (!events) return blocked("checkpoint.effect_unknown");
  if (events.length === 0) return { kind: "not_needed" };
  if (!events.some((event) => event.type === "tool_end")) {
    return events.some((event) => event.type === "tool_start" || event.type === "tool_update"
      || event.type === "host_command_prepared" || event.type === "host_command_settled")
      ? blocked("checkpoint.effect_unknown") : { kind: "not_needed" };
  }
  if (events.some((event) => event.type === "context_compaction_start" || event.type === "run_error"
    || event.type === "run_cancelled" || event.type === "run_end")) return blocked("checkpoint.effect_unknown");

  const previousArtifact = store.getArtifact(previous.summaryArtifactId);
  const previousPayload = previousArtifact?.sealedPayload;
  if (!isRecord(previousPayload) || previousArtifact?.contentSha256 !== previous.summaryContentSha256
    || digest(previousPayload) !== previous.summaryContentSha256
    || previousPayload.runId !== run.id || previousPayload.attemptId !== previous.attemptId
    || previousPayload.sourceEventSeq !== previous.sourceEventSeq
    || typeof previousPayload.summary !== "string"
    || !isValidCompactedModelView(previousPayload.summary, previousPayload.modelView)) {
    return blocked("checkpoint.snapshot_unavailable");
  }
  const oldView = previousPayload.modelView;
  const newView = input.modelView;
  if (!isValidCompactedModelView(previousPayload.summary, newView)
    || JSON.stringify(newView.slice(0, oldView.length)) !== JSON.stringify(oldView)) {
    return blocked("checkpoint.snapshot_unavailable");
  }
  const lastMessage = newView.at(-1);
  if (!isRecord(lastMessage) || lastMessage.role !== "toolResult") return blocked("checkpoint.snapshot_unavailable");
  const toolEnds = events.filter((event): event is Extract<RunEventEnvelope, { readonly type: "tool_end" }> => event.type === "tool_end");
  const starts = events.filter((event): event is Extract<RunEventEnvelope, { readonly type: "tool_start" }> => event.type === "tool_start");
  const startedIds = starts.map((event) => event.data.toolCallId);
  const endedIds = toolEnds.map((event) => event.data.toolCallId);
  const openCalls = new Set<string>();
  const settledCalls = new Set<string>();
  let invalidToolOrder = false;
  for (const event of events) {
    if (event.type !== "tool_start" && event.type !== "tool_update" && event.type !== "tool_end") continue;
    const id = event.data.toolCallId;
    if (typeof id !== "string") { invalidToolOrder = true; break; }
    if (event.type === "tool_start") {
      if (openCalls.has(id) || settledCalls.has(id)) invalidToolOrder = true;
      openCalls.add(id);
    } else if (!openCalls.has(id)) {
      invalidToolOrder = true;
    } else if (event.type === "tool_end") {
      openCalls.delete(id);
      settledCalls.add(id);
    }
  }
  const appendedResultIds = newView.slice(oldView.length).filter((message) => isRecord(message) && message.role === "toolResult")
    .map((message) => (message as Record<string, unknown>).toolCallId);
  if (invalidToolOrder || openCalls.size > 0 || input.activeToolCallIds.length > 0
    || endedIds.some((id) => typeof id !== "string")
    || new Set(startedIds).size !== startedIds.length || new Set(endedIds).size !== endedIds.length
    || startedIds.length !== endedIds.length || appendedResultIds.length !== endedIds.length
    || endedIds.some((id) => !startedIds.includes(id) || !appendedResultIds.includes(id))
    // A failed built-in read is a settled, read-only fact. Other failed tools
    // may have partial external effects until their Host evidence says otherwise.
    || toolEnds.some((event) => event.data.isError && event.data.toolName !== "read")
    || store.listHarnessToolExecutions(run.id).some((execution) =>
      execution.state === "unknown_outcome" || execution.state === "executing" || execution.state === "committing_evidence")
    || store.listHostCommandWriteBlockers(run.cwd).some((item) => item.runId === run.id)
    || store.listApprovalRequests({ runId: run.id, status: "pending", limit: 1 }).length > 0
    || Boolean(store.findRequiredUserInputForAttempt({ sourceRunId: run.id, sourceFence }))) {
    return blocked("checkpoint.effect_unknown");
  }
  const sourceEventSeq = events.at(-1)!.seq;
  const payload = {
    schemaVersion: 1,
    boundary: "run-compaction-progress",
    runId: run.id,
    attemptId: attempt.id,
    sourceEventSeq,
    predecessorId: previous.id,
    summary: previousPayload.summary,
    modelView: newView,
    completedToolCallIds: endedIds,
  };
  const contentSha256 = digest(payload);
  const artifactId = `artifact_${run.id}_compaction_progress_${attempt.id}_${sourceEventSeq}`;
  let artifact = store.getArtifact(artifactId);
  if (artifact) {
    if (artifact.runId !== run.id || artifact.contentSha256 !== contentSha256
      || artifact.contentType !== "application/vnd.ling.run-compaction-summary+json") {
      return blocked("checkpoint.lineage_mismatch");
    }
  } else {
    artifact = store.createArtifact({
      id: artifactId, runId: run.id, type: "json",
      path: `${run.id}/compaction/${artifactId}.json`, title: "Host Run compaction progress view",
      contentType: "application/vnd.ling.run-compaction-summary+json",
      sealedPayload: payload, createdAt: new Date().toISOString(),
    });
  }
  const now = new Date().toISOString();
  const checkpoint = store.createRunCompactionCheckpoint({
    runId: run.id, attemptId: attempt.id, sourceEventSeq, predecessorId: previous.id,
    contextSnapshotArtifactId: previous.contextSnapshotArtifactId,
    summaryArtifactId: artifact.id, summaryContentSha256: contentSha256,
    contextViewId: run.contextViewId, providerName: run.providerName, providerModel: run.providerModel,
    policyVersion: previous.policyVersion,
    policySnapshotFingerprint: previous.policySnapshotFingerprint,
    workspaceProvenanceWatermark: store.getLatestWorkspaceProvenanceWatermark(),
    objective: previous.objective, constraints: previous.constraints, createdAt: now,
  });
  const committed = checkpoint.state === "committed" ? checkpoint
    : store.transitionRunCompactionCheckpoint({ id: checkpoint.id, expectedRevision: checkpoint.revision,
      state: "committed", now });
  if (!committed) return blocked("checkpoint.lineage_mismatch");
  const assessment = assessRunCompactionRecovery({ store, run, sourceAttempt: attempt,
    policySnapshot: input.policySnapshot });
  return assessment.kind === "verified" ? { kind: "committed", checkpointId: committed.id }
    : blocked(assessment.kind === "blocked" ? assessment.code : "checkpoint.lineage_mismatch");
}

function eventsAfter(store: Pick<RunStore, "listEvents">, runId: string, sequence: number): RunEventEnvelope[] | undefined {
  const events: RunEventEnvelope[] = [];
  let afterSeq = sequence;
  for (;;) {
    const page = store.listEvents(runId, { afterSeq, limit: 1000 });
    events.push(...page);
    if (events.length > 10_000) return undefined;
    if (page.length < 1000) return events;
    afterSeq = page.at(-1)!.seq;
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blocked(code: RunCompactionCheckpointBlockerCode): RunCompactionProgressResult {
  return { kind: "blocked", code };
}
