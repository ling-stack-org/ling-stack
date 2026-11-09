import type { WorkflowMergeApplyDisposition, WorkflowMergeApplyIdentities, WorkflowMergeApplyObservation } from "./workflow-merge-apply-types.js";
import type { WorkflowMergeApprovalPayloadV1, WorkflowMergeApprovalRequest } from "./workflow-merge-types.js";
import type { WorkflowIsolationGitIdentity } from "./workflow-isolation-types.js";
import { isWorkflowMergeTargetSnapshot, workflowMergeTargetSnapshotDigest } from "./workflow-merge-approval.js";
import { workflowIsolationCanonicalJson as json, workflowIsolationDigest as digest,
  workflowIsolationRecord as record } from "./workflow-isolation.js";

export function workflowMergeApplyPermitId(request: WorkflowMergeApprovalRequest, ownerToken: string): string {
  return digest({ requestId: request.requestId, approvalId: request.approvalId, ownerToken }, "wmp1_");
}

export function workflowMergeApplyIntentId(request: WorkflowMergeApprovalRequest): string {
  return digest({ roundId: request.payload.roundId, generation: request.payload.generation, effectKey: "target:apply" }, "wici_");
}

/** The retained Host proposal must still be revalidated by beginApply; this is journal data only. */
export function workflowMergeApplyEffectEvidence(request: WorkflowMergeApprovalRequest, ownerToken: string) {
  const { before, after } = workflowMergeApplyIdentities(request.payload);
  return { schemaVersion: 1 as const, kind: "workflow_integration_coordinator_effect" as const,
    roundId: request.payload.roundId, generation: request.payload.generation, authorityDigest: request.payload.authorityDigest,
    effectKey: "target:apply", effectKind: "target_apply" as const, before, after,
    effect: { kind: "workflow_merge_apply", permitId: workflowMergeApplyPermitId(request, ownerToken),
      requestId: request.requestId, approvalId: request.approvalId, ownerToken, basisFingerprint: request.payload.fingerprint } };
}

/** A state label or matching HEAD alone never proves that the target was applied or safely untouched. */
export function workflowMergeApplyDisposition(payload: WorkflowMergeApprovalPayloadV1, value: unknown): WorkflowMergeApplyDisposition {
  if (!record(value) || value.verifiedClean !== true || !isWorkflowMergeTargetSnapshot(value.repository)
    || typeof value.head !== "string" || value.head !== value.repository.head || typeof value.tree !== "string"
    || value.tree.length !== payload.candidate.tree.length || !/^[a-f0-9]+$/u.test(value.tree)
    || value.basisDigest !== workflowMergeTargetSnapshotDigest(value.repository)) return "unknown";
  const expected = value.state === "expected" && value.head === payload.target.expectedHead;
  const candidate = value.state === "candidate" && value.head === payload.candidate.commit && value.tree === payload.candidate.tree;
  if ((!expected && !candidate) || json({ ...value.repository, head: payload.target.expectedHead }) !== json(payload.targetSnapshot)) return "unknown";
  return candidate ? "applied" : "not_applied";
}

export function workflowMergeApplyIdentities(payload: WorkflowMergeApprovalPayloadV1): WorkflowMergeApplyIdentities {
  const { executionRoot, branchRef, worktreeId } = payload.target;
  const before = { executionRoot, branchRef, worktreeId, commonDir: payload.repositoryIdentity.commonDir,
    exists: true, headCommit: payload.target.expectedHead, cleanStateDigest: payload.target.cleanStateDigest };
  const after = { ...before, headCommit: payload.candidate.commit, tree: payload.candidate.tree,
    cleanStateDigest: workflowMergeTargetSnapshotDigest({ ...payload.targetSnapshot, head: payload.candidate.commit }) };
  return { before, after };
}

export function workflowMergeApplyObservedIdentity(payload: WorkflowMergeApprovalPayloadV1,
  observation: WorkflowMergeApplyObservation): WorkflowIsolationGitIdentity {
  const { before, after } = workflowMergeApplyIdentities(payload);
  const disposition = workflowMergeApplyDisposition(payload, observation);
  if (disposition === "applied") return after;
  if (disposition === "not_applied") return before;
  // For unavailable observations this is only the expected anchor, never proof that the checkout exists or is clean.
  return before;
}
