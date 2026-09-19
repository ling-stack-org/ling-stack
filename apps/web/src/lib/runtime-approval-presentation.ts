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
  return composerGateApprovalPresentationForRunIds(
    [...model.runIds, model.anchorRunId],
    presentations,
  );
}

/**
 * Resolve the first pending composer approval owned by a set of durable Runs.
 * Workflow projections may span several participant Runs, while a normal or
 * private turn usually has one. Keeping the lookup at the Run boundary lets
 * every surface use the same ownership rule without consulting a WorkCell.
 */
export function composerGateApprovalPresentationForRunIds(
  runIds: readonly (string | undefined)[],
  presentations: ReadonlyMap<string, ComposerGateApprovalPresentation>,
): ComposerGateApprovalPresentation | undefined {
  for (const runId of runIds) {
    const normalizedRunId = runId?.trim();
    if (!normalizedRunId) {
      continue;
    }
    const presentation = presentations.get(normalizedRunId);
    if (presentation) {
      return presentation;
    }
  }
  return undefined;
}

/**
 * Resolve the composer-owned approval directly from the durable Run owner.
 *
 * Timeline renderers and surface adapters should not need a WorkCell merely to
 * decide whether the Composer must show an approval gate. The Run id is the
 * canonical ownership boundary; WorkCell lookup remains an input adapter for
 * legacy evidence only.
 */
export function composerGateApprovalPresentationForRunId(
  runId: string | undefined,
  presentations: ReadonlyMap<string, ComposerGateApprovalPresentation>,
): ComposerGateApprovalPresentation | undefined {
  const normalizedRunId = runId?.trim();
  return normalizedRunId ? presentations.get(normalizedRunId) : undefined;
}

// The dialog queue and the legacy composer gate use the same durable
// approval-to-run projection. Keep the dialog vocabulary as a named adapter so
// the queue can evolve independently without duplicating ownership logic.
export type DialogOwnedApprovalPresentation = ComposerGateApprovalPresentation;

export function buildDialogOwnedApprovalPresentationByRunId(
  approvals: readonly InlineApprovalView[],
  t: Translate,
): ReadonlyMap<string, DialogOwnedApprovalPresentation> {
  return buildComposerGateApprovalPresentationByRunId(approvals, t);
}

export function dialogOwnedApprovalPresentationForWorkCell(
  model: ConversationOperationCellViewModel,
  presentations: ReadonlyMap<string, DialogOwnedApprovalPresentation>,
): DialogOwnedApprovalPresentation | undefined {
  return composerGateApprovalPresentationForWorkCell(model, presentations);
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
