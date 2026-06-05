export type TeammateWizardStepId = "template" | "model" | "profile" | "placement";
export type TeammateTemplateFilter = "all" | "product" | "engineering" | "design" | "qa" | "security" | "docs";

export interface LocalTeammateDraft {
  readonly id: string;
  readonly templateId?: string;
  readonly displayName: string;
  readonly description: string;
  readonly providerPresetId?: string;
  readonly modelLabel: string;
  readonly channelIds: readonly string[];
  readonly memorySources: readonly string[];
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly disabled: boolean;
  readonly createdAt: string;
}

export type LocalTeammateCreateInput = Omit<LocalTeammateDraft, "id" | "createdAt" | "pinned" | "hidden" | "disabled">;
