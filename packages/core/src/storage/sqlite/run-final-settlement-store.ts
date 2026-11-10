import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { delegationDigest, delegationFence, delegationId, delegationJson, delegationRecord, delegationTimestamp } from "../../harness/delegation-write-validation.js";
import { assertRunProgressPayloadSecretFree, captureRunProgressCheckpointLineage, readRunProgressFrozenExecution, type RunProgressLineageStore } from "../../run-progress-checkpoint-lineage.js";
import { RUN_PROGRESS_MAX_PAYLOAD_BYTES, RunProgressCheckpointError } from "../../run-progress-checkpoint-types.js";
import type { CommitRunFinalSettlementInput, ReadRunFinalSettlementResult, RunFinalSettlementObservationV1 } from "../../run-final-settlement-types.js";
import type { RunSuspensionCompactionWitness, RunSuspensionSettlementWitness } from "../../run-suspension-types.js";
import type { CreateRunArtifactInput, RunArtifact, RunEventEnvelope, RunSession, RunStore } from "../../run-types.js";
import { toRuntimeAttemptFence, type RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { harnessArtifactOwnerHolder, readHarnessRetainedBody, syncHarnessArtifactOwnerPins } from "./harness-artifact-recovery-pins.js";
import { hostAttemptReadScopeForSource } from "./host-attempt-read-scope.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";
import { compactionSuspensionArtifactIds } from "./run-compaction-suspension-witness.js";
import { SqliteRunCompactionCheckpointStore } from "./run-compaction-checkpoint-store.js";
import { verifyCompactionSuspensionEffects } from "./run-compaction-suspension-effects.js";
import { readCompactionSuspensionHandoffAttempts } from "./run-compaction-suspension-lineage.js";
import { readRootSuspensionActivationRecord } from "./run-suspension-activation-records.js";
import { readRootSuspensionStartRecord } from "./run-suspension-start-records.js";
import { readDelegatedSuspensionActivationRecord, readDelegatedSuspensionStartRecord } from "./run-suspension-delegated-records.js";
import { readRunProgressEvents, validateRunProgressEffects } from "./run-progress-checkpoint-effects.js";
import { isCurrentRunExecutionOwner } from "./run-execution-admission.js";
import { assertNoPendingRunTerminalIntent } from "./run-terminal-intent-store.js";
import { parseRunSuspensionLineage } from "./run-suspension-witness.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";
import { FINAL_SETTLEMENT_CONTENT_TYPE, FINAL_SETTLEMENT_VIEW_CONTENT_TYPE, finalSettlementFail as fail,
  readFinalSettlementArtifact, readRunFinalSettlementRecord, type FinalSettlementPayload } from "./run-final-settlement-records.js";
import { readRestoredFinalSettlementHandoff } from "./run-final-settlement-handoff.js";
import type { SqliteStoreContext } from "./store-context.js";

export type FinalSettlementPorts = RunProgressLineageStore & Pick<RunStore, "getRun" | "getWorkUnitAttempt" | "listEvents"
  | "listHarnessToolExecutions" | "listHostCommandWriteBlockers" | "listApprovalRequests">;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const narration = ["assistant_text_delta", "assistant_thinking_delta", "assistant_reasoning_summary", "message_end", "turn_end"];

function validView(view: readonly unknown[]): Record<string, unknown> {
  if (!Array.isArray(view) || view.length < 2 || view.length > 1000 || Buffer.byteLength(JSON.stringify(view)) > RUN_PROGRESS_MAX_PAYLOAD_BYTES) fail();
  const final = view.at(-1);
  if (!record(final) || final.role !== "assistant" || final.stopReason !== "stop" || !Array.isArray(final.content)
    || final.content.some(block => !record(block) || block.type === "toolCall") || typeof final.errorMessage === "string" && final.errorMessage.trim()) fail();
  const pending = new Map<string, string>(), seen = new Set<string>();
  for (const [index, message] of view.entries()) {
    if (!record(message) || !["user", "assistant", "toolResult", ...(index === 0 ? ["compactionSummary"] : [])].includes(String(message.role))) fail();
    if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || pending.get(message.toolCallId) !== message.toolName || typeof message.isError !== "boolean" || !Array.isArray(message.content)) fail();
      pending.delete(message.toolCallId); continue;
    }
    if (pending.size) fail();
    if (message.role !== "assistant") continue;
    if (!["stop", "toolUse"].includes(String(message.stopReason)) || !Array.isArray(message.content)) fail();
    for (const block of message.content) {
      if (!record(block)) fail();
      if (block.type !== "toolCall") continue;
      if (typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !record(block.arguments) || seen.has(block.id)) fail();
      seen.add(block.id); pending.set(block.id, block.name);
    }
    if (message.usage !== undefined) {
      if (!record(message.usage)) fail("checkpoint.effect_unknown");
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])
        if (!Number.isSafeInteger(message.usage[key]) || Number(message.usage[key]) < 0) fail("checkpoint.effect_unknown");
      if (message.usage.cost !== undefined && (!record(message.usage.cost)
        || Object.values(message.usage.cost).some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0))) fail("checkpoint.effect_unknown");
    }
  }
  if (pending.size) fail();
  return final;
}

