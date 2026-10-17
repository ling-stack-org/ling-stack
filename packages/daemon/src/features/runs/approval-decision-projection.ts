import {
  DEFAULT_WORKSPACE_ID,
  type ApprovalRequest,
  type RunEventType,
  type RunExecutionStoreFacet,
  type RunStore,
} from "@ling-stack/core";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendControlPlaneEvent } from "../control-plane/events.js";

export function appendApprovalCreatedControlPlaneEvent(
  store: RunStore,
  hub: ControlPlaneEventHub | undefined,
  cwd: string,
  approval: ApprovalRequest,
  now: string,
): void {
  if (!hub) return;
  const owner = resolveApprovalOwner(approval);
  appendControlPlaneEvent(store, hub, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "approvals",
    entityType: "approval",
    entityId: approval.id,
    action: "approval.created",
    data: {
      ownerType: owner.type,
      ownerId: owner.id,
      actionType: approval.actionType,
      risk: approval.risk,
      expiresAt: approval.expiresAt ?? null,
    },
  }, now);
}

/** Append the durable Run decision projection for a committed approval. */
export function appendApprovalDecisionEvent(
  store: RunStore,
  approval: ApprovalRequest,
): void {
  const runId = resolveApprovalDecisionRunId(store, approval);
  if (!runId) {
    const payload = approval.payload;
    if (approval.runId || payload.type === "workflow_step" && payload.gateStage === "post" && payload.runId) {
      throw new Error(`Approval decision Run lineage is invalid: ${approval.id}`);
    }
    return;
  }
  store.appendApprovalDecisionEvent(runId, approval.id, approvalDecisionEventType(approval), {
    approvalId: approval.id,
    status: approval.status,
    resolvedBy: approval.resolvedBy,
    decisionReason: approval.decisionReason,
    decisionKind: approval.decisionKind,
    decisionRuleId: approval.decisionRuleId,
  });
}

/**
 * Resolve the Run that owns the immutable decision-event projection.
 * Workflow approvals remain owned by the Workflow Step; payload.runId is
 * accepted only after the whole persisted Step/Workflow/Run lineage matches.
 */
export function resolveApprovalDecisionRunId(
  store: RunStore,
  approval: ApprovalRequest,
): string | undefined {
  if (approval.runId) {
    const run = store.getRun(approval.runId);
    if (!run || !approval.taskId || run.taskId !== approval.taskId
      || (run.channelId ?? undefined) !== approval.channelId
      || approval.workflowStepId !== undefined && run.workflowStepId !== approval.workflowStepId) {
      return undefined;
    }
    return run.id;
  }

  const payload = approval.payload;
  if (payload.type !== "workflow_step" || payload.gateStage !== "post"
    || approval.taskId !== undefined || !approval.workflowStepId
    || !approval.channelId || !payload.runId
    || payload.workflowStepId !== approval.workflowStepId) {
    return undefined;
  }
  const step = store.getChannelWorkflowStep(approval.workflowStepId);
  const workflow = store.getChannelWorkflow(payload.workflowId);
  const run = store.getRun(payload.runId);
  if (!step || !workflow || !run
    || step.workflowId !== workflow.id
    || step.channelId !== approval.channelId
    || workflow.channelId !== approval.channelId
    || step.runId !== run.id
    || run.workflowStepId !== step.id
    || run.channelId !== step.channelId
    || step.taskId !== undefined && run.taskId !== step.taskId) {
    return undefined;
  }
  return run.id;
}

export function appendApprovalResolvedControlPlaneEvent(
  store: RunStore,
  hub: ControlPlaneEventHub | undefined,
  cwd: string,
  approval: ApprovalRequest,
  previousStatus: ApprovalRequest["status"],
  decision: "approved" | "denied" | "cancelled",
  now: string,
): void {
  if (!hub) return;
  const owner = resolveApprovalOwner(approval);
  appendControlPlaneEvent(store, hub, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "approvals",
    entityType: "approval",
    entityId: approval.id,
    action: "approval.resolved",
    idempotencyKey: `approval-resolved:${approval.id}`,
    data: {
      ownerType: owner.type,
      ownerId: owner.id,
      previousStatus,
      status: approval.status,
      decision,
      resolvedBy: approval.resolvedBy ?? (decision === "cancelled" ? "system" : "local-user"),
    },
  }, now);
}

export function appendApprovalExpiredControlPlaneEvent(
  store: RunExecutionStoreFacet,
  hub: ControlPlaneEventHub | undefined,
  cwd: string,
  approval: ApprovalRequest,
  previousStatus: ApprovalRequest["status"],
  now: string,
): void {
  if (!hub) return;
  const owner = resolveApprovalOwner(approval);
  appendControlPlaneEvent(store, hub, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "approvals",
    entityType: "approval",
    entityId: approval.id,
    action: "approval.expired",
    idempotencyKey: `approval-expired:${approval.id}`,
    data: {
      ownerType: owner.type,
      ownerId: owner.id,
      previousStatus,
      status: approval.status,
      decision: "expired",
      resolvedBy: "system",
    },
  }, now);
}

export function approvalDecisionEventType(
  approval: ApprovalRequest,
): Extract<RunEventType, "approval_approved" | "approval_denied" | "approval_expired" | "approval_cancelled"> {
  if (approval.status === "approved") return "approval_approved";
  if (approval.status === "expired") return "approval_expired";
  if (approval.status === "cancelled") return "approval_cancelled";
  return "approval_denied";
}

function resolveApprovalOwner(approval: ApprovalRequest): { readonly type: string; readonly id: string | null } {
  if (approval.runId) return { type: "run", id: approval.runId };
  if (approval.mediaJobId) return { type: "media_job", id: approval.mediaJobId };
  if (approval.externalWorkActionId) return { type: "external_work_action", id: approval.externalWorkActionId };
  if (approval.workflowStepId) return { type: "workflow_step", id: approval.workflowStepId };
  if (approval.taskId) return { type: "task", id: approval.taskId };
  if (approval.channelId) return { type: "channel", id: approval.channelId };
  return { type: "unknown", id: null };
}
