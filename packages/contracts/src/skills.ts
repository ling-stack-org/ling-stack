import type { ToolName } from "./shared.js";
import type { SkillApprovalProfile } from "./approvals.js";
import type { ProviderCapability } from "./providers.js";
import type { AiTeammateRoleKey } from "./teammates.js";

export type TeammateSkillBindingSource = "template" | "user";

export interface TeammateSkillBinding {
  readonly teammateId: string;
  readonly skillId: string;
  readonly source: TeammateSkillBindingSource;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

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

export interface SkillDefinition {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly roleAffinity: readonly AiTeammateRoleKey[];
  readonly workflowPhase: SkillWorkflowPhase;
  readonly promptFragments: readonly string[];
  readonly requiredTools: readonly ToolName[];
  readonly requiredProviderCapabilities: readonly ProviderCapability[];
  readonly approvalProfile: SkillApprovalProfile;
  readonly stateEffects: readonly SkillStateEffect[];
}

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

export interface SkillRegistryListResponse {
  readonly cwd: string;
  readonly skills: readonly SkillRegistryEntry[];
}

export interface SkillRegistryRefreshResponse {
  readonly cwd: string;
  readonly refreshedAt: string;
  readonly registryGeneration: number;
  readonly skills: readonly SkillRegistryEntry[];
}

export interface SkillImportDraftRequest {
  readonly content: string;
  readonly source?: SkillPackSource;
  readonly sourcePath?: string;
  readonly name?: string;
}

export interface SkillImportDraftResponse {
  readonly cwd: string;
  readonly draft: SkillImportDraft;
}

export interface SkillImportPublishResponse {
  readonly cwd: string;
  readonly draftId: string;
  readonly skills: readonly SkillRegistryEntry[];
}

export interface SkillRegistryMutationResponse {
  readonly cwd: string;
  readonly skill: SkillRegistryEntry;
}

export type EffectiveSkillBlockedReasonCode =
  | "disabled_binding"
  | "missing_tools"
  | "missing_provider_capability"
  | "channel_policy"
  | "approval_mismatch";

export interface EffectiveSkillBlockedReason {
  readonly code: EffectiveSkillBlockedReasonCode;
  readonly message: string;
  readonly missing?: readonly string[];
}

export interface EffectiveTeammateSkill {
  readonly teammateId: string;
  readonly skillId: string;
  readonly skill: SkillDefinition;
  readonly binding: TeammateSkillBinding;
  readonly executable: boolean;
  readonly blockedReasons: readonly EffectiveSkillBlockedReason[];
  readonly promptFragments: readonly string[];
  readonly requiredTools: readonly ToolName[];
  readonly requiredProviderCapabilities: readonly ProviderCapability[];
}

export interface ReplaceTeammateSkillBindingsRequest {
  readonly bindings: readonly {
    readonly skillId: string;
    readonly source?: TeammateSkillBindingSource;
    readonly enabled?: boolean;
  }[];
}

export interface TeammateSkillBindingListResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly bindings: readonly TeammateSkillBinding[];
  readonly effectiveSkills?: readonly EffectiveTeammateSkill[];
}
