import { createHash } from "node:crypto";
import type { RunCompactionCheckpointBlockerCode, RunCompactionCheckpointV1 } from "@ling-stack/contracts";
import type { RunSession, RunStore, WorkUnitAttempt } from "@ling-stack/core";
import type { EffectiveRunPolicySnapshot } from "@ling-stack/core";
import { isValidCompactedModelView } from "./run-compaction-model-view.js";
import { runnerPolicySnapshotFingerprint } from "./replay-package.js";

export type RunCompactionRecoveryAssessment =
  | { readonly kind: "not_compacted" }
  | { readonly kind: "blocked"; readonly code: RunCompactionCheckpointBlockerCode; readonly checkpointId?: string }
  | { readonly kind: "verified"; readonly checkpoint: RunCompactionCheckpointV1; readonly summary: string; readonly modelView: readonly unknown[] };

/**
 * Verify Host facts before any daemon-recovery model dispatch. A verified row is
 * still not a reconstructed SDK session; callers must supply that capability.
 */
export function assessRunCompactionRecovery(input: {
  readonly store: Pick<RunStore,
    | "readSnapshot" | "getLatestRunCompactionStart" | "getLatestRunCompactionCheckpoint" | "getRunCompactionCheckpoint"
    | "getArtifact" | "getLatestWorkspaceProvenanceWatermark" | "listHarnessToolExecutions"
    | "listHostCommandWriteBlockers" | "listHostOperationBlockers" | "listEvents">;
  readonly run: RunSession;
  readonly sourceAttempt: WorkUnitAttempt;
  /** Supplied only after the delegated recovery helper verifies the stopped A/current B edge. */
  readonly recoveryBookkeepingAttemptId?: string;
  readonly policySnapshot: EffectiveRunPolicySnapshot;
}): RunCompactionRecoveryAssessment {
  return input.store.readSnapshot(() => {
    const start = input.store.getLatestRunCompactionStart(input.run.id);
    if (!start) return { kind: "not_compacted" };
    const checkpoint = input.store.getLatestRunCompactionCheckpoint(input.run.id);
    if (!checkpoint) return blocked("checkpoint.missing");
    if (checkpoint.state !== "committed") {
      return blocked(checkpoint.blockerCode ?? "checkpoint.missing", checkpoint.id);
    }
    if (checkpoint.sourceEventSeq < start.seq || checkpoint.attemptId !== input.sourceAttempt.id
      || (checkpoint.sourceEventSeq === start.seq && start.data.attemptId !== input.sourceAttempt.id)
      || start.data.checkpointArtifactId !== checkpoint.contextSnapshotArtifactId
      || checkpoint.contextViewId !== input.run.contextViewId
      || checkpoint.providerName !== input.run.providerName
      || checkpoint.providerModel !== input.run.providerModel
      || checkpoint.policyVersion !== start.data.policyVersion) {
      return blocked("checkpoint.lineage_mismatch", checkpoint.id);
    }
    const snapshot = input.store.getArtifact(checkpoint.contextSnapshotArtifactId);
    const summary = input.store.getArtifact(checkpoint.summaryArtifactId);
    const summaryPayload = summary?.sealedPayload;
    if (!snapshot || snapshot.runId !== input.run.id || snapshot.type !== "json"
      || snapshot.contentType !== "application/vnd.ling.pi-compaction-context+json"
      || !hasValidSnapshotPayload(snapshot.sealedPayload, snapshot.contentSha256, checkpoint, start.data.attemptId)
      || !summary || summary.runId !== input.run.id || summary.type !== "json"
      || summary.contentType !== "application/vnd.ling.run-compaction-summary+json"
      || summary.contentSha256 !== checkpoint.summaryContentSha256
      || !hasValidSummaryPayload(summary.sealedPayload, checkpoint)) {
      return blocked("checkpoint.snapshot_unavailable", checkpoint.id);
    }
    if (checkpoint.sourceEventSeq > start.seq
      && !hasValidProgressLineage(input.store, checkpoint, start.seq, start.data.attemptId)) {
      return blocked("checkpoint.lineage_mismatch", checkpoint.id);
    }
    if (checkpoint.policySnapshotFingerprint !== runnerPolicySnapshotFingerprint(input.policySnapshot)) {
      return blocked("checkpoint.permission_drift", checkpoint.id);
    }
    if (checkpoint.workspaceProvenanceWatermark !== input.store.getLatestWorkspaceProvenanceWatermark()) {
      return blocked("checkpoint.source_watermark_changed", checkpoint.id);
    }
    if (hasPostCheckpointProgress(input.store, input.run, checkpoint, checkpoint.sourceEventSeq === start.seq,
      input.recoveryBookkeepingAttemptId)) {
      return blocked("checkpoint.effect_unknown", checkpoint.id);
    }
    const effectUnknown = input.store.listHarnessToolExecutions(input.run.id).some((execution) =>
      execution.state === "unknown_outcome"
      || execution.state === "executing"
      || execution.state === "committing_evidence")
      || input.store.listHostCommandWriteBlockers(input.run.cwd).some((item) => item.runId === input.run.id)
      || input.store.listHostOperationBlockers({ runId: input.run.id, workUnitId: input.sourceAttempt.workUnitId,
        attemptId: input.sourceAttempt.id, runtimeInstanceId: input.sourceAttempt.runtimeInstanceId,
        fencingToken: input.sourceAttempt.fencingToken }).length > 0;
    if (effectUnknown || checkpoint.unresolvedToolCallIds.length > 0
      || checkpoint.unresolvedApprovalIds.length > 0 || checkpoint.unresolvedQuestionIds.length > 0) {
      return blocked("checkpoint.effect_unknown", checkpoint.id);
    }
    return {
      kind: "verified",
      checkpoint,
      summary: (summaryPayload as { readonly summary: string }).summary,
      modelView: (summaryPayload as { readonly modelView: readonly unknown[] }).modelView,
    };
  });
}

