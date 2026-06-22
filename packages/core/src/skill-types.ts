import { randomUUID } from "node:crypto";
import type { ApprovalActionType, ApprovalRisk } from "./approval-types.js";
import type { RunTool } from "./approval-policy.js";
import type { ProviderCapability } from "./provider-types.js";

export type SkillPackSource = "builtin" | "gstack" | "workspace" | "skill-directory" | "agents-md" | "custom";
export type SkillRegistryReviewStatus = "builtin" | "draft" | "published" | "disabled" | "archived";
export type SkillImportWarningSeverity = "info" | "warning" | "error";
export type SkillSourceKind =
  | "gstack-skill-directory"
  | "codex-skill-directory"
  | "workspace-skill-directory"
  | "manual-markdown";
export type SkillSourceSnapshotReviewStatus = "draft" | "reviewed" | "published" | "archived";
export type SkillSourceFileKind = "script" | "asset" | "reference" | "agent-metadata" | "other";
export type SkillSourceWarningSeverity = "info" | "warning" | "error";
export type SkillSourceWarningCode =
  | "permission_like_instruction"
  | "secret_reference"
  | "external_send_claim"
  | "destructive_command"
  | "host_specific_tool"
  | "unsupported_tool"
  | "large_source"
  | "source_truncated"
  | "missing_metadata"
  | "drifted_upstream"
  | "missing_upstream"
  | "orphaned_snapshot";
export type SkillSourceSyncRecordState =
  | "attachable"
  | "unchanged"
  | "drifted"
  | "new"
  | "missing"
  | "blocked"
  | "orphaned";
export type SkillSourceSyncDiffField =
  | "sourceChecksum"
  | "upstreamVersion"
  | "upstreamSkillPath"
  | "sourceLengthChars"
  | "referencedFiles"
  | "warnings"
  | "frontMatterName"
  | "frontMatterDescription"
  | "agentDisplayName"
  | "agentShortDescription"
  | "agentAllowImplicitInvocation";
export type SkillImportWarningCode =
  | "permission_like_instruction"
  | "secret_reference"
  | "external_send_claim"
  | "unknown_tool"
  | "unknown_provider_capability"
  | "unsupported_section"
  | "missing_metadata"
  | "duplicate_skill_id";

export type AiTeammateRoleKey =
  | "product"
  | "architect"
  | "engineer"
  | "designer"
  | "qa"
  | "security"
  | "release"
  | "docs"
  | "custom";

export type SkillWorkflowPhase =
  | "discover"
  | "plan"
  | "design"
  | "implement"
  | "review"
  | "test"
  | "secure"
  | "ship"
  | "document"
  | "operate";

export type SkillStateEffect =
  | "creates_plan"
  | "updates_plan"
  | "creates_task"
  | "updates_task"
  | "starts_run"
  | "requests_approval"
  | "creates_artifact"
  | "updates_docs"
  | "prepares_release";

export type SkillApprovalMode = "none" | "standard" | "strict";

export interface SkillApprovalProfile {
  readonly mode: SkillApprovalMode;
  readonly risk?: ApprovalRisk;
  readonly requiredForTools?: readonly RunTool[];
  readonly requiredForActions?: readonly ApprovalActionType[];
}

export interface SkillDefinition {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly roleAffinity: readonly AiTeammateRoleKey[];
  readonly workflowPhase: SkillWorkflowPhase;
  readonly promptFragments: readonly string[];
  readonly requiredTools: readonly RunTool[];
  readonly requiredProviderCapabilities: readonly ProviderCapability[];
  readonly approvalProfile: SkillApprovalProfile;
  readonly stateEffects: readonly SkillStateEffect[];
}

export interface AiTeammateTemplate {
  readonly id: string;
  readonly name: string;
  readonly roleKey: AiTeammateRoleKey;
  readonly summary: string;
  readonly defaultSkillIds: readonly string[];
  readonly allowedTools: readonly RunTool[];
  readonly requiredProviderCapabilities: readonly ProviderCapability[];
  readonly approvalProfile: SkillApprovalProfile;
  readonly systemPrompt: string;
}

