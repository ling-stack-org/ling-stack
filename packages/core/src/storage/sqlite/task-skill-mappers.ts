import type { SQLOutputValue } from "node:sqlite";
import {
  type SkillCompiledRuntimeViewRecord,
  type SkillCompiledRuntimeViewReviewStatus,
  type SkillImportDraft,
  type SkillImportDraftDefinition,
  type SkillPackSource,
  type SkillRegistryEntry,
  type SkillRegistryReviewStatus,
  type SkillSourceArtifact,
  type SkillSourceArtifactReviewStatus,
  type SkillSourceKind,
  type SkillSourceSnapshot,
  type SkillSourceSnapshotReviewStatus,
  type SkillSourceUpgradeMode,
  type SkillSourceUpgradePolicy,
  type SkillVisibility,
} from "../../skill-types.js";
import type { OfficialSkillSourceSubscription } from "../../managed-official-skill-source-types.js";
import { type Task, type TaskStatus } from "../../workspace-types.js";
import {
  omitUndefined,
  parseJson,
  parseJsonObject,
  parseJsonStringArray,
  readBoolean,
  readNullableString,
  readNumber,
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
    attachmentIds: parseJsonStringArray(readString(row, "attachment_ids_json")),
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
    definition: parseSkillDefinition(readString(row, "definition_json")),
    visibility: parseSkillVisibility(readString(row, "visibility_json")),
    reviewStatus: readString(row, "review_status") as SkillRegistryReviewStatus,
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function parseSkillDefinition(value: string): SkillRegistryEntry["definition"] {
  const parsed = parseJsonObject(value);
  const { workflowPhase: _legacyWorkflowPhase, ...definition } = parsed;
  return definition as unknown as SkillRegistryEntry["definition"];
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
    definitions: Array.isArray(draft.definitions) ? draft.definitions.map(parseSkillImportDraftDefinition) : [],
    warnings: parseJson(readString(row, "warnings_json")) as SkillImportDraft["warnings"],
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function parseSkillImportDraftDefinition(value: unknown): SkillImportDraftDefinition {
  if (!isRecord(value) || !isRecord(value.definition)) {
    return value as SkillImportDraftDefinition;
  }
  const { workflowPhase: _legacyWorkflowPhase, ...definition } = value.definition;
  return { ...value, definition } as unknown as SkillImportDraftDefinition;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapSkillSourceSnapshot(row: Record<string, SQLOutputValue>): SkillSourceSnapshot {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    skillId: readString(row, "skill_id"),
    sourceKind: readString(row, "source_kind") as SkillSourceKind,
    sourcePath: readNullableString(row, "source_path"),
    upstreamName: readNullableString(row, "upstream_name"),
    upstreamVersion: readNullableString(row, "upstream_version"),
    upstreamSkillPath: readNullableString(row, "upstream_skill_path"),
    bundleUpdateMode: readNullableString(row, "bundle_update_mode") as SkillSourceSnapshot["bundleUpdateMode"],
    sourceChecksum: readString(row, "source_checksum"),
    rawSkillMarkdown: readString(row, "raw_skill_markdown"),
    rawSkillMarkdownArtifactId: readNullableString(row, "raw_skill_markdown_artifact_id"),
    agentMetadata: parseOptionalSkillAgentMetadata(readString(row, "agent_metadata_json")),
    referencedFiles: parseJson(readString(row, "referenced_files_json")) as SkillSourceSnapshot["referencedFiles"],
    warnings: parseJson(readString(row, "warnings_json")) as SkillSourceSnapshot["warnings"],
    reviewStatus: readString(row, "review_status") as SkillSourceSnapshotReviewStatus,
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapOfficialSkillSourceSubscription(row: Record<string, SQLOutputValue>): OfficialSkillSourceSubscription {
  return omitUndefined({
    workspaceId: readString(row, "workspace_id"),
    sourceId: readString(row, "source_id") as OfficialSkillSourceSubscription["sourceId"],
    originUrl: readString(row, "origin_url"),
    ref: readString(row, "ref"),
    revision: readNullableString(row, "revision"),
    version: readNullableString(row, "version"),
    lastSyncedAt: readNullableString(row, "last_synced_at"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapSkillSourceArtifact(row: Record<string, SQLOutputValue>): SkillSourceArtifact {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    snapshotId: readString(row, "snapshot_id"),
    path: readString(row, "path"),
    kind: readString(row, "kind") as SkillSourceArtifact["kind"],
    checksum: readString(row, "checksum"),
    sizeBytes: readNumber(row, "size_bytes"),
    storageRef: readString(row, "storage_ref"),
    mediaType: readNullableString(row, "media_type"),
    reviewStatus: readString(row, "review_status") as SkillSourceArtifactReviewStatus,
    includedInRuntime: readBoolean(row, "included_in_runtime"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapSkillCompiledRuntimeView(row: Record<string, SQLOutputValue>): SkillCompiledRuntimeViewRecord {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    skillId: readString(row, "skill_id"),
    sourceSnapshotId: readString(row, "source_snapshot_id"),
    createdAt: readString(row, "created_at"),
    compilerVersion: readString(row, "compiler_version"),
    coreRulesMarkdown: readString(row, "core_rules_markdown"),
    lazyReferences: parseJson(readString(row, "lazy_references_json")) as SkillCompiledRuntimeViewRecord["lazyReferences"],
    sourceMap: parseJson(readString(row, "source_map_json")) as SkillCompiledRuntimeViewRecord["sourceMap"],
    tokenEstimate: readNumber(row, "token_estimate"),
    fallbackPolicy: readString(row, "fallback_policy") as SkillCompiledRuntimeViewRecord["fallbackPolicy"],
    authorityBoundary: parseJson(readString(row, "authority_boundary_json")) as SkillCompiledRuntimeViewRecord["authorityBoundary"],
    reviewStatus: readString(row, "review_status") as SkillCompiledRuntimeViewReviewStatus,
    updatedAt: readString(row, "updated_at"),
  };
}

export function mapSkillSourceUpgradePolicy(row: Record<string, SQLOutputValue>): SkillSourceUpgradePolicy {
  return omitUndefined({
    workspaceId: readString(row, "workspace_id"),
    mode: readString(row, "mode") as SkillSourceUpgradeMode,
    approvedRootIds: parseJsonStringArray(readString(row, "approved_root_ids_json")),
    allowNewSkills: readBoolean(row, "allow_new_skills"),
    allowGlobalGstackUpgrade: false as const,
    lastCheckedAt: readNullableString(row, "last_checked_at"),
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

function parseOptionalSkillAgentMetadata(value: string): SkillSourceSnapshot["agentMetadata"] {
  const parsed = parseJson(value);
  if (parsed === null || parsed === undefined) {
    return undefined;
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  return omitUndefined({
    displayName: typeof record.displayName === "string" ? record.displayName : undefined,
    shortDescription: typeof record.shortDescription === "string" ? record.shortDescription : undefined,
    defaultPrompt: typeof record.defaultPrompt === "string" ? record.defaultPrompt : undefined,
    allowImplicitInvocation: typeof record.allowImplicitInvocation === "boolean" ? record.allowImplicitInvocation : undefined,
  });
}
