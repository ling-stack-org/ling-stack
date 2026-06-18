import type { SQLOutputValue } from "node:sqlite";
import {
  type ChannelBrief,
  type ChannelContextSummary,
  type ChannelContextSummaryAuthorType,
  type ChannelContextSummaryTargetType,
  type ChannelDecision,
  type ChannelDecisionStatus,
  type ChannelHandoff,
  type ChannelHandoffStatus,
} from "../../workspace-types.js";
import {
  omitUndefined,
  parseJsonStringArray,
  readNullableString,
  readString,
} from "./helpers.js";

export function mapChannelBrief(row: Record<string, SQLOutputValue>): ChannelBrief {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    objective: readString(row, "objective"),
    scope: readString(row, "scope"),
    acceptanceCriteria: parseJsonStringArray(readString(row, "acceptance_criteria_json")),
    openQuestions: parseJsonStringArray(readString(row, "open_questions_json")),
    risks: parseJsonStringArray(readString(row, "risks_json")),
    decisionIds: parseJsonStringArray(readString(row, "decision_ids_json")),
    attachmentIds: parseJsonStringArray(readString(row, "attachment_ids_json")),
    linkPreviewIds: parseJsonStringArray(readString(row, "link_preview_ids_json")),
    updatedBy: readString(row, "updated_by"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

export function mapChannelDecision(row: Record<string, SQLOutputValue>): ChannelDecision {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceMessageId: readNullableString(row, "source_message_id"),
    sourceTaskId: readNullableString(row, "source_task_id"),
    sourceRunId: readNullableString(row, "source_run_id"),
    title: readString(row, "title"),
    decision: readString(row, "decision"),
    rationale: readString(row, "rationale"),
    alternatives: parseJsonStringArray(readString(row, "alternatives_json")),
    status: readString(row, "status") as ChannelDecisionStatus,
    supersedesDecisionId: readNullableString(row, "supersedes_decision_id"),
    createdBy: readString(row, "created_by"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapChannelHandoff(row: Record<string, SQLOutputValue>): ChannelHandoff {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceMessageId: readNullableString(row, "source_message_id"),
    sourceTaskId: readNullableString(row, "source_task_id"),
    sourceRunId: readNullableString(row, "source_run_id"),
    fromParticipantId: readString(row, "from_participant_id"),
    fromParticipantLabel: readString(row, "from_participant_label"),
    toParticipantId: readString(row, "to_participant_id"),
    toParticipantLabel: readString(row, "to_participant_label"),
    reason: readString(row, "reason"),
    requiredInput: readString(row, "required_input"),
    expectedOutput: readString(row, "expected_output"),
    status: readString(row, "status") as ChannelHandoffStatus,
    createdBy: readString(row, "created_by"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapChannelContextSummary(row: Record<string, SQLOutputValue>): ChannelContextSummary {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    targetType: readString(row, "target_type") as ChannelContextSummaryTargetType,
    targetId: readString(row, "target_id"),
    sourceMessageIds: parseJsonStringArray(readString(row, "source_message_ids_json")),
    decisionIds: parseJsonStringArray(readString(row, "decision_ids_json")),
    summary: readString(row, "summary"),
    acceptanceCriteria: parseJsonStringArray(readString(row, "acceptance_criteria_json")),
    openQuestions: parseJsonStringArray(readString(row, "open_questions_json")),
    authorType: readString(row, "author_type") as ChannelContextSummaryAuthorType,
    authorId: readNullableString(row, "author_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}
