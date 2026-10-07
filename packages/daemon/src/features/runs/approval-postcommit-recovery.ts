import type { ApprovalPostCommitEffect, ApprovalRequest, MediaJob, RunStore } from "@ling-stack/core";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { hasApprovalDecisionEvent, reconcileApprovalPostCommitEffects } from "./approval-postcommit-effects.js";

export interface ApprovalPostCommitRecoveryResult {
  readonly recovered: number;
  readonly unknown: number;
  readonly deferred: number;
}

/** Reconcile one SQLite store without treating an expired claim as permission to replay it. */
export function recoverApprovalPostCommitStore(input: {
  readonly store: RunStore;
  readonly cwd: string;
  readonly controlPlaneEvents?: ControlPlaneEventHub;
  readonly onOwnerResolved: (approval: ApprovalRequest) => MediaJob | undefined;
  readonly now?: string;
}): ApprovalPostCommitRecoveryResult {
  const { store } = input;
  const now = input.now ?? new Date().toISOString();
  let recovered = 0;
  let unknown = 0;
  let deferred = 0;
  let after: { createdAt: string; approvalId: string; effectKind: ApprovalPostCommitEffect["effectKind"] } | undefined;
  for (;;) {
    const page = store.listApprovalPostCommitEffects({ status: "claimed", after, limit: 500 });
    for (const effect of page) {
      if (effect.claimExpiresAt && effect.claimExpiresAt < now) {
        const approval = store.getApprovalRequest(effect.approvalId);
        const resolution = expiredEffectResolution(store, effect, approval);
        const settled = store.recoverExpiredApprovalPostCommitClaim(effect.approvalId, effect.effectKind, {
          expectedRevision: effect.revision,
          status: resolution,
          errorCode: resolution === "effect_unknown" ? "approval_effect_outcome_unknown"
            : resolution === "blocked" ? "approval_owner_evidence_missing" : "approval_recovery_verified",
        }, now);
        if (settled?.status === "effect_unknown") unknown += 1;
        if (settled?.status === "completed") recovered += 1;
      }
    }
    if (page.length < 500) break;
    const last = page.at(-1)!;
    after = { createdAt: last.createdAt, approvalId: last.approvalId, effectKind: last.effectKind };
  }

  after = undefined;
  const reconcileId = (id: string): void => {
    try {
    const approval = store.getApprovalRequest(id);
    if (!approval || approval.status === "pending") { deferred += 1; return; }
    // A queued media job without a durable handle may already have been sent
    // to a provider. It must never be dispatched again by this scanner.
    if (approval.mediaJobId) {
      const job = store.getMediaJob(approval.mediaJobId);
      if (job && job.status !== "waiting_for_approval") {
        const effect = store.listApprovalPostCommitEffects({ approvalId: id }).find((item) => item.effectKind === "owner" && item.status === "pending");
        if (effect) {
          const token = `media-unknown-${id}`;
          const claim = store.claimApprovalPostCommitEffect(id, "owner", {
            token, claimExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
          }, now);
          const proven = Boolean(store.getMediaJobExecutionHandle(job.id))
            || job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";
          if (claim && store.settleApprovalPostCommitEffect(id, "owner", {
            token, status: proven ? "completed" : "effect_unknown",
            ...(proven ? {} : { errorCode: "media_execution_handle_missing" }),
          }, now)) {
            if (proven) recovered += 1;
            else unknown += 1;
          }
        }
      }
    }
    const result = reconcileApprovalPostCommitEffects({
      store, approval, cwd: input.cwd, now, controlPlaneEvents: input.controlPlaneEvents,
      onOwnerResolved: () => input.onOwnerResolved(approval),
    });
    if (result.deferred) deferred += 1;
    else recovered += 1;
    } catch {
      // One corrupt owner must not starve the rest of the durable queue.
      deferred += 1;
    }
  };
  let lastProcessedId: string | undefined;
  for (;;) {
    const page = store.listApprovalPostCommitEffects({ status: "pending", after, limit: 500 });
    for (const effect of page) {
      if (effect.approvalId !== lastProcessedId) reconcileId(effect.approvalId);
      lastProcessedId = effect.approvalId;
    }
    if (page.length < 500) break;
    const last = page.at(-1)!;
    after = { createdAt: last.createdAt, approvalId: last.approvalId, effectKind: last.effectKind };
  }
  return { recovered, unknown, deferred };
}

function expiredEffectResolution(
  store: RunStore,
  effect: ApprovalPostCommitEffect,
  approval: ApprovalRequest | undefined,
): "pending" | "completed" | "blocked" | "effect_unknown" {
  if (!approval || approval.status === "pending") return "blocked";
  if (effect.effectKind === "decision_event") return hasApprovalDecisionEvent(store, approval) ? "completed" : "pending";
  if (effect.effectKind === "control_plane_event") return "pending"; // approval ID is the idempotency key.
  if (effect.ownerKind === "media_job") return "effect_unknown";
  if (effect.ownerKind === "workflow_step" || effect.ownerKind === "external_work_action") return "pending";
  if (effect.ownerKind === "run" && approval.runId) {
    const checkpoint = store.getApprovalCheckpointForApproval(approval.id);
    const run = store.getRun(approval.runId);
    if (!checkpoint || !run) return "blocked";
    if (run.status !== "waiting_for_approval") return "completed";
    if (checkpoint.status === "approved" || checkpoint.status === "denied") return "pending";
  }
  return "blocked";
}
