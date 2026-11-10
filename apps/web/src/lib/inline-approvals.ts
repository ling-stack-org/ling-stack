import { effectiveApprovalStatus, mergeApprovalSnapshot } from "./approvals.js";
import { readDataString } from "./data.js";
import {
  resolveRuntimeApprovalOwner,
  runtimeApprovalOwnerMatches,
  type RuntimeApprovalOwner,
  type RuntimeApprovalOwnershipContext,
} from "./runtime-approval-ownership.js";
import type { ApprovalRequest, ApprovalActionType } from "../types.js";

export interface InlineApprovalContext extends RuntimeApprovalOwnershipContext {
  readonly owner: RuntimeApprovalOwner;
}

export interface InlineApprovalView {
  readonly approval: ApprovalRequest;
  readonly summary: string;
  readonly ownerLabel: string;
  readonly requiresDetailConfirmation: boolean;
}

const inlineActionTypes = new Set<ApprovalActionType>([
  "runtime_permission_request",
  "bash",
  "edit",
  "write",
  "mcp_tool_call",
  "workflow_step",
]);

export function isInlineApprovalActionType(actionType: ApprovalActionType): boolean {
  return inlineActionTypes.has(actionType);
}

export function isInlineApprovalEligible(approval: ApprovalRequest, context: InlineApprovalContext): boolean {
  if (effectiveApprovalStatus(approval) !== "pending") {
    return false;
  }
  if (!inlineActionTypes.has(approval.actionType)) {
    return false;
  }
  if (approval.externalWorkActionId || approval.mediaJobId) {
    return false;
  }

  return runtimeApprovalOwnerMatches(resolveRuntimeApprovalOwner(approval, context), context.owner);
}

export function buildInlineApprovalViews(
  approvals: readonly ApprovalRequest[],
  context: InlineApprovalContext,
): InlineApprovalView[] {
  const uniqueApprovals = mergeApprovalSnapshot([], approvals);
  return uniqueApprovals
    .filter((approval) => isInlineApprovalEligible(approval, context))
    .sort((left, right) => {
      const riskDifference = approvalRiskRank(right.risk) - approvalRiskRank(left.risk);
      return riskDifference || left.createdAt.localeCompare(right.createdAt);
    })
    .map((approval) => ({
      approval,
      summary: inlineApprovalSummary(approval),
      ownerLabel: inlineApprovalOwnerLabel(approval),
      requiresDetailConfirmation: approval.risk === "high" || approval.risk === "critical",
    }));
}

export function inlineApprovalSummary(approval: ApprovalRequest): string {
  const payloadType = readDataString(approval.payload, "type");
  if (payloadType === "runtime_permission_request") {
    const kind = readDataString(approval.payload, "requestKind") || approval.actionType;
    const reason = readDataString(approval.payload, "reason");
    return reason ? `${kind}: ${reason}` : kind;
  }
  if (payloadType === "bash") {
    return readDataString(approval.payload, "command") || approval.description;
  }
  if (payloadType === "file_write" || payloadType === "file_edit") {
    return readDataString(approval.payload, "path") || approval.description;
  }
  if (payloadType === "mcp_tool_call" || payloadType === "tool_call") {
    return readDataString(approval.payload, "toolName") || approval.description;
  }
  if (payloadType === "workflow_step") {
    return readDataString(approval.payload, "title") || approval.description;
  }
  return approval.description;
}

export function inlineApprovalOwnerLabel(approval: ApprovalRequest): string {
  if (approval.runId) {
    return `run ${shortId(approval.runId)}`;
  }
  if (approval.taskId) {
    return `task ${shortId(approval.taskId)}`;
  }
  if (approval.workflowStepId) {
    return `step ${shortId(approval.workflowStepId)}`;
  }
  if (approval.channelId) {
    return `channel ${shortId(approval.channelId)}`;
  }
  return "workspace";
}

function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 12)}...` : value;
}

function approvalRiskRank(risk: ApprovalRequest["risk"]): number {
  return risk === "critical" ? 4 : risk === "high" ? 3 : risk === "medium" ? 2 : 1;
}
