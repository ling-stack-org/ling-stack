import type {
  ApprovalActionType,
  ApprovalPolicy,
  ApprovalPolicyFormState,
  ApprovalRequest,
  ApprovalRisk,
  ApprovalStatus,
  RunEventEnvelope,
} from "../types.js";
import { readDataField, readDataString } from "./data.js";
import { formatDateTime } from "./formatting.js";

export const defaultApprovalPolicyForm: ApprovalPolicyFormState = {
  toolDecisions: {
    read: "allow",
    grep: "allow",
    find: "allow",
    ls: "allow",
    bash: "ask",
    edit: "ask",
    write: "ask",
  },
  allowedWritePathsText: ".",
};

export function highestApprovalRisk(approvals: readonly ApprovalRequest[]): ApprovalRisk {
  const order: readonly ApprovalRisk[] = ["low", "medium", "high", "critical"];
  return approvals.reduce<ApprovalRisk>((highest, approval) => {
    return order.indexOf(approval.risk) > order.indexOf(highest) ? approval.risk : highest;
  }, "low");
}

export function buildRunApprovalSummaries(
  events: readonly RunEventEnvelope[],
  approvals: readonly ApprovalRequest[],
  runId: string,
): readonly ApprovalRequest[] {
  const summaries = new Map<string, ApprovalRequest>();
  for (const approval of approvals) {
    if (approval.runId === runId) {
      summaries.set(approval.id, approval);
    }
  }

  for (const event of events) {
    if (event.type === "approval_requested") {
      const approvalId = readDataString(event.data, "approvalId");
      if (!approvalId || summaries.has(approvalId)) {
        continue;
      }
      summaries.set(approvalId, {
        id: approvalId,
        runId: event.runId,
        taskId: readDataString(event.data, "taskId") || event.runId,
        toolCallId: readDataString(event.data, "toolCallId") || undefined,
        actionType: readApprovalActionType(event.data),
        risk: readApprovalRisk(event.data),
        title: readDataString(event.data, "title") || "Approval requested",
        description: readDataString(event.data, "description") || "The run requested approval.",
        payload: readDataField(event.data, "payload"),
        status: "pending",
        createdAt: event.ts,
        expiresAt: readDataString(event.data, "expiresAt") || undefined,
      });
      continue;
    }

    if (event.type === "approval_approved" || event.type === "approval_denied" || event.type === "approval_expired") {
      const approvalId = readDataString(event.data, "approvalId");
      if (!approvalId) {
        continue;
      }
      const existing = summaries.get(approvalId);
      const fallbackStatus = event.type === "approval_approved" ? "approved" : event.type === "approval_expired" ? "expired" : "denied";
      const status = readApprovalStatus(event.data, fallbackStatus);
      summaries.set(approvalId, {
        id: approvalId,
        runId: event.runId,
        taskId: existing?.taskId ?? event.runId,
        toolCallId: existing?.toolCallId,
        actionType: existing?.actionType ?? "bash",
        risk: existing?.risk ?? "medium",
        title: existing?.title ?? (fallbackStatus === "approved" ? "Approval approved" : fallbackStatus === "expired" ? "Approval expired" : "Approval denied"),
        description: existing?.description ?? "Approval decision recorded.",
        payload: existing?.payload ?? {},
        status,
        createdAt: existing?.createdAt ?? event.ts,
        expiresAt: existing?.expiresAt,
        resolvedAt: event.ts,
        resolvedBy: "local-user",
        decisionReason: readDataString(event.data, "decisionReason") || existing?.decisionReason,
      });
    }
  }

  return [...summaries.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function mergeApprovalsForRun(
  current: readonly ApprovalRequest[],
  nextRunApprovals: readonly ApprovalRequest[],
  runId: string,
): readonly ApprovalRequest[] {
  const otherApprovals = current.filter((approval) => approval.runId !== runId);
  return [...nextRunApprovals, ...otherApprovals];
}

export function approvalOwnerLabels(approval: ApprovalRequest): readonly string[] {
  if (approval.mediaJobId) {
    return ["generation task"];
  }
  return [
    approval.taskId ? "task" : "",
    approval.runId ? "run" : "",
  ].filter(Boolean);
}

export function approvalOwnerIdentity(approval: ApprovalRequest): string {
  if (approval.mediaJobId) return `generation task ${approval.mediaJobId}`;
  if (approval.runId) return `run ${approval.runId}`;
  if (approval.taskId) return `task ${approval.taskId}`;
  if (approval.workflowStepId) return `step ${approval.workflowStepId}`;
  if (approval.channelId) return `channel ${approval.channelId}`;
  return "workspace";
}

export interface RuntimePermissionDeltaProjection {
  readonly kind: string;
  readonly continuationMode: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly unchanged: readonly string[];
}

export function projectRuntimePermissionDelta(approval: ApprovalRequest): RuntimePermissionDeltaProjection | undefined {
  if (approval.actionType !== "runtime_permission_request") return undefined;
  const requestedScope = readDataField(approval.payload, "requestedScope");
  const currentScope = readDataField(approval.payload, "currentScope");
  const continuation = readDataField(approval.payload, "proposedContinuation");
  const requested = runtimePermissionScopeEntries(requestedScope);
  const current = runtimePermissionScopeEntries(currentScope);
  const requestedSet = new Set(requested);
  const currentSet = new Set(current);
  return {
    kind: readDataString(approval.payload, "requestKind") || "-",
    continuationMode: readRecordString(continuation, "mode") || "-",
    added: requested.filter((entry) => !currentSet.has(entry)),
    removed: current.filter((entry) => !requestedSet.has(entry)),
    unchanged: requested.filter((entry) => currentSet.has(entry)),
  };
}

export function upsertApproval(current: readonly ApprovalRequest[], next: ApprovalRequest): readonly ApprovalRequest[] {
  const existingIndex = current.findIndex((approval) => approval.id === next.id);
  if (existingIndex === -1) {
    return [next, ...current];
  }
  return current.map((approval, index) => (index === existingIndex ? next : approval));
}

export function readApprovalActionType(data: unknown): ApprovalActionType {
  const value = readDataString(data, "actionType");
  if (["write", "edit", "bash", "git_commit", "git_push", "external_send", "deploy", "media_cost", "credential_change", "provider_change"].includes(value)) {
    return value as ApprovalActionType;
  }
  return "bash";
}

export function readApprovalRisk(data: unknown): ApprovalRisk {
  const value = readDataString(data, "risk");
  if (["low", "medium", "high", "critical"].includes(value)) {
    return value as ApprovalRisk;
  }
  return "medium";
}

export function readApprovalStatus(data: unknown, fallback: ApprovalStatus): ApprovalStatus {
  const value = readDataString(data, "status");
  if (["pending", "approved", "denied", "expired", "cancelled"].includes(value)) {
    return value as ApprovalStatus;
  }
  return fallback;
}

export function effectiveApprovalStatus(approval: ApprovalRequest): ApprovalStatus {
  if (approval.status !== "pending" || !approval.expiresAt) {
    return approval.status;
  }
  return new Date(approval.expiresAt).getTime() <= Date.now() ? "expired" : "pending";
}

export function approvalTimingLabel(approval: ApprovalRequest): string {
  if (!approval.expiresAt) {
    return "";
  }
  const expiresAt = new Date(approval.expiresAt).getTime();
  if (Number.isNaN(expiresAt)) {
    return "";
  }
  if (approval.status !== "pending" || expiresAt <= Date.now()) {
    return `expired ${formatDateTime(approval.expiresAt)}`;
  }
  const remainingMs = expiresAt - Date.now();
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `expires in ${remainingMinutes}m`;
}

export function approvalPolicyToForm(policy: ApprovalPolicy): ApprovalPolicyFormState {
  return {
    toolDecisions: {
      read: policy.toolDecisions.read ?? "allow",
      grep: policy.toolDecisions.grep ?? "allow",
      find: policy.toolDecisions.find ?? "allow",
      ls: policy.toolDecisions.ls ?? "allow",
      bash: policy.toolDecisions.bash ?? "ask",
      edit: policy.toolDecisions.edit ?? "ask",
      write: policy.toolDecisions.write ?? "ask",
    },
    allowedWritePathsText: policy.allowedWritePaths.join("\n"),
  };
}

function runtimePermissionScopeEntries(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  const kind = readRecordString(value, "kind");
  if (kind === "core_tool") {
    return readStringArray(value.tools).map((tool) => `tool ${tool}`);
  }
  if (kind === "write_scope") {
    const operation = readRecordString(value, "operation") || "write";
    return readStringArray(value.paths).map((path) => `${operation} ${path}`);
  }
  if (kind === "mcp_tool") {
    return [`mcp ${readRecordString(value, "serverId") || "-"}/${readRecordString(value, "toolName") || "-"}`];
  }
  if (kind === "runner_capability") {
    return [`runner ${readRecordString(value, "runnerId") || "-"}/${readRecordString(value, "capability") || "-"}`];
  }
  return kind ? [kind] : [];
}

function readRecordString(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
