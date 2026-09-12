import {
  approvalSideEffectFingerprintV1,
  toRuntimeAttemptFence,
  type ApprovalRequest,
  type EffectiveRunPolicySnapshot,
  type RunSession,
  type RunStore,
  type RuntimeAttemptFenceV1,
} from "@ling-stack/core";
import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import type { RunnerAdapter } from "../../context.js";
import { DEFAULT_RUNNER_ID } from "../../runtime/runners.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import {
  startRuntimeWorkUnit,
  startQueuedRuntimeWorkUnit,
  retryRuntimeWorkUnit,
  transitionWorkUnitCancelled,
  transitionWorkUnitTerminal,
} from "../../runtime/work-units.js";
import {
  approvalAutoReviewCoordinator,
  type ApprovalAutoReviewCoordinator,
  type ApprovalAutoReviewOutcome,
} from "./approval-auto-review-coordinator.js";
import { buildApprovalAutoReviewEvidence } from "./approval-auto-review-evidence.js";
import { executeApprovalAutoReviewModel } from "./approval-auto-review-executor.js";

export type ApprovalAutoReviewHostOutcome =
  | {
      readonly status: "resolved";
      readonly approval: ApprovalRequest;
      readonly workUnitId: string;
      readonly attempts: number;
    }
  | {
      readonly status: "manual";
      readonly code: string;
      readonly reason: string;
      readonly workUnitId?: string;
      readonly attempts: number;
    };

export interface ReviewPendingApprovalAutomaticallyInput {
  readonly store: RunStore;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly runner: RunnerAdapter;
  readonly provider: PiRunnerProviderConfig;
  readonly providerPresetId?: string;
  readonly run: RunSession;
  readonly approval: ApprovalRequest;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly effectivePolicySnapshot: EffectiveRunPolicySnapshot;
  readonly signal?: AbortSignal;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly coordinator?: ApprovalAutoReviewCoordinator;
  readonly sourceAuthority?: "active_execution" | "recoverable_suspension";
}

const MAX_APPROVAL_REVIEW_WORK_UNIT_ATTEMPTS = 2;

/**
 * Owns one durable approval-review WorkUnit from evidence capture through the
 * fenced Store verdict. Parsed model output becomes authority only after CAS.
 */
export async function reviewPendingApprovalAutomatically(
  input: ReviewPendingApprovalAutomaticallyInput,
): Promise<ApprovalAutoReviewHostOutcome> {
  const evidence = buildApprovalAutoReviewEvidence({
    store: input.store,
    run: input.run,
    approval: input.approval,
    sourceFence: input.sourceFence,
    effectivePolicySnapshot: input.effectivePolicySnapshot,
    extraSecrets: input.extraSecrets,
    sourceAuthority: input.sourceAuthority,
  });
  if (!evidence.ok) {
    return {
      status: "manual",
      code: evidence.code,
      reason: evidence.reason,
      attempts: 0,
    };
  }

  const actionFingerprint = approvalSideEffectFingerprintV1({
    actionType: input.approval.actionType,
    toolCallId: evidence.snapshot.action.toolCallId,
    sideEffect: input.approval.payload,
  });
  const reviewRequest = {
    schemaVersion: 1,
    approvalId: input.approval.id,
    approvalCreatedAt: input.approval.createdAt,
    runId: input.run.id,
    sourceWorkUnitId: input.sourceFence.workUnitId,
    sourceAttemptId: input.sourceFence.attemptId,
    policyUpdatedAt: input.effectivePolicySnapshot.workspacePolicyUpdatedAt,
    evidenceFingerprint: evidence.fingerprint,
    actionFingerprint,
  } as const;
  const reviewUnitStart = beginApprovalReviewWorkUnit(input, evidence.fingerprint, reviewRequest);
  if (!reviewUnitStart.ok) {
    return reviewUnitStart.outcome;
  }
  const reviewUnit = reviewUnitStart.reviewUnit;
  const coordinator = input.coordinator ?? approvalAutoReviewCoordinator;
  const outcome = await coordinator.review({
    signal: input.signal,
    execute: (signal) => executeApprovalAutoReviewModel({
      runner: input.runner,
      provider: input.provider,
      cwd: input.run.cwd,
      approvalId: input.approval.id,
      evidenceFingerprint: evidence.fingerprint,
      serializedEvidence: evidence.serialized,
      signal,
    }),
  });

  if (outcome.status === "resolved") {
    const resolved = input.store.resolveApprovalBySystemReviewer({
      approvalId: input.approval.id,
      approvalCreatedAt: input.approval.createdAt,
      runId: input.run.id,
      toolCallId: evidence.snapshot.action.toolCallId,
      sideEffectFingerprint: actionFingerprint,
      workspacePolicyUpdatedAt: input.effectivePolicySnapshot.workspacePolicyUpdatedAt,
      sourceFence: input.sourceFence,
      sourceAuthority: input.sourceAuthority,
      decision: outcome.verdict.decision,
      reason: outcome.verdict.reason,
    }, new Date().toISOString());
    if (!resolved.ok) {
      appendReviewProgress(input.store, reviewUnit, {
        phase: "manual_fallback",
        code: resolved.code,
        attempts: outcome.attempts,
      });
      failReviewWorkUnit(input.store, reviewUnit, "review_resolution_stale", resolved.code);
      return {
        status: "manual",
        code: resolved.code,
        reason: "Automatic review lost its approval, policy, action, or execution fence; manual approval is required.",
        workUnitId: reviewUnit.workUnit.id,
        attempts: outcome.attempts,
      };
    }
    appendReviewProgress(input.store, reviewUnit, {
      phase: "resolved",
      decision: outcome.verdict.decision,
      attempts: outcome.attempts,
    });
    succeedReviewWorkUnit(input.store, reviewUnit);
    return {
      status: "resolved",
      approval: resolved.approval,
      workUnitId: reviewUnit.workUnit.id,
      attempts: outcome.attempts,
    };
  }

  appendReviewProgress(input.store, reviewUnit, {
    phase: "manual_fallback",
    code: outcome.code,
    attempts: outcome.attempts,
  });
  settleManualReviewWorkUnit(input.store, reviewUnit, outcome);
  return {
    ...outcome,
    workUnitId: reviewUnit.workUnit.id,
  };
}

