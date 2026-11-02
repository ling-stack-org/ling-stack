import type { SQLOutputValue } from "node:sqlite";
import {
  defaultApprovalToolDecisions,
  type ApprovalPolicy,
  type ApprovalToolDecision,
  type ApprovalToolDecisions,
  type RunTool,
} from "../../approval-policy.js";
import {
  approvalDecisionKinds,
  type ApprovalCommandRule,
  type ApprovalCommandRuleProposal,
  type ApprovalDecisionKind,
  type ApprovalRequest,
  type ApprovalStatus,
} from "../../approval-types.js";
import { type MediaJob, type MediaJobStatus } from "../../media-types.js";
import {
  omitUndefined,
  parseJsonObject,
  parseJsonStringArray,
  readNullableString,
  readNumber,
  readString,
} from "./helpers.js";

export function mapApprovalRequest(row: Record<string, SQLOutputValue>): ApprovalRequest {
  return omitUndefined({
    id: readString(row, "id"),
    runId: readNullableString(row, "run_id"),
    taskId: readNullableString(row, "task_id"),
    mediaJobId: readNullableString(row, "media_job_id"),
    externalWorkActionId: readNullableString(row, "external_work_action_id"),
    workflowStepId: readNullableString(row, "workflow_step_id"),
    channelId: readNullableString(row, "channel_id"),
    toolCallId: readNullableString(row, "tool_call_id"),
    actionType: readString(row, "action_type") as ApprovalRequest["actionType"],
    risk: readString(row, "risk") as ApprovalRequest["risk"],
    title: readString(row, "title"),
    description: readString(row, "description"),
    payload: parseJsonObject(readString(row, "payload_json")) as ApprovalRequest["payload"],
    status: readString(row, "status") as ApprovalStatus,
    createdAt: readString(row, "created_at"),
    expiresAt: readNullableString(row, "expires_at"),
    resolvedAt: readNullableString(row, "resolved_at"),
    resolvedBy: readNullableString(row, "resolved_by") as ApprovalRequest["resolvedBy"],
    decisionReason: readNullableString(row, "decision_reason"),
    availableDecisions: parseApprovalDecisionKinds(readString(row, "available_decisions_json")),
    proposedCommandRule: parseApprovalCommandRuleProposal(readNullableString(row, "proposed_command_rule_json")),
    decisionKind: readNullableString(row, "decision_kind") as ApprovalRequest["decisionKind"],
    decisionRuleId: readNullableString(row, "decision_rule_id"),
  });
}

export function mapApprovalCommandRule(row: Record<string, SQLOutputValue>): ApprovalCommandRule {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    toolName: readString(row, "tool_name") as "bash",
    version: readNumber(row, "rule_version") as 1,
    prefix: parseJsonStringArray(readString(row, "prefix_tokens_json")),
    display: readString(row, "display"),
    fingerprint: readString(row, "fingerprint"),
    sourceApprovalId: readNullableString(row, "source_approval_id"),
    createdBy: readString(row, "created_by") as "local-user",
    createdAt: readString(row, "created_at"),
    revokedAt: readNullableString(row, "revoked_at"),
  });
}

function parseApprovalDecisionKinds(value: string): ApprovalDecisionKind[] {
  const parsed = parseJsonStringArray(value)
    .filter((item): item is ApprovalDecisionKind => (approvalDecisionKinds as readonly string[]).includes(item));
  return parsed.length > 0 ? parsed : ["approve_once", "deny"];
}

function parseApprovalCommandRuleProposal(value: string | undefined): ApprovalCommandRuleProposal | undefined {
  if (!value) return undefined;
  const parsed = parseJsonObject(value);
  const prefix = Array.isArray(parsed.prefix)
    ? parsed.prefix.filter((item): item is string => typeof item === "string")
    : [];
  if (
    parsed.version !== 1 ||
    prefix.length === 0 ||
    typeof parsed.display !== "string" ||
    typeof parsed.fingerprint !== "string" ||
    (parsed.cwd !== undefined && (typeof parsed.cwd !== "string" || !parsed.cwd))
  ) {
    return undefined;
  }
  return {
    prefix,
    display: parsed.display,
    fingerprint: parsed.fingerprint,
    version: 1,
    ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}),
  };
}

export function mapApprovalPolicy(row: Record<string, SQLOutputValue>): ApprovalPolicy {
  return {
    workspaceId: readString(row, "workspace_id"),
    toolDecisions: parseApprovalToolDecisions(readString(row, "tool_decisions_json")),
    allowedWritePaths: parseJsonStringArray(readString(row, "allowed_write_paths_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

export function mapMediaJob(row: Record<string, SQLOutputValue>): MediaJob {
  const sourceKind = readString(row, "source_kind");
  const providerPresetId = readNullableString(row, "provider_preset_id");
  const workflowVersionId = readNullableString(row, "workflow_version_id");
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    providerPresetId,
    workflowVersionId,
    executionSource: sourceKind === "workflow" && workflowVersionId
      ? { kind: "workflow" as const, workflowVersionId }
      : { kind: "provider" as const, providerPresetId: providerPresetId ?? "" },
    operation: readString(row, "operation") as MediaJob["operation"],
    prompt: readString(row, "prompt"),
    input: parseJsonObject(readString(row, "input_json")),
    artifactIds: parseJsonStringArray(readString(row, "artifact_ids_json")),
    status: readString(row, "status") as MediaJobStatus,
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function parseApprovalToolDecisions(value: string): ApprovalToolDecisions {
  const parsed = parseJsonObject(value);
  const decisions: Record<RunTool, ApprovalToolDecision> = { ...defaultApprovalToolDecisions };
  for (const tool of Object.keys(defaultApprovalToolDecisions) as RunTool[]) {
    const decision = parsed[tool];
    if (decision === "allow" || decision === "ask" || decision === "deny") {
      decisions[tool] = decision;
    }
  }
  return decisions;
}
