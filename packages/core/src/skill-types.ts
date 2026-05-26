import type { ApprovalActionType, ApprovalRisk } from "./approval-types.js";
import type { RunTool } from "./approval-policy.js";
import type { ProviderCapability } from "./provider-types.js";

export type SkillPackSource = "builtin" | "gstack" | "agents-md" | "custom";

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