function beginApprovalReviewWorkUnit(
  input: ReviewPendingApprovalAutomaticallyInput,
  evidenceFingerprint: string,
  request: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly reviewUnit: ReturnType<typeof startRuntimeWorkUnit> }
  | { readonly ok: false; readonly outcome: Extract<ApprovalAutoReviewHostOutcome, { readonly status: "manual" }> } {
  const idempotencyKey = `approval_review:${input.approval.id}:${evidenceFingerprint}`;
  const existing = input.store.findWorkUnitByIdempotency({
    kind: "approval_review",
    ownerType: "approval",
    ownerId: input.approval.id,
    idempotencyKey,
  });
  if (!existing) {
    return {
      ok: true,
      reviewUnit: startRuntimeWorkUnit({
        store: input.store,
        runtimeSupervisor: input.runtimeSupervisor,
        kind: "approval_review",
        ownerType: "approval",
        ownerId: input.approval.id,
        channelId: input.run.channelId,
        teammateId: input.run.teammateId,
        providerPresetId: input.providerPresetId,
        requestedRunnerId: DEFAULT_RUNNER_ID,
        effectiveRunnerId: DEFAULT_RUNNER_ID,
        idempotencyKey,
        request,
      }),
    };
  }
  if (!matchesReviewRequest(existing.request, request)) {
    return manualStartOutcome("review_identity_changed", "A prior automatic review has conflicting durable identity.", existing.id, existing.attemptCount);
  }
  const settledManual = readSettledManualOutcome(input.store, existing.id);
  if (existing.status === "succeeded" && settledManual) {
    return { ok: false, outcome: { ...settledManual, workUnitId: existing.id } };
  }
  if (input.sourceAuthority !== "recoverable_suspension") {
    return manualStartOutcome("review_already_exists", "Automatic review is already recorded for this evidence.", existing.id, existing.attemptCount);
  }
  if (existing.attemptCount >= MAX_APPROVAL_REVIEW_WORK_UNIT_ATTEMPTS) {
    return manualStartOutcome("recovery_limit", "Automatic review restart limit was reached; manual approval is required.", existing.id, existing.attemptCount);
  }
  if (existing.status === "queued") {
    const restarted = startQueuedRuntimeWorkUnit({
      store: input.store,
      runtimeSupervisor: input.runtimeSupervisor,
      workUnit: existing,
      providerPresetId: input.providerPresetId,
      requestedRunnerId: DEFAULT_RUNNER_ID,
      effectiveRunnerId: DEFAULT_RUNNER_ID,
      startedData: { reason: "approval-review-daemon-recovery", recovered: true },
    });
    if (!restarted) {
      return manualStartOutcome("review_retry_stale", "Automatic review recovery lost its queued WorkUnit claim.", existing.id, existing.attemptCount);
    }
    return { ok: true, reviewUnit: restarted };
  }
  if (existing.status !== "stale" && existing.status !== "cancelled") {
    return manualStartOutcome("review_not_recoverable", "The prior automatic review is not safely recoverable.", existing.id, existing.attemptCount);
  }
  const retried = retryRuntimeWorkUnit({
    store: input.store,
    runtimeSupervisor: input.runtimeSupervisor,
    workUnit: existing,
    reason: "approval-review-daemon-recovery",
    providerPresetId: input.providerPresetId,
    requestedRunnerId: DEFAULT_RUNNER_ID,
    effectiveRunnerId: DEFAULT_RUNNER_ID,
  });
  if (!retried) {
    return manualStartOutcome("review_retry_stale", "Automatic review recovery lost its WorkUnit claim.", existing.id, existing.attemptCount);
  }
  return { ok: true, reviewUnit: retried };
}

