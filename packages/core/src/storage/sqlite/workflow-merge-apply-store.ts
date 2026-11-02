import type { RunStore } from "../../run-types.js";
import type { WorkflowIntegrationCoordinatorAuthority, WorkflowIntegrationCoordinatorEffect } from "../../workflow-integration-coordinator-types.js";
import type { WorkflowIsolationStore, WorkflowIsolationMutationResult, WorkflowIsolationReceipt, WorkflowIntegrationRound } from "../../workflow-isolation-types.js";
import type { WorkflowMergeApprovalRequest } from "../../workflow-merge-types.js";
import type { WorkflowMergeApplyStore, WorkflowMergeApplyPermit, WorkflowMergeApplyObservationEvidenceV1 } from "../../workflow-merge-apply-types.js";
import { workflowMergeApplyDisposition, workflowMergeApplyEffectEvidence, workflowMergeApplyIdentities,
  workflowMergeApplyIntentId, workflowMergeApplyObservedIdentity, workflowMergeApplyPermitId } from "../../workflow-merge-apply.js";
import { workflowIsolationCanonicalJson as json, workflowIsolationDigest as digest, workflowIsolationRecord as record,
  workflowIsolationIdentity as identity, workflowIsolationRevision as revision, workflowIsolationTime as time } from "../../workflow-isolation.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { WorkflowMergeApprovalRetainedReader } from "./workflow-merge-approval-store.js";
import { harnessArtifactOwnerHolder, pinHarnessArtifactWithinTransaction, readHarnessRetainedBody } from "./harness-artifact-recovery-pins.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { workflowMergeApplyWorkspaceBusy } from "./workflow-merge-lease-guard.js";

type Authority = Extract<WorkflowIntegrationCoordinatorAuthority, { readonly status: "authorized" }>;
interface EvidencePorts {
  readonly authority: (roundId: string, generation: number, now: string, excludedApprovalId: string) => WorkflowIntegrationCoordinatorAuthority;
  readonly candidateVerified: (authority: Authority, verifiedApplyIntentId?: string) => boolean;
  readonly effects: (roundId: string, generation: number) => readonly WorkflowIntegrationCoordinatorEffect[];
  readonly receipts: (roundId: string, generation: number) => readonly WorkflowIsolationReceipt[];
}
export interface WorkflowMergeApplyInternalReader {
  validateEffect(effect: WorkflowIntegrationCoordinatorEffect): void;
  validateReceipt(effect: WorkflowIntegrationCoordinatorEffect, receipt: WorkflowIsolationReceipt, evidence: Record<string, unknown>): void;
  completionBlocker(round: WorkflowIntegrationRound, now: string): string | undefined;
}
type Rejection = { readonly status: "invalid" | "stale" | "conflict"; readonly code: string };
class Rejected extends Error { constructor(readonly result: Rejection) { super(result.code); } }
function reject(status: Rejection["status"], code: string): never { throw new Rejected({ status, code: `workflow_merge.${code}` }); }
const same = (a: unknown, b: unknown) => json(a) === json(b);
const adapters = new WeakMap<RunStore, WorkflowMergeApplyStore>();

export function createSqliteWorkflowMergeApplyStore(store: RunStore): WorkflowMergeApplyStore {
  const adapter = adapters.get(store);
  if (!adapter) throw new Error("workflow_merge.apply_store_not_sqlite");
  return adapter;
}

/** Only Host composition receives the retained readers; the public journal cannot confirm a target write. */
export function registerSqliteWorkflowMergeApplyStore(store: RunStore, context: SqliteStoreContext,
  isolation: WorkflowIsolationStore, approvals: WorkflowMergeApprovalRetainedReader, evidence: EvidencePorts): WorkflowMergeApplyInternalReader {
  if (adapters.has(store)) throw new Error("workflow_merge.apply_store_already_registered");
  const adapter = new SqliteWorkflowMergeApplyStore(context, isolation, approvals, store, evidence);
  adapters.set(store, adapter);
  return adapter;
}

