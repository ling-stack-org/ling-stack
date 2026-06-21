import { randomUUID } from "node:crypto";
import type { ApprovalActionType, ApprovalRisk } from "./approval-types.js";
import type { RunTool } from "./approval-policy.js";
import type { ProviderCapability } from "./provider-types.js";

export type SkillPackSource = "builtin" | "gstack" | "workspace" | "skill-directory" | "agents-md" | "custom";
export type SkillRegistryReviewStatus = "builtin" | "draft" | "published" | "disabled" | "archived";
export type SkillImportWarningSeverity = "info" | "warning" | "error";
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

function cryptoRandomId(): string {
  return randomUUID().replaceAll("-", "");
}
