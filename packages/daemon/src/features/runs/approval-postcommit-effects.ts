import { randomUUID } from "node:crypto";
import { syncExternalWorkActionForApproval, type ApprovalRequest, type MediaJob, type RunStore } from "@ling-stack/core";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendApprovalDecisionEvent, appendApprovalExpiredControlPlaneEvent, appendApprovalResolvedControlPlaneEvent } from "./approvals.js";

/**
 * Reconcile independent approval owners after the decision has committed.
 * A failed Run resume must not suppress a workflow gate or media decision.
 * The caller reports any failure as deferred while durable recovery remains
 * responsible for retrying the affected owner.
 */
export function runApprovalPostCommitEffects(input: {
  readonly resumeRun: () => void;
  readonly syncWorkflow: () => void;
  readonly syncMedia: () => MediaJob | undefined;
}): MediaJob | undefined {
  const failures: unknown[] = [];
  let mediaJob: MediaJob | undefined;
  const attempt = (effect: () => void): void => {
    try {
      effect();
    } catch (error) {
      failures.push(error);
    }
  };
  attempt(input.resumeRun);
  attempt(input.syncWorkflow);
  attempt(() => { mediaJob = input.syncMedia(); });
  if (failures.length > 0) {
    throw new AggregateError(failures, "approval_postcommit_effects_deferred");
  }
  return mediaJob;
}

/** Reconcile each durable effect independently; a committed decision never becomes an HTTP failure. */
export function reconcileApprovalPostCommitEffects(input: {
  readonly store: RunStore;
  readonly approval: ApprovalRequest;
  readonly cwd: string;
  readonly now: string;
  readonly controlPlaneEvents?: ControlPlaneEventHub;
  readonly onOwnerResolved?: () => MediaJob | undefined;
}): { readonly mediaJob?: MediaJob; readonly deferred: boolean } {
  const { store, approval, cwd, now, controlPlaneEvents } = input;
  const effects = typeof store.listApprovalPostCommitEffects === "function"
    ? store.listApprovalPostCommitEffects({ approvalId: approval.id }) : [];
  let deferred = false;
  let mediaJob: MediaJob | undefined;
  const attempt = (kind: "decision_event" | "owner" | "control_plane_event", operation: () => void): boolean => {
    const effect = effects.find((candidate) => candidate.effectKind === kind);
    if (effect?.status === "completed") return true;
    if (effects.length && !effect) return true;
    const token = randomUUID();
    let claim;
    try {
      claim = effect && store.claimApprovalPostCommitEffect(approval.id, kind, {
        token, claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }, new Date().toISOString());
    } catch {
      deferred = true;
      return false;
    }
    if (effect && !claim) { deferred = true; return false; }
    if (effect && effect.attempts >= 5) {
      try {
        store.settleApprovalPostCommitEffect(approval.id, kind, {
          token, status: "blocked", errorCode: "approval_effect_retry_exhausted",
        }, new Date().toISOString());
      } catch { /* The claim remains durable for inspection. */ }
      deferred = true;
      return false;
    }
    try {
      operation();
      if (effect && !store.settleApprovalPostCommitEffect(approval.id, kind, { token, status: "completed" }, new Date().toISOString())) {
        deferred = true;
        return false;
      }
      return true;
    } catch {
      if (effect) try {
        store.settleApprovalPostCommitEffect(approval.id, kind, {
          token,
          status: kind === "owner" && effect.ownerKind === "media_job" ? "effect_unknown" : "pending",
          errorCode: "approval_effect_callback_failed",
        }, new Date().toISOString());
      } catch { /* The claim is durable for the next recovery scan. */ }
      deferred = true;
      return false;
    }
  };
  const eventRecorded = attempt("decision_event", () => {
    if (approval.runId && !hasApprovalDecisionEvent(store, approval)) appendApprovalDecisionEvent(store, approval);
  });
  if (eventRecorded) attempt("owner", () => {
    if (effects.length && approval.externalWorkActionId) syncExternalWorkActionForApproval(store, approval, now);
    else {
      mediaJob = input.onOwnerResolved?.();
      if (approval.mediaJobId && !mediaJob) throw new Error("approval_media_owner_missing");
    }
  });
  attempt("control_plane_event", () => {
    if (approval.status === "expired") {
      appendApprovalExpiredControlPlaneEvent(store, controlPlaneEvents, cwd, approval, "pending", now);
    } else {
      appendApprovalResolvedControlPlaneEvent(store, controlPlaneEvents, cwd, approval, "pending",
        approval.status === "approved" ? "approved" : approval.status === "cancelled" ? "cancelled" : "denied", now);
    }
  });
  if (!effects.length) attempt("owner", () => { syncExternalWorkActionForApproval(store, approval, now); });
  return { ...(mediaJob ? { mediaJob } : {}), deferred };
}

/** A crash after append but before settlement must not append the decision again. */
export function hasApprovalDecisionEvent(store: RunStore, approval: ApprovalRequest): boolean {
  if (!approval.runId) return false;
  const decisionType = approval.status === "approved" ? "approval_approved"
    : approval.status === "expired" ? "approval_expired"
      : approval.status === "cancelled" ? "approval_cancelled" : "approval_denied";
  let afterSeq = 0;
  for (;;) {
    const page = store.listEvents(approval.runId, { afterSeq, limit: 1000 });
    if (page.some((event) => event.type === decisionType
      && typeof event.data === "object" && event.data !== null
      && "approvalId" in event.data && event.data.approvalId === approval.id)) return true;
    const lastSeq = page.at(-1)?.seq;
    if (page.length < 1000 || lastSeq === undefined || lastSeq <= afterSeq) return false;
    afterSeq = lastSeq;
  }
}
