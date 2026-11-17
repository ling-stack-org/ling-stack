import { randomUUID } from "node:crypto";
import { createNodeRerunHostAdmissionPlanV1, parseNodeRerunIntent } from "@ling-stack/contracts";
import type { CreateApprovalRequestInput } from "../../approval-types.js";
import type { NodeRerunApprovalBasisV1, RequestNodeRerunApprovalInput, RequestNodeRerunApprovalResult } from "../../node-rerun-store-types.js";
import type { RunStore } from "../../run-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";
import type { SqliteStoreContext } from "./store-context.js";
import { createNodeRerunApprovalBasis, isCanonicalTimestamp, nodeRerunApprovalChannel, nodeRerunApprovalPayload, readNodeRerunApprovalBasis } from "./node-rerun-approval-authority.js";

type Ports = Pick<RunStore, "getNodeRerunIntent" | "getApprovalRequest"> & {
  readonly createApproval: (input: CreateApprovalRequestInput, basis: NodeRerunApprovalBasisV1) => ReturnType<RunStore["createApprovalRequest"]>;
};

/** Owns generation consent and idempotency; execution admission consumes consent separately. */
export class SqliteNodeRerunApprovalStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports) {}

  getNodeRerunApprovalBasis(approvalId: string): NodeRerunApprovalBasisV1 | undefined {
    return readSqliteSnapshot(this.context.database, () => this.readBasis(approvalId));
  }

  private readBasis(approvalId: string): NodeRerunApprovalBasisV1 | undefined {
    const approval = this.ports.getApprovalRequest(approvalId);
    return approval ? readNodeRerunApprovalBasis(this.context.database, approval, id => this.ports.getNodeRerunIntent(id)) : undefined;
  }

  requestNodeRerunApproval(input: RequestNodeRerunApprovalInput): RequestNodeRerunApprovalResult {
    if (!isCanonicalTimestamp(input.now)) throw new TypeError("node_rerun_approval.invalid_timestamp");
    const db = this.context.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.requestWithinTransaction(input);
      db.exec("COMMIT");
      return result;
    } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
  }

  private requestWithinTransaction(input: RequestNodeRerunApprovalInput): RequestNodeRerunApprovalResult {
    const db = this.context.database;
    const record = this.ports.getNodeRerunIntent(input.recordId);
    if (!record) return { status: "blocked", code: "node_rerun_intent_not_found" };
    const existing = db.prepare("SELECT approval_id FROM node_rerun_approval_requests WHERE intent_id=?").get(record.id);
    if (existing) {
      const approval = this.ports.getApprovalRequest(String(existing.approval_id));
      if (!approval || !this.readBasis(approval.id)) throw new Error("node_rerun_approval.binding_corrupt");
      return { status: "duplicate", approval };
    }
    if (db.prepare("SELECT id FROM approval_requests WHERE node_rerun_intent_id=? LIMIT 1").get(record.id))
      throw new Error("node_rerun_approval.binding_corrupt");
    const channelId = nodeRerunApprovalChannel(db, record);
    if (!channelId) return { status: "blocked", code: "node_rerun_source_unavailable" };
    const observation = readSqliteWithinTransaction(db, () => input.revalidate(parseNodeRerunIntent(record.intent)));
    if (!observation.observed || observation.admission.decision !== "eligible_for_host_admission")
      return { status: "blocked", code: "node_rerun_admission_blocked" };
    const plan = createNodeRerunHostAdmissionPlanV1({ intent: record.intent, ...observation, observed: observation.observed });
    if (plan.planFingerprint !== record.planFingerprint || plan.currentPolicyFingerprint !== record.policyFingerprint)
      return { status: "blocked", code: "node_rerun_plan_stale" };
    const basis = createNodeRerunApprovalBasis(record, `node_rerun_generation_${randomUUID()}`, channelId, input.now);
    const approval = this.ports.createApproval({ nodeRerunIntentId: record.id, channelId, actionType: "node_rerun", risk: "high",
      title: `Rerun node ${record.intent.source.nodeId}`, description: `Approve a fresh execution generation for node ${record.intent.source.nodeId}.`,
      payload: nodeRerunApprovalPayload(basis), expiresAt: basis.expiresAt, availableDecisions: ["approve_once", "deny"] }, basis);
    const inserted = db.prepare(`INSERT INTO node_rerun_approval_requests
      (intent_id,approval_id,generation_id,basis_json,basis_sha256,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(record.id, approval.id, basis.generationId, JSON.stringify(basis), basis.fingerprint, basis.expiresAt, basis.createdAt);
    if (inserted.changes !== 1 || !this.readBasis(approval.id))
      throw new Error("node_rerun_approval.commit_receipt_missing");
    return { status: "created", approval };
  }
}