export interface WorkflowStepTemplate {
  readonly id: string;
  readonly name: string;
  readonly phase: SkillWorkflowPhase;
  readonly teammateTemplateId: string;
  readonly councilSlotKey?: string;
  readonly skillId: string;
  readonly dependsOn?: readonly string[];
  readonly approvalGate?: SkillApprovalProfile;
}

export interface WorkflowTemplate {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly steps: readonly WorkflowStepTemplate[];
}

export interface SkillPack {
  readonly id: string;
  readonly source: SkillPackSource;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly skills: readonly SkillDefinition[];
  readonly teammateTemplates: readonly AiTeammateTemplate[];
  readonly workflowTemplates: readonly WorkflowTemplate[];
}

export interface SkillVisibility {
  readonly workspaceVisible: boolean;
  readonly ownerTeammateId?: string;
  readonly promotableToWorkspace: boolean;
}

export interface SkillRegistryEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly packId: string;
  readonly source: SkillPackSource;
  readonly sourcePath?: string;
  readonly version?: string;
  readonly checksum?: string;
  readonly definition: SkillDefinition;
  readonly visibility: SkillVisibility;
  readonly reviewStatus: SkillRegistryReviewStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SkillAgentMetadata {
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly defaultPrompt?: string;
  readonly allowImplicitInvocation?: boolean;
}

export interface SkillSourceFileRef {
  readonly path: string;
  readonly kind: SkillSourceFileKind;
  readonly checksum?: string;
  readonly sizeBytes?: number;
  readonly includedInSnapshot: boolean;
}

export interface SkillSourceWarning {
  readonly code: SkillSourceWarningCode;
  readonly severity: SkillSourceWarningSeverity;
  readonly message: string;
  readonly location?: string;
}

export interface SkillSourceSyncDiffItem {
  readonly field: SkillSourceSyncDiffField;
  readonly label: string;
  readonly before?: string;
  readonly after?: string;
  readonly severity: SkillSourceWarningSeverity;
}

export interface SkillSourceSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly skillId: string;
  readonly sourceKind: SkillSourceKind;
  readonly sourcePath?: string;
  readonly upstreamName?: string;
  readonly upstreamVersion?: string;
  readonly upstreamSkillPath?: string;
  readonly sourceChecksum: string;
  readonly rawSkillMarkdown: string;
  readonly agentMetadata?: SkillAgentMetadata;
  readonly referencedFiles: readonly SkillSourceFileRef[];
  readonly warnings: readonly SkillSourceWarning[];
  readonly reviewStatus: SkillSourceSnapshotReviewStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SkillSourceScanRoot {
  readonly rootPath: string;
  readonly sourceKind: SkillSourceKind;
  readonly label?: string;
  readonly upstreamName?: string;
  readonly upstreamVersion?: string;
}

export interface SkillSourceFrontMatter {
  readonly name?: string;
  readonly description?: string;
}

export interface SkillSourceSyncPreviewRecord {
  readonly state: SkillSourceSyncRecordState;
  readonly skillId: string;
  readonly sourceKind?: SkillSourceKind;
  readonly sourcePath?: string;
  readonly upstreamName?: string;
  readonly upstreamVersion?: string;
  readonly upstreamSkillPath?: string;
  readonly sourceChecksum?: string;
  readonly sourceSizeBytes?: number;
  readonly frontMatter?: SkillSourceFrontMatter;
  readonly agentMetadata?: SkillAgentMetadata;
  readonly referencedFiles: readonly SkillSourceFileRef[];
  readonly warnings: readonly SkillSourceWarning[];
  readonly definitionPreview?: SkillDefinition;
  readonly snapshotPreview?: CreateSkillSourceSnapshotInput;
  readonly existingSnapshotId?: string;
  readonly diff: readonly SkillSourceSyncDiffItem[];
}

