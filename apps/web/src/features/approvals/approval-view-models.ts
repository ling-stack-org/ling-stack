import type { BadgeTone, StatusTone } from "../../shared/ui/index.js";
import { approvalOwnerIdentity, effectiveApprovalStatus } from "../../lib/approvals.js";
import { formatUnknownPreview, readDataField, readDataString } from "../../lib/data.js";
import { reviewQueueCategoryLabel, type ReviewQueueItemCategory } from "../../lib/review-queue.js";
import type { ApprovalActionType, ApprovalRequest, ApprovalRisk, ApprovalStatus, ExternalWorkActionView, RunSession } from "../../types.js";

export type ApprovalQueueMode = "actionable" | "history";
export type ApprovalCategoryFilter = "all" | ReviewQueueItemCategory;
export type ApprovalRiskFilter = "all" | ApprovalRisk;

export interface ApprovalQueueRowView {
  readonly id: string;
  readonly approval: ApprovalRequest;
  readonly category: ReviewQueueItemCategory;
  readonly categoryLabel: string;
  readonly externalAction?: ExternalWorkActionView;
  readonly inlineOwned: boolean;
  readonly actionable: boolean;
  readonly historical: boolean;
  readonly ownerLabel: string;
  readonly recommendedAction: string;
  readonly searchText: string;
  readonly status: ApprovalStatus;
}

export interface BuildApprovalQueueRowsInput {
  readonly approvals: readonly ApprovalRequest[];
  readonly externalActionDetails: Readonly<Record<string, ExternalWorkActionView>>;
  readonly inlineApprovalIds?: ReadonlySet<string>;
  readonly runsById?: ReadonlyMap<string, RunSession>;
}

export function buildApprovalQueueRows(input: BuildApprovalQueueRowsInput): readonly ApprovalQueueRowView[] {
  return [...new Map(input.approvals.map((approval) => [approval.id, approval])).values()]
    .filter((approval) => !input.inlineApprovalIds?.has(approval.id))
    .map((approval) => buildApprovalQueueRow(approval, input))
    .sort(compareApprovalQueueRows);
}

export function filterApprovalQueueRows(input: {
  readonly rows: readonly ApprovalQueueRowView[];
  readonly mode: ApprovalQueueMode;
  readonly category: ApprovalCategoryFilter;
  readonly risk: ApprovalRiskFilter;
  readonly search: string;
}): readonly ApprovalQueueRowView[] {
  const query = input.search.trim().toLocaleLowerCase();
  return input.rows.filter((row) => {
    if (input.mode === "actionable" ? !row.actionable : !row.historical) return false;
    if (input.category !== "all" && row.category !== input.category) return false;
    if (input.risk !== "all" && (!isApprovalDecisionCategory(row.category) || row.approval.risk !== input.risk)) return false;
    return !query || row.searchText.includes(query);
  });
}

export function isApprovalDecisionCategory(category: ReviewQueueItemCategory): boolean {
  return category === "approve_external_action" || category === "offline_local_approval";
}

export function approvalStatusTone(status: ApprovalStatus): StatusTone {
  if (status === "approved") return "success";
  if (status === "pending") return "warning";
  if (status === "denied" || status === "expired" || status === "cancelled") return "danger";
  return "neutral";
}

export function approvalRiskTone(risk: ApprovalRisk): BadgeTone {
  if (risk === "critical" || risk === "high") return "danger";
  if (risk === "medium") return "warning";
  return "neutral";
}

export function approvalActionDisplayKey(actionType: ApprovalActionType): string {
  if (actionType === "runtime_permission_request") return "Runtime permission scope";
  if (actionType === "external_send") return "External action";
  if (actionType === "provider_change") return "Provider";
  if (actionType === "credential_change") return "Permissions";
  return actionType;
}

function buildApprovalQueueRow(
  approval: ApprovalRequest,
  input: BuildApprovalQueueRowsInput,
): ApprovalQueueRowView {
  const externalAction = approval.externalWorkActionId
    ? input.externalActionDetails[approval.externalWorkActionId]
    : undefined;
  const run = approval.runId ? input.runsById?.get(approval.runId) : undefined;
  const status = effectiveApprovalStatus(approval);
  const category = classifyApprovalQueueCategory(approval, status, externalAction, run);
  const actionStatus = externalAction?.action.status;
  const actionable = status === "pending" || category === "repair" || (
    category === "execute_approved_action" && (
      !actionStatus || actionStatus === "proposed" || actionStatus === "waiting_for_approval" || actionStatus === "approved"
    )
  );
  const historical = status !== "pending" || Boolean(actionStatus && actionStatus !== "approved" && actionStatus !== "waiting_for_approval" && actionStatus !== "proposed");
  const ownerLabel = approvalOwnerIdentity(approval);
  const externalIdentity = externalAction
    ? `${externalAction.action.externalWorkId} ${externalAction.action.target.repository} ${externalAction.action.target.subjectKind} ${externalAction.action.target.number}`
    : "";
  return {
    id: approval.id,
    approval,
    category,
    categoryLabel: reviewQueueCategoryLabel(category),
    externalAction,
    inlineOwned: false,
    actionable,
    historical,
    ownerLabel,
    recommendedAction: recommendedActionForCategory(category),
    searchText: [
      approval.title,
      approval.description,
      approval.actionType,
      ownerLabel,
      approval.runId,
      approval.taskId,
      approval.channelId,
      approval.workflowStepId,
      externalIdentity,
      readDataString(approval.payload, "path"),
      readDataString(approval.payload, "command"),
      formatUnknownPreview(readDataField(approval.payload, "target"), 180),
    ].filter(Boolean).join(" ").toLocaleLowerCase(),
    status,
  };
}

function classifyApprovalQueueCategory(
  approval: ApprovalRequest,
  status: ApprovalStatus,
  externalAction: ExternalWorkActionView | undefined,
  run: RunSession | undefined,
): ReviewQueueItemCategory {
  if (approval.externalWorkActionId) {
    if (externalAction?.action.status === "approved") return "execute_approved_action";
    if (externalAction?.action.status === "failed" || externalAction?.action.status === "stale_target") return "repair";
    if (status === "pending") return "approve_external_action";
    if (status === "approved" && (!externalAction || externalAction.action.status === "proposed" || externalAction.action.status === "waiting_for_approval")) {
      return "execute_approved_action";
    }
    if (status === "expired") return "repair";
    return "approve_external_action";
  }
  if (status === "expired" || run?.status === "failed" || run?.status === "cancelled") return "repair";
  if (status === "pending") return approval.channelId ? "offline_local_approval" : "route";
  return "offline_local_approval";
}

function recommendedActionForCategory(category: ReviewQueueItemCategory): string {
  if (category === "approve_external_action") return "Approve or reject this external action";
  if (category === "execute_approved_action") return "Execute or cancel the approved action";
  if (category === "route") return "Route it to the right channel";
  if (category === "repair") return "Open the linked run and fix the blocker";
  return "Review the local action risk";
}

function compareApprovalQueueRows(left: ApprovalQueueRowView, right: ApprovalQueueRowView): number {
  const actionableDifference = Number(right.actionable) - Number(left.actionable);
  if (actionableDifference) return actionableDifference;
  const riskDifference = riskRank(right.approval.risk) - riskRank(left.approval.risk);
  return riskDifference || left.approval.createdAt.localeCompare(right.approval.createdAt);
}

function riskRank(risk: ApprovalRisk): number {
  return risk === "critical" ? 4 : risk === "high" ? 3 : risk === "medium" ? 2 : 1;
}
