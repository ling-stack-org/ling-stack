import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { LingAppServerGitHubDelivery, LingAppServerVerifyOperation, LingAppServerVerifyPlanResult } from "@ling-stack/contracts";
import type { GoalEvidenceRef, LingThreadGoal, UpdateLingThreadGoalInput } from "../../run-types.js";
import { parseGoalAcceptanceEvidence } from "../../goal-supervision.js";

/** Checks persisted, goal-scoped evidence while completion owns the writer lock. */
export function assertGoalCompletion(db: DatabaseSync, goal: LingThreadGoal, input: UpdateLingThreadGoalInput): void {
  const criteria = goal.acceptanceCriteria ?? [], evidence = parseGoalAcceptanceEvidence(input.acceptanceEvidence ?? []);
  const refs = input.completionEvidenceRefs ?? goal.completionEvidenceRefs;
  const strict = criteria.length > 0 || input.completedBy === "ling-agent" || refs.some(ref => ref.kind === "verification" || ref.kind === "github_delivery");
  if (!strict) return;
  if (goal.status !== "active" && goal.status !== "blocked") throw new Error("goal_completion_not_active");
  if (criteria.some(criterion => criterion.kind === "verification_passed" || criterion.kind === "github_delivered")
    && input.verificationGoalRevision !== goal.updatedAt) throw new Error("goal_verification_acceptance_revision_required");
  if (!input.completionVerificationSummary?.trim()) throw new Error("goal_completion_summary_required");
  if (db.prepare("SELECT 1 FROM run_sessions WHERE thread_id=? AND status IN ('queued','running','waiting_for_approval','yielded') LIMIT 1").get(goal.threadId)
    || db.prepare(`SELECT 1 FROM approval_requests a JOIN run_sessions r ON r.id=a.run_id
      WHERE r.thread_id=? AND a.status='pending' LIMIT 1`).get(goal.threadId)) throw new Error("goal_completion_work_pending");
  const verifications = new Map<string, PersistedVerification>();
  const deliveries = new Map<string, LingAppServerGitHubDelivery>();
  const verify = (ref: GoalEvidenceRef): void => {
    if (ref.kind === "run") {
      const run = db.prepare("SELECT status,thread_id,created_at FROM run_sessions WHERE id=?").get(ref.id);
      if (!run || run.thread_id !== goal.threadId || run.status !== "succeeded" || String(run.created_at) < goal.createdAt) throw new Error("goal_completion_evidence_invalid");
    } else if (ref.kind === "artifact") {
      const artifact = db.prepare(`SELECT a.content_sha256,a.sealed_payload_json,r.thread_id,r.status,r.created_at
        FROM artifacts a JOIN run_sessions r ON r.id=a.run_id WHERE a.id=?`).get(ref.id);
      if (!artifact || artifact.thread_id !== goal.threadId || artifact.status !== "succeeded" || String(artifact.created_at) < goal.createdAt
        || typeof artifact.content_sha256 !== "string" || typeof artifact.sealed_payload_json !== "string"
        || createHash("sha256").update(JSON.stringify(JSON.parse(artifact.sealed_payload_json))).digest("hex") !== artifact.content_sha256) throw new Error("goal_completion_evidence_invalid");
    } else if (ref.kind === "workflow") {
      const workflow = db.prepare("SELECT status,created_at FROM channel_workflows WHERE id=?").get(ref.id);
      if (!workflow || workflow.status !== "succeeded" || String(workflow.created_at) < goal.createdAt
        || !db.prepare(`SELECT 1 FROM ling_threads WHERE id=? AND workflow_id=?
          UNION ALL SELECT 1 FROM run_sessions r JOIN channel_workflow_steps s ON s.id=r.workflow_step_id WHERE r.thread_id=? AND s.workflow_id=? LIMIT 1`)
          .get(goal.threadId, ref.id, goal.threadId, ref.id)) throw new Error("goal_completion_evidence_invalid");
      if (db.prepare("SELECT 1 FROM channel_workflow_steps WHERE workflow_id=? AND status NOT IN ('succeeded','skipped') LIMIT 1").get(ref.id)) throw new Error("goal_completion_evidence_invalid");
    } else if (ref.kind === "turn") {
      const turn = db.prepare("SELECT thread_id,status FROM ling_turns WHERE id=?").get(ref.id);
      if (!turn || turn.thread_id !== goal.threadId || turn.status !== "succeeded") throw new Error("goal_completion_evidence_invalid");
    } else if (ref.kind === "approval") {
      const approval = db.prepare("SELECT a.status,r.thread_id FROM approval_requests a JOIN run_sessions r ON r.id=a.run_id WHERE a.id=?").get(ref.id);
      if (!approval || approval.thread_id !== goal.threadId || approval.status !== "approved") throw new Error("goal_completion_evidence_invalid");
    } else if (ref.kind === "verification" && !verifications.has(ref.id)) {
      if (!evidence.some(binding => binding.evidence.kind === "verification" && binding.evidence.id === ref.id
        && criteria.some(criterion => criterion.id === binding.criterionId && criterion.kind === "verification_passed"))) {
        throw new Error("goal_completion_evidence_invalid");
      }
      verifications.set(ref.id, getGoalVerification(db, goal, ref.id, input.verificationCandidateDigest));
    } else if (ref.kind === "github_delivery" && !deliveries.has(ref.id)) {
      const criterion = criteria.find(criterion => criterion.kind === "github_delivered"
        && evidence.some(binding => binding.criterionId === criterion.id && binding.evidence.kind === "github_delivery" && binding.evidence.id === ref.id));
      const requirement = criterion?.githubDelivery;
      const current = requirement && db.prepare(`SELECT payload_json FROM app_server_state
        WHERE workspace_id=? AND kind='github_delivery_current' AND record_id=?`).get(goal.workspaceId, requirement.workItemId);
      const delivery = typeof current?.payload_json === "string" ? JSON.parse(current.payload_json) as LingAppServerGitHubDelivery : undefined;
      if (!requirement || !delivery || delivery.deliveryId !== ref.id || delivery.threadId !== goal.threadId
        || !input.reconciledGitHubDeliveryIds?.includes(ref.id) || delivery.status !== "delivered" || !delivery.mergedCommit
        || delivery.candidateDigest !== input.verificationCandidateDigest || !delivery.checks.length
        || delivery.checks.some(check => check.outcome !== "passed")) throw new Error("goal_completion_evidence_invalid");
      deliveries.set(ref.id, delivery);
    }
  };
  if (!refs.length) throw new Error("goal_completion_evidence_required");
  for (const ref of refs) verify(ref);
  if (evidence.length !== criteria.length) throw new Error("goal_acceptance_incomplete");
  for (const criterion of criteria) {
    const binding = evidence.find(item => item.criterionId === criterion.id);
    const kind = criterion.kind === "run_succeeded" ? "run" : criterion.kind === "workflow_succeeded" ? "workflow"
      : criterion.kind === "verification_passed" ? "verification" : criterion.kind === "github_delivered" ? "github_delivery" : "artifact";
    if (!binding || criterion.evidenceId !== undefined && binding.evidence.id !== criterion.evidenceId || binding.evidence.kind !== kind || !refs.some(ref => ref.kind === kind && ref.id === binding.evidence.id)) throw new Error("goal_acceptance_incomplete");
    verify(binding.evidence);
    if (kind === "github_delivery") {
      const delivery = deliveries.get(binding.evidence.id)!;
      if (delivery.policyRevision !== criterion.githubDelivery?.policyRevision || delivery.workItemId !== criterion.githubDelivery.workItemId) {
        throw new Error("goal_acceptance_delivery_policy_mismatch");
      }
    }
    if (kind === "verification") {
      const requirement = criterion.verification!;
      const { operation, plan } = verifications.get(binding.evidence.id)!;
      const proof = operation.checks.find(check => check.checkId === requirement.checkId);
      const plannedCheck = plan.checks.find(check => check.checkId === requirement.checkId);
      if (proof?.status !== "passed" || proof.candidateDigest !== operation.candidateDigest
        || proof.planRevision !== plan.planRevision || proof.recipeDigest !== plannedCheck?.recipeDigest
        || proof.verifierBasisRef !== requirement.verifierBasisRef || proof.coverageDigest !== requirement.coverageDigest
        || proof.verifierBasisRef !== plannedCheck.verifierBasisRef || proof.coverageDigest !== plannedCheck.coverageDigest
        || !proof.producerRefs.length || JSON.stringify(proof.producerRefs) !== JSON.stringify(plannedCheck.producerRefs)) {
        throw new Error("goal_verification_basis_mismatch");
      }
    }
    if (criterion.contentSha256 && db.prepare("SELECT content_sha256 FROM artifacts WHERE id=?").get(binding.evidence.id)?.content_sha256 !== criterion.contentSha256) throw new Error("goal_acceptance_digest_mismatch");
  }
}