export function runFinalSettlementBudgetDigest(context: SqliteStoreContext, runId: string, sourceFence: RuntimeAttemptFenceV1, restored = false): string {
  const db = context.database;
  const charges = db.prepare("SELECT * FROM delegation_budget_charges WHERE run_id=? ORDER BY id").all(runId);
  if (charges.length > 10_000 || charges.some(row => !["measured", "cancelled_before_dispatch"].includes(String(row.state)))) fail("checkpoint.effect_unknown");
  const root = db.prepare(`WITH RECURSIVE parents(id,parent_run_id,depth) AS (SELECT id,parent_run_id,0 FROM run_sessions WHERE id=? UNION ALL
    SELECT r.id,r.parent_run_id,p.depth+1 FROM run_sessions r JOIN parents p ON r.id=p.parent_run_id WHERE p.depth<128)
    SELECT p.depth,b.* FROM parents p JOIN delegation_root_budgets b ON b.root_run_id=p.id`).all(runId);
  if (root.length > 1 || root.some(row => row.depth === 128)
    || restored && charges.some(row => row.attempt_id === sourceFence.attemptId)
    || !restored && root.length && !charges.some(row => row.attempt_id === sourceFence.attemptId && row.state === "measured")) fail("checkpoint.effect_unknown");
  for (const row of charges) if (row.state === "measured" && [row.input_tokens, row.cached_input_tokens, row.output_tokens]
    .some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) fail("checkpoint.effect_unknown");
  return delegationDigest({ root, charges });
}

/** Full immutable predecessor snapshot. It is not an ordinary recovery head. */
export function runFinalSettlementPredecessorDigest(context: SqliteStoreContext, runId: string): string {
  return delegationDigest({ ordinary: context.database.prepare("SELECT * FROM run_progress_checkpoints WHERE run_id=? ORDER BY source_event_seq,id").all(runId),
    heads: context.database.prepare("SELECT * FROM run_progress_checkpoint_heads WHERE run_id=?").all(runId),
    compacted: context.database.prepare("SELECT * FROM run_compaction_checkpoints WHERE run_id=? ORDER BY source_event_seq,id").all(runId) });
}
function effectDigest(context: SqliteStoreContext, ports: FinalSettlementPorts, runId: string): string {
  return delegationDigest({ operations: context.database.prepare("SELECT * FROM host_operations WHERE run_id=? ORDER BY operation_id").all(runId),
    tools: ports.listHarnessToolExecutions(runId),
    approvals: context.database.prepare("SELECT * FROM approval_requests WHERE run_id=? ORDER BY id").all(runId),
    questions: context.database.prepare("SELECT * FROM user_input_requests WHERE source_run_id=? ORDER BY request_id").all(runId) });
}

