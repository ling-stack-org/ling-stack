import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { NodeRerunApprovalPayloadV1, NodeRerunPreparedIntentV1 } from "@ling-stack/contracts";
import type { ApprovalRequest, CreateApprovalRequestInput } from "../../approval-types.js";
import type { NodeRerunApprovalBasisV1 } from "../../node-rerun-store-types.js";

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const isCanonicalTimestamp = (value: string): boolean => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** The complete intent is part of the consent digest; the short plan identifier alone is insufficient. */
export function createNodeRerunApprovalBasis(record: NodeRerunPreparedIntentV1, generationId: string,
  channelId: string, createdAt: string): NodeRerunApprovalBasisV1 {
  if (!/^node_rerun_generation_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(generationId) || !channelId
    || !isCanonicalTimestamp(record.preparedAt) || !isCanonicalTimestamp(createdAt) || Date.parse(createdAt) < Date.parse(record.preparedAt))
    throw new Error("node_rerun_approval.invalid_basis");
  const basis = { schemaVersion: 1 as const, nodeRerunIntentId: record.id, workspaceId: record.workspaceId, channelId,
    intent: record.intent, planFingerprint: record.planFingerprint, policyFingerprint: record.policyFingerprint,
    generationId, createdAt, expiresAt: new Date(Date.parse(createdAt) + 30 * 60_000).toISOString() };
  return { ...basis, fingerprint: digest(basis) };
}

export function nodeRerunApprovalPayload(basis: NodeRerunApprovalBasisV1): NodeRerunApprovalPayloadV1 {
  return { schemaVersion: 1, type: "node_rerun", nodeRerunIntentId: basis.nodeRerunIntentId, generationId: basis.generationId,
    intent: basis.intent, planFingerprint: basis.planFingerprint, policyFingerprint: basis.policyFingerprint,
    expiresAt: basis.expiresAt, fingerprint: basis.fingerprint };
}

/** Resolve the source through the recorded workflow owner, including its workspace and channel. */
export function nodeRerunApprovalChannel(db: DatabaseSync, record: NodeRerunPreparedIntentV1): string | undefined {
  const source = db.prepare(`SELECT step.channel_id FROM run_sessions run
    JOIN channel_workflow_steps step ON step.id=run.workflow_step_id AND step.run_id=run.id
      AND step.task_id=run.task_id AND step.channel_id=run.channel_id
    JOIN channel_workflows workflow ON workflow.id=step.workflow_id AND workflow.channel_id=step.channel_id
      AND workflow.workspace_id=step.workspace_id
    JOIN channels channel ON channel.id=step.channel_id AND channel.workspace_id=step.workspace_id
    WHERE run.id=? AND step.workspace_id=?`).get(record.intent.source.runId, record.workspaceId);
  return typeof source?.channel_id === "string" ? source.channel_id : undefined;
}

export function assertNodeRerunApprovalShape(approval: CreateApprovalRequestInput, basis: NodeRerunApprovalBasisV1): void {
  if (approval.nodeRerunIntentId !== basis.nodeRerunIntentId || approval.actionType !== "node_rerun"
    || [approval.runId, approval.taskId, approval.mediaJobId, approval.externalWorkActionId, approval.workflowStepId, approval.toolCallId]
      .some(value => value !== undefined)
    || approval.channelId !== basis.channelId || approval.risk !== "high" || approval.expiresAt !== basis.expiresAt
    || approval.proposedCommandRule !== undefined
    || canonical(approval.availableDecisions) !== canonical(["approve_once", "deny"])
    || canonical(approval.payload) !== canonical(nodeRerunApprovalPayload(basis)))
    throw new Error("node_rerun_approval.binding_corrupt");
}

/** Verify the durable consent, owner and checkpoint as one receipt. Missing bindings never authorize a decision. */
export function readNodeRerunApprovalBasis(db: DatabaseSync, approval: ApprovalRequest,
  getIntent: (id: string) => NodeRerunPreparedIntentV1 | undefined): NodeRerunApprovalBasisV1 | undefined {
  const row = db.prepare("SELECT * FROM node_rerun_approval_requests WHERE approval_id=?").get(approval.id);
  if (!row) return undefined;
  const record = typeof row.intent_id === "string" ? getIntent(row.intent_id) : undefined;
  if (!record || typeof row.generation_id !== "string" || typeof row.created_at !== "string")
    throw new Error("node_rerun_approval.binding_corrupt");
  const channelId = nodeRerunApprovalChannel(db, record);
  if (!channelId) throw new Error("node_rerun_approval.source_unavailable");
  const basis = createNodeRerunApprovalBasis(record, row.generation_id, channelId, row.created_at);
  if (row.basis_json !== JSON.stringify(basis) || row.basis_sha256 !== basis.fingerprint || row.expires_at !== basis.expiresAt
    || approval.createdAt !== basis.createdAt) throw new Error("node_rerun_approval.binding_corrupt");
  assertNodeRerunApprovalShape(approval, basis);
  const checkpoint = db.prepare("SELECT * FROM approval_checkpoints WHERE approval_id=?").get(approval.id);
  if (!checkpoint || checkpoint.node_rerun_intent_id !== record.id || checkpoint.channel_id !== basis.channelId
    || checkpoint.action_type !== approval.actionType || checkpoint.risk !== approval.risk || checkpoint.status !== approval.status
    || checkpoint.side_effect_json !== JSON.stringify(approval.payload) || checkpoint.created_at !== basis.createdAt
    || [checkpoint.run_id, checkpoint.task_id, checkpoint.media_job_id, checkpoint.external_work_action_id,
      checkpoint.workflow_step_id, checkpoint.tool_call_id, checkpoint.runner_resume_handle_json, checkpoint.resume_basis_json]
      .some(value => value !== null)) throw new Error("node_rerun_approval.checkpoint_corrupt");
  return basis;
}
