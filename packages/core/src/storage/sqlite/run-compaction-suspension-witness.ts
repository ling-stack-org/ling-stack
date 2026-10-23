import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import type { RunCompactionCheckpointV1 } from "@ling-stack/contracts";
import { delegationDigest, delegationFence, delegationId, delegationRecord } from "../../harness/delegation-write-validation.js";
import { assertRunProgressPayloadSecretFree, captureRunProgressCheckpointLineage,
  type RunProgressLineageStore } from "../../run-progress-checkpoint-lineage.js";
import { RunProgressCheckpointError, RUN_PROGRESS_MAX_PAYLOAD_BYTES } from "../../run-progress-checkpoint-types.js";
import type { ReadRunCompactionSuspensionWitnessInput, ReadRunCompactionSuspensionWitnessResult, RunSuspensionCompactionWitness,
  RunSuspensionWitness } from "../../run-suspension-types.js";
import type { RunStore } from "../../run-types.js";
import { toRuntimeAttemptFence } from "../../runtime-supervisor-types.js";
import { readHarnessRetainedBody } from "./harness-artifact-recovery-pins.js";
import { SqliteRunCompactionCheckpointStore } from "./run-compaction-checkpoint-store.js";
import { assertNoUnsettledHostFacts, readRunProgressEvents, validateRunProgressRecoveryBookkeeping } from "./run-progress-checkpoint-effects.js";
import { isCurrentRunExecutionOwner } from "./run-execution-admission.js";
import { readSqliteSnapshot } from "./read-snapshot.js";
import type { SqliteStoreContext } from "./store-context.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";
import { hostAttemptReadScopeForSource } from "./host-attempt-read-scope.js";
import { verifyCompactionSuspensionEffects } from "./run-compaction-suspension-effects.js";
import { readCompactionSuspensionHandoffAttempts } from "./run-compaction-suspension-lineage.js";
import { parseRunSuspensionLineage } from "./run-suspension-witness.js";
import { mapRunEvent } from "./run-mappers.js";

export type CompactionSuspensionPorts = RunProgressLineageStore & Pick<RunStore, "getRun" | "getWorkUnitAttempt" | "listEvents"
  | "listHarnessToolExecutions" | "listHostCommandWriteBlockers" | "listApprovalRequests">;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(): never { throw new RunProgressCheckpointError("checkpoint.snapshot_unavailable"); }

function artifact(context: SqliteStoreContext, id: string, runId: string, type: string) {
  const retained = readHarnessRetainedBody(context.database, id), row = context.database.prepare("SELECT * FROM artifacts WHERE id=?").get(id);
  if (!row || row.run_id !== runId || row.type !== "json" || row.content_type !== type || retained.bytes > RUN_PROGRESS_MAX_PAYLOAD_BYTES
    || typeof row.sealed_payload_json !== "string") fail();
  const payload: unknown = JSON.parse(row.sealed_payload_json as string);
  if (!record(payload) || hash(payload) !== retained.contentSha256) fail();
  assertRunProgressPayloadSecretFree(payload);
  return { payload, digest: retained.contentSha256 };
}

/** Suspend only an interrupted tool loop. Successful final settlement has its own gate. */
function validView(summary: unknown, value: unknown): value is readonly unknown[] {
  if (typeof summary !== "string" || !summary.trim() || !Array.isArray(value) || !value.length
    || Buffer.byteLength(JSON.stringify(value)) > RUN_PROGRESS_MAX_PAYLOAD_BYTES || !record(value[0])
    || value[0].role !== "compactionSummary" || value[0].summary !== summary || !record(value.at(-1))
    || value.at(-1).role !== "toolResult") return false;
  const calls = new Set<string>(), results = new Set<string>();
  for (const [index, message] of value.entries()) {
    if (!record(message)) return false;
    if (index > 0 && !["user", "assistant", "toolResult"].includes(String(message.role))) return false;
    if (message.role === "assistant") {
      if (!Array.isArray(message.content) || !["stop", "toolUse"].includes(String(message.stopReason))) return false;
      for (const block of message.content) if (record(block) && block.type === "toolCall") {
        if (typeof block.id !== "string" || !block.id || calls.has(block.id)) return false;
        calls.add(block.id);
      }
    }
    if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || !calls.has(message.toolCallId) || results.has(message.toolCallId)) return false;
      results.add(message.toolCallId);
    }
  }
  return [...calls].every(id => results.has(id));
}

