import { isDeepStrictEqual } from "node:util";
import { approvalSideEffectFingerprintV1, isApprovalResumeBasisV1,
  type RunSession, type RunStore, type RuntimeAttemptFenceV1 } from "@ling-stack/core";
import type { PiRunnerApprovalRequest } from "@ling-stack/runner-pi";
import { isRecord } from "../../shared/validation.js";
import { hostCapabilityApprovalPayload } from "./host-capability-action.js";
import { readPreparedRunnerInput } from "./prepared-runner-input.js";

type HostAuthorityStore = Pick<RunStore, "readSnapshot" | "getRun" | "isCurrentRunExecutionOwner"
  | "getApprovalRequest" | "getApprovalCheckpointForApproval">;
export interface HostCapabilityAuthorityOptions {
  readonly store: HostAuthorityStore;
  readonly run: RunSession;
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly sourceFence?: RuntimeAttemptFenceV1;
  readonly signal?: AbortSignal;
}
export interface HostCapabilityAuthorityRejection {
  readonly code: "host_capability_owner_invalid" | "host_capability_input_invalid" | "host_capability_prepared_input_invalid" | "host_capability_approval_invalid";
  readonly reason: string;
}

/**
 * Capture the dispatch identity once. A successful check is not a permission grant
 * or an execution receipt: executors must also check current policy, file identity
 * and cancellation immediately before effects. Never capture the latest Attempt.
 */
export function createHostCapabilityAuthority(options: HostCapabilityAuthorityOptions) {
  const source = { ...options.run, requestSnapshot: structuredClone(options.run.requestSnapshot) };
  const fence = options.sourceFence ? Object.freeze({ ...options.sourceFence }) : undefined;
  const reject = (code: HostCapabilityAuthorityRejection["code"], reason: string): HostCapabilityAuthorityRejection => ({ code, reason });
  return {
    /** Validate one consistent DB view before approval and again before execution. */
    check(request: PiRunnerApprovalRequest, approvalId?: string): HostCapabilityAuthorityRejection | undefined {
      return options.store.readSnapshot(() => {
        if (options.signal?.aborted || !fence || fence.workUnitId !== options.workUnitId || fence.attemptId !== options.attemptId
          || source.workUnitId !== fence.workUnitId || !options.store.isCurrentRunExecutionOwner(source.id, fence)) {
          return reject("host_capability_owner_invalid", "The captured Run/Attempt no longer owns this Host capability call.");
        }
        const run = options.store.getRun(source.id);
        if (!run || (["taskId", "cwd", "channelId", "threadId", "teammateId", "workflowStepId", "workUnitId"] as const)
          .some(key => run[key] !== source[key]) || request.cwd !== source.cwd || request.task.id !== source.taskId) {
          return reject("host_capability_owner_invalid", "Host capability task, workspace or conversation ownership does not match its source Run.");
        }
        let payload;
        try {
          payload = hostCapabilityApprovalPayload(request);
          if (!payload || !request.toolCallId.trim()) throw new Error("Missing Host call identity");
        } catch {
          return reject("host_capability_input_invalid", "Invalid Host capability input or tool call identity.");
        }
        try {
          const frozen = isRecord(source.requestSnapshot) ? source.requestSnapshot.runnerExecutionInput : undefined;
          const current = isRecord(run.requestSnapshot) ? run.requestSnapshot.runnerExecutionInput : undefined;
          if (!isDeepStrictEqual(frozen, current)) throw new Error("Prepared input changed");
          const prepared = readPreparedRunnerInput(current, request);
          const selected = prepared.input.hostCapabilityTools?.find(tool => tool.name === request.toolName);
          const modelTool = prepared.preparedInput.tools.find(tool => tool.name === request.toolName);
          if (!selected || selected.capabilityId !== payload.capabilityId || !modelTool
            || modelTool.description !== selected.description || !isDeepStrictEqual(modelTool.parameters, selected.inputSchema)) {
            throw new Error("Host capability was not selected in actual prepared model input");
          }
        } catch {
          return reject("host_capability_prepared_input_invalid", "Host capability is absent from, or inconsistent with, the source Run's prepared input.");
        }
        if (approvalId === undefined) return undefined;
        const approval = options.store.getApprovalRequest(approvalId);
        const checkpoint = options.store.getApprovalCheckpointForApproval(approvalId);
        const basis = checkpoint?.resumeBasis;
        const fingerprint = approvalSideEffectFingerprintV1({ actionType: "host_capability", toolCallId: request.toolCallId, sideEffect: payload });
        if (!approval || !checkpoint || approval.id !== approvalId || checkpoint.approvalId !== approvalId
          || approval.status !== "approved" || checkpoint.status !== "approved"
          || approval.runId !== source.id || checkpoint.runId !== source.id
          || approval.taskId !== source.taskId || checkpoint.taskId !== source.taskId
          || approval.channelId !== source.channelId || checkpoint.channelId !== source.channelId
          // A Run approval has one owner. Workflow lineage lives in its immutable resume basis.
          || approval.workflowStepId !== undefined || checkpoint.workflowStepId !== undefined
          || approval.toolCallId !== request.toolCallId || checkpoint.toolCallId !== request.toolCallId
          || approval.actionType !== "host_capability" || checkpoint.actionType !== "host_capability"
          || !isDeepStrictEqual(approval.payload, payload) || !isDeepStrictEqual(checkpoint.sideEffect, payload)
          || !isApprovalResumeBasisV1(basis) || basis.approvalId !== approvalId || basis.runId !== source.id
          || basis.workUnitId !== fence.workUnitId || basis.priorAttemptId !== fence.attemptId
          || basis.workflowStepId !== source.workflowStepId || basis.toolCallId !== request.toolCallId
          || basis.actionType !== "host_capability" || basis.sideEffectFingerprint !== fingerprint) {
          return reject("host_capability_approval_invalid", "The durable Host approval and checkpoint do not authorize this exact source call.");
        }
        return undefined;
      });
    },
  };
}

export type ReturnTypeOfHostCapabilityAuthority = ReturnType<typeof createHostCapabilityAuthority>;
