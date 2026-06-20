import type { SQLOutputValue } from "node:sqlite";
import type {
  ChannelPlaybookCandidate,
  ChannelPlaybookCandidateCreatedBy,
  ChannelPlaybookCandidateStatus,
} from "../../workspace-types.js";
import type {
  ProcedureObservationStep,
  ProcedureObservationValidationStep,
} from "../../procedure-observation-types.js";
import type { SkillCandidateSourceRef } from "../../skill-candidate-types.js";
import {
  omitUndefined,
  parseJson,
  parseJsonStringArray,
  readNullableString,
  readString,
} from "./helpers.js";

export function mapChannelPlaybookCandidate(row: Record<string, SQLOutputValue>): ChannelPlaybookCandidate {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    title: readString(row, "title"),
    summary: readString(row, "summary"),
    normalizedGoal: readString(row, "normalized_goal"),
    procedureSteps: parseProcedureSteps(readString(row, "procedure_steps_json")),
    validationSteps: parseValidationSteps(readString(row, "validation_steps_json")),
    positiveTriggers: parseJsonStringArray(readString(row, "positive_triggers_json")),
    negativeTriggers: parseJsonStringArray(readString(row, "negative_triggers_json")),
    sourceRefs: parseSourceRefs(readString(row, "source_refs_json")),
    reason: readString(row, "reason"),
    createdBy: readString(row, "created_by") as ChannelPlaybookCandidateCreatedBy,
    status: readString(row, "status") as ChannelPlaybookCandidateStatus,
    activatedAt: readNullableString(row, "activated_at"),
    expiresAt: readNullableString(row, "expires_at"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function parseProcedureSteps(value: string): readonly ProcedureObservationStep[] {
  return parseJsonArray(value).map((item) => {
    if (!isRecord(item)) {
      throw new Error("Expected channel playbook procedure step object from SQLite");
    }
    return omitUndefined({
      title: readRecordString(item, "title"),
      instruction: readOptionalString(item.instruction),
      requiredTools: Array.isArray(item.requiredTools) ? item.requiredTools.map(String) : undefined,
      expectedEvidence: readOptionalString(item.expectedEvidence),
    });
  });
}

function parseValidationSteps(value: string): readonly ProcedureObservationValidationStep[] {
  return parseJsonArray(value).map((item) => {
    if (!isRecord(item)) {
      throw new Error("Expected channel playbook validation step object from SQLite");
    }
    return omitUndefined({
      title: readRecordString(item, "title"),
      commandOrCheck: readOptionalString(item.commandOrCheck),
      expectedResult: readOptionalString(item.expectedResult),
    });
  });
}

function parseSourceRefs(value: string): readonly SkillCandidateSourceRef[] {
  return parseJsonArray(value).map((item) => {
    if (!isRecord(item)) {
      throw new Error("Expected channel playbook source ref object from SQLite");
    }
    return omitUndefined({
      type: readRecordString(item, "type") as SkillCandidateSourceRef["type"],
      id: readRecordString(item, "id"),
      label: readOptionalString(item.label),
      url: readOptionalString(item.url),
    });
  });
}

function parseJsonArray(value: string): readonly unknown[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected JSON array from SQLite");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected non-empty string field ${key} from SQLite`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