/** Bounded full dependency set; used by every suspension owner, not only a replay package. */
export function compactionSuspensionArtifactIds(context: SqliteStoreContext, witness: RunSuspensionWitness): readonly string[] {
  if (witness.kind !== "compaction") return [];
  const store = new SqliteRunCompactionCheckpointStore(context), ids = new Set<string>(), seen = new Set<string>();
  const head = store.get(witness.checkpoint.checkpointId);
  if (!head) fail();
  // This lookup is by the immutable snapshot identity, never the Run's latest
  // start/current Attempt. A historical audit must not silently truncate a chain.
  const starts = context.database.prepare(`SELECT * FROM run_events WHERE run_id=? AND type='context_compaction_start'
    AND json_extract(data_json,'$.checkpointArtifactId')=? LIMIT 2`).all(head.runId, witness.checkpoint.contextSnapshotArtifactId);
  const installed = context.database.prepare("SELECT * FROM run_events WHERE run_id=? AND seq=?").get(head.runId, witness.checkpoint.installedEventSeq);
  if (starts.length !== 1 || !installed) fail();
  const start = mapRunEvent(starts[0]!), end = mapRunEvent(installed);
  if (start.type !== "context_compaction_start" || end.type !== "context_compaction_end" || end.seq <= start.seq
    || end.data.outcome !== "sdk_installed" || end.data.attemptId !== start.data.attemptId
    || end.data.policyVersion !== head.policyVersion || delegationDigest(end) !== witness.checkpoint.installedEventDigest) fail();
  let current: RunCompactionCheckpointV1 | undefined = head;
  let successor: { checkpoint: RunCompactionCheckpointV1; payload: Record<string, unknown> } | undefined;
  while (current) {
    if (seen.has(current.id) || seen.size >= 128 || current.state !== "committed" || !current.committedAt
      || current.runId !== head.runId || current.contextSnapshotArtifactId !== head.contextSnapshotArtifactId
      || current.contextViewId !== head.contextViewId || current.providerName !== head.providerName || current.providerModel !== head.providerModel
      || current.policyVersion !== head.policyVersion || current.policySnapshotFingerprint !== head.policySnapshotFingerprint
      || current.workspaceProvenanceWatermark !== head.workspaceProvenanceWatermark || current.sourceEventSeq < start.seq) fail();
    seen.add(current.id); ids.add(current.contextSnapshotArtifactId); ids.add(current.summaryArtifactId);
    const snapshot = artifact(context, current.contextSnapshotArtifactId, current.runId, "application/vnd.ling.pi-compaction-context+json");
    if (current.id === witness.checkpoint.checkpointId && (current.revision !== witness.checkpoint.revision || current.summaryArtifactId !== witness.checkpoint.summaryArtifactId
      || current.contextSnapshotArtifactId !== witness.checkpoint.contextSnapshotArtifactId
      || current.summaryContentSha256 !== witness.checkpoint.summaryContentSha256 || snapshot.digest !== witness.checkpoint.contextSnapshotSha256)) fail();
    const summary = artifact(context, current.summaryArtifactId, current.runId, "application/vnd.ling.run-compaction-summary+json"), payload = summary.payload;
    if (summary.digest !== current.summaryContentSha256 || payload.schemaVersion !== 1 || payload.runId !== current.runId
      || payload.attemptId !== current.attemptId || payload.sourceEventSeq !== current.sourceEventSeq
      || !validView(payload.summary, payload.modelView) || snapshot.payload.attemptId !== start.data.attemptId) fail();
    if (successor && (successor.checkpoint.predecessorId !== current.id || successor.payload.predecessorId !== current.id
      || successor.checkpoint.sourceEventSeq <= current.sourceEventSeq || !Array.isArray(successor.payload.modelView)
      || !same(successor.payload.modelView.slice(0, payload.modelView.length), payload.modelView))) fail();
    if (payload.boundary === "run-compaction-summary") {
      if (current.sourceEventSeq !== start.seq || current.attemptId !== start.data.attemptId) fail();
      return [...ids];
    }
    if (payload.boundary !== "run-compaction-progress" || !current.predecessorId || payload.predecessorId !== current.predecessorId) fail();
    successor = { checkpoint: current, payload };
    current = store.get(current.predecessorId);
  }
  return fail();
}

