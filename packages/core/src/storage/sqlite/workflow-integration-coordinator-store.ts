import type { SQLOutputValue } from "node:sqlite";
import type { RunStore } from "../../run-types.js";
import type { WorkflowIntegrationCoordinatorStore, WorkflowIntegrationCoordinatorAuthority,
  WorkflowIntegrationCoordinatorEffect, WorkflowIntegrationCoordinatorParticipant,
  RecordWorkflowIntegrationCoordinatorIntentInput, RecordWorkflowIntegrationCoordinatorReceiptInput,
  AdvanceWorkflowIntegrationCoordinatorRoundInput } from "../../workflow-integration-coordinator-types.js";
import type { WorkflowIsolationStore, WorkflowIsolationWriter, WorkflowIntegrationRound,
  WorkflowIsolationReceipt, WorkflowIsolationMutationResult, WorkflowIsolationGitIdentity } from "../../workflow-isolation-types.js";
import { workflowIsolationCanonicalJson as json, workflowIsolationDigest as digest, workflowIsolationRecord as record,
  workflowIsolationIdentity as identity, workflowIsolationRevision as revision, workflowIsolationTime as time,
  normalizeWorkflowIsolationGitIdentity, normalizeWorkflowIntegrationCandidate,
  canTransitionWorkflowIntegrationRound } from "../../workflow-isolation.js";
import type { SqliteStoreContext } from "./store-context.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { readSqliteSnapshot } from "./read-snapshot.js";
import { harnessArtifactOwnerHolder, pinHarnessArtifactWithinTransaction, readHarnessRetainedBody } from "./harness-artifact-recovery-pins.js";
import { readWorkflowIsolationTerminalCapture, type WorkflowIsolationTerminalCapturePorts } from "./workflow-isolation-terminal-capture.js";
import { SqliteWorkflowIsolationResultsStore } from "./workflow-isolation-results-store.js";
import { createSqliteWorkflowIsolationStore } from "./workflow-isolation-store.js";
import { readWorkflowIntegrationCompletionBlocker, registerWorkflowIntegrationCompletionReader,
  workflowCandidateVerificationMatches } from "./workflow-integration-completion.js";
import { registerSqliteWorkflowMergeApprovalStore, type WorkflowMergeApprovalPorts } from "./workflow-merge-approval-store.js";

type Authority = Extract<WorkflowIntegrationCoordinatorAuthority, { readonly status: "authorized" }>;
type Rejection = { readonly status: "invalid" | "stale" | "conflict"; readonly code: string };
class Veto extends Error {
  constructor(readonly result: Rejection) { super(result.code); }
}
function veto(status: Rejection["status"], code: string): never {
  throw new Veto({ status, code: `workflow_integration.${code}` });
}
const same = (a: unknown, b: unknown): boolean => a === undefined || b === undefined ? a === b : json(a) === json(b);
const parse = (value: SQLOutputValue | undefined): unknown => typeof value === "string" ? JSON.parse(value) : undefined;
const writerOf = (binding: WorkflowIntegrationCoordinatorParticipant["binding"]): WorkflowIsolationWriter => ({ bindingId: binding.bindingId, ...binding.fence });
const adapters = new WeakMap<RunStore, WorkflowIntegrationCoordinatorStore>();

export function createSqliteWorkflowIntegrationCoordinatorStore(store: RunStore): WorkflowIntegrationCoordinatorStore {
  const adapter = adapters.get(store);
  if (!adapter) throw new Error("workflow_integration.store_not_sqlite");
  return adapter;
}

/** Host composition only. Neither a SQLite handle nor a terminal writer is added to RunStore. */
export function registerSqliteWorkflowIntegrationCoordinatorStore(store: RunStore, context: SqliteStoreContext,
  ports: WorkflowIsolationTerminalCapturePorts & WorkflowMergeApprovalPorts, canonicalWorkspaceRoot: string): void {
  if (adapters.has(store)) throw new Error("workflow_integration.store_already_registered");
  const adapter = new SqliteWorkflowIntegrationCoordinatorStore(context, ports, canonicalWorkspaceRoot,
    createSqliteWorkflowIsolationStore(store));
  adapters.set(store, adapter);
  adapter.registerMergeApprovalStore(store);
  registerWorkflowIntegrationCompletionReader(context.database, (workflowId, now) => adapter.completionBlocker(workflowId, now),
    workflowId => adapter.readPublicationBlocker(workflowId));
}

class SqliteWorkflowIntegrationCoordinatorStore implements WorkflowIntegrationCoordinatorStore {
  private readonly results: SqliteWorkflowIsolationResultsStore;
  constructor(private readonly context: SqliteStoreContext, private readonly ports: WorkflowIsolationTerminalCapturePorts & WorkflowMergeApprovalPorts,
    private readonly root: string, private readonly isolation: WorkflowIsolationStore) {
    this.results = new SqliteWorkflowIsolationResultsStore(context, ports, isolation, root);
  }

  assertAuthority(input: Parameters<WorkflowIntegrationCoordinatorStore["assertAuthority"]>[0]): WorkflowIntegrationCoordinatorAuthority {
    return readSqliteSnapshot(this.context.database, () => this.readAuthority(input.roundId, input.generation, input.now));
  }

  registerMergeApprovalStore(store: RunStore): void {
    registerSqliteWorkflowMergeApprovalStore(store, this.context, this.isolation, this.ports, {
      authority: (roundId, generation, now, excludedMergeApprovalId) => this.readAuthority(roundId, generation, now, excludedMergeApprovalId),
      candidateVerified: authority => {
        try { this.verifyRetainedCandidate(authority); return true; }
        catch { return false; }
      },
    });
  }

  private readAuthority(roundId: string, generation: number, now: string, excludedMergeApprovalId?: string): WorkflowIntegrationCoordinatorAuthority {
    try { return this.authority(roundId, generation, now, excludedMergeApprovalId); }
    catch (error) {
      if (error instanceof Veto) return { status: error.result.status === "conflict" ? "blocked" : error.result.status, code: error.result.code };
      return { status: "blocked", code: "workflow_integration.authority_evidence_unverified" };
    }
  }