function validateFinalFacts(context: SqliteStoreContext, ports: FinalSettlementPorts, run: RunSession,
  sourceFence: RuntimeAttemptFenceV1, view: readonly unknown[], events: readonly RunEventEnvelope[], now: string): void {
  const final = validView(view);
  const canonical = events.filter(event => event.type === "message_end" && event.data.attemptId === sourceFence.attemptId && event.data.role === "assistant").at(-1);
  const text = (final.content as Record<string, unknown>[]).filter(block => block.type === "text").map(block => String(block.text ?? "")).join("");
  if (!canonical || canonical.data.stopReason !== "stop" || (canonical.data.text ?? "") !== text || canonical.data.errorMessage) fail("checkpoint.effect_unknown");
  for (const event of events.filter(event => event.seq > canonical.seq))
    if (event.type !== "turn_end" || event.data.attemptId !== sourceFence.attemptId
      || Object.keys(event.data).some(key => !["type", "attemptId"].includes(key))) fail("checkpoint.source_watermark_changed");
  if (final.usage !== undefined) {
    const usage = final.usage as Record<string, unknown>;
    const expected = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "totalTokens"].map(key => [key, usage[key]]));
    if (!same(canonical.data.usage, expected)) fail("checkpoint.effect_unknown");
  } else if (canonical.data.usage !== undefined) fail("checkpoint.effect_unknown");
  const hasTools = events.some(event => event.type === "tool_start");
  if (hasTools) verifyCompactionSuspensionEffects(context.database, ports, run, events, view, sourceFence);
  else {
    const prepared = readRunProgressFrozenExecution(run).preparedInput;
    if (!record(prepared) || view[0] && record(view[0]) && view[0].role !== "user" || view.length !== 2) fail();
    validateRunProgressEffects(ports, run, events.filter(event => !narration.includes(event.type)), view.slice(0, 1), sourceFence, context.database);
  }
  assertUserInputDurableQuiescence(context.database, run.id, sourceFence, Date.parse(now),
    hostAttemptReadScopeForSource(context.database, { runId: run.id, ...sourceFence }));
  runFinalSettlementBudgetDigest(context, run.id, sourceFence);
}

/** Historical checkpoints must be the complete immutable prefix actually carried by this SDK.
 * Neither a current head pointer nor a copied source fence proves a restart handoff. */
function ordinaryPredecessors(context: SqliteStoreContext, ports: FinalSettlementPorts, run: RunSession,
  sourceFence: RuntimeAttemptFenceV1, view: readonly unknown[], compacted: boolean): readonly string[] {
  const db = context.database, rows = db.prepare("SELECT * FROM run_progress_checkpoints WHERE run_id=? ORDER BY source_event_seq,id").all(run.id);
  if (rows.length > 128) fail();
  const ids: string[] = []; let prior: { id: string; seq: number; view: readonly unknown[] } | undefined;
  for (const row of rows) {
    const source = ports.getWorkUnitAttempt(String(row.source_attempt_id));
    const artifact = readFinalSettlementArtifact(db, String(row.model_view_artifact_id), run.id, "application/vnd.ling.run-progress-model-view+json");
    const payload = artifact.payload;
    if (!source || source.workUnitId !== sourceFence.workUnitId || source.runtimeInstanceId !== row.source_runtime_instance_id
      || source.fencingToken !== row.source_fencing_token || row.schema_version !== 1 || row.kind !== "noncompacted_model_view"
      || !record(payload) || payload.schemaVersion !== 1 || payload.boundary !== "run-progress-model-view" || payload.runId !== run.id
      || !same(payload.sourceFence, toRuntimeAttemptFence(source)) || payload.sourceEventSeq !== row.source_event_seq
      || payload.predecessorId !== row.predecessor_id || !same(payload.lineage, JSON.parse(String(row.lineage_json)))
      || !same(payload.lineage, captureRunProgressCheckpointLineage(ports, run).lineage)
      || artifact.digest !== row.model_view_sha256 || !Array.isArray(payload.modelView)
      || prior && (row.predecessor_id !== prior.id || Number(row.source_event_seq) <= prior.seq || !same(payload.modelView.slice(0, prior.view.length), prior.view))
      || !prior && row.predecessor_id !== null) fail();
    let cursor = sourceFence; const seen = new Set<string>();
    while (cursor.attemptId !== source.id) {
      if (seen.has(cursor.attemptId) || seen.size >= 128) fail("checkpoint.lineage_mismatch");
      seen.add(cursor.attemptId);
      const roots = db.prepare("SELECT suspension_id FROM run_suspension_root_activations WHERE run_id=? AND target_attempt_id=?").get(run.id, cursor.attemptId);
      const children = db.prepare("SELECT suspension_id FROM run_suspension_delegated_activations WHERE run_id=? AND target_attempt_id=?").get(run.id, cursor.attemptId);
      if (Boolean(roots) === Boolean(children)) fail("checkpoint.lineage_mismatch");
      const suspensionId = String((roots ?? children)!.suspension_id);
      const activation = roots ? readRootSuspensionActivationRecord(db, suspensionId)?.activation : readDelegatedSuspensionActivationRecord(db, suspensionId)?.activation;
      const start = roots ? readRootSuspensionStartRecord(db, suspensionId) : readDelegatedSuspensionStartRecord(db, suspensionId);
      if (!activation || !start || activation.runId !== run.id || !same(activation.targetFence, cursor)) fail("checkpoint.lineage_mismatch");
      cursor = activation.sourceFence;
    }
    ids.push(String(row.model_view_artifact_id)); prior = { id: String(row.id), seq: Number(row.source_event_seq), view: payload.modelView };
  }
  const head = db.prepare("SELECT checkpoint_id,revision FROM run_progress_checkpoint_heads WHERE run_id=?").get(run.id);
  if (prior ? !head || head.checkpoint_id !== prior.id || head.revision !== rows.length : Boolean(head)) fail();
  if (prior && !compacted && !same(view.slice(0, prior.view.length), prior.view)) fail();
  return ids;
}

