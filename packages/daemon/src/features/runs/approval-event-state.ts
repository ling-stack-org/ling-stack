import type { RunEventEnvelope, RunStore } from "@ling-stack/core";

/** Approval audit events describe attempts; only matching durable state changes drive lifecycle. */
export function approvalEventReflectsRunState(
  store: Pick<RunStore, "getApprovalRequest" | "getRun">,
  envelope: RunEventEnvelope,
): boolean {
  const approvalId = (envelope.data as { readonly approvalId?: unknown }).approvalId;
  if (typeof approvalId !== "string") return false;
  const approval = store.getApprovalRequest(approvalId);
  const run = store.getRun(envelope.runId);
  if (!approval || !run || approval.runId !== run.id) return false;
  switch (envelope.type) {
    case "approval_requested":
      return approval.status === "pending" && run.status === "waiting_for_approval";
    case "approval_approved":
      return approval.status === "approved" && run.status === "running";
    case "approval_denied":
      return approval.status === "denied" && run.status === "failed";
    case "approval_expired":
      return approval.status === "expired" && run.status === "failed";
    default:
      return false;
  }
}
