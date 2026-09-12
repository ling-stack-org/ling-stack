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
  const reviewUnit = startRuntimeWorkUnit({
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
    idempotencyKey: `approval_review:${input.approval.id}:${evidence.fingerprint}`,
    request: {
      schemaVersion: 1,
      approvalId: input.approval.id,
      approvalCreatedAt: input.approval.createdAt,
      runId: input.run.id,
      sourceWorkUnitId: input.sourceFence.workUnitId,
      sourceAttemptId: input.sourceFence.attemptId,
      policyUpdatedAt: input.effectivePolicySnapshot.workspacePolicyUpdatedAt,
      evidenceFingerprint: evidence.fingerprint,
      actionFingerprint,
    },
  });
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
