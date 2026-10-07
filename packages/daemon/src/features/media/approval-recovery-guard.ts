import type { MediaJobExecutionHandle, RunStore } from "@ling-stack/core";

/** An approval cannot authorize replay across an unknown provider submission boundary. */
export function mediaApprovalRecoveryBlocked(
  store: RunStore,
  mediaJobId: string,
  handle: MediaJobExecutionHandle | undefined,
): boolean {
  const approvals = store.listApprovalRequests({ mediaJobId, status: "approved", complete: true });
  for (const approval of approvals) {
    const effect = store.listApprovalPostCommitEffects({ approvalId: approval.id })
      .find((candidate) => candidate.effectKind === "owner");
    if (!effect) continue;
    const placeholder = !handle || handle.externalOperationId.startsWith("ling-pending:")
      || handle?.recovery.phase === "nonrecoverable_execution";
    if (placeholder) {
      store.quarantineMediaApprovalSubmission(approval.id, mediaJobId, new Date().toISOString());
      return true;
    }
    if (effect.status === "effect_unknown" || effect.status === "blocked" || effect.status === "claimed") return true;
  }
  return false;
}