function readSettledManualOutcome(
  store: RunStore,
  workUnitId: string,
): Extract<ApprovalAutoReviewHostOutcome, { readonly status: "manual" }> | undefined {
  const event = [...store.listRuntimeEvents(workUnitId, { limit: 1000 })].reverse().find((candidate) => {
    if (candidate.type !== "work_unit_progress" || !isRecord(candidate.data)) return false;
    return candidate.data.phase === "manual_fallback" && candidate.data.code === "reviewer_manual";
  });
  if (!event || !isRecord(event.data)) return undefined;
  return {
    status: "manual",
    code: "reviewer_manual",
    reason: "Automatic reviewer previously requested a human decision.",
    attempts: readNonNegativeInteger(event.data.attempts),
  };
}

function matchesReviewRequest(actual: unknown, expected: Readonly<Record<string, unknown>>): boolean {
  if (!isRecord(actual)) return false;
  return [
    "schemaVersion",
    "approvalId",
    "approvalCreatedAt",
    "runId",
    "sourceWorkUnitId",
    "sourceAttemptId",
    "policyUpdatedAt",
    "evidenceFingerprint",
    "actionFingerprint",
  ].every((key) => actual[key] === expected[key]);
}

function manualStartOutcome(
  code: string,
  reason: string,
  workUnitId: string,
  attempts: number,
): { readonly ok: false; readonly outcome: Extract<ApprovalAutoReviewHostOutcome, { readonly status: "manual" }> } {
  return { ok: false, outcome: { status: "manual", code, reason, workUnitId, attempts } };
}

function readNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendReviewProgress(
  store: RunStore,
  reviewUnit: ReturnType<typeof startRuntimeWorkUnit>,
  data: Readonly<Record<string, unknown>>,
): void {
  store.appendRuntimeEvent({
    ...toRuntimeAttemptFence(reviewUnit.attempt),
    type: "work_unit_progress",
    actor: "system",
    ts: new Date().toISOString(),
    data,
  });
}

function settleManualReviewWorkUnit(
  store: RunStore,
  reviewUnit: ReturnType<typeof startRuntimeWorkUnit>,
  outcome: Extract<ApprovalAutoReviewOutcome, { readonly status: "manual" }>,
): void {
  if (outcome.code === "cancelled") {
    transitionWorkUnitCancelled(store, reviewUnit.workUnit.id, reviewUnit.attempt.id, "automatic_review_cancelled");
    return;
  }
  if (outcome.code === "reviewer_manual") {
    succeedReviewWorkUnit(store, reviewUnit);
    return;
  }
  failReviewWorkUnit(store, reviewUnit, `automatic_review_${outcome.code}`, outcome.reason);
}

function succeedReviewWorkUnit(
  store: RunStore,
  reviewUnit: ReturnType<typeof startRuntimeWorkUnit>,
): void {
  transitionWorkUnitTerminal(store, {
    workUnitId: reviewUnit.workUnit.id,
    attemptId: reviewUnit.attempt.id,
    event: "runner_succeeded",
    attemptStatus: "succeeded",
    runtimeEventType: "work_unit_succeeded",
    actor: "system",
    now: new Date().toISOString(),
  });
}

function failReviewWorkUnit(
  store: RunStore,
  reviewUnit: ReturnType<typeof startRuntimeWorkUnit>,
  errorCode: string,
  errorMessage: string,
): void {
  transitionWorkUnitTerminal(store, {
    workUnitId: reviewUnit.workUnit.id,
    attemptId: reviewUnit.attempt.id,
    event: "runner_failed",
    attemptStatus: "failed",
    runtimeEventType: "work_unit_failed",
    actor: "system",
    now: new Date().toISOString(),
    errorCode,
    errorMessage,
  });
}
