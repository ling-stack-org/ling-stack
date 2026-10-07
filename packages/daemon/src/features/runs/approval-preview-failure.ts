import {
  approvalSideEffectFingerprintV1,
  type ApprovalRequest,
  type EffectiveRunPolicySnapshot,
  type RunArtifact,
  type RunSession,
  type RunStore,
  type RuntimeAttemptFenceV1,
} from "@ling-stack/core";
import type { PiRunnerApprovalRequest } from "@ling-stack/runner-pi";
import { createExecutionActionPreviewArtifacts } from "./action-artifacts.js";
import {
  prepareHarnessToolApproval,
  resolveHarnessToolApproval,
  type HarnessToolContext,
} from "../harness/tool-execution/broker.js";
import { createFileMutationRecoveryBasis, type FileMutationActionDraft } from "../harness/tool-execution/executors/file-mutation.js";

interface ApprovalPreviewContext {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly sourceFence?: RuntimeAttemptFenceV1;
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly request: PiRunnerApprovalRequest;
  readonly approval: ApprovalRequest;
  readonly mode: HarnessToolContext["mode"];
  readonly unifiedExecBash: boolean;
  readonly fileMutationDraft?: FileMutationActionDraft;
  readonly effectivePolicySnapshot?: EffectiveRunPolicySnapshot;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly now: string;
  readonly decision: "ask" | "deny";
  readonly decisionReason?: string;
  readonly onApprovalResolved?: (approval: ApprovalRequest) => void;
  readonly onApprovalWaitAbandoned?: () => void;
  readonly publishDecision: (approval: ApprovalRequest) => void;
}

/** Each serialized callback owns one local pause; no other callback may release it. */
export function createCallbackApprovalWait(callbacks: {
  readonly onApprovalWaitStarted?: () => void;
  readonly onApprovalResolved?: (approval: ApprovalRequest) => void;
  readonly onApprovalWaitAbandoned?: () => void;
}) {
  let owned = false;
  return {
    start(): void { if (owned) return; owned = true; callbacks.onApprovalWaitStarted?.(); },
    resolve(approval: ApprovalRequest): void {
      if (!owned) return;
      callbacks.onApprovalResolved?.(approval);
      owned = false;
    },
    abandon(): void { if (!owned) return; owned = false; callbacks.onApprovalWaitAbandoned?.(); },
  };
}

/**
 * Preview generation is not execution permission. On failure, close only this
 * captured execution's pending request; never convert a front-door refusal into
 * a ready/unavailable preview or overwrite a concurrent approval decision.
 */
