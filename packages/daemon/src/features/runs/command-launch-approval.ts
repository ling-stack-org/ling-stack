import { isDeepStrictEqual } from "node:util";
import { approvalSideEffectFingerprintV1, isApprovalResumeBasisV1, buildChannelTeamRiskReviewDecision, redactSecrets,
  type EffectiveRunPolicySnapshot, type RunSession, type RunStore, type RuntimeAttemptFenceV1, type SkillApprovalProfile } from "@ling-stack/core";
import type { PiRunnerApprovalRequest } from "@ling-stack/runner-pi";
import { isRecord } from "../../shared/validation.js";
import { findMatchingApprovalCommandRulesForCommand } from "./approval-command-rules.js";
import { classifyBashActionType, classifyBashRiskFlags } from "./action-classifier.js";

/** Read within the caller's SQLite launch snapshot. A matching rule or approved text is not resume authority. */
export function assertCommandLaunchApproval(input: {
  readonly store: RunStore;
  readonly source: RunSession;
  readonly fence: RuntimeAttemptFenceV1;
  readonly request: PiRunnerApprovalRequest;
  readonly policy: EffectiveRunPolicySnapshot;
  readonly approvalProfile?: SkillApprovalProfile;
  readonly approvalId?: string;
  readonly delegatedRequirementFingerprint?: string;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly codePrefix: string;
}): void {
  const { store, source, fence, request, policy } = input;
  const requireApproval = (value: unknown, code: string): void => {
    if (!value) throw new Error(input.codePrefix + "_" + code);
  };
  const snapshot = isRecord(source.requestSnapshot) ? source.requestSnapshot : {};
  const command = isRecord(request.input) && typeof request.input.command === "string" ? request.input.command : "";
  const actionType = classifyBashActionType(command);
  const riskFlags = classifyBashRiskFlags(command);
  const risk = riskFlags.includes("git_force_push") ? "critical" : riskFlags.length ? "high" : "medium";
  const payload = { type: "bash" as const, cwd: request.cwd, command, riskFlags };
  const publishedPayload = redactSecrets(payload, input.extraSecrets ?? []) as typeof payload;
  const review = buildChannelTeamRiskReviewDecision({ actionType, risk, payload });
  requireApproval(review.status !== "blocked", "risk_denied");
  if (input.approvalId === undefined) {
    const profile = input.approvalProfile ?? (isRecord(snapshot.approvalProfile) ? snapshot.approvalProfile : undefined);
    const unforced = !profile || profile.mode === "none" || profile.mode !== "strict"
      && !(Array.isArray(profile?.requiredForTools) && profile.requiredForTools.includes("bash"))
      && !(Array.isArray(profile?.requiredForActions) && profile.requiredForActions.includes(actionType));
    if (unforced && policy.toolDecisions.bash === "allow" && review.status === "not_required") return;
    requireApproval(unforced && review.status === "not_required" && findMatchingApprovalCommandRulesForCommand(store, command, request.cwd), "approval_required");
    return;
  }
  const approval = store.getApprovalRequest(input.approvalId);
  const checkpoint = store.getApprovalCheckpointForApproval(input.approvalId);
  const basis = checkpoint?.resumeBasis;
  requireApproval(approval?.status === "approved" && checkpoint
    && approval.runId === source.id && checkpoint.runId === source.id
    && approval.taskId === source.taskId && checkpoint.taskId === source.taskId
    && approval.channelId === source.channelId && checkpoint.channelId === source.channelId
    && approval.workflowStepId === undefined && checkpoint.workflowStepId === undefined
    && approval.toolCallId === request.toolCallId && checkpoint.toolCallId === request.toolCallId
    && approval.actionType === actionType && checkpoint.actionType === actionType
    && approval.payload.type === "bash" && approval.payload.cwd === publishedPayload.cwd && approval.payload.command === publishedPayload.command
    && isDeepStrictEqual(checkpoint.sideEffect, approval.payload)
    && isApprovalResumeBasisV1(basis) && basis.approvalId === approval.id && basis.runId === source.id
    && basis.workUnitId === fence.workUnitId && basis.workflowStepId === source.workflowStepId
    && basis.delegatedRequirementFingerprint === input.delegatedRequirementFingerprint
    && basis.toolCallId === request.toolCallId && basis.actionType === actionType
    && basis.sideEffectFingerprint === approvalSideEffectFingerprintV1({ actionType, toolCallId: request.toolCallId, sideEffect: approval.payload }),
    "approval_invalid");
  // Narrow only after the entire structured lineage above has passed.
  if (!approval || !checkpoint || !isApprovalResumeBasisV1(basis)) throw new Error(input.codePrefix + "_approval_invalid");
  const direct = checkpoint.status === "approved" && basis.priorAttemptId === fence.attemptId;
  const handle = checkpoint.runnerResumeHandle;
  const resumed = checkpoint.status === "resume_pending" && handle?.kind === "ling_continuation"
    && handle.runId === source.id && handle.attemptId === fence.attemptId
    && isRecord(handle.payload) && handle.payload.approvalId === approval.id
    && handle.payload.resumeBasisFingerprint === basis.fingerprint;
  requireApproval(direct || resumed, "approval_lineage_invalid");
}
