import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, normalize } from "node:path";
import type { SQLOutputValue } from "node:sqlite";
import type { WorkflowIsolationStore, WorkflowIsolationWriter, WorkflowIsolationExecutionBinding,
  WorkflowIsolationScopePlanV1, WorkflowIsolationMutationResult, WorkflowIsolationTerminalCaptureResult } from "../../workflow-isolation-types.js";
import type { WorkflowIsolationTerminalResultsStore, WorkflowIsolationTerminalResultIntent,
  WorkflowIsolationTerminalResultReceipt, WorkflowIsolationTerminalResultEffectV1,
  RecordWorkflowIsolationTerminalResultIntentInput, RecordWorkflowIsolationTerminalResultReceiptInput,
  ResumeWorkflowIsolationTerminalResultStepInput } from "../../workflow-isolation-results-types.js";
import type { ChannelWorkflowStep } from "../../workspace-types.js";
import type { WorkflowMergeTargetSnapshotV1 } from "../../workflow-merge-types.js";
import { isWorkflowMergeTargetSnapshot, workflowMergeTargetSnapshotDigest } from "../../workflow-merge-approval.js";
import { transitionWorkflow, transitionWorkflowStep } from "../../state-machines.js";
import { workflowIsolationCanonicalJson as json, workflowIsolationDigest as digest, workflowIsolationRecord as record,
  workflowIsolationIdentity as identity, workflowIsolationRevision as revision, workflowIsolationTime as time } from "../../workflow-isolation.js";
import type { SqliteStoreContext } from "./store-context.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { harnessArtifactOwnerHolder, pinHarnessArtifactWithinTransaction, readHarnessRetainedBody } from "./harness-artifact-recovery-pins.js";
import { readWorkflowIsolationTerminalCapture, type WorkflowIsolationTerminalCapturePorts } from "./workflow-isolation-terminal-capture.js";
import { SqliteStateTransitionStore } from "./state-transition-store.js";

type Scopes = Pick<WorkflowIsolationStore, "getExecutionBinding" | "getScopePlan" | "getIntegrationRound" | "getReceipt" | "getIntent">;
type Row = Record<string, SQLOutputValue>;
type Authority = Extract<WorkflowIsolationTerminalCaptureResult, { readonly status: "authorized" }>;
type Rejection = { readonly status: "invalid" | "stale" | "conflict"; readonly code: string };
class Veto extends Error {
  constructor(readonly result: Rejection) { super(result.code); }
}
function veto(status: Rejection["status"], code: string): never {
  throw new Veto({ status, code: `workflow_isolation.result_${code}` });
}
const same = (a: unknown, b: unknown): boolean => a === undefined || b === undefined ? a === b : json(a) === json(b);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const oid = (value: unknown, size?: number): value is string => typeof value === "string"
  && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value) && (size === undefined || value.length === size);
const token = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
const path = (value: unknown): value is string => identity(value) && isAbsolute(value) && normalize(value) === value;
const validWriter = (value: unknown): value is WorkflowIsolationWriter => record(value)
  && [value.bindingId, value.workUnitId, value.attemptId, value.runtimeInstanceId].every(identity)
  && typeof value.fencingToken === "string" && /^[1-9][0-9]*$/u.test(value.fencingToken);
const writerOf = (binding: WorkflowIsolationExecutionBinding): WorkflowIsolationWriter => ({ bindingId: binding.bindingId, ...binding.fence });
const rowWriter = (row: Row): WorkflowIsolationWriter => ({ bindingId: String(row.binding_id), workUnitId: String(row.work_unit_id),
  attemptId: String(row.attempt_id), runtimeInstanceId: String(row.runtime_instance_id), fencingToken: String(row.fencing_token) });
const intentPayload = (value: WorkflowIsolationTerminalResultIntent, runId: string) => ({ intentId: value.intentId,
  writer: value.writer, runId, expectedBindingRevision: value.bindingRevision, proofDigest: value.proofDigest,
  packetArtifactId: value.packetArtifactId, packetContentSha256: value.packetContentSha256, packetDigest: value.packetDigest,
  commonDir: value.commonDir, ref: value.ref, commit: value.commit, tree: value.tree });
