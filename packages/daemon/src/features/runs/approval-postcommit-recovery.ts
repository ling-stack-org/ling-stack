import type { ApprovalPostCommitEffect, ApprovalRequest, MediaJob, RunStore } from "@ling-stack/core";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { reconcileApprovalPostCommitEffects } from "./approval-postcommit-effects.js";
import { verifyApprovalPostCommitEvidence } from "./approval-postcommit-evidence.js";

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
  const decisionEventsDeferredUntilNextScan = new Set<string>();
  let after: { createdAt: string; approvalId: string; effectKind: ApprovalPostCommitEffect["effectKind"] } | undefined;
  for (;;) {
    const page = store.listApprovalPostCommitEffects({ status: "claimed", after, limit: 500 });
    for (const effect of page) {
      if (effect.claimExpiresAt && effect.claimExpiresAt < now) {
        const approval = store.getApprovalRequest(effect.approvalId);
        const resolution = expiredEffectResolution(store, effect, approval);
        const settled = store.recoverExpiredApprovalPostCommitClaim(effect.approvalId, effect.effectKind, {
          expectedRevision: effect.revision,
          status: resolution.status,
          errorCode: resolution.code,
        }, now);
        if (settled?.status === "effect_unknown") unknown += 1;
        if (settled?.status === "completed") recovered += 1;
        if (effect.effectKind === "decision_event" && settled?.status === "pending") {
          // Do not reclaim and replay a decision event in the same recovery
          // scan that expired its prior lease. The stale publisher may still
          // be returning from appendEvent; a same-scan replay can race it and
          // append the same canonical decision twice. The next periodic scan
          // will either observe the old publisher's event or safely replay it.
          decisionEventsDeferredUntilNextScan.add(effect.approvalId);
          deferred += 1;
        }
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
      if (effect.approvalId !== lastProcessedId
        && !decisionEventsDeferredUntilNextScan.has(effect.approvalId)) {
        reconcileId(effect.approvalId);
      }
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
): { readonly status: "pending" | "completed" | "blocked" | "effect_unknown"; readonly code: string } {
  if (!approval || approval.status === "pending") {
    return { status: "blocked", code: "approval_owner_evidence_missing" };
  }
  const evidence = verifyApprovalPostCommitEvidence(store, approval, effect.effectKind);
  if (evidence.status === "applied") {
    return { status: "completed", code: evidence.code };
  }
  // An expired media claim may have crossed the provider boundary before the
  // daemon died. Unless durable evidence proves the outcome, never replay it.
  if (effect.effectKind === "owner" && effect.ownerKind === "media_job") {
    return { status: "effect_unknown", code: "approval_effect_outcome_unknown" };
  }
  return { status: evidence.status, code: evidence.code };
}
