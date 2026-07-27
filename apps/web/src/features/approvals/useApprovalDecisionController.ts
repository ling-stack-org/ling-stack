import { useEffect, useMemo, useState } from "react";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import type { ApprovalRequest } from "../../types.js";
import type { ApprovalResolution } from "./types.js";

export function useApprovalDecisionController(input: {
  readonly approval: ApprovalRequest;
  readonly resolvingDecision?: ApprovalResolution;
  readonly errorMessage?: string;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
}) {
  const [decisionReason, setDecisionReason] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reasonError, setReasonError] = useState("");
  const [attempted, setAttempted] = useState(false);
  const status = effectiveApprovalStatus(input.approval);
  const highRisk = input.approval.risk === "high" || input.approval.risk === "critical";
  const reasonRequired = highRisk && input.approval.actionType !== "media_cost";
  const isResolving = Boolean(input.resolvingDecision);
  const trimmedReason = decisionReason.trim();
  const mutationError = useMemo(
    () => attempted && status === "pending" && !isResolving ? input.errorMessage?.trim() ?? "" : "",
    [attempted, input.errorMessage, isResolving, status],
  );

  useEffect(() => {
    setDecisionReason("");
    setDialogOpen(false);
    setReasonError("");
    setAttempted(false);
  }, [input.approval.id]);

  useEffect(() => {
    if (status === "pending") return;
    setDialogOpen(false);
    setReasonError("");
    setAttempted(false);
  }, [status]);

  function updateReason(value: string): void {
    setDecisionReason(value);
    if (value.trim()) setReasonError("");
  }

  function requestDecision(decision: ApprovalResolution): void {
    if (status !== "pending" || isResolving) return;
    if (decision === "approve" && highRisk) {
      setReasonError("");
      setDialogOpen(true);
      return;
    }
    submit(decision);
  }

  function submit(decision: ApprovalResolution): void {
    if (status !== "pending" || isResolving) return;
    if (decision === "approve" && reasonRequired && !trimmedReason) {
      setReasonError("High-risk approvals need a decision reason.");
      return;
    }
    setReasonError("");
    setAttempted(true);
    input.onResolve(input.approval.id, decision, trimmedReason || undefined);
  }

  function setOpen(open: boolean): void {
    if (isResolving) return;
    setDialogOpen(open);
    if (!open) setReasonError("");
  }

  return {
    decisionReason,
    dialogOpen,
    reasonError,
    mutationError,
    highRisk,
    reasonRequired,
    isResolving,
    status,
    updateReason,
    requestDecision,
    submit,
    setOpen,
  };
}
