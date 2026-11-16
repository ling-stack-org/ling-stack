import type { RunStore } from "../../run-types.js";
import type { WorkflowIntegrationCoordinatorAuthority } from "../../workflow-integration-coordinator-types.js";
import type { WorkflowIsolationMutationResult, WorkflowIsolationStore } from "../../workflow-isolation-types.js";
import type { WorkflowMergeApprovalStore, WorkflowMergeApprovalRequest, WorkflowMergeApprovalPayloadV1,
  WorkflowMergeApprovalInspection, WorkflowMergeTargetSnapshotV1 } from "../../workflow-merge-types.js";
import { isWorkflowMergeTargetSnapshot, workflowMergeApprovalFingerprint, workflowMergeTargetSnapshotDigest } from "../../workflow-merge-approval.js";
import { workflowIsolationCanonicalJson as json, workflowIsolationDigest as digest,
  workflowIsolationIdentity as identity, workflowIsolationRevision as revision, workflowIsolationTime as time } from "../../workflow-isolation.js";
import type { SqliteStoreContext } from "./store-context.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";

type Authority = Extract<WorkflowIntegrationCoordinatorAuthority, { readonly status: "authorized" }>;
export type WorkflowMergeApprovalPorts = Pick<RunStore,
  "createApprovalRequest" | "getApprovalRequest" | "getApprovalCheckpointForApproval" | "getChannelWorkflowStep">;
interface EvidencePorts {
  readonly authority: (roundId: string, generation: number, now: string, excludedMergeApprovalId?: string) => WorkflowIntegrationCoordinatorAuthority;
  readonly candidateVerified: (authority: Authority) => boolean;
}
/** Retained lineage only; reading this after expiry/cancellation grants no execution authority. */
export interface WorkflowMergeApprovalRetainedReader extends WorkflowMergeApprovalStore {
  readRetained(approvalId: string): { readonly request: WorkflowMergeApprovalRequest; readonly approval: ReturnType<WorkflowMergeApprovalPorts["getApprovalRequest"]> & {} };
}
type Rejection = { readonly status: "invalid" | "stale" | "conflict"; readonly code: string };
class Rejected extends Error {
  constructor(readonly result: Rejection) { super(result.code); }
}
function reject(status: Rejection["status"], code: string): never { throw new Rejected({ status, code: `workflow_merge.${code}` }); }
const same = (a: unknown, b: unknown): boolean => json(a) === json(b);
const adapters = new WeakMap<RunStore, WorkflowMergeApprovalStore>();

export function createSqliteWorkflowMergeApprovalStore(store: RunStore): WorkflowMergeApprovalStore {
  const adapter = adapters.get(store);
  if (!adapter) throw new Error("workflow_merge.store_not_sqlite");
  return adapter;
}

/** Host composition only. Neither the proposal nor an approved basis is an execution capability. */
export function registerSqliteWorkflowMergeApprovalStore(store: RunStore, context: SqliteStoreContext,
  isolation: WorkflowIsolationStore, ports: WorkflowMergeApprovalPorts, evidence: EvidencePorts): WorkflowMergeApprovalRetainedReader {
  if (adapters.has(store)) throw new Error("workflow_merge.store_already_registered");
  const adapter = new SqliteWorkflowMergeApprovalStore(context, isolation, ports, evidence);
  adapters.set(store, adapter);
  return adapter;
}

class SqliteWorkflowMergeApprovalStore implements WorkflowMergeApprovalStore {
  constructor(private readonly context: SqliteStoreContext, private readonly isolation: WorkflowIsolationStore,
    private readonly ports: WorkflowMergeApprovalPorts, private readonly evidence: EvidencePorts) {}

