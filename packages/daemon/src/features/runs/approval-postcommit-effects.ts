import { randomUUID } from "node:crypto";
import { syncExternalWorkActionForApproval, type ApprovalRequest, type MediaJob, type RunStore } from "@ling-stack/core";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import {
  appendApprovalDecisionEvent,
  appendApprovalExpiredControlPlaneEvent,
  appendApprovalResolvedControlPlaneEvent,
} from "./approval-decision-projection.js";
import { hasApprovalDecisionEvent, verifyApprovalPostCommitEvidence } from "./approval-postcommit-evidence.js";

export { hasApprovalDecisionEvent } from "./approval-postcommit-evidence.js";

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
    if (!effect) {
      try {
        operation();
        return true;
      } catch {
        deferred = true;
        return false;
      }
    }
    const token = randomUUID();
    const claimBase = Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now();
    const effectNow = new Date(claimBase).toISOString();
    let claim;
    try {
      claim = store.claimApprovalPostCommitEffect(approval.id, kind, {
        token, claimExpiresAt: new Date(claimBase + 60_000).toISOString(),
      }, effectNow);
    } catch {
      deferred = true;
      return false;
    }
    if (!claim) { deferred = true; return false; }
    if (kind !== "owner" && effect.attempts >= 5) {
      try {
        store.settleApprovalPostCommitEffect(approval.id, kind, {
          token, status: "blocked", errorCode: "approval_effect_retry_exhausted",
        }, effectNow);
      } catch { /* The claim remains durable for inspection. */ }
      deferred = true;
      return false;
    }
    if (kind === "owner" && approval.payload.type === "workflow_step") {
      const existingEvidence = verifyApprovalPostCommitEvidence(store, approval, kind);
      if (existingEvidence.status === "applied") {
        try {
          if (!store.settleApprovalPostCommitEffect(approval.id, kind, { token, status: "completed" }, effectNow)) {
            deferred = true;
            return false;
          }
          return true;
        } catch {
          deferred = true;
          return false;
        }
      }
      if (existingEvidence.status === "blocked" || existingEvidence.status === "effect_unknown") {
        try {
          store.settleApprovalPostCommitEffect(approval.id, kind, {
            token,
            status: existingEvidence.status,
            errorCode: existingEvidence.code,
          }, effectNow);
        } catch {
          // The claim remains durable for expiry recovery.
        }
        deferred = true;
        return false;
      }
    }
    let operationFailed = false;
    try {
      operation();
    } catch {
      operationFailed = true;
    }

    const evidence = kind === "control_plane_event"
      ? operationFailed
        ? { status: "pending" as const, code: "approval_control_plane_event_failed" }
        : { status: "applied" as const, code: "approval_control_plane_event_applied" }
      : verifyApprovalPostCommitEvidence(store, approval, kind);
    if (evidence.status === "applied") {
      try {
        if (!store.settleApprovalPostCommitEffect(approval.id, kind, { token, status: "completed" }, effectNow)) {
          deferred = true;
          return false;
        }
        return true;
      } catch {
        deferred = true;
        return false;
      }
    }

    try {
      store.settleApprovalPostCommitEffect(approval.id, kind, {
        token,
        status: evidence.status === "effect_unknown" ? "effect_unknown"
          : evidence.status === "blocked" ? "blocked" : "pending",
        errorCode: operationFailed && evidence.status === "pending"
          ? "approval_effect_callback_failed" : evidence.code,
      }, effectNow);
    } catch {
      // The claim remains durable until expiry recovery can re-read facts.
    }
    deferred = true;
    return false;
  };
  const eventRecorded = attempt("decision_event", () => {
    if (!hasApprovalDecisionEvent(store, approval)) appendApprovalDecisionEvent(store, approval);
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
