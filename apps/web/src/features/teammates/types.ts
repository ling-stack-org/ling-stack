import type { AiTeammate, SkillApprovalProfile, ToolName } from "../../types.js";

export type TeammateWizardStepId = "template" | "model" | "profile" | "placement";
export type TeammateTemplateFilter = "all" | "product" | "engineering" | "design" | "qa" | "security" | "docs";

export interface LocalTeammateDraft {
  readonly id: string;
  readonly workspaceId?: string;
  readonly templateId?: string;
  readonly kind?: AiTeammate["kind"];
  readonly systemRole?: AiTeammate["systemRole"];
  readonly protectedProfile?: boolean;
  readonly editableFields?: AiTeammate["editableFields"];
  readonly roleKey?: AiTeammate["roleKey"];
  readonly displayName: string;
  readonly description: string;
  readonly avatarTone?: string;
  readonly avatarImageAttachmentId?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt: readonly string[];
  readonly allowedTools: readonly ToolName[];
  readonly approvalProfile: SkillApprovalProfile;
  readonly status?: AiTeammate["status"];
  readonly modelLabel: string;
  readonly channelIds: readonly string[];
  readonly memorySources: readonly string[];
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly disabled: boolean;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface LocalTeammateCreateInput {
  readonly templateId?: string;
  readonly displayName: string;
  readonly description: string;
  readonly providerPresetId?: string;
  readonly modelLabel: string;
  readonly channelIds: readonly string[];
  readonly memorySources: readonly string[];
}