interface PersistedVerification {
  readonly operation: LingAppServerVerifyOperation;
  readonly plan: LingAppServerVerifyPlanResult;
}

function getGoalVerification(
  db: DatabaseSync, goal: LingThreadGoal, operationId: string, candidateDigest: string | undefined,
): PersistedVerification {
  if (!candidateDigest) throw new Error("goal_verification_candidate_required");
  const row = db.prepare(`SELECT payload_json, created_at FROM app_server_state
    WHERE workspace_id=? AND kind='verify_operation' AND record_id=?`).get(goal.workspaceId, operationId);
  if (typeof row?.payload_json !== "string" || String(row.created_at) < goal.createdAt) throw new Error("goal_completion_evidence_invalid");
  const result = JSON.parse(row.payload_json) as PersistedVerification;
  const { operation, plan } = result;
  if (!operation || !plan || operation.operationId !== operationId || operation.planId !== plan.planId
    || operation.threadId !== goal.threadId || plan.threadId !== goal.threadId
    || operation.status !== "passed" || !operation.completedAt) throw new Error("goal_completion_evidence_invalid");
  if (operation.candidateDigest !== candidateDigest || plan.candidate.candidateDigest !== candidateDigest) {
    throw new Error("goal_verification_candidate_stale");
  }
  return result;
}