/** An older SDK view cannot replay any progress observed after it was sealed. */
function hasPostCheckpointProgress(
  store: Pick<RunStore, "listEvents">,
  run: RunSession,
  checkpoint: RunCompactionCheckpointV1,
  requiresInstallEvent: boolean,
  recoveryAttemptId?: string,
): boolean {
  let afterSeq = checkpoint.sourceEventSeq;
  let installed = !requiresInstallEvent;
  let recoveryStartSeen = false;
  for (;;) {
    const page = store.listEvents(run.id, { afterSeq, limit: 1000 });
    for (const event of page) {
      if (!installed && event.type === "context_compaction_end"
        && event.data.attemptId === checkpoint.attemptId && event.data.outcome === "sdk_installed") {
        installed = true;
        continue;
      }
      if (!installed && (event.type === "assistant_text_delta" || event.type === "assistant_thinking_delta"
        || event.type === "assistant_reasoning_summary" || event.type === "message_end")) continue;
      // Pi opens the next turn before entering the provider admission hook.
      // Empty lifecycle markers carry no output, execution or new model view.
      if (event.type === "turn_start" || event.type === "turn_end") continue;
      if (event.type === "artifact_created" && isRecord(event.data.artifact)
        && event.data.artifact.id === checkpoint.contextSnapshotArtifactId) continue;
      if (installed && recoveryAttemptId && !recoveryStartSeen && event.type === "run_start"
        && event.data.attemptId === recoveryAttemptId && event.data.taskId === run.taskId
        && event.data.cwd === run.cwd && event.data.provider === run.providerName && event.data.model === run.providerModel) {
        const keys = Object.keys(event.data).sort().join(",");
        const hasType = Object.prototype.hasOwnProperty.call(event.data, "type");
        if (hasType && event.data.type !== "run_start"
          || keys !== ["attemptId", "taskId", "cwd", "provider", "model", ...(hasType ? ["type"] : [])].sort().join(",")) return true;
        recoveryStartSeen = true;
        continue;
      }
      return true;
    }
    if (page.length < 1000) return !installed;
    afterSeq = page[page.length - 1]!.seq;
  }
}

function hasValidSnapshotPayload(payload: unknown, digest: string | undefined,
  checkpoint: RunCompactionCheckpointV1, sourceAttemptId: string | undefined): boolean {
  return isRecord(payload) && payload.schemaVersion === 1 && payload.boundary === "pi-compaction-context"
    && payload.runId === checkpoint.runId && payload.attemptId === sourceAttemptId
    && payload.contextViewId === checkpoint.contextViewId && payload.model === checkpoint.providerModel
    && Array.isArray(payload.messages) && hasDigest(payload, digest);
}