  recordIntent(input: RecordWorkflowIntegrationCoordinatorIntentInput): WorkflowIsolationMutationResult<WorkflowIntegrationCoordinatorEffect> {
    return this.transaction(() => {
      const authority = this.authority(input.roundId, input.generation, input.now);
      this.expectAuthority(authority, input.authorityDigest);
      if (!identity(input.effectKey) || !revision(input.expectedRevision)
        || !["integration_create", "integrate_branch", "candidate_verify"].includes(input.kind)) veto("invalid", "effect_input_invalid");
      const before = normalizeWorkflowIsolationGitIdentity(input.before), after = normalizeWorkflowIsolationGitIdentity(input.after);
      if (!before || !after) veto("invalid", "effect_identity_invalid");
      const binding = authority.participants.find(p => p.binding.bindingId === authority.writer.bindingId)!.binding;
      const payload = this.artifact(input.payloadArtifactId, binding.runId);
      const expected = { schemaVersion: 1, kind: "workflow_integration_coordinator_effect", roundId: input.roundId,
        generation: input.generation, authorityDigest: input.authorityDigest, effectKey: input.effectKey,
        effectKind: input.kind, before, after, effect: payload.body.effect };
      if (!same(payload.body, expected) || !record(payload.body.effect)) veto("invalid", "effect_artifact_mismatch");
      const existing = this.effects(input.roundId, input.generation).find(effect => effect.effectKey === input.effectKey);
      if (existing) {
        if (existing.scopeRevision !== input.expectedRevision || existing.kind !== input.kind || !same(existing.before, before)
          || !same(existing.after, after) || existing.payloadArtifactId !== input.payloadArtifactId
          || existing.payloadContentSha256 !== payload.sha256 || existing.authorityDigest !== input.authorityDigest)
          veto("conflict", "effect_key_reused");
        return { status: "duplicate", value: existing };
      }
      this.expectRevision(authority.round, input.expectedRevision);
      if (authority.round.openIntentId) veto("conflict", "effect_unconfirmed");
      this.validateEffect(authority, input.kind, input.effectKey, before, after, payload.body.effect);
      const intentId = digest({ roundId: input.roundId, generation: input.generation, effectKey: input.effectKey }, "wici_");
      const commandId = intentId;
      const scope = { type: "round", roundId: input.roundId, generation: input.generation };
      const intentDigest = digest({ intentId, commandId, scope, expectedRevision: input.expectedRevision,
        writer: authority.writer, kind: input.kind, before, after });
      this.context.database.prepare(`INSERT INTO workflow_isolation_intents(intent_id,command_id,intent_digest,scope_type,
        round_id,generation,scope_revision,writer_binding_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,
        kind,before_json,after_json,status,created_at) VALUES (?,?,?,'round',?,?,?,?,?,?,?,?,?,?,?,'pending',?)`)
        .run(intentId, commandId, intentDigest, input.roundId, input.generation, input.expectedRevision,
          authority.writer.bindingId, authority.writer.workUnitId, authority.writer.attemptId, authority.writer.runtimeInstanceId,
          authority.writer.fencingToken, input.kind, json(before), json(after), input.now);
      const link = { intentId, roundId: input.roundId, generation: input.generation, effectKey: input.effectKey,
        authorityDigest: input.authorityDigest, payloadArtifactId: input.payloadArtifactId, payloadContentSha256: payload.sha256 };
      this.context.database.prepare(`INSERT INTO workflow_integration_effect_links(intent_id,round_id,generation,effect_key,
        authority_digest,payload_artifact_id,payload_content_sha256,link_digest,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(intentId, input.roundId, input.generation, input.effectKey, input.authorityDigest, input.payloadArtifactId,
          payload.sha256, digest(link), input.now);
      this.updateRound(authority.round, input.now, intentId, authority.writer.bindingId);
      this.pin(input.payloadArtifactId, intentId, input.now);
      return { status: "created", value: this.effects(input.roundId, input.generation).find(effect => effect.intentId === intentId)! };
    });
  }

  recordReceipt(input: RecordWorkflowIntegrationCoordinatorReceiptInput): WorkflowIsolationMutationResult<WorkflowIsolationReceipt> {
    return this.transaction(() => {
      if (!time(input.now) || !identity(input.intentId) || !revision(input.expectedRevision)
        || !["confirmed", "blocked", "effect_unknown"].includes(input.outcome)) veto("invalid", "receipt_input_invalid");
      const row = this.context.database.prepare("SELECT round_id,generation FROM workflow_integration_effect_links WHERE intent_id=?").get(input.intentId);
      if (!row) veto("invalid", "receipt_intent_missing");
      const effect = this.effects(String(row.round_id), Number(row.generation)).find(e => e.intentId === input.intentId)!;
      if (input.authorityDigest !== effect.authorityDigest) veto("stale", "authority_changed");
      const round = this.isolation.getIntegrationRound(String(row.round_id));
      if (!round || round.generation !== row.generation) veto("stale", "generation_changed");
      const binding = this.isolation.getExecutionBinding(effect.writer.bindingId);
      if (!binding || !same(writerOf(binding), effect.writer)) veto("stale", "writer_changed");
      const observed = normalizeWorkflowIsolationGitIdentity(input.observed);
      if (!observed) veto("invalid", "receipt_identity_invalid");
      const payload = this.artifact(input.artifactId, binding.runId);
      if (!same(payload.body, { schemaVersion: 1, kind: "workflow_integration_coordinator_receipt", intentId: input.intentId,
        effectKey: effect.effectKey, outcome: input.outcome, observed, evidence: payload.body.evidence }) || !record(payload.body.evidence))
        veto("invalid", "receipt_artifact_mismatch");
      const receiptId = digest({ intentId: input.intentId, expectedRevision: input.expectedRevision,
        authorityDigest: input.authorityDigest, outcome: input.outcome, observed, artifactId: input.artifactId }, "wicr_");
      if (input.outcome === "confirmed") {
        const authority = this.authority(round.roundId, round.generation, input.now);
        this.expectAuthority(authority, input.authorityDigest);
        if (!same(observed, effect.after)) veto("invalid", "receipt_after_mismatch");
        this.validateObservation(authority, effect, payload.body.evidence);
      }
      const existing = this.receipts(round.roundId, round.generation).find(receipt => receipt.receiptId === receiptId);
      if (existing) return { status: "duplicate", value: existing };
      this.expectRevision(round, input.expectedRevision);
      if (round.openIntentId !== effect.intentId || effect.status === "confirmed") veto("stale", "receipt_effect_changed");
      const receiptDigest = digest({ receiptId, intentId: input.intentId, expectedRevision: input.expectedRevision,
        writer: effect.writer, outcome: input.outcome, observed, artifactId: input.artifactId });
      this.context.database.prepare(`INSERT INTO workflow_isolation_receipts(receipt_id,intent_id,receipt_digest,scope_revision,
        outcome,observed_json,artifact_id,created_at) VALUES (?,?,?,?,?,?,?,?)`).run(receiptId, input.intentId, receiptDigest,
          input.expectedRevision, input.outcome, json(observed), input.artifactId, input.now);
      const link = { receiptId, intentId: input.intentId, scopeRevision: input.expectedRevision, authorityDigest: input.authorityDigest,
        artifactId: input.artifactId, artifactContentSha256: payload.sha256 };
      this.context.database.prepare(`INSERT INTO workflow_integration_receipt_links(receipt_id,intent_id,scope_revision,
        authority_digest,artifact_id,artifact_content_sha256,link_digest,created_at) VALUES (?,?,?,?,?,?,?,?)`).run(receiptId,
          input.intentId, input.expectedRevision, input.authorityDigest, input.artifactId, payload.sha256, digest(link), input.now);
      this.changed(this.context.database.prepare("UPDATE workflow_isolation_intents SET status=? WHERE intent_id=? AND status<>'confirmed'")
        .run(input.outcome, input.intentId));
      this.updateRound(round, input.now, input.outcome === "confirmed" ? null : effect.intentId, effect.writer.bindingId);
      this.pin(input.artifactId, input.intentId, input.now);
      return { status: "created", value: this.isolation.getReceipt(receiptId)! };
    });
  }

  advanceRound(input: AdvanceWorkflowIntegrationCoordinatorRoundInput): WorkflowIsolationMutationResult<WorkflowIntegrationRound> {
    return this.transaction(() => {
      if (input.to === "applying" || input.to === "applied") veto("invalid", "merge_permit_not_implemented");
      const authority = this.authority(input.roundId, input.generation, input.now), { round } = authority;
      this.expectAuthority(authority, input.authorityDigest);
      const candidate = input.candidate === undefined ? undefined
        : normalizeWorkflowIntegrationCandidate(input.candidate, round.inputs.repositoryIdentity.objectFormat);
      if (input.candidate !== undefined && !candidate || candidate && input.to !== "awaiting_approval") veto("invalid", "candidate_invalid");
      if (round.phase === input.to && round.revision === input.expectedRevision + 1
        && same(round.candidate, candidate) && round.reason === input.reason) return { status: "duplicate", value: round };
      this.expectRevision(round, input.expectedRevision);
      if (round.phase !== input.from || !canTransitionWorkflowIntegrationRound(input.from, input.to)) veto("stale", "phase_changed");
      const effects = this.effects(round.roundId, round.generation);
      if (round.openIntentId || effects.some(effect => effect.status !== "confirmed")) veto("conflict", "round_effects_unconfirmed");
      const receipts = this.receipts(round.roundId, round.generation);
      if (!Array.isArray(input.receiptIds ?? []) || new Set(input.receiptIds).size !== (input.receiptIds?.length ?? 0)
        || (input.receiptIds?.length ?? 0) > 1024 || input.receiptIds?.some(id => !receipts.some(receipt => receipt.receiptId === id && receipt.outcome === "confirmed")))
        veto("invalid", "round_receipts_invalid");
      const confirmed = effects.filter(effect => receipts.some(receipt => receipt.intentId === effect.intentId
        && receipt.outcome === "confirmed" && input.receiptIds?.includes(receipt.receiptId)));
      if (input.to === "integrating" && !confirmed.some(effect => effect.effectKey === "worktree:create")) veto("invalid", "integration_receipt_required");
      if (input.to === "verifying") {
        const selected = this.selectedParticipants(authority);
        if (!selected.length || selected.some((p, index) => !confirmed.some(effect => effect.effectKey === `merge:${index + 1}`
          && this.effectBody(effect).workflowStepId === p.plan.workflowStepId))) veto("invalid", "integration_incomplete");
      }
      if (input.to === "awaiting_approval") {
        if (!candidate || !input.candidateArtifactId) veto("invalid", "candidate_required");
        this.verifyCandidate(authority, candidate, input.candidateArtifactId, confirmed, receipts);
        this.pin(input.candidateArtifactId, round.roundId, input.now);
      }
      if (input.reason !== undefined && !identity(input.reason) || ["failed", "conflicted", "blocked"].includes(input.to) && !identity(input.reason))
        veto("invalid", "reason_required");
      const last = ["failed", "conflicted", "blocked"].includes(input.to) ? round.lastConfirmedPhase : input.to;
      this.changed(this.context.database.prepare(`UPDATE workflow_integration_generations SET phase=?,last_confirmed_phase=?,
        writer_binding_id=COALESCE(writer_binding_id,?),candidate_json=COALESCE(candidate_json,?),reason=?,revision=revision+1,updated_at=?
        WHERE round_id=? AND generation=? AND revision=? AND phase=? AND open_intent_id IS NULL`).run(input.to, last,
          authority.writer.bindingId, candidate ? json(candidate) : null, input.reason ?? null, input.now,
          round.roundId, round.generation, input.expectedRevision, input.from));
      return { status: "updated", value: this.isolation.getIntegrationRound(round.roundId)! };
    });
  }

  listEffects(input: Parameters<WorkflowIntegrationCoordinatorStore["listEffects"]>[0]): readonly WorkflowIntegrationCoordinatorEffect[] {
    return readSqliteSnapshot(this.context.database, () => this.effects(input.roundId, input.generation));
  }
  listReceipts(input: Parameters<WorkflowIntegrationCoordinatorStore["listReceipts"]>[0]): readonly WorkflowIsolationReceipt[] {
    return readSqliteSnapshot(this.context.database, () => this.receipts(input.roundId, input.generation));
  }
  listRounds(workflowId?: string): readonly WorkflowIntegrationRound[] {
    return readSqliteSnapshot(this.context.database, () => {
      if (workflowId !== undefined && !identity(workflowId)) veto("invalid", "workflow_identity_invalid");
      const rows = workflowId === undefined
        ? this.context.database.prepare("SELECT round_id FROM workflow_integration_rounds ORDER BY round_id").all()
        : this.context.database.prepare("SELECT round_id FROM workflow_integration_rounds WHERE workflow_id=? ORDER BY round_id").all(workflowId);
      return rows.map(row => {
        const round = this.isolation.getIntegrationRound(String(row.round_id));
        if (!round) veto("invalid", "round_evidence_missing");
        return round;
      });
    });
  }
  readPublicationBlocker(workflowId: string): string | undefined {
    return readSqliteSnapshot(this.context.database, () => {
      try {
        const generations = this.context.database.prepare(`SELECT generation.round_id,generation.generation,generation.open_intent_id
          FROM workflow_integration_generations generation JOIN workflow_integration_rounds round USING(round_id)
          WHERE round.workflow_id=?`).all(workflowId);
        for (const row of generations) {
          const roundId = String(row.round_id), generation = Number(row.generation);
          const effects = this.effects(roundId, generation), receipts = this.receipts(roundId, generation);
          const intents = this.context.database.prepare("SELECT intent_id,status FROM workflow_isolation_intents WHERE round_id=? AND generation=?").all(roundId, generation);
          this.validateJournalInventory(row.open_intent_id === null ? undefined : String(row.open_intent_id), effects, receipts);
          if (row.open_intent_id || intents.length !== effects.length || intents.some(intent => intent.status !== "confirmed")
            || effects.some(effect => !receipts.some(receipt => receipt.intentId === effect.intentId && receipt.outcome === "confirmed")))
            return "workflow_isolation.integration_effect_unconfirmed";
        }
        const bindings = this.context.database.prepare(`SELECT binding.binding_id FROM workflow_isolation_bindings binding
          JOIN workflow_isolation_scope_plans plan USING(plan_id) WHERE plan.workflow_id=?`).all(workflowId);
        for (const row of bindings) {
          const binding = this.isolation.getExecutionBinding(String(row.binding_id));
          if (!binding || binding.openIntentId) return "workflow_isolation.preparation_effect_unconfirmed";
          const intents = this.context.database.prepare(`SELECT intent_id FROM workflow_isolation_intents
            WHERE scope_type='binding' AND scope_binding_id=?`).all(binding.bindingId);
          for (const raw of intents) {
            const intent = this.isolation.getIntent(String(raw.intent_id));
            const confirmed = this.context.database.prepare(`SELECT receipt_id FROM workflow_isolation_receipts
              WHERE intent_id=? AND outcome='confirmed'`).get(raw.intent_id!);
            const receipt = confirmed && this.isolation.getReceipt(String(confirmed.receipt_id));
            if (!intent || intent.status !== "confirmed" || !receipt || !same(receipt.observed, intent.after)
              || !same(intent.writer, writerOf(binding))) return "workflow_isolation.preparation_effect_unconfirmed";
            this.artifact(receipt.artifactId, binding.runId);
          }
        }
        const results = this.context.database.prepare(`SELECT result.binding_id,result.intent_id,result.status
          FROM workflow_isolation_result_intents result JOIN workflow_isolation_bindings binding USING(binding_id)
          JOIN workflow_isolation_scope_plans plan USING(plan_id) WHERE plan.workflow_id=?`).all(workflowId);
        for (const row of results) {
          const intent = this.results.getTerminalResultIntent(String(row.binding_id));
          const confirmed = this.context.database.prepare(`SELECT receipt_id FROM workflow_isolation_result_receipts
            WHERE intent_id=? AND outcome='confirmed'`).get(row.intent_id!);
          const receipt = confirmed && this.results.getTerminalResultReceipt(String(confirmed.receipt_id));
          if (!intent || intent.status !== "confirmed" || !receipt || receipt.intentId !== intent.intentId
            || receipt.observedCommit !== intent.commit || receipt.revision !== intent.revision
            || !same(receipt.writer, intent.writer)) return "workflow_isolation.result_effect_unconfirmed";
          const binding = this.isolation.getExecutionBinding(String(row.binding_id));
          if (!binding) return "workflow_isolation.result_effect_unconfirmed";
          const packet = this.artifact(intent.packetArtifactId, binding.runId), observation = this.artifact(receipt.artifactId, binding.runId);
          if (packet.sha256 !== intent.packetContentSha256 || digest(packet.body, "wgp1_") !== intent.packetDigest
            || observation.sha256 !== receipt.artifactContentSha256) return "workflow_isolation.result_effect_unconfirmed";
        }
        return undefined;
      } catch { return "workflow_isolation.publication_evidence_unverified"; }
    });
  }
  readCompletionBlocker(workflowId: string): string | undefined {
    return readWorkflowIntegrationCompletionBlocker(this.context.database, workflowId);
  }

  /** Shared with the final SQL completion transaction. Persisted rounds remain authoritative after pin removal. */
  completionBlocker(workflowId: string, now: string): string | undefined {
    const rows = this.context.database.prepare("SELECT round_id,current_generation FROM workflow_integration_rounds WHERE workflow_id=? ORDER BY round_id").all(workflowId);
    const pins = this.context.database.prepare("SELECT metadata_json FROM channel_workflow_steps WHERE workflow_id=?").all(workflowId);
    for (const row of pins) {
      const metadata = parse(row.metadata_json);
      if (!record(metadata) || !("isolationScopePlan" in metadata)) continue;
      const pin = metadata.isolationScopePlan;
      const plan = record(pin) && identity(pin.planId) ? this.isolation.getScopePlan(pin.planId) : undefined;
      if (!plan || !record(pin) || pin.planDigest !== plan.planDigest || plan.workflowId !== workflowId
        || !rows.some(round => round.round_id === plan.integrationRoundId && round.current_generation === plan.generation))
        return "workflow_isolation.completion_plan_changed";
    }
    for (const row of rows) {
      const authority = this.authority(String(row.round_id), Number(row.current_generation), now), { round } = authority;
      if (round.inputs.mode !== "candidate_only") return "workflow_isolation.merge_permit_not_implemented";
      if (round.phase !== "awaiting_approval" || !round.candidate || round.openIntentId) return "workflow_isolation.completion_candidate_unverified";
      this.verifyRetainedCandidate(authority);
    }
    return undefined;
  }

  private authority(roundId: string, generation: number, now: string, excludedMergeApprovalId?: string): Authority {
    if (!identity(roundId) || !Number.isSafeInteger(generation) || generation < 1 || !time(now)) veto("invalid", "authority_input_invalid");
    const round = this.isolation.getIntegrationRound(roundId);
    if (!round || round.generation !== generation) veto("stale", "generation_changed");
    const { inputs } = round, workflow = this.ports.getChannelWorkflow(inputs.workflowId);
    const channel = workflow && this.ports.getChannel(workflow.channelId);
    if (!workflow || !channel || !["running", "waiting_for_approval", "blocked", "succeeded"].includes(workflow.status)
      || workflow.workspaceId !== inputs.canonicalWorkspaceId || channel.workspaceId !== inputs.canonicalWorkspaceId
      || inputs.canonicalWorkspaceRoot !== this.root || workflow.metadata?.workflowGraphFingerprint !== inputs.graphFingerprint)
      veto("stale", "workflow_changed");
    const storedPlans = this.context.database.prepare("SELECT plan_id FROM workflow_isolation_scope_plans WHERE round_id=? AND generation=?").all(roundId, generation);
    if (storedPlans.length !== inputs.participants.length) veto("conflict", "participants_not_ready");
    const effects = this.effects(roundId, generation), receipts = this.receipts(roundId, generation);
    const rawIntents = this.context.database.prepare("SELECT intent_id FROM workflow_isolation_intents WHERE round_id=? AND generation=?").all(roundId, generation);
    if (rawIntents.length !== effects.length || rawIntents.some(row => !effects.some(effect => effect.intentId === row.intent_id))) veto("conflict", "foreign_round_effect");
    this.validateJournalInventory(round.openIntentId, effects, receipts);
    const internalCoordinator = { roundId, generation, verifiedIntentIds: effects.map(effect => effect.intentId) };
    const participants: WorkflowIntegrationCoordinatorParticipant[] = [];
    for (const participant of inputs.participants) {
      const step = this.ports.getChannelWorkflowStep(participant.workflowStepId), pin = step?.metadata?.isolationScopePlan;
      const plan = pin && this.isolation.getScopePlan(pin.planId);
      if (!step || !plan || plan.planDigest !== pin!.planDigest || !storedPlans.some(row => row.plan_id === plan.planId)
        || step.position !== participant.position || step.channelId !== workflow.channelId || plan.workflowId !== workflow.id
        || plan.workflowStepId !== step.id || plan.canonicalWorkspaceId !== inputs.canonicalWorkspaceId
        || plan.canonicalWorkspaceRoot !== inputs.canonicalWorkspaceRoot || plan.integrationRoundId !== roundId || plan.generation !== generation
        || plan.baseCommit !== inputs.baseCommit || plan.graphFingerprint !== inputs.graphFingerprint
        || !same(plan.target, inputs.target) || !same(plan.repositoryIdentity, inputs.repositoryIdentity)
        || !same(plan.templatePins, inputs.templatePins)) veto("stale", "participant_plan_changed");
      if (!["succeeded", "failed"].includes(step.status) || step.metadata?.activeGateStage !== undefined) veto("conflict", "participant_not_semantic_terminal");
      if (step.status !== "succeeded" && (participant.required || inputs.optionalFailurePolicy !== "exclude_failed_with_evidence"))
        veto("conflict", "required_participant_failed");
      const bindingRow = this.context.database.prepare("SELECT binding_id FROM workflow_isolation_bindings WHERE plan_id=?").get(plan.planId);
      const binding = bindingRow && this.isolation.getExecutionBinding(String(bindingRow.binding_id));
      if (!binding) veto("stale", "participant_binding_missing");
      const terminal = readWorkflowIsolationTerminalCapture(this.context.database, this.ports, binding, plan, round, now, internalCoordinator);
      if (terminal.status !== "authorized") throw new Veto({ status: terminal.status === "invalid" ? "invalid" : terminal.status === "stale" ? "stale" : "conflict", code: terminal.code });
      let resultIntent;
      try { resultIntent = this.results.readConfirmedTerminalResult(binding, plan, terminal); }
      catch { veto("conflict", "participant_result_unverified"); }
      if (terminal.terminal.outcome !== step.status) veto("stale", "participant_outcome_changed");
      participants.push({ binding, plan, proofDigest: terminal.proofDigest, resultIntent });
    }
    const writer = writerOf(participants.find(p => p.plan.workflowStepId === inputs.mergeOrder[0])!.binding);
    if (round.writerBindingId && round.writerBindingId !== writer.bindingId || effects.some(effect => !same(effect.writer, writer))) veto("stale", "writer_changed");
    if (this.context.database.prepare(`SELECT 1 FROM channel_workflow_steps WHERE workflow_id=? AND (status='waiting_for_approval'
      OR json_extract(metadata_json,'$.activeGateStage') IS NOT NULL) LIMIT 1`).get(workflow.id)
      || this.context.database.prepare(`SELECT 1 FROM approval_requests approval WHERE approval.status='pending' AND approval.id<>? AND (
        EXISTS (SELECT 1 FROM channel_workflow_steps step WHERE step.workflow_id=? AND (step.id=approval.workflow_step_id
          OR step.task_id=approval.task_id OR step.run_id=approval.run_id OR EXISTS (SELECT 1 FROM run_sessions run
            WHERE run.workflow_step_id=step.id AND (run.id=approval.run_id OR run.task_id=approval.task_id))))
        OR CASE WHEN json_valid(approval.payload_json) THEN json_extract(approval.payload_json,'$.workflowId') END=?) LIMIT 1`)
        .get(excludedMergeApprovalId ?? "", workflow.id, workflow.id)) veto("conflict", "approval_gate_active");
    const authorityDigest = digest({ roundId, generation, inputsDigest: round.inputsDigest, writer, participants }, "wica1_");
    if (effects.some(effect => effect.authorityDigest !== authorityDigest)
      || receipts.some(receipt => !effects.some(effect => effect.intentId === receipt.intentId))) veto("stale", "authority_changed");
    return { status: "authorized", round, writer, authorityDigest, participants };
  }

  private effects(roundId: string, generation: number): WorkflowIntegrationCoordinatorEffect[] {
    if (!identity(roundId) || !Number.isSafeInteger(generation) || generation < 1) veto("invalid", "scope_invalid");
    return this.context.database.prepare("SELECT * FROM workflow_integration_effect_links WHERE round_id=? AND generation=? ORDER BY created_at,intent_id")
      .all(roundId, generation).map(row => {
        const intent = this.isolation.getIntent(String(row.intent_id));
        if (!intent || intent.scope.type !== "round" || intent.scope.roundId !== roundId || intent.scope.generation !== generation)
          veto("invalid", "effect_link_corrupt");
        const link = { intentId: intent.intentId, roundId, generation, effectKey: String(row.effect_key), authorityDigest: String(row.authority_digest),
          payloadArtifactId: String(row.payload_artifact_id), payloadContentSha256: String(row.payload_content_sha256) };
        const binding = this.isolation.getExecutionBinding(intent.writer.bindingId);
        if (!binding || !same(writerOf(binding), intent.writer)) veto("invalid", "effect_writer_corrupt");
        const artifact = this.artifact(link.payloadArtifactId, binding.runId);
        if (row.link_digest !== digest(link) || artifact.sha256 !== link.payloadContentSha256
          || !same(artifact.body, { schemaVersion: 1, kind: "workflow_integration_coordinator_effect", roundId, generation,
            authorityDigest: link.authorityDigest, effectKey: link.effectKey, effectKind: intent.kind,
            before: intent.before, after: intent.after, effect: artifact.body.effect }) || !record(artifact.body.effect)) veto("invalid", "effect_link_corrupt");
        return { ...intent, effectKey: link.effectKey, payloadArtifactId: link.payloadArtifactId,
          payloadContentSha256: link.payloadContentSha256, authorityDigest: link.authorityDigest };
      });
  }

  private validateJournalInventory(openIntentId: string | undefined, effects: readonly WorkflowIntegrationCoordinatorEffect[],
    receipts: readonly WorkflowIsolationReceipt[]): void {
    const pending = effects.filter(effect => effect.status !== "confirmed");
    if (pending.length > 1 || (pending[0]?.intentId !== openIntentId)
      || effects.some(effect => effect.status === "confirmed"
        && !receipts.some(receipt => receipt.intentId === effect.intentId && receipt.outcome === "confirmed")))
      veto("conflict", "journal_inventory_unverified");
  }

  private receipts(roundId: string, generation: number): WorkflowIsolationReceipt[] {
    const effects = this.effects(roundId, generation);
    const rows = this.context.database.prepare(`SELECT receipt.* FROM workflow_isolation_receipts receipt
      JOIN workflow_isolation_intents intent USING(intent_id) WHERE intent.round_id=? AND intent.generation=? ORDER BY receipt.scope_revision,receipt.receipt_id`).all(roundId, generation);
    return rows.map(row => {
      const receipt = this.isolation.getReceipt(String(row.receipt_id)), effect = effects.find(effect => effect.intentId === row.intent_id);
      const link = this.context.database.prepare("SELECT * FROM workflow_integration_receipt_links WHERE receipt_id=?").get(row.receipt_id!);
      if (!receipt || !effect || !link) veto("invalid", "receipt_link_corrupt");
      const payload = { receiptId: receipt.receiptId, intentId: receipt.intentId, scopeRevision: Number(row.scope_revision),
        authorityDigest: effect.authorityDigest, artifactId: receipt.artifactId, artifactContentSha256: String(link.artifact_content_sha256) };
      const binding = this.isolation.getExecutionBinding(effect.writer.bindingId)!;
      const artifact = this.artifact(receipt.artifactId, binding.runId);
      if (link.intent_id !== receipt.intentId || link.scope_revision !== row.scope_revision || link.authority_digest !== effect.authorityDigest
        || link.artifact_id !== receipt.artifactId || link.link_digest !== digest(payload) || artifact.sha256 !== payload.artifactContentSha256
        || !same(artifact.body, { schemaVersion: 1, kind: "workflow_integration_coordinator_receipt", intentId: receipt.intentId,
          effectKey: effect.effectKey, outcome: receipt.outcome, observed: receipt.observed, evidence: artifact.body.evidence })
        || !record(artifact.body.evidence) || receipt.outcome === "confirmed" && (effect.status !== "confirmed" || !same(receipt.observed, effect.after)))
        veto("invalid", "receipt_link_corrupt");
      return receipt;
    });
  }

  private validateEffect(authority: Authority, kind: string, key: string, before: WorkflowIsolationGitIdentity,
    after: WorkflowIsolationGitIdentity, effect: Record<string, unknown>): void {
    const { round } = authority, { inputs } = round;
    for (const value of [before, after]) {
      const { executionRoot, branchRef, worktreeId } = value;
      if (!same({ executionRoot, branchRef, worktreeId }, inputs.integration) || value.commonDir !== inputs.repositoryIdentity.commonDir
        || value.headCommit !== null && value.headCommit.length !== inputs.baseCommit.length
        || value.tree !== undefined && value.tree.length !== inputs.baseCommit.length) veto("invalid", "effect_location_mismatch");
    }
    if (key === "worktree:create") {
      const scope = effect.scope;
      if (kind !== "integration_create" || round.phase !== "collecting" || effect.kind !== "workflow_integration_worktree"
        || !record(scope) || !record(scope.repository) || scope.roundId !== round.roundId || scope.stepId !== "integration"
        || scope.generation !== round.generation || scope.baseCommit !== inputs.baseCommit || scope.executionRoot !== after.executionRoot
        || scope.branchRef !== after.branchRef || scope.worktreeId !== after.worktreeId || scope.repository.root !== this.root
        || scope.repository.commonDir !== after.commonDir || before.exists || before.headCommit !== null
        || !after.exists || after.headCommit !== inputs.baseCommit) veto("invalid", "worktree_effect_mismatch");
    } else if (key.startsWith("ref:")) {
      if (kind !== "integration_create" || round.phase !== "integrating" || effect.kind !== "integration_create"
        || effect.roundId !== round.roundId || effect.generation !== round.generation || effect.commonDir !== after.commonDir
        || typeof effect.ref !== "string" || key !== `ref:${effect.ref}` || !effect.ref.startsWith(`${this.refPrefix(round)}/`)
        || effect.beforeCommit !== null || before.exists || before.headCommit !== null || !after.exists
        || effect.afterCommit !== after.headCommit || effect.tree !== after.tree || typeof effect.packetJson !== "string"
        || effect.packetJson !== json(JSON.parse(effect.packetJson)) || effect.packetDigest !== digest(JSON.parse(effect.packetJson), "wgp1_"))
        veto("invalid", "ref_effect_mismatch");
    } else if (kind === "integrate_branch") {
      const selected = this.selectedParticipants(authority), participant = selected[Number(effect.sequence) - 1];
      if (round.phase !== "integrating" || !Number.isSafeInteger(effect.sequence) || key !== `merge:${effect.sequence}` || !participant
        || effect.roundId !== round.roundId || effect.generation !== round.generation || effect.inputsDigest !== round.inputsDigest
        || !same(effect.writer, authority.writer) || effect.commonDir !== after.commonDir || effect.baseCommit !== inputs.baseCommit
        || effect.workflowStepId !== participant.plan.workflowStepId || effect.theirsCommit !== participant.resultIntent.commit
        || effect.branchResultDigest !== participant.resultIntent.packetDigest
        || effect.resultRef !== `${this.refPrefix(round)}/merge-${String(effect.sequence).padStart(4, "0")}`
        || !same(before, after) || !after.exists || after.headCommit !== inputs.baseCommit) veto("invalid", "merge_effect_mismatch");
    } else if (kind === "candidate_verify") {
      const candidate = effect.candidate;
      if (round.phase !== "verifying" || key !== "candidate:verify" || effect.kind !== "workflow_candidate_verify"
        || !same(before, after) || !after.exists || !record(candidate) || candidate.commit !== after.headCommit || candidate.tree !== after.tree
        || candidate.resultRef !== `${this.refPrefix(round)}/candidate` || !identity(candidate.packetDigest)
        || !same(effect.validationRequirements, inputs.validationRequirements)
        || effect.requirementsDigest !== digest(inputs.validationRequirements, "wvr1_")) veto("invalid", "verification_effect_mismatch");
    } else veto("invalid", "effect_kind_invalid");
  }

  private validateObservation(authority: Authority, effect: WorkflowIntegrationCoordinatorEffect, evidence: Record<string, unknown>): void {
    const body = this.effectBody(effect);
    if (effect.effectKey === "worktree:create") {
      const receipt = evidence.receipt;
      if (!same(evidence.scope, body.scope) || !record(receipt) || receipt.executionRoot !== effect.after.executionRoot
        || receipt.branchRef !== effect.after.branchRef || receipt.worktreeId !== effect.after.worktreeId
        || receipt.baseCommit !== authority.round.inputs.baseCommit || receipt.commonDir !== effect.after.commonDir
        || ![receipt.rootDevice, receipt.rootInode].every(value => typeof value === "string" && /^[0-9]+$/u.test(value)))
        veto("invalid", "worktree_observation_mismatch");
    } else if (effect.effectKey.startsWith("ref:")) {
      if (evidence.intentId !== effect.intentId || evidence.outcome !== "confirmed" || evidence.observedCommit !== effect.after.headCommit
        || !same(evidence.effect, body)) veto("invalid", "ref_observation_mismatch");
    } else if (effect.kind === "integrate_branch") {
      const result = evidence.evidence;
      if (evidence.intentId !== effect.intentId || evidence.outcome !== "confirmed" || !same(evidence.effect, body) || !record(result)
        || !same(Object.fromEntries(Object.keys(body).map(key => [key, result[key]])), body)
        || ![0, 1].includes(Number(result.exitCode)) || !this.oid(result.commit, authority.round) || !this.oid(result.tree, authority.round))
        veto("invalid", "merge_observation_mismatch");
    } else if (effect.kind === "candidate_verify") {
      const candidate = body.candidate;
      if (!record(candidate) || evidence.schemaVersion !== 1 || evidence.kind !== "workflow_candidate_verification"
        || evidence.applied !== false || evidence.projectTestsRun !== false || !["passed", "failed"].includes(String(evidence.status))
        || !record(evidence.candidate) || evidence.candidate.commit !== candidate.commit || evidence.candidate.tree !== candidate.tree
        || evidence.candidate.packetDigest !== candidate.packetDigest || evidence.candidate.resultRef !== candidate.resultRef
        || evidence.inputsDigest !== authority.round.inputsDigest || !same(evidence.writer, authority.writer)
        || !same(evidence.validationRequirements, authority.round.inputs.validationRequirements)) veto("invalid", "verification_observation_mismatch");
    }
  }

  private verifyCandidate(authority: Authority, candidate: NonNullable<WorkflowIntegrationRound["candidate"]>, artifactId: string | undefined,
    effects: readonly WorkflowIntegrationCoordinatorEffect[], receipts: readonly WorkflowIsolationReceipt[], retainedPacket?: unknown): void {
    const { round } = authority, writer = authority.participants.find(p => p.binding.bindingId === authority.writer.bindingId)!;
    const packet = artifactId ? this.artifact(artifactId, writer.binding.runId).body : retainedPacket;
    const final = effects.find(effect => effect.effectKey === `ref:${this.refPrefix(round)}/candidate`);
    const ref = final && this.effectBody(final);
    if (!record(packet) || packet.schemaVersion !== 1 || packet.kind !== "workflow_integration_candidate"
      || packet.status !== "pending_verification" || packet.applied !== false || packet.commit !== candidate.commit || packet.tree !== candidate.tree
      || packet.resultRef !== `${this.refPrefix(round)}/candidate` || digest(packet, "wgp1_") !== candidate.packetDigest
      || !record(packet.context) || packet.context.roundId !== round.roundId || packet.context.generation !== round.generation
      || packet.context.inputsDigest !== round.inputsDigest || !same(packet.context.inputs, round.inputs) || !same(packet.context.writer, authority.writer)
      || !same(candidate.branchResultDigests, authority.participants.map(p => p.resultIntent.packetDigest))
      || !ref || ref.packetDigest !== candidate.packetDigest || ref.packetJson !== json(packet) || final!.status !== "confirmed"
      || !receipts.some(receipt => receipt.intentId === final!.intentId && receipt.outcome === "confirmed")) veto("invalid", "candidate_packet_mismatch");
    const verification = effects.find(effect => effect.effectKey === "candidate:verify");
    if (!verification || verification.status !== "confirmed" || !receipts.some(receipt => {
      if (receipt.intentId !== verification.intentId || receipt.outcome !== "confirmed") return false;
      const artifact = this.artifact(receipt.artifactId, writer.binding.runId);
      return workflowCandidateVerificationMatches(artifact.body.evidence, { roundId: round.roundId, generation: round.generation,
        inputs: round.inputs, inputsDigest: round.inputsDigest, candidate, writer: authority.writer });
    })) veto("invalid", "candidate_verification_receipt_missing");
  }

  private verifyRetainedCandidate(authority: Authority): void {
    const { round } = authority;
    const effects = this.effects(round.roundId, round.generation), receipts = this.receipts(round.roundId, round.generation);
    if (!round.candidate || round.openIntentId || effects.some(effect => effect.status !== "confirmed"))
      veto("conflict", "candidate_effects_unconfirmed");
    const final = effects.find(effect => effect.effectKey === `ref:${this.refPrefix(round)}/candidate`);
    const packet = final && this.effectBody(final).packetJson;
    if (typeof packet !== "string") veto("invalid", "candidate_packet_missing");
    this.verifyCandidate(authority, round.candidate, undefined, effects, receipts, JSON.parse(packet));
  }

  private selectedParticipants(authority: Authority): readonly WorkflowIntegrationCoordinatorParticipant[] {
    return authority.participants.filter(participant => {
      const packet = this.artifact(participant.resultIntent.packetArtifactId, participant.binding.runId).body, terminal = packet.terminal;
      return record(terminal) && terminal.outcome === "succeeded" && Array.isArray(terminal.validations)
        && terminal.validations.every(value => record(value) && value.exitCode === 0);
    });
  }
  private refPrefix(round: WorkflowIntegrationRound): string {
    return `refs/ling/workflow/candidates/${round.roundId}/${round.generation}-${round.inputs.integration.worktreeId}`;
  }
  private effectBody(effect: WorkflowIntegrationCoordinatorEffect): Record<string, unknown> {
    const binding = this.isolation.getExecutionBinding(effect.writer.bindingId)!;
    const body = this.artifact(effect.payloadArtifactId, binding.runId).body.effect;
    if (!record(body)) veto("invalid", "effect_payload_invalid");
    return body;
  }
  private artifact(id: string, runId: string): { readonly body: Record<string, unknown>; readonly sha256: string } {
    if (!identity(id)) veto("invalid", "artifact_identity_invalid");
    let retained;
    try { retained = readHarnessRetainedBody(this.context.database, id); }
    catch { veto("invalid", "artifact_unverified"); }
    const row = this.context.database.prepare("SELECT run_id,type,sealed_payload_json FROM artifacts WHERE id=?").get(id);
    const body = row && parse(row.sealed_payload_json);
    if (!row || row.run_id !== runId || row.type !== "json" || !record(body)) veto("invalid", "artifact_mismatch");
    return { body, sha256: retained.contentSha256 };
  }
  private oid(value: unknown, round: WorkflowIntegrationRound): boolean {
    return typeof value === "string" && value.length === round.inputs.baseCommit.length && /^[a-f0-9]+$/u.test(value);
  }
  private expectAuthority(authority: Authority, expected: string): void {
    if (authority.authorityDigest !== expected) veto("stale", "authority_changed");
  }
  private expectRevision(round: WorkflowIntegrationRound, expected: number): void {
    if (!revision(expected)) veto("invalid", "revision_invalid");
    if (round.revision !== expected) veto("stale", "revision_changed");
  }
  private updateRound(round: WorkflowIntegrationRound, now: string, open: string | null, bindingId: string): void {
    this.changed(this.context.database.prepare(`UPDATE workflow_integration_generations SET open_intent_id=?,
      writer_binding_id=COALESCE(writer_binding_id,?),revision=revision+1,updated_at=? WHERE round_id=? AND generation=? AND revision=?
      AND (writer_binding_id IS NULL OR writer_binding_id=?)`).run(open, bindingId, now, round.roundId, round.generation, round.revision, bindingId));
  }
  private pin(artifactId: string, ownerId: string, now: string): void {
    pinHarnessArtifactWithinTransaction(this.context.database, { artifactId,
      holder: harnessArtifactOwnerHolder("workflow_integration", ownerId), reason: "audit_hold", now });
  }
  private changed(result: { readonly changes: number | bigint }): void {
    if (Number(result.changes) !== 1) veto("stale", "cas_changed");
  }
  private transaction<T>(write: () => WorkflowIsolationMutationResult<T>): WorkflowIsolationMutationResult<T> {
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const value = write(); this.context.database.exec("COMMIT"); return value; }
    catch (error) { rollbackOwnedSqliteTransaction(this.context.database); if (error instanceof Veto) return error.result; throw error; }
  }
}