/** Semantic checkpoint authority only. The owning writer separately verifies physical/source state. */
export function verifyRunCompactionSuspensionWitness(context: SqliteStoreContext, ports: CompactionSuspensionPorts,
  input: ReadRunCompactionSuspensionWitnessInput, expected?: RunSuspensionCompactionWitness): Extract<ReadRunCompactionSuspensionWitnessResult, { kind: "verified" }> {
  const run = ports.getRun(input.runId), source = ports.getWorkUnitAttempt(input.sourceFence.attemptId);
  if (!run || run.workUnitId !== input.sourceFence.workUnitId || !source || !same(toRuntimeAttemptFence(source), input.sourceFence)) fail();
  const lineage = captureRunProgressCheckpointLineage(ports, run).lineage;
  if (!same(lineage, input.expectedLineage)) throw new RunProgressCheckpointError("checkpoint.lineage_mismatch");
  const store = new SqliteRunCompactionCheckpointStore(context), checkpoint = store.getLatestForRun(run.id);
  const events = readRunProgressEvents(ports, run.id), start = events.filter(event => event.type === "context_compaction_start").at(-1);
  if (!checkpoint || checkpoint.state !== "committed" || !checkpoint.committedAt || !start
    || checkpoint.sourceEventSeq < start.seq || checkpoint.contextViewId !== run.contextViewId || checkpoint.providerName !== run.providerName
    || checkpoint.providerModel !== run.providerModel || checkpoint.policyVersion !== start.data.policyVersion
    || start.data.checkpointArtifactId !== checkpoint.contextSnapshotArtifactId || typeof start.data.attemptId !== "string"
    || checkpoint.policySnapshotFingerprint !== lineage.policySnapshotFingerprint || checkpoint.workspaceProvenanceWatermark !== lineage.workspaceProvenanceWatermark
    || checkpoint.unresolvedToolCallIds.length || checkpoint.unresolvedApprovalIds.length || checkpoint.unresolvedQuestionIds.length) fail();
  const handoffAttempts = readCompactionSuspensionHandoffAttempts(context.database, checkpoint, input.sourceFence);
  const snapshot = artifact(context, checkpoint.contextSnapshotArtifactId, run.id, "application/vnd.ling.pi-compaction-context+json");
  if (snapshot.payload.schemaVersion !== 1 || snapshot.payload.boundary !== "pi-compaction-context" || snapshot.payload.runId !== run.id
    || snapshot.payload.attemptId !== start.data.attemptId || snapshot.payload.contextViewId !== run.contextViewId
    || snapshot.payload.model !== run.providerModel || !Array.isArray(snapshot.payload.messages)) fail();
  const installed = events.filter(event => event.seq > start.seq && event.type === "context_compaction_end");
  if (installed.length !== 1 || installed[0]!.data.outcome !== "sdk_installed" || installed[0]!.data.attemptId !== start.data.attemptId
    || installed[0]!.data.policyVersion !== checkpoint.policyVersion) fail();
  const end = installed[0]!;
  const seen = new Set<string>();
  let current: RunCompactionCheckpointV1 | undefined = checkpoint;
  let latestPayload: Record<string, unknown> | undefined;
  while (current) {
    if (seen.has(current.id) || seen.size >= 128 || current.state !== "committed" || !current.committedAt || current.runId !== run.id
      || current.contextSnapshotArtifactId !== checkpoint.contextSnapshotArtifactId || current.contextViewId !== checkpoint.contextViewId
      || current.providerName !== checkpoint.providerName || current.providerModel !== checkpoint.providerModel
      || current.policyVersion !== checkpoint.policyVersion || current.policySnapshotFingerprint !== checkpoint.policySnapshotFingerprint
      || current.workspaceProvenanceWatermark !== checkpoint.workspaceProvenanceWatermark
      || current.unresolvedToolCallIds.length || current.unresolvedApprovalIds.length || current.unresolvedQuestionIds.length) fail();
    seen.add(current.id);
    const summary = artifact(context, current.summaryArtifactId, run.id, "application/vnd.ling.run-compaction-summary+json");
    const payload = summary.payload;
    if (summary.digest !== current.summaryContentSha256 || payload.schemaVersion !== 1 || payload.runId !== run.id
      || payload.attemptId !== current.attemptId || payload.sourceEventSeq !== current.sourceEventSeq || !validView(payload.summary, payload.modelView)) fail();
    latestPayload ??= payload;
    if (current.sourceEventSeq === start.seq) {
      if (payload.boundary !== "run-compaction-summary" || current.attemptId !== start.data.attemptId) fail();
      break;
    }
    const previous: RunCompactionCheckpointV1 | undefined = current.predecessorId ? store.get(current.predecessorId) : undefined;
    if (!previous || previous.sourceEventSeq >= current.sourceEventSeq || previous.sourceEventSeq < start.seq
      || payload.boundary !== "run-compaction-progress" || payload.predecessorId !== previous.id || !Array.isArray(payload.completedToolCallIds)
      || !payload.completedToolCallIds.length || new Set(payload.completedToolCallIds).size !== payload.completedToolCallIds.length) fail();
    const owner = ports.getWorkUnitAttempt(current.attemptId);
    if (!owner || owner.workUnitId !== run.workUnitId) fail();
    if (previous.attemptId !== current.attemptId) readCompactionSuspensionHandoffAttempts(context.database, previous, toRuntimeAttemptFence(owner));
    const oldPayload = artifact(context, previous.summaryArtifactId, run.id, "application/vnd.ling.run-compaction-summary+json").payload;
    if (!Array.isArray(oldPayload.modelView) || !same((payload.modelView as unknown[]).slice(0, oldPayload.modelView.length), oldPayload.modelView)) fail();
    const between = events.filter(event => event.seq > previous.sourceEventSeq && event.seq <= current!.sourceEventSeq);
    validateRunProgressRecoveryBookkeeping(run, between.filter(event => event.type === "run_start"), current.attemptId);
    const starts = new Set<string>(), ended = new Set<string>();
    for (const event of between) {
      if (event.type === "context_compaction_start" || ["run_end", "run_error", "run_cancelled"].includes(event.type)) fail();
      if (!["tool_start", "tool_update", "tool_end"].includes(event.type)) continue;
      const id = event.data.toolCallId;
      if (typeof id !== "string" || event.data.attemptId !== undefined && event.data.attemptId !== current.attemptId) fail();
      if (event.type === "tool_start") { if (starts.has(id) || ended.has(id)) fail(); starts.add(id); }
      else if (!starts.has(id) || ended.has(id)) fail();
      else if (event.type === "tool_end") { if (event.data.isError && event.data.toolName !== "read") fail(); ended.add(id); }
    }
    const appended = (payload.modelView as unknown[]).slice(oldPayload.modelView.length)
      .filter(message => record(message) && message.role === "toolResult").map(message => (message as Record<string, unknown>).toolCallId);
    if (between.at(-1)?.seq !== current.sourceEventSeq || starts.size !== ended.size || !same([...ended].sort(), [...payload.completedToolCallIds].sort())
      || !same([...ended].sort(), appended.sort()) || previous.sourceEventSeq === start.seq && !between.some(event => event.seq === end.seq)) fail();
    current = previous;
  }
  if (!current || !latestPayload) fail();
  verifyCompactionSuspensionEffects(context.database, ports, run, events, latestPayload.modelView as readonly unknown[], input.sourceFence);
  const recoveryMarkers = new Map<string, typeof events>();
  for (const event of events.filter(event => event.seq > checkpoint.sourceEventSeq)) {
    if (event.seq === end.seq) continue;
    if (event.seq < end.seq && ["assistant_text_delta", "assistant_thinking_delta", "assistant_reasoning_summary", "message_end"].includes(event.type)
      && (event.data.attemptId === undefined || event.data.attemptId === start.data.attemptId)) continue;
    if (event.type === "run_start" && typeof event.data.attemptId === "string" && handoffAttempts.has(event.data.attemptId)) {
      const markers = recoveryMarkers.get(event.data.attemptId) ?? []; markers.push(event); recoveryMarkers.set(event.data.attemptId, markers); continue;
    }
    if (["turn_start", "turn_end"].includes(event.type) && (event.data.attemptId === source.id || event.data.attemptId === checkpoint.attemptId
      || typeof event.data.attemptId === "string" && handoffAttempts.has(event.data.attemptId))
      && Object.keys(event.data).every(key => ["type", "attemptId"].includes(key)) && (event.data.type === undefined || event.data.type === event.type)) continue;
    if (event.type === "artifact_created" && record(event.data.artifact) && event.data.artifact.id === checkpoint.contextSnapshotArtifactId) continue;
    fail();
  }
  for (const [attemptId, markers] of recoveryMarkers) validateRunProgressRecoveryBookkeeping(run, markers, attemptId);
  if (ports.listHarnessToolExecutions(run.id).some(item => !["succeeded", "denied", "failed", "cancelled", "superseded"].includes(item.state))
    || ports.listHostCommandWriteBlockers(run.cwd).some(item => item.runId === run.id)
    || context.database.prepare("SELECT 1 FROM approval_requests WHERE run_id=? AND status='pending' LIMIT 1").get(run.id)) {
    throw new RunProgressCheckpointError("checkpoint.effect_unknown");
  }
  assertNoUnsettledHostFacts(context.database, ports, run.id, input.sourceFence.workUnitId);
  assertUserInputDurableQuiescence(context.database, run.id, input.sourceFence, Date.now(),
    hostAttemptReadScopeForSource(context.database, { runId: run.id, ...input.sourceFence }));
  const witness: RunSuspensionCompactionWitness = { kind: "compaction", checkpoint: {
    checkpointId: checkpoint.id, revision: checkpoint.revision, sourceEventSeq: checkpoint.sourceEventSeq,
    boundaryEventSeq: events.at(-1)?.seq ?? 0, summaryArtifactId: checkpoint.summaryArtifactId, summaryContentSha256: checkpoint.summaryContentSha256,
    contextSnapshotArtifactId: checkpoint.contextSnapshotArtifactId, contextSnapshotSha256: snapshot.digest,
    installedEventSeq: end.seq, installedEventDigest: delegationDigest(end), sourceFence: input.sourceFence, lineage,
  } };
  if (expected && !same(expected, witness)) throw new RunProgressCheckpointError("checkpoint.lineage_mismatch");
  return { kind: "verified", witness, modelViewArtifactId: checkpoint.summaryArtifactId, modelView: latestPayload.modelView as readonly unknown[] };
}

/** Public read-only observation. It cannot qualify historical/claimed owners or mint a stop receipt. */
export function readRunCompactionSuspensionWitness(context: SqliteStoreContext, ports: CompactionSuspensionPorts,
  raw: ReadRunCompactionSuspensionWitnessInput): ReadRunCompactionSuspensionWitnessResult {
  return readSqliteSnapshot(context.database, () => {
    try {
      const row = delegationRecord(raw, ["runId", "sourceFence", "expectedLineage"]);
      const input = { runId: delegationId(row.runId), sourceFence: delegationFence(row.sourceFence), expectedLineage: parseRunSuspensionLineage(row.expectedLineage) };
      if (!context.database.prepare("SELECT 1 FROM run_events WHERE run_id=? AND type='context_compaction_start' LIMIT 1").get(input.runId)) return { kind: "not_compacted" };
      if (!isCurrentRunExecutionOwner(context, input.runId, input.sourceFence, false)) throw new RunProgressCheckpointError("checkpoint.lineage_mismatch");
      return verifyRunCompactionSuspensionWitness(context, ports, input);
    } catch (error) { return { kind: "blocked", code: error instanceof RunProgressCheckpointError ? error.code : "checkpoint.snapshot_unavailable" }; }
  });
}