/** Immutable final data plus independent current-context/effect verification; no live-owner exemption. */
export function verifyRunFinalSettlement(context: SqliteStoreContext, ports: FinalSettlementPorts,
  expected: RunSuspensionSettlementWitness, now: string, allowedTail: readonly RunEventEnvelope[] = []): Extract<ReadRunFinalSettlementResult, { kind: "verified" }> {
  return verifyFinalSettlement(context, ports, expected, now, allowedTail, new Set());
}
function verifyFinalSettlement(context: SqliteStoreContext, ports: FinalSettlementPorts,
  expected: RunSuspensionSettlementWitness, now: string, allowedTail: readonly RunEventEnvelope[], ancestors: Set<string>): Extract<ReadRunFinalSettlementResult, { kind: "verified" }> {
  if (ancestors.size >= 128 || ancestors.has(expected.settlement.id)) fail("checkpoint.lineage_mismatch");
  ancestors.add(expected.settlement.id);
  const saved = readRunFinalSettlementRecord(context.database, expected.settlement.id);
  if (!same(saved.witness, expected)) fail("checkpoint.lineage_mismatch");
  const payload = saved.payload, run = ports.getRun(payload.runId), source = ports.getWorkUnitAttempt(payload.sourceFence.attemptId);
  if (!run || !source || !same(toRuntimeAttemptFence(source), payload.sourceFence)
    || !same(captureRunProgressCheckpointLineage(ports, run).lineage, payload.lineage)) fail("checkpoint.lineage_mismatch");
  const all = readRunProgressEvents(ports, run.id), events = all.filter(event => event.seq <= payload.boundaryEventSeq);
  if (events.at(-1)?.seq !== payload.boundaryEventSeq || !same(all.slice(events.length), allowedTail)
    || delegationDigest(events) !== payload.canonicalEventDigest) fail("checkpoint.source_watermark_changed");
  if (runFinalSettlementBudgetDigest(context, run.id, payload.sourceFence, payload.observationKind === "pi_restored_final_settlement") !== payload.budgetDigest
    || effectDigest(context, ports, run.id) !== payload.effectDigest
    || runFinalSettlementPredecessorDigest(context, run.id) !== payload.predecessorDigest) fail("checkpoint.effect_unknown");
  if (payload.observationKind === "pi_restored_final_settlement") {
    const restored = readRestoredFinalSettlementHandoff(context.database, run, payload.sourceFence, saved.modelView, events);
    if (!same(restored.handoff, payload.restoredHandoff)
      || restored.artifactIds.some(id => !payload.dependencies.some(dep => dep.id === id))) fail("checkpoint.lineage_mismatch");
    verifyFinalSettlement(context, ports, restored.handoff.predecessor, now,
      all.filter(event => event.seq > restored.handoff.predecessor.settlement.boundaryEventSeq), ancestors);
    assertUserInputDurableQuiescence(context.database, run.id, payload.sourceFence, Date.parse(now),
      hostAttemptReadScopeForSource(context.database, { runId: run.id, ...payload.sourceFence }));
  } else validateFinalFacts(context, ports, run, payload.sourceFence, saved.modelView, events, now);
  ancestors.delete(expected.settlement.id);
  return { kind: "verified", witness: expected, modelViewArtifactId: payload.modelViewArtifactId, modelView: saved.modelView,
    artifactIds: [expected.settlement.artifactId, payload.modelViewArtifactId, ...payload.dependencies.map(dep => dep.id)] };
}

