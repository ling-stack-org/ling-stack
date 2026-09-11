import { isDeepStrictEqual } from "node:util";
import {
  approvalSideEffectFingerprintV1, isApprovalResumeBasisV1, buildChannelTeamRiskReviewDecision, redactSecrets,
  type EffectiveRunPolicySnapshot, type RunSession, type RunStore, type RuntimeAttemptFenceV1,
} from "@ling-stack/core";
import type { PiRunnerApprovalRequest } from "@ling-stack/runner-pi";
import { isRecord } from "../../shared/validation.js";
import { isNativeRestrictedCommandRuntime, type NativeRestrictedCommandRuntime } from "../../runtime/sandbox/restricted-command-runtime.js";
import { validateWorkflowOperationRunContext } from "./workflow-operation-snapshot.js";
import { workflowOperationAuthorityRejection } from "./workflow-operation-effect-gate.js";
import { findMatchingApprovalCommandRulesForCommand } from "./approval-command-rules.js";
import { classifyBashRiskFlags } from "./action-classifier.js";

function requireAuthority(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}

/** Captures a typed command's immutable inputs. Revalidates actual SQLite facts at every
 * asynchronous boundary and within the journal's atomic launch callback. Never a grant.
 */
export function createRestrictedCommandDispatch(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly request: PiRunnerApprovalRequest;
  readonly approvalId?: string;
  readonly restrictedCommandRuntime?: NativeRestrictedCommandRuntime;
  readonly signal?: AbortSignal;
  readonly extraSecrets?: readonly (string | undefined)[];
}) {
  const source = structuredClone(input.run), request = structuredClone(input.request);
  const fence = Object.freeze({ ...input.sourceFence });
  const context = validateWorkflowOperationRunContext({ store: input.store, run: source });
  if (context.status === "legacy") return undefined;
  requireAuthority(context.status === "ready", context.status === "blocked" ? context.code : "operation_binding_snapshot_invalid");
  const runtime = input.restrictedCommandRuntime;
  requireAuthority(isNativeRestrictedCommandRuntime(runtime), "operation_binding_isolation_unavailable");
  const snapshot = isRecord(source.requestSnapshot) ? source.requestSnapshot : {};
  const value = snapshot.effectivePolicySnapshot;
  requireAuthority(isRecord(value) && isRecord(value.toolDecisions) && Array.isArray(value.allowedWritePaths),
    "restricted_command_policy_missing");
  // The sandbox compiler validates the full shape before any process is created.
  const policy = structuredClone(value) as unknown as EffectiveRunPolicySnapshot;
  const command = isRecord(request.input) && typeof request.input.command === "string" ? request.input.command : "";
  const operations = context.ownedOperations.filter(operation => operation.kind === "run_command"
    && operation.binding?.effectScope.exactCommands.includes(command));
  requireAuthority(operations.length === 1, "operation_binding_command_out_of_scope");
  const operation = operations[0]!;
  const workspacePolicy = input.store.getApprovalPolicy();
  const check = () => {
    input.signal?.throwIfAborted();
    const read = () => {
      requireAuthority(input.store.isCurrentRunExecutionOwner(source.id, fence)
        && source.workUnitId === fence.workUnitId, "stale_run_execution");
      const current = input.store.getRun(source.id);
      requireAuthority(current?.status === "running" && request.task.id === source.taskId
        && (["cwd", "taskId", "workUnitId", "channelId", "threadId", "teammateId", "workflowStepId"] as const)
          .every(key => current[key] === source[key])
        && isDeepStrictEqual(current.requestSnapshot, source.requestSnapshot), "restricted_command_source_changed");
      const rejection = workflowOperationAuthorityRejection({ store: input.store, run: source, request, restrictedCommandRuntime: runtime });
      requireAuthority(!rejection, rejection?.code ?? "restricted_command_authority_invalid");
      const currentPolicy = input.store.getApprovalPolicy();
      requireAuthority(isDeepStrictEqual(currentPolicy, workspacePolicy)
        && currentPolicy.updatedAt === policy.workspacePolicyUpdatedAt
        && currentPolicy.toolDecisions.bash !== "deny" && policy.toolDecisions.bash !== "deny",
        "restricted_command_policy_changed");
      const riskFlags = classifyBashRiskFlags(command);
      const risk = riskFlags.includes("git_force_push") ? "critical" : riskFlags.length ? "high" : "medium";
      const payload = { type: "bash" as const, cwd: request.cwd, command, riskFlags };
      const publishedPayload = redactSecrets(payload, input.extraSecrets ?? []) as typeof payload;
      const review = buildChannelTeamRiskReviewDecision({ actionType: "bash", risk, payload });
      requireAuthority(review.status !== "blocked", "restricted_command_risk_denied");
      if (input.approvalId === undefined) {
        if (policy.toolDecisions.bash === "allow" && review.status === "not_required") return;
        const profile = isRecord(snapshot.approvalProfile) ? snapshot.approvalProfile : undefined;
        requireAuthority(review.status === "not_required" && profile?.mode !== "strict"
          && !(Array.isArray(profile?.requiredForTools) && profile.requiredForTools.includes("bash"))
          && !(Array.isArray(profile?.requiredForActions) && profile.requiredForActions.includes("bash"))
          && findMatchingApprovalCommandRulesForCommand(input.store, command), "restricted_command_approval_required");
        return;
      }
      const approval = input.store.getApprovalRequest(input.approvalId);
      const checkpoint = input.store.getApprovalCheckpointForApproval(input.approvalId);
      const basis = checkpoint?.resumeBasis;
      requireAuthority(approval?.status === "approved" && checkpoint
        && approval.runId === source.id && checkpoint.runId === source.id
        && approval.taskId === source.taskId && checkpoint.taskId === source.taskId
        && approval.channelId === source.channelId && checkpoint.channelId === source.channelId
        && approval.workflowStepId === undefined && checkpoint.workflowStepId === undefined
        && approval.toolCallId === request.toolCallId && checkpoint.toolCallId === request.toolCallId
        && approval.actionType === "bash" && checkpoint.actionType === "bash"
        && approval.payload.type === "bash" && approval.payload.cwd === publishedPayload.cwd && approval.payload.command === publishedPayload.command
        && isDeepStrictEqual(checkpoint.sideEffect, approval.payload)
        && isApprovalResumeBasisV1(basis) && basis.approvalId === approval.id && basis.runId === source.id
        && basis.workUnitId === fence.workUnitId && basis.workflowStepId === source.workflowStepId
        && basis.delegatedRequirementFingerprint === context.step.metadata?.delegatedRequirement?.fingerprint
        && basis.toolCallId === request.toolCallId && basis.actionType === "bash"
        && basis.sideEffectFingerprint === approvalSideEffectFingerprintV1({ actionType: "bash", toolCallId: request.toolCallId, sideEffect: approval.payload }),
        "restricted_command_approval_invalid");
      const direct = checkpoint.status === "approved" && basis.priorAttemptId === fence.attemptId;
      const handle = checkpoint.runnerResumeHandle;
      const resumed = checkpoint.status === "resume_pending" && handle?.kind === "ling_continuation"
        && handle.runId === source.id && handle.attemptId === fence.attemptId
        && isRecord(handle.payload) && handle.payload.approvalId === approval.id
        && handle.payload.resumeBasisFingerprint === basis.fingerprint;
      requireAuthority(direct || resumed, "restricted_command_approval_lineage_invalid");
    };
    input.store.readSnapshot(read);
  };
  check();
  return {
    prepare: async () => {
      const prepared = await runtime.prepare({ command, cwd: source.cwd, inputRefs: operation.binding!.inputRefs, policy,
      source: { ...fence, workspaceId: workspacePolicy.workspaceId, runId: source.id, toolCallId: request.toolCallId },
      assertCurrentAuthority: check, signal: input.signal });
      return prepared;
    },
  };
}