export function createOwnedApprovalPreviewArtifacts(input: ApprovalPreviewContext): readonly RunArtifact[] {
  try {
    return createExecutionActionPreviewArtifacts({ store: input.store, run: input.run, approval: input.approval,
      toolName: input.request.toolName, toolArgs: input.request.input, now: input.now, extraSecrets: input.extraSecrets });
  } catch (previewError) {
    const cleanupErrors: unknown[] = [];
    let resolved: ApprovalRequest | undefined;
    try {
      assertOriginalApprovalOwner(input);
      const current = input.store.getApprovalRequest(input.approval.id);
      if (current?.status !== "pending") throw new Error("approval_preview_cleanup_decision_conflict");
      const resolve = input.decision === "deny" ? input.store.denyApprovalRequest : input.store.cancelApprovalRequest;
      resolved = resolve.call(input.store, input.approval.id, {
        reason: input.decision === "deny" ? input.decisionReason : "Approval preview failed before execution.",
        executionCleanup: { runId: input.run.id, toolCallId: input.request.toolCallId,
          approvalCreatedAt: input.approval.createdAt, sourceFence: input.sourceFence! },
      }, new Date().toISOString());
      if (!resolved) throw new Error("approval_preview_cleanup_request_missing");
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }

    if (resolved) {
      // Keep evidence publication independent of harness reconciliation: a
      // durable cancelled/denied decision remains true if the latter fails.
      try { reconcileHarness(input, resolved); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
      try { input.publishDecision(resolved); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (input.decision === "ask") releaseLocalApprovalWait(input, cleanupErrors);
    if (cleanupErrors.length > 0) {
      // Preserve the original refusal as first error and cause. A cleanup
      // failure must not mask it, nor disappear behind a fabricated success.
      throw new AggregateError([previewError, ...cleanupErrors], previewError instanceof Error ? previewError.message : String(previewError),
        { cause: previewError });
    }
    throw previewError;
  }
}

function assertOriginalApprovalOwner(input: ApprovalPreviewContext): void {
  if (!input.sourceFence || input.sourceFence.workUnitId !== input.workUnitId || input.sourceFence.attemptId !== input.attemptId
    || !input.store.isCurrentRunExecutionOwner(input.run.id, input.sourceFence, false)) {
    throw new Error("approval_preview_cleanup_execution_stale");
  }
  if (!hasOriginalApprovalIdentity(input, input.store.getApprovalRequest(input.approval.id))) {
    throw new Error("approval_preview_cleanup_identity_changed");
  }
  const basis = input.store.getApprovalCheckpointForApproval(input.approval.id)?.resumeBasis;
  if (!basis || basis.approvalId !== input.approval.id || basis.runId !== input.run.id || basis.workUnitId !== input.workUnitId
    || basis.priorAttemptId !== input.attemptId || basis.toolCallId !== input.request.toolCallId
    || basis.actionType !== input.approval.actionType || basis.sideEffectFingerprint !== fingerprint(input.approval)) {
    throw new Error("approval_preview_cleanup_resume_basis_changed");
  }
}

function hasOriginalApprovalIdentity(input: ApprovalPreviewContext, approval: ApprovalRequest | undefined): approval is ApprovalRequest {
  return approval?.id === input.approval.id && approval.runId === input.run.id && approval.toolCallId === input.request.toolCallId
    && approval.createdAt === input.approval.createdAt && approval.actionType === input.approval.actionType
    && fingerprint(approval) === fingerprint(input.approval);
}

function fingerprint(approval: ApprovalRequest): string {
  return approvalSideEffectFingerprintV1({ actionType: approval.actionType, toolCallId: approval.toolCallId!, sideEffect: approval.payload });
}

function reconcileHarness(input: ApprovalPreviewContext, approval: ApprovalRequest): void {
  if (!input.sourceFence || (!input.unifiedExecBash && !input.fileMutationDraft)) return;
  const context: HarnessToolContext = {
    mode: input.mode, store: input.store, run: input.run, sourceFence: input.sourceFence, request: input.request,
    approvalId: approval.id, effectivePolicySnapshot: input.effectivePolicySnapshot,
    executorKind: input.unifiedExecBash ? "bash" : input.fileMutationDraft!.executorKind,
    ...(input.fileMutationDraft ? { recoveryBasis: createFileMutationRecoveryBasis(input.fileMutationDraft) } : {}),
  };
  if (input.decision === "deny") {
    prepareHarnessToolApproval({ ...context, approvalState: "denied", failureCode: "tool.policy_denied",
      resultSummary: { reason: approval.decisionReason ?? input.decisionReason } });
  } else {
    resolveHarnessToolApproval({ ...context, nextState: "cancelled", failureCode: "tool.execution_cancelled",
      resultSummary: { reason: approval.decisionReason } });
  }
}

/** Release only the callback-owned local pause, never infer a durable verdict. */
function releaseLocalApprovalWait(input: ApprovalPreviewContext, cleanupErrors: unknown[]): void {
  let abandoned = false;
  const abandon = () => { if (abandoned) return; abandoned = true; input.onApprovalWaitAbandoned?.(); };
  try {
    const latest = input.store.getApprovalRequest(input.approval.id);
    if (input.sourceFence && input.store.isCurrentRunExecutionOwner(input.run.id, input.sourceFence, false)
      && hasOriginalApprovalIdentity(input, latest) && latest.status !== "pending") {
      input.onApprovalResolved?.(latest);
    } else {
      abandon();
    }
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
    try { abandon(); } catch (releaseError) { cleanupErrors.push(releaseError); }
  }
}