function hasValidSummaryPayload(payload: unknown, checkpoint: RunCompactionCheckpointV1): boolean {
  return isRecord(payload) && payload.schemaVersion === 1
    && (payload.boundary === "run-compaction-summary" || payload.boundary === "run-compaction-progress")
    && payload.runId === checkpoint.runId && payload.attemptId === checkpoint.attemptId
    && payload.sourceEventSeq === checkpoint.sourceEventSeq
    && (payload.boundary !== "run-compaction-progress" || (
      payload.predecessorId === checkpoint.predecessorId
      && Array.isArray(payload.completedToolCallIds)
      && payload.completedToolCallIds.length > 0
      && payload.completedToolCallIds.every((id) => typeof id === "string")))
    && typeof payload.summary === "string" && payload.summary.trim().length > 0
    && isValidCompactedModelView(payload.summary, payload.modelView)
    && hasDigest(payload, checkpoint.summaryContentSha256);
}

function hasValidProgressLineage(
  store: Pick<RunStore, "getRunCompactionCheckpoint" | "getArtifact" | "listEvents">,
  checkpoint: RunCompactionCheckpointV1,
  startSeq: number,
  startAttemptId: string | undefined,
): boolean {
  let current = checkpoint;
  const seen = new Set<string>();
  while (current.sourceEventSeq > startSeq) {
    if (!current.predecessorId || seen.has(current.id)) return false;
    seen.add(current.id);
    const previous = store.getRunCompactionCheckpoint(current.predecessorId);
    const currentPayload = store.getArtifact(current.summaryArtifactId)?.sealedPayload;
    const previousArtifact = previous && store.getArtifact(previous.summaryArtifactId);
    const previousPayload = previousArtifact?.sealedPayload;
    if (!previous || previous.state !== "committed" || previous.runId !== current.runId
      || previous.sourceEventSeq >= current.sourceEventSeq
      || previous.sourceEventSeq < startSeq || previous.contextSnapshotArtifactId !== current.contextSnapshotArtifactId
      || previous.contextViewId !== current.contextViewId
      || previous.providerName !== current.providerName || previous.providerModel !== current.providerModel
      || previous.policySnapshotFingerprint !== current.policySnapshotFingerprint
      || !isRecord(currentPayload) || currentPayload.boundary !== "run-compaction-progress"
      || !isRecord(previousPayload) || !hasValidSummaryPayload(previousPayload, previous)
      || previousArtifact?.contentSha256 !== previous.summaryContentSha256
      || !Array.isArray(currentPayload.modelView) || !Array.isArray(previousPayload.modelView)
      || JSON.stringify(currentPayload.modelView.slice(0, previousPayload.modelView.length))
        !== JSON.stringify(previousPayload.modelView)) return false;
    const events = eventsBetween(store, current.runId, previous.sourceEventSeq, current.sourceEventSeq);
    const toolEnds = events.filter((event) => event.type === "tool_end").map((event) => event.data.toolCallId);
    if (events.at(-1)?.seq !== current.sourceEventSeq
      || (previous.sourceEventSeq === startSeq && !events.some((event) => event.type === "context_compaction_end"
        && event.data.attemptId === previous.attemptId && event.data.outcome === "sdk_installed"))
      || toolEnds.length !== (currentPayload.completedToolCallIds as readonly unknown[]).length
      || toolEnds.some((id) => !(currentPayload.completedToolCallIds as readonly unknown[]).includes(id))) return false;
    current = previous;
  }
  return current.sourceEventSeq === startSeq && current.attemptId === startAttemptId;
}

function eventsBetween(store: Pick<RunStore, "listEvents">, runId: string, startSeq: number, endSeq: number): ReturnType<RunStore["listEvents"]> {
  const events: ReturnType<RunStore["listEvents"]> = [];
  let afterSeq = startSeq;
  while (afterSeq < endSeq) {
    const page = store.listEvents(runId, { afterSeq, limit: 1000 }).filter((event) => event.seq <= endSeq);
    events.push(...page);
    if (events.length > 10_000) return [];
    if (page.length === 0 || page.at(-1)!.seq === endSeq) break;
    afterSeq = page.at(-1)!.seq;
  }
  return events;
}

function hasDigest(payload: Record<string, unknown>, expected: string | undefined): boolean {
  return typeof expected === "string"
    && createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex") === expected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blocked(code: RunCompactionCheckpointBlockerCode, checkpointId?: string): RunCompactionRecoveryAssessment {
  return { kind: "blocked", code, ...(checkpointId ? { checkpointId } : {}) };
}