  requestApproval(input: Parameters<WorkflowMergeApprovalStore["requestApproval"]>[0]): WorkflowIsolationMutationResult<WorkflowMergeApprovalRequest> {
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      if (!time(input.now) || !time(input.expiresAt) || input.expiresAt <= input.now
        || Date.parse(input.expiresAt) - Date.parse(input.now) > 24 * 60 * 60 * 1000
        || !revision(input.expectedRevision) || !isWorkflowMergeTargetSnapshot(input.targetSnapshot)) reject("invalid", "proposal_input_invalid");
      const existing = this.request(input.roundId, input.generation);
      if (existing) this.approvalFor(existing);
      const authority = this.authority(input.roundId, input.generation, input.now, existing?.approvalId);
      const payload = this.payload(authority, input.targetSnapshot, input.expiresAt);
      if (authority.authorityDigest !== input.authorityDigest) reject("stale", "authority_changed");
      if (existing) {
        if (!same(existing.payload, payload) || authority.round.outstandingApprovalId !== existing.approvalId)
          reject("conflict", "proposal_already_frozen");
        this.context.database.exec("COMMIT");
        return { status: "duplicate", value: existing };
      }
      const { round } = authority;
      if (round.revision !== input.expectedRevision || round.phase !== "awaiting_approval" || round.openIntentId
        || round.outstandingApprovalId) reject("stale", "round_changed");
      const step = this.ports.getChannelWorkflowStep(payload.workflowStepId);
      if (!step) reject("stale", "owner_missing");
      const approval = this.ports.createApprovalRequest({ workflowStepId: step.id, channelId: step.channelId,
        actionType: "workflow_merge", risk: "high", title: "Apply verified workflow candidate",
        description: `Fast-forward ${payload.target.branchRef} in ${payload.target.executionRoot} from ${payload.target.expectedHead} to ${payload.candidate.commit}.`,
        payload, expiresAt: input.expiresAt, availableDecisions: ["approve_once", "deny"] }, input.now);
      if (!same(approval.payload, payload)) reject("invalid", "approval_payload_changed");
      const request: WorkflowMergeApprovalRequest = { requestId: digest({ roundId: round.roundId, generation: round.generation,
        fingerprint: payload.fingerprint }, "wmr1_"), approvalId: approval.id, payload, createdAt: input.now };
      this.context.database.prepare(`INSERT INTO workflow_merge_approval_requests(request_id,round_id,generation,approval_id,
        authority_digest,basis_fingerprint,payload_json,request_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(request.requestId,
          round.roundId, round.generation, approval.id, authority.authorityDigest, payload.fingerprint, json(payload), digest(request), input.now);
      const changed = this.context.database.prepare(`UPDATE workflow_integration_generations SET outstanding_approval_id=?,
        revision=revision+1,updated_at=? WHERE round_id=? AND generation=? AND revision=? AND phase='awaiting_approval'
        AND outstanding_approval_id IS NULL AND open_intent_id IS NULL`).run(approval.id, input.now, round.roundId, round.generation, input.expectedRevision);
      if (Number(changed.changes) !== 1) reject("stale", "round_changed");
      this.approvalFor(request);
      this.context.database.exec("COMMIT");
      return { status: "created", value: request };
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      if (error instanceof Rejected) return error.result;
      throw error;
    }
  }

  getRequest(roundId: string, generation: number): WorkflowMergeApprovalRequest | undefined {
    return readSqliteSnapshot(this.context.database, () => this.request(roundId, generation));
  }

  readRetained(approvalId: string): ReturnType<WorkflowMergeApprovalRetainedReader["readRetained"]> {
    if (!identity(approvalId)) reject("invalid", "approval_identity_invalid");
    const row = this.context.database.prepare("SELECT round_id,generation FROM workflow_merge_approval_requests WHERE approval_id=?").get(approvalId);
    const request = row && this.request(String(row.round_id), Number(row.generation));
    if (!request) reject("invalid", "host_proposal_missing");
    return { request, approval: this.approvalFor(request) };
  }

  inspectApproval(input: Parameters<WorkflowMergeApprovalStore["inspectApproval"]>[0]): WorkflowMergeApprovalInspection {
    return readSqliteSnapshot(this.context.database, () => {
      try {
        if (!identity(input.approvalId) || !time(input.now)) reject("invalid", "inspection_input_invalid");
        const row = this.context.database.prepare("SELECT round_id,generation FROM workflow_merge_approval_requests WHERE approval_id=?").get(input.approvalId);
        const request = row && this.request(String(row.round_id), Number(row.generation));
        if (!request) reject("invalid", "host_proposal_missing");
        const approval = this.approvalFor(request);
        const authority = this.authority(request.payload.roundId, request.payload.generation, input.now, approval.id);
        if (authority.round.outstandingApprovalId !== approval.id
          || !same(request.payload, this.payload(authority, request.payload.targetSnapshot, request.payload.expiresAt)))
          reject("stale", "approval_basis_changed");
        if (approval.status === "approved" || approval.status === "pending") {
          if (request.payload.expiresAt <= input.now) reject("stale", "approval_expired");
        }
        if (approval.status === "approved" && (approval.resolvedBy !== "local-user" || approval.decisionKind !== "approve_once"
          || !time(approval.resolvedAt) || approval.resolvedAt < request.createdAt || approval.resolvedAt > input.now
          || approval.resolvedAt >= request.payload.expiresAt)) reject("invalid", "local_user_decision_required");
        return { status: approval.status, request, approval, round: authority.round };
      } catch (error) {
        return { status: "blocked", code: error instanceof Rejected ? error.result.code : "workflow_merge.approval_evidence_unverified" };
      }
    });
  }

  private authority(roundId: string, generation: number, now: string, excludedMergeApprovalId?: string): Authority {
    const read = this.context.database.isTransaction
      ? readSqliteWithinTransaction(this.context.database, () => this.evidence.authority(roundId, generation, now, excludedMergeApprovalId))
      : this.evidence.authority(roundId, generation, now, excludedMergeApprovalId);
    if (read.status !== "authorized") throw new Rejected({ status: read.status === "invalid" ? "invalid" : read.status === "stale" ? "stale" : "conflict", code: read.code });
    return read;
  }

  private payload(authority: Authority, targetSnapshot: WorkflowMergeTargetSnapshotV1, expiresAt: string): WorkflowMergeApprovalPayloadV1 {
    const { round } = authority, { inputs } = round;
    if (inputs.mode !== "apply_to_target" || inputs.target.inputMode !== "clean_checkout" || !round.candidate
      || !["awaiting_approval", "applying", "applied"].includes(round.phase) || !isWorkflowMergeTargetSnapshot(targetSnapshot)
      || inputs.target.executionRoot !== targetSnapshot.root || inputs.canonicalWorkspaceRoot !== targetSnapshot.root
      || inputs.target.branchRef !== targetSnapshot.branchRef || inputs.target.expectedHead !== targetSnapshot.head
      || inputs.repositoryIdentity.commonDir !== targetSnapshot.commonDir
      || inputs.target.cleanStateDigest !== workflowMergeTargetSnapshotDigest(targetSnapshot)
      || round.candidate.commit === targetSnapshot.head) reject("invalid", "target_or_mode_mismatch");
    if (!this.evidence.candidateVerified(authority)) reject("conflict", "candidate_unverified");
    const payload: Omit<WorkflowMergeApprovalPayloadV1, "fingerprint"> = { type: "workflow_merge", schemaVersion: 1,
      workflowId: inputs.workflowId, workflowStepId: inputs.mergeOrder[0], roundId: round.roundId, generation: round.generation,
      authorityDigest: authority.authorityDigest, inputsDigest: round.inputsDigest,
      graphFingerprint: inputs.graphFingerprint, safetyFingerprint: inputs.safetyFingerprint, templatePins: inputs.templatePins,
      repositoryIdentity: inputs.repositoryIdentity, target: inputs.target, targetSnapshot, candidate: round.candidate, expiresAt };
    return { ...payload, fingerprint: workflowMergeApprovalFingerprint(payload) };
  }

  private request(roundId: string, generation: number): WorkflowMergeApprovalRequest | undefined {
    if (!identity(roundId) || !Number.isSafeInteger(generation) || generation < 1) reject("invalid", "request_scope_invalid");
    const row = this.context.database.prepare("SELECT * FROM workflow_merge_approval_requests WHERE round_id=? AND generation=?").get(roundId, generation);
    if (!row) return undefined;
    const payload = JSON.parse(String(row.payload_json)) as WorkflowMergeApprovalPayloadV1;
    const { fingerprint, ...basis } = payload;
    const request: WorkflowMergeApprovalRequest = { requestId: String(row.request_id), approvalId: String(row.approval_id),
      payload, createdAt: String(row.created_at) };
    if (payload.type !== "workflow_merge" || payload.schemaVersion !== 1 || payload.roundId !== roundId || payload.generation !== generation
      || !isWorkflowMergeTargetSnapshot(payload.targetSnapshot) || !time(request.createdAt) || !time(payload.expiresAt)
      || payload.expiresAt <= request.createdAt || workflowMergeApprovalFingerprint(basis) !== fingerprint
      || row.authority_digest !== payload.authorityDigest || row.basis_fingerprint !== fingerprint || json(payload) !== row.payload_json
      || digest({ roundId, generation, fingerprint }, "wmr1_") !== request.requestId || digest(request) !== row.request_digest)
      reject("invalid", "host_proposal_corrupt");
    const round = this.isolation.getIntegrationRound(roundId, generation);
    if (!round || round.inputs.workflowId !== payload.workflowId) reject("invalid", "host_proposal_round_missing");
    return request;
  }

  private approvalFor(request: WorkflowMergeApprovalRequest) {
    const approval = this.ports.getApprovalRequest(request.approvalId), payload = request.payload;
    const step = this.ports.getChannelWorkflowStep(payload.workflowStepId);
    const checkpoint = this.ports.getApprovalCheckpointForApproval(request.approvalId);
    if (!approval || !step || step.workflowId !== payload.workflowId || approval.actionType !== "workflow_merge"
      || approval.workflowStepId !== step.id || approval.channelId !== step.channelId || approval.runId || approval.taskId
      || approval.mediaJobId || approval.externalWorkActionId || approval.toolCallId || !same(approval.payload, payload)
      || approval.expiresAt !== payload.expiresAt || approval.createdAt !== request.createdAt
      || !same(approval.availableDecisions, ["approve_once", "deny"]) || approval.proposedCommandRule || approval.decisionRuleId
      || !checkpoint || checkpoint.approvalId !== approval.id || checkpoint.workflowStepId !== step.id
      || checkpoint.channelId !== step.channelId || checkpoint.runId || checkpoint.taskId || checkpoint.mediaJobId || checkpoint.externalWorkActionId
      || checkpoint.actionType !== "workflow_merge" || !same(checkpoint.sideEffect, payload)
      || checkpoint.status !== approval.status) reject("invalid", "approval_lineage_changed");
    return approval;
  }
}
