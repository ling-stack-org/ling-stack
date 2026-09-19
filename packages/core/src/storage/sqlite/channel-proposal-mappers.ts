import type { SQLOutputValue } from "node:sqlite";
import {
  isWorkflowParticipantProviderBlockerV1,
} from "@ling-stack/contracts";
import {
  type ChannelExecutionProposal,
  type ChannelExecutionProposalStepSource,
  type ChannelExecutionProposalStatus,
  type ChannelProtocolSourceRef,
  type ChannelProtocolSourceRefType,
  type ChannelRequirementShaping,
  type ResponseLanguage,
} from "../../workspace-types.js";
import {
  isJsonRecord,
  omitUndefined,
  parseJson,
  parseJsonStringArray,
  readNullableString,
  readString,
} from "./helpers.js";

export function mapChannelExecutionProposal(row: Record<string, SQLOutputValue>): ChannelExecutionProposal {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceMessageId: readString(row, "source_message_id"),
    proposedByTeammateId: readString(row, "proposed_by_teammate_id"),
    title: readString(row, "title"),
    prompt: readString(row, "prompt"),
    assigneeTeammateId: readString(row, "assignee_teammate_id"),
    acceptanceCriteria: parseJsonStringArray(readString(row, "acceptance_criteria_json")),
    collaborationSteps: parseChannelExecutionProposalSteps(readString(row, "collaboration_steps_json")),
    requiredTools: parseJsonStringArray(readString(row, "required_tools_json")) as ChannelExecutionProposal["requiredTools"],
    riskSummary: readNullableString(row, "risk_summary"),
    responseLanguage: parseOptionalResponseLanguage(readNullableString(row, "response_language")),
    shaping: parseOptionalChannelRequirementShaping(readNullableString(row, "shaping_json")),
    status: readString(row, "status") as ChannelExecutionProposalStatus,
    linkedTaskId: readNullableString(row, "linked_task_id"),
    linkedRunId: readNullableString(row, "linked_run_id"),
    linkedWorkflowId: readNullableString(row, "linked_workflow_id"),
    errorMessage: readNullableString(row, "error_message"),
    blocker: parseOptionalProposalBlocker(readNullableString(row, "blocker_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function parseOptionalProposalBlocker(value: string | undefined): ChannelExecutionProposal["blocker"] {
  if (!value) return undefined;
  const parsed = parseJson(value);
  if (!isWorkflowParticipantProviderBlockerV1(parsed)) {
    throw new Error("Invalid channel execution proposal blocker from SQLite");
  }
  return parsed;
}

function parseChannelExecutionProposalSteps(value: string): ChannelExecutionProposal["collaborationSteps"] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected channel execution proposal steps array from SQLite");
  }
  return parsed.map((item) => {
    if (!isJsonRecord(item) || typeof item.teammateId !== "string" || typeof item.summary !== "string") {
      throw new Error("Expected channel execution proposal step from SQLite");
    }
    if (
      item.action !== "coordinated" &&
      item.action !== "consulted" &&
      item.action !== "reviewed" &&
      item.action !== "flagged_risk"
    ) {
      throw new Error("Expected channel execution proposal step action from SQLite");
    }
    const sources = parseChannelExecutionProposalStepSources(item.sources);
    return {
      teammateId: item.teammateId,
      action: item.action,
      summary: item.summary,
      ...(sources ? { sources } : {}),
    };
  });
}

