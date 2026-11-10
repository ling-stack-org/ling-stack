import { isDeepStrictEqual } from "node:util";
import { isHostOpenLocalTargetReceiptV1, readHostCapabilityCallV1, type HostOpenLocalTargetReceiptV1 } from "@ling-stack/contracts";
import { approvalSideEffectFingerprintV1, isApprovalResumeBasisV1, type RunEventEnvelope, type RunSession, type RunStore } from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";

export type HostOpenEvidenceStore = Pick<RunStore, "getApprovalRequest">
  & Partial<Pick<RunStore, "readSnapshot" | "getApprovalCheckpointForApproval">>;

/**
 * Fold only an accepted start/end pair and its original durable Host approval.
 * No executor, filesystem access or current-OS query belongs in this projection.
 * Missing read-snapshot/checkpoint support cannot produce verified Host evidence.
 */
export function deriveHostOpenReceipt(input: {
  readonly store: HostOpenEvidenceStore;
  readonly run: RunSession;
  readonly start?: RunEventEnvelope;
  readonly end?: RunEventEnvelope;
}): HostOpenLocalTargetReceiptV1 | undefined {
  const { store, run, start, end } = input;
  if (!start || !end || start.type !== "tool_start" || end.type !== "tool_end" || end.seq <= start.seq
    || start.runId !== run.id || end.runId !== run.id || !isRecord(start.data) || !isRecord(end.data)
    || start.data.toolName !== "host_open_local_target" || end.data.toolName !== "host_open_local_target"
    || end.data.isError !== false) return undefined;
  const result = end.data.result;
  const raw = isRecord(result) && result.isError !== true && isRecord(result.details) ? result.details.hostCapabilityResult : undefined;
  if (!isHostOpenLocalTargetReceiptV1(raw) || raw.runId !== run.id
    || raw.toolCallId !== start.data.toolCallId || raw.toolCallId !== end.data.toolCallId
    || raw.attemptId !== start.data.attemptId || raw.attemptId !== end.data.attemptId) return undefined;
  const receipt = structuredClone(raw);
  let call;
  try { call = readHostCapabilityCallV1(start.data.toolName, start.data.args); }
  catch { return undefined; }
  if (call.capabilityId !== "host.open_local_target" || call.input.path !== receipt.path
    || !store.readSnapshot || !store.getApprovalCheckpointForApproval) return undefined;
  const expected = { type: "host_capability" as const, cwd: run.cwd, ...call };
  const readCheckpoint = store.getApprovalCheckpointForApproval.bind(store);
  return store.readSnapshot(() => {
    const approval = store.getApprovalRequest(receipt.approvalId);
    const checkpoint = readCheckpoint(receipt.approvalId);
    const basis = checkpoint?.resumeBasis;
    if (!approval || !checkpoint || approval.status !== "approved" || checkpoint.status !== "approved"
      || approval.runId !== run.id || checkpoint.runId !== run.id
      || approval.taskId !== run.taskId || checkpoint.taskId !== run.taskId
      || approval.channelId !== run.channelId || checkpoint.channelId !== run.channelId
      || approval.workflowStepId !== undefined || checkpoint.workflowStepId !== undefined
      || approval.id !== receipt.approvalId || checkpoint.approvalId !== receipt.approvalId
      || approval.toolCallId !== receipt.toolCallId || checkpoint.toolCallId !== receipt.toolCallId
      || approval.actionType !== "host_capability" || checkpoint.actionType !== "host_capability"
      || !isDeepStrictEqual(approval.payload, expected) || !isDeepStrictEqual(checkpoint.sideEffect, expected)
      || !isApprovalResumeBasisV1(basis) || basis.approvalId !== receipt.approvalId
      || basis.runId !== run.id || basis.workUnitId !== run.workUnitId
      || basis.priorAttemptId !== receipt.attemptId || basis.workflowStepId !== run.workflowStepId
      || basis.toolCallId !== receipt.toolCallId || basis.actionType !== "host_capability"
      || basis.sideEffectFingerprint !== approvalSideEffectFingerprintV1({
        actionType: "host_capability", toolCallId: receipt.toolCallId, sideEffect: expected,
      })) return undefined;
    return receipt;
  });
}