export interface SkillSourceSyncPreviewSummary {
  readonly totalRecords: number;
  readonly attachable: number;
  readonly unchanged: number;
  readonly drifted: number;
  readonly new: number;
  readonly missing: number;
  readonly blocked: number;
  readonly orphaned: number;
}

export interface SkillSourceSyncPreviewReport {
  readonly generatedAt: string;
  readonly roots: readonly SkillSourceScanRoot[];
  readonly upstreamVersions: readonly string[];
  readonly summary: SkillSourceSyncPreviewSummary;
  readonly records: readonly SkillSourceSyncPreviewRecord[];
}

export interface SkillSourceRuntimeContext {
  readonly loaded: boolean;
  readonly snapshotId: string;
  readonly skillId: string;
  readonly sourceKind: SkillSourceKind;
  readonly sourcePath?: string;
  readonly upstreamName?: string;
  readonly upstreamVersion?: string;
  readonly upstreamSkillPath?: string;
  readonly sourceChecksum: string;
  readonly sourceLengthChars: number;
  readonly loadedChars: number;
  readonly maxLoadedChars: number;
  readonly truncated: boolean;
  readonly warningCount: number;
  readonly warningSeverities: readonly SkillSourceWarningSeverity[];
  readonly referencedFiles: readonly SkillSourceFileRef[];
  readonly blockedReason?: string;
}

export interface SkillSourceRuntimePrompt {
  readonly context: SkillSourceRuntimeContext;
  readonly promptFragment?: string;
}

export interface CreateSkillSourceSnapshotInput {
  readonly id?: string;
  readonly skillId: string;
  readonly sourceKind: SkillSourceKind;
  readonly sourcePath?: string;
  readonly upstreamName?: string;
  readonly upstreamVersion?: string;
  readonly upstreamSkillPath?: string;
  readonly sourceChecksum: string;
  readonly rawSkillMarkdown: string;
  readonly agentMetadata?: SkillAgentMetadata;
  readonly referencedFiles?: readonly SkillSourceFileRef[];
  readonly warnings?: readonly SkillSourceWarning[];
  readonly reviewStatus?: SkillSourceSnapshotReviewStatus;
}

export interface ListSkillSourceSnapshotOptions {
  readonly skillId?: string;
  readonly sourceKind?: SkillSourceKind;
  readonly reviewStatus?: SkillSourceSnapshotReviewStatus;
  readonly includeArchived?: boolean;
}

export interface SkillImportWarning {
  readonly code: SkillImportWarningCode;
  readonly severity: SkillImportWarningSeverity;
  readonly message: string;
  readonly location?: string;
}

export interface SkillImportDraftDefinition {
  readonly definition: SkillDefinition;
  readonly visibility?: SkillVisibility;
  readonly warnings?: readonly SkillImportWarning[];
}

export interface SkillImportDraft {
  readonly id: string;
  readonly workspaceId: string;
  readonly source: SkillPackSource;
  readonly sourcePath?: string;
  readonly packId?: string;
  readonly name: string;
  readonly version?: string;
  readonly description: string;
  readonly definitions: readonly SkillImportDraftDefinition[];
  readonly warnings: readonly SkillImportWarning[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSkillImportDraftInput {
  readonly id?: string;
  readonly source: SkillPackSource;
  readonly sourcePath?: string;
  readonly packId?: string;
  readonly name: string;
  readonly version?: string;
  readonly description: string;
  readonly definitions: readonly SkillImportDraftDefinition[];
  readonly warnings?: readonly SkillImportWarning[];
}

export interface ListSkillRegistryOptions {
  readonly includeArchived?: boolean;
  readonly includeDisabled?: boolean;
}

export function createSkillPackId(): string {
  return `skill_pack_${cryptoRandomId()}`;
}

export function createSkillImportDraftId(): string {
  return `skill_draft_${cryptoRandomId()}`;
}

export function createSkillSourceSnapshotId(): string {
  return `skill_source_${cryptoRandomId()}`;
}

function cryptoRandomId(): string {
  return randomUUID().replaceAll("-", "");
}