/** Constructor-private original SDK settlement writer. No model/route JSON can supply its reader. */
export class SqliteRunFinalSettlementStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: FinalSettlementPorts & {
    readonly createArtifactWithinTransaction: (input: CreateRunArtifactInput) => RunArtifact;
    readonly readFinalSettlementObservation: (ref: unknown) => RunFinalSettlementObservationV1;
  }) {}

  commitRunFinalSettlement(raw: CommitRunFinalSettlementInput): ReadRunFinalSettlementResult {
    let input: CommitRunFinalSettlementInput;
    try {
      const row = delegationRecord(raw, ["runId", "sourceFence", "expectedLineage", "observation", "modelView", "now"]);
      const view: unknown = JSON.parse(delegationJson(row.modelView));
      if (!Array.isArray(view)) fail();
      input = { runId: delegationId(row.runId), sourceFence: delegationFence(row.sourceFence),
        expectedLineage: parseRunSuspensionLineage(row.expectedLineage), observation: row.observation, modelView: view,
        now: delegationTimestamp(row.now) };
      assertRunProgressPayloadSecretFree(input.modelView);
    } catch (error) { return blocked(error); }
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const inspect = () => {
        const run = this.ports.getRun(input.runId), source = this.ports.getWorkUnitAttempt(input.sourceFence.attemptId);
        if (!run || !source || !same(toRuntimeAttemptFence(source), input.sourceFence)
          || !isCurrentRunExecutionOwner(this.context, run.id, input.sourceFence, false) || source.abortRequestedAt || source.endedAt
          || run.status !== "running" || run.endedAt || source.status !== "started") fail("checkpoint.lineage_mismatch");
        assertNoPendingRunTerminalIntent(this.context, run.id);
        const lineage = captureRunProgressCheckpointLineage(this.ports, run).lineage;
        if (!same(lineage, input.expectedLineage)) fail("checkpoint.lineage_mismatch");
        const observation = this.ports.readFinalSettlementObservation(input.observation);
        const observed = delegationRecord(observation, ["kind", "runId", "sourceFence", "modelView", "toolCallIds", "settledBuiltinReads"]);
        // SDK snapshots may own optional undefined fields. Compare both views at
        // the same descriptor-safe JSON boundary used by the persisted artifact.
        const observedView: unknown = JSON.parse(delegationJson(observed.modelView));
        const observedCalls: unknown = JSON.parse(delegationJson(observed.toolCallIds));
        const observedReads: unknown = JSON.parse(delegationJson(observed.settledBuiltinReads));
        if (!["pi_final_settlement", "pi_restored_final_settlement"].includes(String(observed.kind)) || observed.runId !== input.runId || !same(delegationFence(observed.sourceFence), input.sourceFence)
          || !same(observedView, input.modelView) || !Array.isArray(observedCalls) || !Array.isArray(observedReads)) fail("checkpoint.effect_unknown");
        const events = readRunProgressEvents(this.ports, run.id);
        const calls = events.filter(event => event.type === "tool_start" && event.data.attemptId === source.id);
        const ids = calls.map(event => String(event.data.toolCallId)).sort();
        if (!same([...observedCalls].sort(), ids) || new Set(ids).size !== ids.length) fail("checkpoint.effect_unknown");
        const reads = calls.filter(event => ["read", "grep", "find", "ls"].includes(String(event.data.toolName)))
          .map(event => ({ toolCallId: String(event.data.toolCallId), toolName: String(event.data.toolName) })).sort((a, b) => a.toolCallId.localeCompare(b.toolCallId));
        if (!same([...observedReads].sort((a, b) => String((a as { toolCallId?: unknown }).toolCallId).localeCompare(String((b as { toolCallId?: unknown }).toolCallId))), reads)) fail("checkpoint.effect_unknown");
        const restored = observed.kind === "pi_restored_final_settlement"
          ? readRestoredFinalSettlementHandoff(this.context.database, run, input.sourceFence, input.modelView, events) : undefined;
        if (restored) {
          if (observedCalls.length || observedReads.length) fail("checkpoint.effect_unknown");
          verifyRunFinalSettlement(this.context, this.ports, restored.handoff.predecessor, input.now,
            events.filter(event => event.seq > restored.handoff.predecessor.settlement.boundaryEventSeq));
          assertUserInputDurableQuiescence(this.context.database, run.id, input.sourceFence, Date.parse(input.now),
            hostAttemptReadScopeForSource(this.context.database, { runId: run.id, ...input.sourceFence }));
        } else validateFinalFacts(this.context, this.ports, run, input.sourceFence, input.modelView, events, input.now);
        return { run, lineage, events, observationKind: observed.kind as FinalSettlementPayload["observationKind"], restored,
          budgetDigest: runFinalSettlementBudgetDigest(this.context, run.id, input.sourceFence, Boolean(restored)),
          effectDigest: effectDigest(this.context, this.ports, run.id), predecessorDigest: runFinalSettlementPredecessorDigest(this.context, run.id) };
      };
      const facts = readSqliteWithinTransaction(this.context.database, inspect);
      const existing = this.context.database.prepare("SELECT id FROM run_final_settlements WHERE attempt_id=?").get(input.sourceFence.attemptId);
      if (existing) {
        const old = readRunFinalSettlementRecord(this.context.database, String(existing.id));
        if (!same(old.modelView, input.modelView) || !same(old.payload.sourceFence, input.sourceFence)) fail("checkpoint.head_conflict");
        const verified = verifyRunFinalSettlement(this.context, this.ports, old.witness, input.now);
        this.context.database.exec("COMMIT"); return verified;
      }
      const dependencies = new Set<string>();
      for (const id of facts.restored?.artifactIds ?? []) dependencies.add(id);
      let compactionWitness: RunSuspensionCompactionWitness | undefined;
      const cp = new SqliteRunCompactionCheckpointStore(this.context).getLatestForRun(input.runId);
      if (!facts.restored) for (const id of ordinaryPredecessors(this.context, this.ports, facts.run, input.sourceFence, input.modelView, Boolean(cp))) dependencies.add(id);
      if (!facts.restored && cp) {
        const start = facts.events.filter(event => event.type === "context_compaction_start").at(-1);
        const ends = start ? facts.events.filter(event => event.type === "context_compaction_end" && event.seq > start.seq) : [];
        const end = ends[0];
        if (cp.state !== "committed" || !start || ends.length !== 1 || !end || end.data.outcome !== "sdk_installed"
          || start.data.checkpointArtifactId !== cp.contextSnapshotArtifactId || end.data.attemptId !== start.data.attemptId
          || cp.contextViewId !== facts.run.contextViewId || cp.providerName !== facts.run.providerName || cp.providerModel !== facts.run.providerModel
          || cp.policySnapshotFingerprint !== facts.lineage.policySnapshotFingerprint || cp.workspaceProvenanceWatermark !== facts.lineage.workspaceProvenanceWatermark
          || cp.unresolvedToolCallIds.length || cp.unresolvedApprovalIds.length || cp.unresolvedQuestionIds.length) fail();
        readCompactionSuspensionHandoffAttempts(this.context.database, cp, input.sourceFence);
        const summary = readFinalSettlementArtifact(this.context.database, cp.summaryArtifactId, input.runId).payload;
        if (!record(summary) || !Array.isArray(summary.modelView) || !same(input.modelView.slice(0, summary.modelView.length), summary.modelView)) fail();
        compactionWitness = { kind: "compaction", checkpoint: { checkpointId: cp.id, revision: cp.revision, sourceEventSeq: cp.sourceEventSeq,
          boundaryEventSeq: facts.events.at(-1)!.seq, summaryArtifactId: cp.summaryArtifactId, summaryContentSha256: cp.summaryContentSha256,
          contextSnapshotArtifactId: cp.contextSnapshotArtifactId, contextSnapshotSha256: readHarnessRetainedBody(this.context.database, cp.contextSnapshotArtifactId).contentSha256,
          installedEventSeq: end.seq, installedEventDigest: delegationDigest(end), sourceFence: input.sourceFence, lineage: facts.lineage } };
        for (const id of compactionSuspensionArtifactIds(this.context, compactionWitness)) dependencies.add(id);
      } else if (!facts.restored && (facts.events.some(event => event.type === "context_compaction_start") || !record(input.modelView[0]) || input.modelView[0].role !== "user")) fail();
      for (const execution of this.ports.listHarnessToolExecutions(input.runId)) for (const id of execution.evidenceArtifactIds) dependencies.add(id);
      for (const row of this.context.database.prepare("SELECT price_artifact_id FROM delegation_budget_charges WHERE run_id=? AND price_artifact_id IS NOT NULL").all(input.runId)) dependencies.add(String(row.price_artifact_id));
      const id = `run_final_settlement_${randomUUID()}`;
      const viewArtifact = this.create(input.runId, input.modelView, FINAL_SETTLEMENT_VIEW_CONTENT_TYPE, "view", input.now);
      const payload: FinalSettlementPayload = { schemaVersion: 1, kind: "run.final_settlement.v1", id, runId: input.runId,
        observationKind: facts.observationKind, ...(facts.restored ? { restoredHandoff: facts.restored.handoff } : {}),
        sourceFence: input.sourceFence, lineage: facts.lineage, boundaryEventSeq: facts.events.at(-1)!.seq,
        canonicalEventDigest: delegationDigest(facts.events), budgetDigest: facts.budgetDigest, effectDigest: facts.effectDigest,
        modelViewArtifactId: viewArtifact.id, modelViewSha256: viewArtifact.contentSha256!, predecessorDigest: facts.predecessorDigest,
        dependencies: [...dependencies].sort().map(id => ({ id, digest: readHarnessRetainedBody(this.context.database, id).contentSha256 })),
        ...(compactionWitness ? { compactionWitness } : {}), committedAt: input.now };
      const artifact = this.create(input.runId, payload, FINAL_SETTLEMENT_CONTENT_TYPE, "receipt", input.now);
      const rechecked = readSqliteWithinTransaction(this.context.database, inspect);
      if (!same(facts, rechecked)) fail("checkpoint.source_watermark_changed");
      this.context.database.prepare(`INSERT INTO run_final_settlements (id,run_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,
        artifact_id,digest,model_view_artifact_id,model_view_sha256,boundary_event_seq,committed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, input.runId, input.sourceFence.workUnitId, input.sourceFence.attemptId, input.sourceFence.runtimeInstanceId, input.sourceFence.fencingToken,
          artifact.id, artifact.contentSha256!, viewArtifact.id, viewArtifact.contentSha256!, payload.boundaryEventSeq, input.now);
      const artifactIds = [artifact.id, viewArtifact.id, ...dependencies];
      for (const [ownerKind, reason] of [["run_final_settlement", "recovery"], ["run_final_settlement_audit", "audit_hold"]] as const)
        syncHarnessArtifactOwnerPins(this.context.database, { holder: harnessArtifactOwnerHolder(ownerKind, id), keep: true, reason, artifactIds, now: input.now });
      const saved = readRunFinalSettlementRecord(this.context.database, id);
      const result = verifyRunFinalSettlement(this.context, this.ports, saved.witness, input.now);
      this.context.database.exec("COMMIT"); return result;
    } catch (error) { rollbackOwnedSqliteTransaction(this.context.database); return blocked(error); }
  }
  private create(runId: string, payload: unknown, contentType: string, kind: string, now: string): RunArtifact {
    if (Buffer.byteLength(JSON.stringify(payload)) > RUN_PROGRESS_MAX_PAYLOAD_BYTES) fail();
    return this.ports.createArtifactWithinTransaction({ runId, type: "json", path: `sqlite:run-final-settlement-${kind}`,
      contentType, sealedPayload: JSON.parse(delegationJson(payload)), contentSha256: delegationDigest(payload), createdAt: now });
  }
}
function blocked(error: unknown): Extract<ReadRunFinalSettlementResult, { kind: "blocked" }> {
  return { kind: "blocked", code: error instanceof RunProgressCheckpointError ? error.code : "checkpoint.snapshot_unavailable" };
}
