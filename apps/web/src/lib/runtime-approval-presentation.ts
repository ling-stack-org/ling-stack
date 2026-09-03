import type { Translate } from "../i18n.js";
import type { ApprovalRequest } from "../types.js";
import type { ConversationOperationCellViewModel } from "./conversation-work-cell.js";
import type { InlineApprovalView } from "./inline-approvals.js";

export interface ComposerGateApprovalPresentation {
  readonly approvalId: string;
  readonly runId: string;
  readonly actionSentence: string;
}

export function buildComposerGateApprovalPresentationByRunId(
  approvals: readonly InlineApprovalView[],
  t: Translate,
): ReadonlyMap<string, ComposerGateApprovalPresentation> {
  const presentations = new Map<string, ComposerGateApprovalPresentation>();
  for (const item of approvals) {
    const runId = approvalRunId(item.approval);
    if (!runId || presentations.has(runId)) {
      continue;
    }
    presentations.set(runId, {
      approvalId: item.approval.id,
      runId,
      actionSentence: runtimeApprovalActionSentence(item.approval, item.summary, t),
    });
  }
  return presentations;
}

export function composerGateApprovalPresentationForWorkCell(
  model: ConversationOperationCellViewModel,
  presentations: ReadonlyMap<string, ComposerGateApprovalPresentation>,
): ComposerGateApprovalPresentation | undefined {
  for (const runId of model.runIds) {
    const presentation = presentations.get(runId);
    if (presentation) {
      return presentation;
    }
  }
  return presentations.get(model.anchorRunId);
}

export function runtimeApprovalActionSentence(
  approval: ApprovalRequest,
  fallbackTarget: string,
  t: Translate,
): string {
  const payloadType = readStringField(approval.payload, "type");
  const target = compactApprovalTarget(approval, fallbackTarget);
  if (payloadType === "bash" || approval.actionType === "bash") {
    return t("Run command: {target}", { target });
  }
  if (payloadType === "file_write" || approval.actionType === "write") {
    return t("Create file: {target}", { target });
  }
  if (payloadType === "file_edit" || approval.actionType === "edit") {
    return t("Modify file: {target}", { target });
  }
  if (payloadType === "mcp_tool_call" || payloadType === "tool_call" || approval.actionType === "mcp_tool_call") {
    return t("Use tool: {target}", { target });
  }
  if (payloadType === "workflow_step" || approval.actionType === "workflow_step") {
    return t("Start task step: {target}", { target });
  }
  if (payloadType === "runtime_permission_request" || approval.actionType === "runtime_permission_request") {
    return t("Grant runtime permission: {target}", { target });
  }
  return target || approval.title;
}

function approvalRunId(approval: ApprovalRequest): string {
  return approval.runId
    || readStringField(approval.payload, "runId")
    || readStringField(approval.payload, "requestedByRunId");
}

function compactApprovalTarget(approval: ApprovalRequest, fallbackTarget: string): string {
  const cwd = readStringField(approval.payload, "cwd").replace(/\/+$/u, "");
  const path = readStringField(approval.payload, "path");
  const target = path
    || readStringField(approval.payload, "command")
    || readStringField(approval.payload, "toolName")
    || readStringField(approval.payload, "title")
    || fallbackTarget.trim()
    || approval.title;
  if (cwd && target.startsWith(`${cwd}/`)) {
    return target.slice(cwd.length + 1);
  }
  return target;
}

function readStringField(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || !(key in value)) {
    return "";
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}
