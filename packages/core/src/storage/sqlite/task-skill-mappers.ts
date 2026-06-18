import type { SQLOutputValue } from "node:sqlite";
import {
  type SkillImportDraft,
  type SkillImportDraftDefinition,
  type SkillPackSource,
  type SkillRegistryEntry,
  type SkillRegistryReviewStatus,
  type SkillVisibility,
} from "../../skill-types.js";
import { type Task, type TaskStatus } from "../../workspace-types.js";
import {
  omitUndefined,
  parseJson,
  parseJsonObject,
  readNullableString,
  readString,
} from "./helpers.js";

export function mapTask(row: Record<string, SQLOutputValue>): Task {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    title: readString(row, "title"),
    prompt: readString(row, "prompt"),
    status: readString(row, "status") as TaskStatus,
    assigneeTeammateId: readNullableString(row, "assignee_teammate_id"),
    requestedSkillId: readNullableString(row, "requested_skill_id"),
    currentRunId: readNullableString(row, "current_run_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapSkillRegistryEntry(row: Record<string, SQLOutputValue>): SkillRegistryEntry {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    packId: readString(row, "pack_id"),
    source: readString(row, "source") as SkillPackSource,
    sourcePath: readNullableString(row, "source_path"),
    version: readNullableString(row, "version"),
    checksum: readNullableString(row, "checksum"),
    definition: parseJson(readString(row, "definition_json")) as SkillRegistryEntry["definition"],
    visibility: parseSkillVisibility(readString(row, "visibility_json")),
    reviewStatus: readString(row, "review_status") as SkillRegistryReviewStatus,
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapSkillImportDraft(row: Record<string, SQLOutputValue>): SkillImportDraft {
  const draft = parseJsonObject(readString(row, "draft_json"));
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    source: readString(row, "source") as SkillPackSource,
    sourcePath: readNullableString(row, "source_path"),
    packId: typeof draft.packId === "string" ? draft.packId : undefined,
    name: typeof draft.name === "string" ? draft.name : "Imported skills",
    version: typeof draft.version === "string" ? draft.version : undefined,
    description: typeof draft.description === "string" ? draft.description : "",
    definitions: Array.isArray(draft.definitions) ? draft.definitions as SkillImportDraftDefinition[] : [],
    warnings: parseJson(readString(row, "warnings_json")) as SkillImportDraft["warnings"],
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function parseSkillVisibility(value: string): SkillVisibility {
  const parsed = parseJsonObject(value);
  return omitUndefined({
    workspaceVisible: typeof parsed.workspaceVisible === "boolean" ? parsed.workspaceVisible : true,
    ownerTeammateId: typeof parsed.ownerTeammateId === "string" ? parsed.ownerTeammateId : undefined,
    promotableToWorkspace: typeof parsed.promotableToWorkspace === "boolean" ? parsed.promotableToWorkspace : true,
  });
}