class SqliteWorkflowMergeApplyStore implements WorkflowMergeApplyStore, WorkflowMergeApplyInternalReader {
  constructor(private readonly context: SqliteStoreContext, private readonly isolation: WorkflowIsolationStore,
    private readonly approvals: WorkflowMergeApprovalRetainedReader, private readonly ports: Pick<RunStore, "acquireResourceLease">,
    private readonly evidence: EvidencePorts) {}

  beginApply(input: Parameters<WorkflowMergeApplyStore["beginApply"]>[0]): WorkflowIsolationMutationResult<WorkflowMergeApplyPermit> {
    return this.transaction(() => {
      if (!identity(input.approvalId) || !identity(input.ownerToken) || !revision(input.expectedRevision) || !time(input.now))
        reject("invalid", "apply_input_invalid");
      const { request } = this.approvals.readRetained(input.approvalId), payload = request.payload;
      const existing = this.permit(payload.roundId, payload.generation);
      if (existing) return { status: "duplicate", value: existing }; // Observation only, including a different caller's token.
      const authority = this.authorized(request, input.now), { round, writer } = authority;
      if (round.revision !== input.expectedRevision || round.phase !== "awaiting_approval" || round.openIntentId)
        reject("stale", "apply_round_changed");
      if (workflowMergeApplyWorkspaceBusy(this.context.database, round.inputs.canonicalWorkspaceId)) reject("conflict", "target_writer_active");
      const effectPayload = workflowMergeApplyEffectEvidence(request, input.ownerToken);
      const artifact = this.artifact(input.payloadArtifactId, writer.bindingId);
      if (!same(artifact.body, effectPayload)) reject("invalid", "apply_intent_artifact_mismatch");
      const permitId = workflowMergeApplyPermitId(request, input.ownerToken), intentId = workflowMergeApplyIntentId(request);
      const lease = this.ports.acquireResourceLease({ workspaceId: round.inputs.canonicalWorkspaceId,
        resourceType: "bound_path", resourceKey: payload.target.executionRoot, ownerType: "system", ownerId: permitId,
        acquiredAt: input.now, expiresAt: payload.expiresAt });
      if (!lease) reject("conflict", "target_lease_unavailable");
      const permit: WorkflowMergeApplyPermit = { permitId, approvalId: request.approvalId, requestId: request.requestId,
        roundId: round.roundId, generation: round.generation, authorityDigest: authority.authorityDigest,
        basisFingerprint: payload.fingerprint, ownerToken: input.ownerToken, leaseId: lease.id, intentId,
        createdAt: input.now, expiresAt: payload.expiresAt };
      const scope = { type: "round", roundId: round.roundId, generation: round.generation };
      const { before, after } = effectPayload;
      const intentDigest = digest({ intentId, commandId: intentId, scope, expectedRevision: round.revision,
        writer, kind: "target_apply", before, after });
      this.context.database.prepare(`INSERT INTO workflow_isolation_intents(intent_id,command_id,intent_digest,scope_type,
        round_id,generation,scope_revision,writer_binding_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,
        kind,before_json,after_json,status,created_at) VALUES(?,?,?,'round',?,?,?,?,?,?,?,?,'target_apply',?,?,'pending',?)`)
        .run(intentId, intentId, intentDigest, round.roundId, round.generation, round.revision, writer.bindingId,
          writer.workUnitId, writer.attemptId, writer.runtimeInstanceId, writer.fencingToken, json(before), json(after), input.now);
      const link = { intentId, roundId: round.roundId, generation: round.generation, effectKey: "target:apply",
        authorityDigest: authority.authorityDigest, payloadArtifactId: input.payloadArtifactId, payloadContentSha256: artifact.sha256 };
      this.context.database.prepare(`INSERT INTO workflow_integration_effect_links(intent_id,round_id,generation,effect_key,
        authority_digest,payload_artifact_id,payload_content_sha256,link_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(intentId, round.roundId, round.generation, link.effectKey, link.authorityDigest, link.payloadArtifactId,
          link.payloadContentSha256, digest(link), input.now);
      this.context.database.prepare(`INSERT INTO workflow_merge_apply_permits(permit_id,approval_id,request_id,round_id,generation,
        authority_digest,basis_fingerprint,owner_token,lease_id,intent_id,permit_digest,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(permitId, permit.approvalId, permit.requestId, round.roundId, round.generation, permit.authorityDigest,
          permit.basisFingerprint, permit.ownerToken, lease.id, intentId, digest(permit), input.now, permit.expiresAt);
      this.changed(this.context.database.prepare(`UPDATE workflow_integration_generations SET phase='applying',open_intent_id=?,
        revision=revision+1,updated_at=? WHERE round_id=? AND generation=? AND revision=? AND phase='awaiting_approval'
        AND outstanding_approval_id=? AND open_intent_id IS NULL`).run(intentId, input.now, round.roundId, round.generation,
          round.revision, request.approvalId));
      this.pin(input.payloadArtifactId, intentId, input.now);
      return { status: "created", value: this.permit(round.roundId, round.generation)! };
    });
  }

  getPermit(roundId: string, generation: number): WorkflowMergeApplyPermit | undefined {
    return readSqliteSnapshot(this.context.database, () => this.permit(roundId, generation));
  }

  assertPermit(input: Parameters<WorkflowMergeApplyStore["assertPermit"]>[0]): ReturnType<WorkflowMergeApplyStore["assertPermit"]> {
    return readSqliteSnapshot(this.context.database, () => {
      try {
        if (!identity(input.permitId) || !identity(input.ownerToken) || !time(input.now)) reject("invalid", "permit_input_invalid");
        const permit = this.permitById(input.permitId), { request } = this.approvals.readRetained(permit.approvalId);
        if (permit.ownerToken !== input.ownerToken) reject("stale", "permit_owner_changed");
        const authority = this.authorized(request, input.now, permit), { round, writer } = authority;
        if (round.phase !== "applying" || round.openIntentId !== permit.intentId
          || this.isolation.getIntent(permit.intentId)?.status !== "pending"
          || this.context.database.prepare("SELECT status FROM resource_leases WHERE id=?").get(permit.leaseId)?.status !== "active")
          reject("stale", "permit_consumed_or_unconfirmed");
        return { status: "authorized", permit, request, writer, round };
      } catch (error) { return { status: "blocked", code: this.code(error) }; }
    });
  }

  recordObservation(input: Parameters<WorkflowMergeApplyStore["recordObservation"]>[0]): WorkflowIsolationMutationResult<WorkflowIntegrationRound> {
    return this.transaction(() => {
      if (!time(input.now) || !revision(input.expectedRevision)) reject("invalid", "observation_input_invalid");
      const permit = this.permitById(input.permitId), { request } = this.approvals.readRetained(permit.approvalId);
      const round = this.isolation.getIntegrationRound(permit.roundId, permit.generation)!;
      const intent = this.isolation.getIntent(permit.intentId)!;
      const artifact = this.artifact(input.artifactId, intent.writer.bindingId), body = artifact.body;
      if (!record(body.evidence)) reject("invalid", "observation_evidence_invalid");
      const receiptId = digest({ permitId: permit.permitId, artifactId: input.artifactId }, "wmpr_");
      const expected = this.observationReceipt(request, permit, body.evidence);
      if (!same(body, expected) || input.now < permit.createdAt) reject("invalid", "observation_artifact_mismatch");
      const prior = this.evidence.receipts(round.roundId, round.generation).find(receipt => receipt.receiptId === receiptId);
      if (prior) return { status: "duplicate", value: round };
      if (round.revision !== input.expectedRevision || round.openIntentId !== permit.intentId || intent.status === "confirmed")
        reject("stale", "observation_round_changed");
      let authorizationCode: string | undefined;
      if (expected.evidence.disposition === "applied") {
        try { this.authorized(request, input.now, permit); }
        catch (error) { authorizationCode = this.code(error); }
      }
      const receiptDigest = digest({ receiptId, intentId: permit.intentId, expectedRevision: round.revision,
        writer: intent.writer, outcome: expected.outcome, observed: expected.observed, artifactId: input.artifactId });
      this.context.database.prepare(`INSERT INTO workflow_isolation_receipts(receipt_id,intent_id,receipt_digest,scope_revision,
        outcome,observed_json,artifact_id,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(receiptId, permit.intentId,
          receiptDigest, round.revision, expected.outcome, json(expected.observed), input.artifactId, input.now);
      const link = { receiptId, intentId: permit.intentId, scopeRevision: round.revision, authorityDigest: permit.authorityDigest,
        artifactId: input.artifactId, artifactContentSha256: artifact.sha256 };
      this.context.database.prepare(`INSERT INTO workflow_integration_receipt_links(receipt_id,intent_id,scope_revision,
        authority_digest,artifact_id,artifact_content_sha256,link_digest,created_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(receiptId, permit.intentId, round.revision, permit.authorityDigest, input.artifactId, artifact.sha256, digest(link), input.now);
      this.changed(this.context.database.prepare("UPDATE workflow_isolation_intents SET status=? WHERE intent_id=? AND status<>'confirmed'")
        .run(expected.outcome, permit.intentId));
      const settled = expected.outcome === "confirmed", applied = expected.evidence.disposition === "applied" && !authorizationCode;
      const phase = settled ? applied ? "applied" : "blocked" : "applying";
      const reason = applied ? null : authorizationCode ?? `workflow_merge.${expected.evidence.disposition === "unknown" ? "effect_unknown" : "not_applied"}`;
      this.changed(this.context.database.prepare(`UPDATE workflow_integration_generations SET phase=?,last_confirmed_phase=?,
        open_intent_id=?,reason=?,revision=revision+1,updated_at=? WHERE round_id=? AND generation=? AND revision=? AND open_intent_id=?`)
        .run(phase, applied ? "applied" : round.lastConfirmedPhase, settled ? null : permit.intentId, reason, input.now,
          round.roundId, round.generation, round.revision, permit.intentId));
      this.pin(input.artifactId, permit.intentId, input.now);
      if (settled) {
        // Confirmed means the exact physical outcome was observed, not necessarily that a merge was applied.
        this.changed(this.context.database.prepare(`UPDATE resource_leases SET status='released',released_at=?,release_reason=?
          WHERE id=? AND owner_type='system' AND owner_id=? AND status='active'`).run(input.now,
            `workflow_merge.${expected.evidence.disposition}`, permit.leaseId, permit.permitId));
      }
      return { status: "updated", value: this.isolation.getIntegrationRound(round.roundId, round.generation)! };
    });
  }

  inspectApplication(input: Parameters<WorkflowMergeApplyStore["inspectApplication"]>[0]): ReturnType<WorkflowMergeApplyStore["inspectApplication"]> {
    return readSqliteSnapshot(this.context.database, () => {
      try {
        if (!time(input.now)) reject("invalid", "inspection_time_invalid");
        const { request, approval } = this.approvals.readRetained(input.approvalId), payload = request.payload;
        const round = this.isolation.getIntegrationRound(payload.roundId, payload.generation)!;
        const permit = this.permit(payload.roundId, payload.generation);
        if (!permit) return { status: "not_started", request, round, code: `workflow_merge.approval_${approval.status}` };
        const effects = this.evidence.effects(permit.roundId, permit.generation), receipts = this.evidence.receipts(permit.roundId, permit.generation);
        const effect = effects.find(value => value.intentId === permit.intentId);
        if (!effect) reject("invalid", "apply_effect_missing");
        const confirmed = receipts.filter(receipt => receipt.intentId === permit.intentId && receipt.outcome === "confirmed");
        if (confirmed.length > 1) reject("invalid", "apply_receipt_inventory_invalid");
        const receipt = confirmed[0];
        if (!receipt) {
          if (effect.status === "confirmed" || round.openIntentId !== permit.intentId || this.leaseStatus(permit) !== "active")
            reject("invalid", "apply_pending_inventory_invalid");
          return { status: effect.status === "pending" ? "pending" : "effect_unknown", request, round, permit };
        }
        if (effect.status !== "confirmed" || round.openIntentId || this.leaseStatus(permit) !== "released") reject("invalid", "apply_settled_inventory_invalid");
        const evidence = this.artifact(receipt.artifactId, effect.writer.bindingId).body.evidence as unknown as WorkflowMergeApplyObservationEvidenceV1;
        if (evidence.disposition === "not_applied") return { status: "not_applied", request, round, permit, code: round.reason };
        if (round.phase !== "applied") return { status: "blocked", request, round, permit, code: round.reason ?? "workflow_merge.applied_without_authority" };
        this.authorized(request, input.now, permit, receipt.createdAt);
        return { status: "applied", request, round, permit };
      } catch (error) { return { status: "invalid", code: this.code(error) }; }
    });
  }

  validateEffect(effect: WorkflowIntegrationCoordinatorEffect): void {
    const row = this.context.database.prepare("SELECT permit_id FROM workflow_merge_apply_permits WHERE intent_id=?").get(effect.intentId);
    if (!row) reject("invalid", "effect_permit_missing");
    const permit = this.permitById(String(row.permit_id));
    if (effect.kind !== "target_apply" || effect.effectKey !== "target:apply" || effect.authorityDigest !== permit.authorityDigest)
      reject("invalid", "effect_permit_mismatch");
  }

  validateReceipt(effect: WorkflowIntegrationCoordinatorEffect, receipt: WorkflowIsolationReceipt, evidence: Record<string, unknown>): void {
    this.validateEffect(effect);
    const row = this.context.database.prepare("SELECT permit_id FROM workflow_merge_apply_permits WHERE intent_id=?").get(effect.intentId)!;
    const permit = this.permitById(String(row.permit_id)), { request } = this.approvals.readRetained(permit.approvalId);
    const expected = this.observationReceipt(request, permit, evidence);
    if (receipt.outcome !== expected.outcome || !same(receipt.observed, expected.observed) || receipt.createdAt < permit.createdAt)
      reject("invalid", "receipt_permit_mismatch");
    if (receipt.outcome === "confirmed" && this.leaseStatus(permit) !== "released") reject("invalid", "receipt_lease_not_settled");
  }

  completionBlocker(round: WorkflowIntegrationRound, now: string): string | undefined {
    const request = this.approvals.getRequest(round.roundId, round.generation);
    if (!request) return "workflow_merge.approval_missing";
    const read = this.inspectApplication({ approvalId: request.approvalId, now });
    return read.status === "applied" ? undefined : "code" in read && read.code ? read.code : "workflow_merge.application_unconfirmed";
  }

  private authorized(request: WorkflowMergeApprovalRequest, now: string, permit?: WorkflowMergeApplyPermit, consentAt = now): Authority {
    const read = () => {
      const { approval } = this.approvals.readRetained(request.approvalId), payload = request.payload;
      if (!time(now) || !time(consentAt) || consentAt > now || consentAt >= payload.expiresAt || approval.status !== "approved"
        || approval.decisionKind !== "approve_once" || approval.resolvedBy !== "local-user" || !time(approval.resolvedAt)
        || approval.resolvedAt < request.createdAt || approval.resolvedAt > consentAt) reject("stale", "local_consent_not_current");
      const authority = this.evidence.authority(payload.roundId, payload.generation, now, request.approvalId);
      if (authority.status !== "authorized") throw new Rejected({ status: authority.status === "invalid" ? "invalid" : "stale", code: authority.code });
      const { round } = authority;
      if (authority.authorityDigest !== payload.authorityDigest || round.inputsDigest !== payload.inputsDigest
        || round.inputs.mode !== "apply_to_target" || round.outstandingApprovalId !== request.approvalId
        || !same(round.candidate, payload.candidate) || !["awaiting_approval", "applying", "applied"].includes(round.phase)
        || !this.evidence.candidateVerified(authority, permit?.intentId)) reject("stale", "apply_basis_changed");
      return authority;
    };
    return this.context.database.isTransaction ? readSqliteWithinTransaction(this.context.database, read) : read();
  }

  private observationReceipt(request: WorkflowMergeApprovalRequest, permit: WorkflowMergeApplyPermit, evidence: Record<string, unknown>) {
    if (evidence.schemaVersion !== 1 || evidence.kind !== "workflow_merge_apply_observation" || evidence.permitId !== permit.permitId
      || evidence.approvalId !== permit.approvalId || !record(evidence.observation)
      || !["expected", "candidate", "diverged", "unavailable"].includes(String(evidence.observation.state))
      || typeof evidence.observation.verifiedClean !== "boolean") reject("invalid", "apply_observation_invalid");
    const disposition = workflowMergeApplyDisposition(request.payload, evidence.observation);
    const normalized: WorkflowMergeApplyObservationEvidenceV1 = { schemaVersion: 1, kind: "workflow_merge_apply_observation",
      permitId: permit.permitId, approvalId: permit.approvalId, disposition,
      observation: evidence.observation as unknown as WorkflowMergeApplyObservationEvidenceV1["observation"] };
    if (!same(evidence, normalized)) reject("invalid", "apply_disposition_mismatch");
    return { schemaVersion: 1, kind: "workflow_integration_coordinator_receipt", intentId: permit.intentId, effectKey: "target:apply",
      outcome: disposition === "unknown" ? "effect_unknown" as const : "confirmed" as const,
      observed: workflowMergeApplyObservedIdentity(request.payload, normalized.observation), evidence: normalized };
  }

  private permitById(id: string): WorkflowMergeApplyPermit {
    if (!identity(id)) reject("invalid", "permit_identity_invalid");
    const row = this.context.database.prepare("SELECT round_id,generation FROM workflow_merge_apply_permits WHERE permit_id=?").get(id);
    const permit = row && this.permit(String(row.round_id), Number(row.generation));
    if (!permit) reject("invalid", "permit_missing");
    return permit;
  }

  private permit(roundId: string, generation: number): WorkflowMergeApplyPermit | undefined {
    if (!identity(roundId) || !Number.isSafeInteger(generation) || generation < 1) reject("invalid", "permit_scope_invalid");
    const row = this.context.database.prepare("SELECT * FROM workflow_merge_apply_permits WHERE round_id=? AND generation=?").get(roundId, generation);
    if (!row) return undefined;
    const permit: WorkflowMergeApplyPermit = { permitId: String(row.permit_id), approvalId: String(row.approval_id), requestId: String(row.request_id),
      roundId, generation, authorityDigest: String(row.authority_digest), basisFingerprint: String(row.basis_fingerprint), ownerToken: String(row.owner_token),
      leaseId: String(row.lease_id), intentId: String(row.intent_id), createdAt: String(row.created_at), expiresAt: String(row.expires_at) };
    const { request, approval } = this.approvals.readRetained(permit.approvalId), payload = request.payload;
    const intent = this.isolation.getIntent(permit.intentId), { before, after } = workflowMergeApplyIdentities(payload);
    const lease = this.context.database.prepare("SELECT * FROM resource_leases WHERE id=?").get(permit.leaseId);
    const round = this.isolation.getIntegrationRound(roundId, generation);
    if (row.permit_digest !== digest(permit) || permit.requestId !== request.requestId || permit.roundId !== payload.roundId
      || permit.generation !== payload.generation || permit.authorityDigest !== payload.authorityDigest || permit.basisFingerprint !== payload.fingerprint
      || permit.permitId !== workflowMergeApplyPermitId(request, permit.ownerToken) || permit.intentId !== workflowMergeApplyIntentId(request)
      || !identity(permit.ownerToken) || !time(permit.createdAt) || permit.expiresAt !== payload.expiresAt || permit.createdAt >= permit.expiresAt
      || !time(approval.resolvedAt) || permit.createdAt < approval.resolvedAt || !intent || !round
      || intent.kind !== "target_apply" || intent.scope.type !== "round" || intent.scope.roundId !== roundId || intent.scope.generation !== generation
      || intent.writer.bindingId !== round.writerBindingId || !same(intent.before, before) || !same(intent.after, after)
      || intent.createdAt !== permit.createdAt || !lease || lease.workspace_id !== round.inputs.canonicalWorkspaceId
      || lease.resource_type !== "bound_path" || lease.resource_key !== payload.target.executionRoot || lease.owner_type !== "system"
      || lease.owner_id !== permit.permitId || lease.work_unit_id !== null || lease.attempt_id !== null
      || lease.runtime_instance_id !== null || lease.fencing_token !== null || lease.acquired_at !== permit.createdAt
      || lease.expires_at !== permit.expiresAt || !["active", "released"].includes(String(lease.status))) reject("invalid", "permit_evidence_corrupt");
    const link = this.context.database.prepare("SELECT * FROM workflow_integration_effect_links WHERE intent_id=?").get(permit.intentId);
    if (!link) reject("invalid", "permit_effect_link_missing");
    const artifact = this.artifact(String(link.payload_artifact_id), intent.writer.bindingId);
    const expectedLink = { intentId: permit.intentId, roundId, generation, effectKey: "target:apply", authorityDigest: permit.authorityDigest,
      payloadArtifactId: String(link.payload_artifact_id), payloadContentSha256: artifact.sha256 };
    if (link.round_id !== roundId || link.generation !== generation || link.effect_key !== expectedLink.effectKey
      || link.authority_digest !== permit.authorityDigest || link.payload_content_sha256 !== artifact.sha256 || link.link_digest !== digest(expectedLink)
      || !same(artifact.body, workflowMergeApplyEffectEvidence(request, permit.ownerToken))) reject("invalid", "permit_effect_link_corrupt");
    return permit;
  }

  private leaseStatus(permit: WorkflowMergeApplyPermit): unknown {
    return this.context.database.prepare("SELECT status FROM resource_leases WHERE id=?").get(permit.leaseId)?.status;
  }
  private artifact(id: string, bindingId: string) {
    if (!identity(id)) reject("invalid", "artifact_identity_invalid");
    const retained = readHarnessRetainedBody(this.context.database, id), binding = this.isolation.getExecutionBinding(bindingId);
    const row = this.context.database.prepare("SELECT run_id,type,sealed_payload_json FROM artifacts WHERE id=?").get(id);
    const body: unknown = row && JSON.parse(String(row.sealed_payload_json));
    if (!binding || !row || row.run_id !== binding.runId || row.type !== "json" || !record(body)) reject("invalid", "artifact_lineage_invalid");
    return { body, sha256: retained.contentSha256 };
  }
  private pin(artifactId: string, ownerId: string, now: string): void {
    pinHarnessArtifactWithinTransaction(this.context.database, { artifactId,
      holder: harnessArtifactOwnerHolder("workflow_integration", ownerId), reason: "audit_hold", now });
  }
  private changed(result: { readonly changes: number | bigint }): void {
    if (Number(result.changes) !== 1) reject("stale", "apply_cas_changed");
  }
  private code(error: unknown): string { return error instanceof Rejected ? error.result.code : "workflow_merge.apply_evidence_unverified"; }
  private transaction<T>(operation: () => WorkflowIsolationMutationResult<T>): WorkflowIsolationMutationResult<T> {
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.context.database.exec("COMMIT"); return result; }
    catch (error) { rollbackOwnedSqliteTransaction(this.context.database); if (error instanceof Rejected) return error.result; throw error; }
  }
}
