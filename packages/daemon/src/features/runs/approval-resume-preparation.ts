import { toRuntimeAttemptFence, type RunSession, type RunStore, type WorkUnitAttempt } from "@ling-stack/core";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import type { PreparedRunnerContinuationExecution } from "../harness/index.js";
import { hasCurrentRunCallbackIdentity } from "./run-callback-ownership.js";

type PreparationSuspensionResult =
  | { readonly kind: "suspended" }
  | { readonly kind: "blocked"; readonly code: string };

/**
 * A claimed approval continuation already owns an Attempt before Runner preflight.
 * Shutdown may suspend that exact owner only before any durable tool dispatch.
 * A rejected proof retains its existing authority for normal recovery; it is not failed here.
 */
export function suspendClaimedApprovalResumePreparation(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly attempt: WorkUnitAttempt;
  readonly execution: PreparedRunnerContinuationExecution;
  readonly approvalId: string;
  readonly cause: string;
  readonly controlPlaneEvents?: ControlPlaneEventHub;
  readonly now: string;
}): PreparationSuspensionResult {
  const sourceFence = toRuntimeAttemptFence(input.attempt);
  const checkpoint = input.store.readSnapshot(() => {
    const current = input.store.getApprovalCheckpointForApproval(input.approvalId);
    const approval = input.store.getApprovalRequest(input.approvalId);
    const continuation = input.store.getRunnerContinuation(input.execution.continuation.id);
    if (!current || current.status !== "resume_pending" || current.runnerResumeHandle?.attemptId !== sourceFence.attemptId
      || current.runId !== input.run.id || current.resumeBasis?.workUnitId !== sourceFence.workUnitId
      || approval?.status !== "approved" || approval.runId !== input.run.id
      || !hasCurrentRunCallbackIdentity(input.store, input.run, sourceFence)
      || !input.store.isCurrentRunExecutionOwner(input.run.id, sourceFence, true)
      || !continuation || !["prepared", "claimed"].includes(continuation.state) || continuation.runId !== input.run.id
      || continuation.workUnitId !== sourceFence.workUnitId || continuation.targetAttemptId !== sourceFence.attemptId
      || continuation.revision !== input.execution.continuation.revision
      || continuation.state !== input.execution.continuation.state
      || continuation.state === "claimed" && (continuation.claimOwner !== input.execution.claimOwner
        || continuation.claimToken !== input.execution.claimToken)
      || continuation.state === "prepared" && (continuation.claimOwner !== undefined || continuation.claimToken !== undefined)) return undefined;
    let afterSeq = 0;
    for (;;) {
      const events = input.store.listEvents(input.run.id, { afterSeq, limit: 1_000 });
      for (const event of events) {
        if (event.type !== "tool_start") continue;
        const data = event.data as Readonly<Record<string, unknown>>;
        if (data.attemptId === sourceFence.attemptId || typeof data.attemptId !== "string") return undefined;
      }
      if (events.length < 1_000) break;
      const next = events.at(-1)!.seq;
      if (next <= afterSeq) return undefined;
      afterSeq = next;
    }
    return current;
  });
  if (!checkpoint) return { kind: "blocked", code: "approval_resume_preparation_suspension_unproven" };
  const suspended = input.store.commitApprovalResumeSuspension({
    kind: "resume_pre_dispatch", checkpointId: checkpoint.id,
    expectedCheckpointStatus: "resume_pending", expectedCheckpointRevision: checkpoint.revision,
    approvalId: input.approvalId, runId: input.run.id, expectedRunStatus: "running",
    workUnitId: sourceFence.workUnitId, expectedWorkUnitStatus: "running", attemptId: sourceFence.attemptId,
    cause: input.cause, now: input.now,
  });
  if (!suspended.ok) return { kind: "blocked", code: suspended.code };
  for (const event of suspended.controlPlaneEvents) input.controlPlaneEvents?.publish(event);
  return { kind: "suspended" };
}