function parseChannelExecutionProposalStepSources(value: unknown): readonly ChannelExecutionProposalStepSource[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const sources: ChannelExecutionProposalStepSource[] = [];
  for (const item of value) {
    if (!isJsonRecord(item)) {
      continue;
    }
    const kind = item.kind;
    if (kind !== "direct" && kind !== "council") {
      continue;
    }
    const councilId = readOptionalJsonString(item.councilId);
    const councilDisplayName = readOptionalJsonString(item.councilDisplayName);
    const slotKey = readOptionalJsonString(item.slotKey);
    const label = readOptionalJsonString(item.label);
    const source: ChannelExecutionProposalStepSource = {
      kind,
      ...(councilId ? { councilId } : {}),
      ...(councilDisplayName ? { councilDisplayName } : {}),
      ...(slotKey ? { slotKey } : {}),
      ...(label ? { label } : {}),
      ...(typeof item.isDefault === "boolean" ? { isDefault: item.isDefault } : {}),
    };
    sources.push(source);
  }
  return sources.length > 0 ? sources : undefined;
}

function parseOptionalResponseLanguage(value: unknown): ResponseLanguage | undefined {
  return value === "zh-CN" || value === "en-US" ? value : undefined;
}

function parseOptionalChannelRequirementShaping(value: string | undefined): ChannelRequirementShaping | undefined {
  if (!value) {
    return undefined;
  }
  return normalizeChannelRequirementShaping(parseJson(value));
}

function normalizeChannelRequirementShaping(value: unknown): ChannelRequirementShaping | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }
  const status = readOptionalStringValue(value.status);
  if (!isChannelRequirementShapingStatusValue(status)) {
    return undefined;
  }
  return omitUndefined({
    status,
    summary: readOptionalStringValue(value.summary),
    openQuestions: readOptionalStringListValue(value.openQuestions) ?? [],
    clarifications: normalizeChannelRequirementShapingClarifications(value.clarifications),
    sourceRefs: Array.isArray(value.sourceRefs) ? normalizeChannelProtocolSourceRefs(value.sourceRefs) : [],
    updatedAt: readOptionalStringValue(value.updatedAt),
  });
}

function normalizeChannelRequirementShapingClarifications(value: unknown): ChannelRequirementShaping["clarifications"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isJsonRecord(item)) {
      return [];
    }
    const authorType = readOptionalStringValue(item.authorType);
    const body = readOptionalStringValue(item.body);
    const createdAt = readOptionalStringValue(item.createdAt);
    const id = readOptionalStringValue(item.id);
    if (!isChannelRequirementShapingClarificationAuthorValue(authorType) || !body?.trim() || !createdAt?.trim() || !id?.trim()) {
      return [];
    }
    return [omitUndefined({
      id,
      authorType,
      authorId: readOptionalStringValue(item.authorId),
      body,
      sourceMessageId: readOptionalStringValue(item.sourceMessageId),
      createdAt,
    })];
  });
}

function normalizeChannelProtocolSourceRefs(value: readonly unknown[]): ChannelProtocolSourceRef[] {
  return value.flatMap((item) => {
    if (!isJsonRecord(item) || !isChannelProtocolSourceRefTypeValue(item.type) || typeof item.id !== "string" || item.id.trim().length === 0) {
      return [];
    }
    return [omitUndefined({
      type: item.type,
      id: item.id,
      label: readOptionalStringValue(item.label),
    })];
  });
}

function readOptionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readOptionalJsonString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readOptionalStringListValue(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : undefined;
}

function isChannelRequirementShapingStatusValue(value: unknown): value is ChannelRequirementShaping["status"] {
  return value === "collecting_context" ||
    value === "collecting_teammate_input" ||
    value === "needs_user_clarification" ||
    value === "ready_for_confirmation" ||
    value === "converted_to_task" ||
    value === "dismissed";
}

function isChannelRequirementShapingClarificationAuthorValue(value: unknown): value is ChannelRequirementShaping["clarifications"][number]["authorType"] {
  return value === "local-user" || value === "ai-teammate" || value === "system";
}

function isChannelProtocolSourceRefTypeValue(value: unknown): value is ChannelProtocolSourceRefType {
  return (
    value === "message" ||
    value === "channel_decision" ||
    value === "context_summary" ||
    value === "task" ||
    value === "run" ||
    value === "workflow" ||
    value === "workflow_step"
  );
}
