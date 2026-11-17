import type { ApprovalRequest, RunStore, RuntimeAttemptFenceV1 } from "@ling-stack/core";
import type { PiRunnerApprovalRequest } from "@ling-stack/runner-pi";

/** A cancelled child cannot leave a pending approval eligible for later execution. */
export async function waitForScopedApprovalDecision(input: {
  store: RunStore; runId: string; request: PiRunnerApprovalRequest; approval: ApprovalRequest;
  sourceFence?: RuntimeAttemptFenceV1; runSignal?: AbortSignal; wait: () => Promise<ApprovalRequest>;
}): Promise<ApprovalRequest> {
  try { return await input.wait(); }
  catch (error) {
    if (!input.request.signal?.aborted || input.runSignal?.aborted || !input.sourceFence) throw error;
    const current = input.store.getApprovalRequest(input.approval.id);
    if (current?.status !== "pending") throw error;
    const cancelled = input.store.cancelApprovalRequest(current.id, {
      reason: "The originating tool call ended before approval execution.",
      executionCleanup: { runId: input.runId, toolCallId: input.request.toolCallId,
        approvalCreatedAt: input.approval.createdAt, sourceFence: input.sourceFence },
    }, new Date().toISOString());
    if (!cancelled || cancelled.status !== "cancelled") throw error;
    return cancelled;
  }
}