const receiptPayload = (value: WorkflowIsolationTerminalResultReceipt) => ({ receiptId: value.receiptId, intentId: value.intentId,
  writer: value.writer, expectedRevision: value.revision - 1, outcome: value.outcome, observedCommit: value.observedCommit,
  artifactId: value.artifactId, artifactContentSha256: value.artifactContentSha256 });

/** Separate, terminal-only journal. No method here calls currentWriter or changes execution/round authority. */
export class SqliteWorkflowIsolationResultsStore implements WorkflowIsolationTerminalResultsStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: WorkflowIsolationTerminalCapturePorts,
    private readonly scopes: Scopes, private readonly canonicalWorkspaceRoot: string) {}

  recordTerminalResultIntent(input: RecordWorkflowIsolationTerminalResultIntentInput): WorkflowIsolationMutationResult<WorkflowIsolationTerminalResultIntent> {
    return this.transaction(() => {
      this.validateTime(input.now);
      if (!identity(input.intentId) || !identity(input.packetArtifactId) || !revision(input.expectedBindingRevision)
        || !/^witc1_[a-f0-9]{64}$/u.test(input.proofDigest) || !/^wgp1_[a-f0-9]{64}$/u.test(input.packetDigest))
        veto("invalid", "intent_input_invalid");
      const { binding, plan } = this.bound(input.writer);
      if (binding.revision !== input.expectedBindingRevision) veto("stale", "binding_revision_changed");
      const authority = this.authority(binding, plan, input.proofDigest, input.now);
      const packet = this.artifact(input.packetArtifactId, binding.runId);
      const value: WorkflowIsolationTerminalResultIntent = { intentId: input.intentId, writer: writerOf(binding),
        bindingRevision: binding.revision, proofDigest: input.proofDigest, packetArtifactId: input.packetArtifactId,
        packetContentSha256: packet.contentSha256, packetDigest: input.packetDigest, commonDir: plan.repositoryIdentity.commonDir,
        ref: input.ref, commit: input.commit, tree: input.tree, revision: 0, status: "pending", createdAt: input.now, updatedAt: input.now };
      this.validatePacket(value, binding, plan, packet.body, authority);
      const byId = this.intentById(input.intentId), existing = this.getTerminalResultIntent(binding.bindingId);
      if (byId || existing) {
        if (!byId || !existing || byId.intentId !== existing.intentId
          || !same(intentPayload(existing, binding.runId), intentPayload(value, binding.runId))) veto("conflict", "intent_identity_retained");
        return { status: "duplicate", value: existing };
      }
      if (this.context.database.prepare("SELECT 1 FROM workflow_isolation_result_intents WHERE common_dir=? AND ref=?")
        .get(value.commonDir, value.ref)) veto("conflict", "ref_retained");
      this.context.database.prepare(`INSERT INTO workflow_isolation_result_intents(intent_id,binding_id,run_id,work_unit_id,attempt_id,
        runtime_instance_id,fencing_token,binding_revision,proof_digest,packet_artifact_id,packet_content_sha256,packet_digest,
        common_dir,ref,result_commit,result_tree,intent_digest,revision,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'pending',?,?)`).run(value.intentId, binding.bindingId, binding.runId,
        binding.fence.workUnitId, binding.fence.attemptId, binding.fence.runtimeInstanceId, binding.fence.fencingToken,
        value.bindingRevision, value.proofDigest, value.packetArtifactId, value.packetContentSha256, value.packetDigest,
        value.commonDir, value.ref, value.commit, value.tree, digest(intentPayload(value, binding.runId)), input.now, input.now);
      this.pin(input.packetArtifactId, value.intentId, input.now);
      return { status: "created", value };
    });
  }

  getTerminalResultIntent(bindingId: string): WorkflowIsolationTerminalResultIntent | undefined {
    const row = this.context.database.prepare("SELECT * FROM workflow_isolation_result_intents WHERE binding_id=?").get(bindingId);
    return row && this.intentFromRow(row);
  }

  recordTerminalResultReceipt(input: RecordWorkflowIsolationTerminalResultReceiptInput): WorkflowIsolationMutationResult<WorkflowIsolationTerminalResultReceipt> {
    return this.transaction(() => {
      this.validateTime(input.now);
      if (!identity(input.receiptId) || !identity(input.intentId) || !identity(input.artifactId) || !revision(input.expectedRevision)
        || !["confirmed", "blocked", "effect_unknown"].includes(input.outcome)
        || input.observedCommit !== null && !oid(input.observedCommit)) veto("invalid", "receipt_input_invalid");
      const intent = this.intentById(input.intentId);
      if (!intent) veto("invalid", "intent_missing");
      const { binding, plan } = this.bound(input.writer);
      if (!same(intent.writer, writerOf(binding))) veto("stale", "writer_fence_changed");
      const packet = this.artifact(intent.packetArtifactId, binding.runId);
      if (packet.contentSha256 !== intent.packetContentSha256 || digest(packet.body, "wgp1_") !== intent.packetDigest)
        veto("invalid", "packet_changed");
      // Unknown observations remain auditable after cancellation/drift; they never confirm or grant execution.
      if (input.outcome === "confirmed") {
        if (binding.revision !== intent.bindingRevision) veto("stale", "binding_revision_changed");
        const authority = this.authority(binding, plan, intent.proofDigest, input.now);
        this.validatePacket(intent, binding, plan, packet.body, authority);
        if (input.observedCommit !== intent.commit) veto("invalid", "observation_mismatch");
      }
      if (input.observedCommit !== null && !oid(input.observedCommit, intent.commit.length)) veto("invalid", "observation_mismatch");
      const artifact = this.artifact(input.artifactId, binding.runId);
      const effect = this.effect(intent, plan, packet.body);
      if (!same(artifact.body, { schemaVersion: 1, kind: "workflow_isolation_result_ref_receipt", intentId: intent.intentId,
        effect, outcome: input.outcome, observedCommit: input.observedCommit })) veto("invalid", "receipt_artifact_mismatch");
      const value: WorkflowIsolationTerminalResultReceipt = { receiptId: input.receiptId, intentId: intent.intentId,
        writer: intent.writer, revision: input.expectedRevision + 1, outcome: input.outcome, observedCommit: input.observedCommit,
        artifactId: input.artifactId, artifactContentSha256: artifact.contentSha256, createdAt: input.now };
      if (!revision(value.revision)) veto("invalid", "revision_invalid");
      const existing = this.getTerminalResultReceipt(input.receiptId);
      if (existing) {
        if (!same(receiptPayload(existing), receiptPayload(value))) veto("conflict", "receipt_id_reused");
        return { status: "duplicate", value: existing };
      }
      if (intent.revision !== input.expectedRevision) veto("stale", "revision_changed");
      if (intent.status === "confirmed") veto("conflict", "already_confirmed");
      this.context.database.prepare(`INSERT INTO workflow_isolation_result_receipts(receipt_id,intent_id,binding_id,work_unit_id,
        attempt_id,runtime_instance_id,fencing_token,revision,outcome,observed_commit,artifact_id,artifact_content_sha256,receipt_digest,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(value.receiptId, intent.intentId, intent.writer.bindingId, intent.writer.workUnitId,
        intent.writer.attemptId, intent.writer.runtimeInstanceId, intent.writer.fencingToken, value.revision, value.outcome,
        value.observedCommit, value.artifactId, value.artifactContentSha256, digest(receiptPayload(value)), input.now);
      const changed = this.context.database.prepare(`UPDATE workflow_isolation_result_intents SET revision=revision+1,status=?,updated_at=?
        WHERE intent_id=? AND revision=? AND status<>'confirmed'`).run(input.outcome, input.now, intent.intentId, input.expectedRevision);
      if (Number(changed.changes) !== 1) veto("stale", "revision_changed");
      this.pin(input.artifactId, intent.intentId, input.now);
      return { status: "created", value };
    });
  }

  getTerminalResultReceipt(receiptId: string): WorkflowIsolationTerminalResultReceipt | undefined {
    const row = this.context.database.prepare("SELECT * FROM workflow_isolation_result_receipts WHERE receipt_id=?").get(receiptId);
    if (!row) return undefined;
    const value: WorkflowIsolationTerminalResultReceipt = { receiptId: String(row.receipt_id), intentId: String(row.intent_id),
      writer: rowWriter(row), revision: Number(row.revision), outcome: row.outcome as WorkflowIsolationTerminalResultReceipt["outcome"],
      observedCommit: row.observed_commit === null ? null : String(row.observed_commit), artifactId: String(row.artifact_id),
      artifactContentSha256: String(row.artifact_content_sha256), createdAt: String(row.created_at) };
    if (digest(receiptPayload(value)) !== row.receipt_digest) throw new Error("workflow_isolation.result_receipt_corrupt");
    return value;
  }

  /** Internal read-side reuse by the Host coordinator; never grants a live writer. */
  readConfirmedTerminalResult(binding: WorkflowIsolationExecutionBinding, plan: WorkflowIsolationScopePlanV1,
    authority: Authority): WorkflowIsolationTerminalResultIntent {
    const intent = this.getTerminalResultIntent(binding.bindingId);
    if (!intent || intent.status !== "confirmed" || intent.bindingRevision !== binding.revision
      || intent.proofDigest !== authority.proofDigest || !same(intent.writer, writerOf(binding))) veto("stale", "ref_unconfirmed");
    const packet = this.artifact(intent.packetArtifactId, binding.runId);
    if (packet.contentSha256 !== intent.packetContentSha256) veto("invalid", "packet_changed");
    this.validatePacket(intent, binding, plan, packet.body, authority);
    const row = this.context.database.prepare(`SELECT receipt_id FROM workflow_isolation_result_receipts
      WHERE intent_id=? AND outcome='confirmed' AND revision=?`).get(intent.intentId, intent.revision);
    const receipt = row && this.getTerminalResultReceipt(String(row.receipt_id));
    if (!receipt || receipt.observedCommit !== intent.commit || !same(receipt.writer, intent.writer)) veto("invalid", "receipt_artifact_mismatch");
    const observation = this.artifact(receipt.artifactId, binding.runId);
    if (observation.contentSha256 !== receipt.artifactContentSha256 || !same(observation.body, {
      schemaVersion: 1, kind: "workflow_isolation_result_ref_receipt", intentId: intent.intentId,
      effect: this.effect(intent, plan, packet.body), outcome: "confirmed", observedCommit: intent.commit,
    })) veto("invalid", "receipt_artifact_mismatch");
    return intent;
  }

  resumeTerminalResultStep(input: ResumeWorkflowIsolationTerminalResultStepInput): WorkflowIsolationMutationResult<ChannelWorkflowStep> {
    return this.transaction(() => {
      this.validateTime(input.now);
      if (!revision(input.expectedBindingRevision)) veto("invalid", "binding_revision_invalid");
      const { binding, plan } = this.bound(input.writer);
      if (binding.revision !== input.expectedBindingRevision) veto("stale", "binding_revision_changed");
      const intent = this.getTerminalResultIntent(binding.bindingId);
      if (!intent || intent.status !== "confirmed" || intent.bindingRevision !== binding.revision
        || !same(intent.writer, writerOf(binding))) veto("conflict", "ref_unconfirmed");
      const authority = this.authority(binding, plan, intent.proofDigest, input.now);
      const packet = this.artifact(intent.packetArtifactId, binding.runId);
      if (packet.contentSha256 !== intent.packetContentSha256) veto("invalid", "packet_changed");
      this.validatePacket(intent, binding, plan, packet.body, authority);
      const confirmed = this.context.database.prepare(`SELECT receipt_id FROM workflow_isolation_result_receipts
        WHERE intent_id=? AND outcome='confirmed' AND revision=?`).get(intent.intentId, intent.revision);
      const receipt = confirmed && this.getTerminalResultReceipt(String(confirmed.receipt_id));
      if (!receipt || receipt.observedCommit !== intent.commit || !same(receipt.writer, intent.writer)) veto("invalid", "receipt_artifact_mismatch");
      const observation = this.artifact(receipt.artifactId, binding.runId);
      if (observation.contentSha256 !== receipt.artifactContentSha256 || !same(observation.body, {
        schemaVersion: 1, kind: "workflow_isolation_result_ref_receipt", intentId: intent.intentId,
        effect: this.effect(intent, plan, packet.body), outcome: "confirmed", observedCommit: intent.commit,
      })) veto("invalid", "receipt_artifact_mismatch");
      const step = this.ports.getChannelWorkflowStep(plan.workflowStepId)!, workflow = this.ports.getChannelWorkflow(plan.workflowId)!;
      if (!["running", "waiting_for_approval", "blocked"].includes(workflow.status) || step.metadata?.activeGateStage !== undefined)
        veto("conflict", "resume_gate_active");
      const transitions = new SqliteStateTransitionStore(this.context);
      const key = digest({ intentId: intent.intentId, bindingRevision: binding.revision }, "wirs_");
      if (step.status === "running" && transitions.findStateTransitionByIdempotency("workflow_step", step.id, `${key}:start`))
        return { status: "duplicate", value: step };
      const prior = this.context.database.prepare(`SELECT * FROM state_transition_events
        WHERE entity_type='workflow_step' AND entity_id=? ORDER BY rowid DESC LIMIT 1`).get(step.id);
      if (step.status !== "blocked" || typeof step.blocker !== "string" || !/^workflow_isolation\.result_[a-z0-9_]+$/u.test(step.blocker)
        || !prior || prior.actor !== "system" || prior.event !== "blocked" || prior.from_status !== "running"
        || prior.to_status !== "blocked" || prior.reason !== step.blocker || prior.created_at !== step.updatedAt)
        veto("conflict", "resume_not_result_gate");
      const resumed = transitionWorkflowStep({ entityId: step.id, currentStatus: "blocked", expectedStatus: "blocked", event: "resume", actor: "system" });
      const started = transitionWorkflowStep({ entityId: step.id, currentStatus: "claimed", expectedStatus: "claimed", event: "start", actor: "system" });
      if (!resumed.ok || !started.ok) veto("conflict", "resume_not_permitted");
      const changed = this.context.database.prepare(`UPDATE channel_workflow_steps SET status='running',blocker=NULL,updated_at=?
        WHERE id=? AND status='blocked' AND task_id=? AND run_id=? AND updated_at=?`).run(input.now, step.id,
        binding.startOwner.taskId, binding.runId, step.updatedAt);
      if (Number(changed.changes) !== 1) veto("stale", "resume_changed");
      for (const [event, fromStatus, toStatus] of [["resume", "blocked", "claimed"], ["start", "claimed", "running"]])
        transitions.recordStateTransitionEvent({ workspaceId: step.workspaceId, entityType: "workflow_step", entityId: step.id,
          event, fromStatus, toStatus, actor: "system", reason: "workflow_isolation.result_ref_confirmed",
          idempotencyKey: `${key}:${event}`, createdAt: input.now });
      // Only restart the aggregate block produced by this same gate. Approval waits and other blockers stay intact.
      const workflowAudit = this.context.database.prepare(`SELECT * FROM state_transition_events
        WHERE entity_type='workflow' AND entity_id=? ORDER BY rowid DESC LIMIT 1`).get(workflow.id);
      const waits = this.context.database.prepare(`SELECT 1 FROM channel_workflow_steps step LEFT JOIN run_sessions run ON run.id=step.run_id
        WHERE step.workflow_id=? AND (step.status='waiting_for_approval' OR run.status='waiting_for_approval') LIMIT 1`).get(workflow.id);
      const pending = this.context.database.prepare(`SELECT 1 FROM approval_requests approval WHERE approval.status='pending' AND (
        EXISTS (SELECT 1 FROM channel_workflow_steps step WHERE step.workflow_id=? AND (step.id=approval.workflow_step_id
          OR step.task_id=approval.task_id OR step.run_id=approval.run_id OR EXISTS (SELECT 1 FROM run_sessions run
            WHERE run.workflow_step_id=step.id AND (run.id=approval.run_id OR run.task_id=approval.task_id))))
        OR CASE WHEN json_valid(approval.payload_json) THEN json_extract(approval.payload_json,'$.workflowId') END=?) LIMIT 1`)
        .get(workflow.id, workflow.id);
      if (workflow.status === "blocked" && !waits && !pending && workflowAudit?.actor === "system"
        && workflowAudit.event === "step_blocked" && workflowAudit.from_status === "running"
        && workflowAudit.to_status === "blocked" && workflowAudit.reason === step.blocker && workflowAudit.created_at === workflow.updatedAt) {
        const start = transitionWorkflow({ entityId: workflow.id, currentStatus: "blocked", expectedStatus: "blocked", event: "start", actor: "system" });
        if (!start.ok) veto("conflict", "resume_not_permitted");
        this.context.database.prepare("UPDATE channel_workflows SET status='running',updated_at=? WHERE id=? AND status='blocked'")
          .run(input.now, workflow.id);
        transitions.recordStateTransitionEvent({ workspaceId: workflow.workspaceId, entityType: "workflow", entityId: workflow.id,
          fromStatus: "blocked", toStatus: "running", event: "start", actor: "system", reason: "workflow_isolation.result_ref_confirmed",
          idempotencyKey: key, createdAt: input.now });
      }
      return { status: "updated", value: this.ports.getChannelWorkflowStep(step.id)! };
    });
  }

  private intentById(intentId: string): WorkflowIsolationTerminalResultIntent | undefined {
    const row = this.context.database.prepare("SELECT * FROM workflow_isolation_result_intents WHERE intent_id=?").get(intentId);
    return row && this.intentFromRow(row);
  }
  private intentFromRow(row: Row): WorkflowIsolationTerminalResultIntent {
    const value: WorkflowIsolationTerminalResultIntent = { intentId: String(row.intent_id), writer: rowWriter(row),
      bindingRevision: Number(row.binding_revision), proofDigest: String(row.proof_digest), packetArtifactId: String(row.packet_artifact_id),
      packetContentSha256: String(row.packet_content_sha256), packetDigest: String(row.packet_digest), commonDir: String(row.common_dir),
      ref: String(row.ref), commit: String(row.result_commit), tree: String(row.result_tree), revision: Number(row.revision),
      status: row.status as WorkflowIsolationTerminalResultIntent["status"], createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
    if (digest(intentPayload(value, String(row.run_id))) !== row.intent_digest) throw new Error("workflow_isolation.result_intent_corrupt");
    return value;
  }
  private bound(writer: WorkflowIsolationWriter): { readonly binding: WorkflowIsolationExecutionBinding; readonly plan: WorkflowIsolationScopePlanV1 } {
    if (!validWriter(writer)) veto("invalid", "writer_invalid");
    const binding = this.scopes.getExecutionBinding(writer.bindingId), plan = binding && this.scopes.getScopePlan(binding.planId);
    if (!binding || !plan || !same(writerOf(binding), { bindingId: writer.bindingId, workUnitId: writer.workUnitId,
      attemptId: writer.attemptId, runtimeInstanceId: writer.runtimeInstanceId, fencingToken: writer.fencingToken })
      || plan.canonicalWorkspaceRoot !== this.canonicalWorkspaceRoot) veto("stale", "writer_fence_changed");
    return { binding, plan };
  }
  private authority(binding: WorkflowIsolationExecutionBinding, plan: WorkflowIsolationScopePlanV1, proofDigest: string, now: string): Authority {
    const result = readWorkflowIsolationTerminalCapture(this.context.database, this.ports, binding, plan,
      this.scopes.getIntegrationRound(plan.integrationRoundId), now);
    if (result.status !== "authorized") throw new Veto({ status: result.status === "blocked" ? "conflict" : result.status, code: result.code });
    if (result.proofDigest !== proofDigest) veto("stale", "proof_changed");
    return result;
  }
  private artifact(artifactId: string, runId: string): { readonly body: Record<string, unknown>; readonly contentSha256: string } {
    let retained: ReturnType<typeof readHarnessRetainedBody>;
    try { retained = readHarnessRetainedBody(this.context.database, artifactId); }
    catch { veto("invalid", "artifact_unverified"); }
    const row = this.context.database.prepare("SELECT run_id,type,sealed_payload_json FROM artifacts WHERE id=?").get(artifactId);
    if (!row || row.run_id !== runId || row.type !== "json" || typeof row.sealed_payload_json !== "string") veto("invalid", "artifact_mismatch");
    let body: unknown;
    try { body = JSON.parse(row.sealed_payload_json); }
    catch { veto("invalid", "artifact_unverified"); }
    if (!record(body)) veto("invalid", "artifact_mismatch");
    return { body, contentSha256: retained.contentSha256 };
  }
  private validatePacket(intent: WorkflowIsolationTerminalResultIntent, binding: WorkflowIsolationExecutionBinding,
    plan: WorkflowIsolationScopePlanV1, packet: Record<string, unknown>, authority: Authority): void {
    const size = plan.repositoryIdentity.objectFormat === "sha1" ? 40 : 64;
    const ref = `refs/ling/workflow/results/${plan.integrationRoundId}/${plan.workflowStepId}/${plan.stepGeneration}-${plan.worktreeId}`;
    if (![plan.integrationRoundId, plan.workflowStepId, plan.worktreeId].every(token) || intent.ref !== ref
      || !oid(intent.commit, size) || !oid(intent.tree, size) || packet.schemaVersion !== 1 || packet.kind !== "workflow_branch_result"
      || packet.resultRef !== ref || packet.baseCommit !== plan.baseCommit || packet.commit !== intent.commit || packet.tree !== intent.tree
      || digest(packet, "wgp1_") !== intent.packetDigest) veto("invalid", "packet_mismatch");
    const context = packet.context, terminal = packet.terminal;
    if (!record(context) || !record(context.scope) || !record(context.receipt) || !record(terminal)
      || !record(context.scope.repository)) veto("invalid", "packet_context_mismatch");
    const scope = context.scope, receipt = context.receipt, repository = context.scope.repository;
    const linkedOwner = this.ports.getChannelWorkflowStep(plan.workflowStepId)?.metadata?.startOwner;
    if (linkedOwner?.phase !== "linked") veto("stale", "linked_owner_changed");
    const lineage = { workflowId: plan.workflowId, canonicalWorkspaceId: plan.canonicalWorkspaceId, canonicalWorkspaceRoot: plan.canonicalWorkspaceRoot,
      planId: plan.planId, planDigest: plan.planDigest, bindingId: binding.bindingId, bindingRevision: binding.revision,
      runId: binding.runId, startOwner: linkedOwner, ...binding.fence };
    if (!same(context.lineage, lineage) || !same(terminal.lineage, lineage)
      || scope.roundId !== plan.integrationRoundId || scope.stepId !== plan.workflowStepId || scope.generation !== plan.stepGeneration
      || scope.worktreeId !== plan.worktreeId || scope.executionRoot !== plan.executionRoot || scope.branchRef !== plan.branchRef
      || scope.baseCommit !== plan.baseCommit || scope.worktreeRoot !== dirname(plan.executionRoot)
      || join(String(scope.worktreeRoot), plan.worktreeId) !== plan.executionRoot || repository.root !== plan.canonicalWorkspaceRoot
      || repository.commonDir !== plan.repositoryIdentity.commonDir || repository.head !== plan.target.expectedHead
      || repository.branchRef !== plan.target.branchRef || !this.repositoryMatches(repository, plan.target.cleanStateDigest)
      || receipt.worktreeId !== plan.worktreeId || receipt.executionRoot !== plan.executionRoot || receipt.branchRef !== plan.branchRef
      || receipt.baseCommit !== plan.baseCommit || receipt.commonDir !== plan.repositoryIdentity.commonDir
      || ![receipt.rootDevice, receipt.rootInode].every(value => typeof value === "string" && /^[0-9]+$/u.test(value)))
      veto("invalid", "packet_context_mismatch");
    const creation = binding.creationReceiptId && this.scopes.getReceipt(binding.creationReceiptId);
    const creationIntent = creation && this.scopes.getIntent(creation.intentId);
    if (!creation || !creationIntent) veto("invalid", "creation_changed");
    const original = this.artifact(creation.artifactId, binding.runId).body;
    if (original.schemaVersion !== 1 || original.kind !== "workflow_isolation_worktree" || original.intentId !== creationIntent.intentId
      || original.planId !== plan.planId || original.planDigest !== plan.planDigest || !same(original.writer, intent.writer)
      || !same(original.observed, creation.observed) || !same(original.scope, scope) || !same(original.receipt, receipt))
      veto("invalid", "creation_changed");
    if (terminal.outcome !== authority.terminal.outcome || !Array.isArray(terminal.unknownEffects) || terminal.unknownEffects.length
      || !Array.isArray(terminal.contextArtifactRefs) || terminal.contextArtifactRefs.length > 128 || !Array.isArray(terminal.validations)
      || terminal.validations.length > 128 || !Array.isArray(context.allowedPaths) || context.allowedPaths.length > 10000
      || !Array.isArray(packet.changedPaths) || packet.changedPaths.length > 10000 || typeof packet.patch !== "string"
      || packet.patchDigest !== sha256(packet.patch)) veto("invalid", "packet_evidence_mismatch");
    this.validateTerminalArtifacts(terminal, intent, authority);
  }
  private validateTerminalArtifacts(terminal: Record<string, unknown>, intent: WorkflowIsolationTerminalResultIntent, authority: Authority): void {
    const { plan, binding } = authority;
    const base = { schemaVersion: 1, writer: intent.writer, planId: plan.planId, planDigest: plan.planDigest, proofDigest: intent.proofDigest };
    const evidence = (id: unknown, kind: string) => {
      if (!identity(id)) veto("invalid", "terminal_artifact_mismatch");
      const body = this.artifact(id, binding.runId).body;
      if (!same(Object.fromEntries(Object.keys(base).map(key => [key, body[key]])), base) || body.kind !== kind)
        veto("invalid", "terminal_artifact_mismatch");
      return body;
    };
    const result = evidence(terminal.terminalArtifactRef, "workflow_isolation_terminal");
    const quiescence = evidence(terminal.quiescenceArtifactRef, "workflow_isolation_quiescence");
    const tools = evidence(terminal.toolCompletionArtifactRef, "workflow_isolation_tool_completion");
    if (result.outcome !== authority.terminal.outcome || result.endedAt !== authority.terminal.endedAt || !same(result.audit, authority.terminal.audit)
      || !same(quiescence.completion, authority.terminal.completion) || quiescence.descendantEvidenceFingerprint !== authority.terminal.descendantEvidenceFingerprint
      || tools.effectDigest !== authority.terminal.effectDigest) veto("invalid", "terminal_artifact_mismatch");
    if (!identity(terminal.outputPacketArtifactRef)) veto("invalid", "terminal_artifact_mismatch");
    const output = this.artifact(terminal.outputPacketArtifactRef, binding.runId).body;
    if (!same(output.isolation, base) || output.workflowId !== plan.workflowId || output.workflowStepId !== plan.workflowStepId
      || output.runId !== binding.runId || output.status !== authority.terminal.outcome) veto("invalid", "terminal_artifact_mismatch");
    for (const id of terminal.contextArtifactRefs as unknown[]) evidence(id, "workflow_isolation_context");
    for (const value of terminal.validations as unknown[]) {
      if (!record(value) || value.executionRoot !== plan.executionRoot || !identity(value.artifactRef)) veto("invalid", "terminal_artifact_mismatch");
      this.artifact(value.artifactRef, binding.runId);
    }
  }
  private repositoryMatches(value: Record<string, unknown>, expected: string): boolean {
    if (typeof value.dirty !== "boolean" || !isWorkflowMergeTargetSnapshot({ ...value, dirty: false })) return false;
    return expected === workflowMergeTargetSnapshotDigest(value as unknown as WorkflowMergeTargetSnapshotV1);
  }
  private effect(intent: WorkflowIsolationTerminalResultIntent, plan: WorkflowIsolationScopePlanV1,
    packet: Record<string, unknown>): WorkflowIsolationTerminalResultEffectV1 {
    return { kind: "branch_capture", roundId: plan.integrationRoundId, generation: plan.stepGeneration,
      commonDir: intent.commonDir, ref: intent.ref, beforeCommit: null, afterCommit: intent.commit,
      tree: intent.tree, packetDigest: intent.packetDigest, packetJson: json(packet) };
  }
  private validateTime(value: string): void { if (!time(value)) veto("invalid", "time_invalid"); }
  private pin(artifactId: string, intentId: string, now: string): void {
    pinHarnessArtifactWithinTransaction(this.context.database, { artifactId,
      holder: harnessArtifactOwnerHolder("workflow_terminal_result", intentId), reason: "audit_hold", now });
  }
  private transaction<T>(operation: () => WorkflowIsolationMutationResult<T>): WorkflowIsolationMutationResult<T> {
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.context.database.exec("COMMIT"); return result; }
    catch (error) { rollbackOwnedSqliteTransaction(this.context.database); if (error instanceof Veto) return error.result; throw error; }
  }
}
