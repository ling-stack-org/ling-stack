import { randomUUID } from "node:crypto";
import { createSqliteWorkflowIsolationStore, createSqliteWorkflowMergeApprovalStore, createSqliteWorkflowMergeApplyStore,
  workflowMergeApplyDisposition, workflowMergeApplyEffectEvidence, workflowMergeApplyObservedIdentity,
  type RunStore, type WorkflowIntegrationRound, type WorkflowMergeApplyPermit, type WorkflowMergeApprovalRequest,
  type WorkflowMergeApplyObservation, type WorkflowMergeApplyObservationEvidenceV1 } from "@ling-stack/core";
import { applyWorkflowGitFastForward, observeWorkflowGitApply } from "../workspaces/workflow-git-apply.js";
import { integrationValue, requireIntegration, retainIntegrationArtifact } from "./workflow-integration-journal.js";
import { runWorkflowIsolationOperation, workflowIsolationIsDraining } from "./workflow-isolation-lifecycle.js";
import { completeWorkflowIfStepsFinished } from "./workflow-completion.js";
import { maybeCreateWorkflowTerminalCoordinatorReply } from "./workflows.js";
import { cleanupWorkflowWorktrees } from "./workflow-worktree-cleanup.js";

export interface WorkflowMergeApplicationResult {
  readonly status: "applied" | "not_applied" | "waiting" | "blocked" | "effect_unknown";
  readonly round: WorkflowIntegrationRound;
  readonly code?: string;
}
interface Input { readonly store: RunStore; readonly approvalId: string; readonly now?: () => string }

/** Live local-user decision path only. An existing durable permit is never permission to replay Git. */
export function applyApprovedWorkflowMerge(input: Input): Promise<WorkflowMergeApplicationResult> {
  return coordinate(input, true);
}

/** Startup/duplicate recovery observes under the repository lock. It cannot mint a permit or invoke Git merge. */
export function reconcileWorkflowMergeApplication(input: Input): Promise<WorkflowMergeApplicationResult> {
  return coordinate(input, false);
}

