import { effectiveApprovalStatus } from "./approvals.js";
import { readDataString } from "./data.js";
import type { ApprovalRequest, ApprovalActionType } from "../types.js";

export interface InlineApprovalContext {
  readonly activeChannelId?: string;
  readonly activeRunId?: string;
  readonly visibleRunIds?: readonly string[];
  readonly visibleTaskIds?: readonly string[];
  readonly blockedWorkflowStepIds?: readonly string[];
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

  const visibleRunIds = new Set([context.activeRunId, ...(context.visibleRunIds ?? [])].filter(Boolean));
  const visibleTaskIds = new Set(context.visibleTaskIds ?? []);
  const blockedWorkflowStepIds = new Set(context.blockedWorkflowStepIds ?? []);

  if (approval.runId && visibleRunIds.has(approval.runId)) {
    return true;
  }
  if (approval.taskId && visibleTaskIds.has(approval.taskId)) {
    return true;
  }
  if (approval.workflowStepId && blockedWorkflowStepIds.has(approval.workflowStepId)) {
    return true;
  }
  if (approval.channelId && approval.channelId === context.activeChannelId) {
    return approval.actionType !== "workflow_step" || Boolean(approval.workflowStepId && blockedWorkflowStepIds.has(approval.workflowStepId));
  }

  const payloadRunId = readDataString(approval.payload, "runId") || readDataString(approval.payload, "requestedByRunId");
  if (payloadRunId && visibleRunIds.has(payloadRunId)) {
    return true;
  }

  return false;
}

export function buildInlineApprovalViews(
  approvals: readonly ApprovalRequest[],
  context: InlineApprovalContext,
): InlineApprovalView[] {
  const uniqueApprovals = [...new Map(approvals.map((approval) => [approval.id, approval])).values()];
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