function coordinate(input: Input, liveDecision: boolean): Promise<WorkflowMergeApplicationResult> {
  const approval = input.store.getApprovalRequest(input.approvalId);
  requireIntegration(approval?.payload.type === "workflow_merge", "workflow_merge.approval_missing");
  const { workflowId, roundId, generation } = approval.payload;
  return runWorkflowIsolationOperation<WorkflowMergeApplicationResult>(input.store, workflowId, `merge-apply:${roundId}`, async () => {
    const { store } = input, now = input.now ?? (() => new Date().toISOString());
    const isolation = createSqliteWorkflowIsolationStore(store), applications = createSqliteWorkflowMergeApplyStore(store);
    const approvals = createSqliteWorkflowMergeApprovalStore(store);
    const latest = () => isolation.getIntegrationRound(roundId, generation)!;
    let permit: WorkflowMergeApplyPermit | undefined, request: WorkflowMergeApprovalRequest | undefined;
    const settled = (): WorkflowMergeApplicationResult => {
      const read = applications.inspectApplication({ approvalId: input.approvalId, now: now() });
      if (read.status === "applied") {
        return { status: "applied", round: read.round };
      }
      return { status: read.status === "pending" || read.status === "not_started" &&
        ["workflow_merge.approval_pending", "workflow_merge.approval_approved"].includes(read.code ?? "") ? "waiting"
        : read.status === "not_applied" ? "not_applied" : read.status === "effect_unknown" ? "effect_unknown" : "blocked",
      round: latest(), ...("code" in read && read.code ? { code: read.code } : {}) };
    };
    const persist = (observation: WorkflowMergeApplyObservation): void => {
      requireIntegration(permit && request, "workflow_merge.apply_owner_missing");
      const binding = isolation.getExecutionBinding(latest().writerBindingId!);
      requireIntegration(binding, "workflow_merge.apply_writer_missing");
      const disposition = workflowMergeApplyDisposition(request.payload, observation);
      const evidence: WorkflowMergeApplyObservationEvidenceV1 = { schemaVersion: 1, kind: "workflow_merge_apply_observation",
        permitId: permit.permitId, approvalId: permit.approvalId, disposition, observation };
      const payload = { schemaVersion: 1, kind: "workflow_integration_coordinator_receipt", intentId: permit.intentId,
        effectKey: "target:apply", outcome: disposition === "unknown" ? "effect_unknown" : "confirmed",
        observed: workflowMergeApplyObservedIdentity(request.payload, observation), evidence };
      const artifactId = retainIntegrationArtifact(store, binding.runId, payload, "Workflow target apply observation", now());
      integrationValue(applications.recordObservation({ permitId: permit.permitId, expectedRevision: latest().revision, artifactId, now: now() }));
    };
    try {
      request = approvals.getRequest(roundId, generation);
      requireIntegration(request?.approvalId === input.approvalId, "workflow_merge.host_proposal_missing");
      permit = applications.getPermit(roundId, generation);
      const target = { expectedRepository: request.payload.targetSnapshot, expectedHead: request.payload.target.expectedHead,
        candidateCommit: request.payload.candidate.commit, candidateTree: request.payload.candidate.tree };
      if (permit) {
        const read = applications.inspectApplication({ approvalId: input.approvalId, now: now() });
        if (["applied", "not_applied", "blocked", "invalid"].includes(read.status)) return settled();
        persist(await observeWorkflowGitApply(target));
        return settled();
      }
      if (!liveDecision) return settled();
      const ownerToken = randomUUID();
      const assertCurrentAuthority = (): void => {
        if (permit) {
          const read = applications.assertPermit({ permitId: permit.permitId, ownerToken, now: now() });
          requireIntegration(read.status === "authorized", read.status === "blocked" ? read.code : "workflow_merge.permit_invalid");
        } else {
          const read = approvals.inspectApproval({ approvalId: input.approvalId, now: now() });
          requireIntegration(read.status === "approved", read.status === "blocked" ? read.code : "workflow_merge.local_consent_required");
        }
      };
      const result = await applyWorkflowGitFastForward({ ...target, assertCurrentAuthority,
        beforeApply: () => {
          const binding = isolation.getExecutionBinding(latest().writerBindingId!);
          requireIntegration(binding && request, "workflow_merge.apply_writer_missing");
          const payload = workflowMergeApplyEffectEvidence(request, ownerToken);
          const payloadArtifactId = retainIntegrationArtifact(store, binding.runId, payload, "Workflow target apply intent", now());
          const begun = applications.beginApply({ approvalId: input.approvalId, expectedRevision: latest().revision,
            ownerToken, payloadArtifactId, now: now() });
          permit = integrationValue(begun);
          requireIntegration(begun.status === "created", "workflow_merge.permit_requires_observation");
        },
        afterApply: receipt => persist({ state: "candidate", verifiedClean: true, repository: receipt.repository,
          head: receipt.head, tree: receipt.tree, basisDigest: receipt.basisDigest }),
      });
      if (result.status === "applied") return settled();
      permit ??= applications.getPermit(roundId, generation);
      if (permit && result.observation) {
        // This is physical reconciliation, even if authority was revoked after Git ran.
        persist(result.observation);
        return settled();
      }
      return { status: result.status === "unknown" ? "effect_unknown" : "blocked", round: latest(), code: result.code };
    } catch (cause) {
      const code = cause instanceof Error && "code" in cause && typeof cause.code === "string"
        ? cause.code : "workflow_merge.application_unverified";
      return { status: permit ? "effect_unknown" : "blocked", round: latest(), code };
    }
  }).then(async result => {
    if (result.status === "applied" && !workflowIsolationIsDraining(input.store, workflowId)) {
      const at = input.now?.() ?? new Date().toISOString();
      completeWorkflowIfStepsFinished(input.store, workflowId, at);
      await cleanupWorkflowWorktrees(input.store, workflowId, { observeOnly: !liveDecision, now: input.now });
      maybeCreateWorkflowTerminalCoordinatorReply(input.store, workflowId, { now: at });
    }
    return result;
  });
}
