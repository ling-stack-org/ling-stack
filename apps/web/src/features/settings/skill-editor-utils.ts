import type {
  ApprovalActionType,
  ApprovalRisk,
  ProviderCapability,
  SkillApprovalMode,
  SkillApprovalProfile,
  SkillEditableDefinition,
  SkillImportDraft,
  SkillImportDraftRequest,
  SkillRegistryEntry,
  ToolName,
} from "../../types.js";

export type SkillEditorMode = "create" | "candidate" | "revision";

export interface SkillEditorForm {
  readonly name: string;
  readonly summary: string;
  readonly promptFragments: readonly string[];
  readonly requiredTools: readonly ToolName[];
  readonly requiredProviderCapabilities: readonly ProviderCapability[];
  readonly approvalMode: SkillApprovalMode;
  readonly approvalRisk: ApprovalRisk | "";
  readonly approvalRequiredForTools: readonly ToolName[];
  readonly approvalRequiredForActions: readonly ApprovalActionType[];
}

export interface SkillEditorPreservedDefinition {
  readonly skillId?: string;
  readonly roleAffinity: SkillRegistryEntry["definition"]["roleAffinity"];
  readonly stateEffects: SkillRegistryEntry["definition"]["stateEffects"];
}

export interface SkillEditorSeed {
  readonly form: SkillEditorForm;
  readonly preserved: SkillEditorPreservedDefinition;
}

export const skillEditorToolOptions: readonly ToolName[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];
export const skillEditorProviderCapabilityOptions: readonly ProviderCapability[] = [
  "chat",
  "tool_call",
  "reasoning",
  "vision",
  "web_search",
  "embedding",
  "image_generate",
  "image_edit",
  "video_generate",
  "tts",
  "asr",
];
export const skillEditorApprovalActionOptions: readonly ApprovalActionType[] = [
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "bash",
  "git_commit",
  "git_push",
  "external_send",
  "deploy",
  "media_cost",
  "credential_change",
  "provider_change",
  "workflow_step",
  "mcp_tool_call",
  "host_capability",
  "runtime_permission_request",
];

export function emptySkillEditorSeed(): SkillEditorSeed {
  return {
    form: {
      name: "",
      summary: "",
      promptFragments: [""],
      requiredTools: ["read", "grep", "find", "ls"],
      requiredProviderCapabilities: ["chat", "reasoning"],
      approvalMode: "none",
      approvalRisk: "",
      approvalRequiredForTools: [],
      approvalRequiredForActions: [],
    },
    preserved: {
      roleAffinity: ["custom"],
      stateEffects: [],
    },
  };
}

export function skillEditorSeedFromSkill(skill: SkillRegistryEntry): SkillEditorSeed {
  return skillEditorSeedFromDefinition(skill.definition, { stripSourceFrontmatter: skill.source === "skill-directory" });
}

export function skillEditorSeedFromDraft(draft: SkillImportDraft): SkillEditorSeed {
  const definition = draft.definitions[0]?.definition;
  return definition ? skillEditorSeedFromDefinition(definition) : emptySkillEditorSeed();
}

export function skillEditableDefinitionFromForm(form: SkillEditorForm): SkillEditableDefinition {
  return {
    name: form.name.trim(),
    summary: form.summary.trim(),
    promptFragments: form.promptFragments.map((item) => item.trim()).filter(Boolean),
    requiredTools: unique(form.requiredTools),
    requiredProviderCapabilities: unique(form.requiredProviderCapabilities),
    approvalProfile: approvalProfileFromForm(form),
  };
}

export function skillEditorImportRequest(
  form: SkillEditorForm,
  preserved: SkillEditorPreservedDefinition,
  options: { readonly sourcePath?: string } = {},
): SkillImportDraftRequest {
  const editable = skillEditableDefinitionFromForm(form);
  return {
    source: "custom",
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    name: editable.name,
    content: JSON.stringify({
      name: editable.name,
      description: editable.summary,
      skills: [{
        ...(preserved.skillId ? { id: preserved.skillId } : {}),
        ...editable,
        roleAffinity: preserved.roleAffinity,
        stateEffects: preserved.stateEffects,
      }],
    }, null, 2),
  };
}

export function skillEditorFingerprint(form: SkillEditorForm): string {
  return JSON.stringify({
    ...form,
    promptFragments: form.promptFragments.map((item) => item.trimEnd()),
    requiredTools: [...form.requiredTools].sort(),
    requiredProviderCapabilities: [...form.requiredProviderCapabilities].sort(),
    approvalRequiredForTools: [...form.approvalRequiredForTools].sort(),
    approvalRequiredForActions: [...form.approvalRequiredForActions].sort(),
  });
}

export function isEditableSkillEntry(skill: SkillRegistryEntry): boolean {
  if (skill.reviewStatus === "archived" || skill.source === "builtin" || skill.source === "gstack" || skill.source === "workspace") {
    return false;
  }
  return skill.source === "custom" || skill.source === "skill-directory" || skill.source === "agents-md";
}

export function isEvolvedSkillEntry(skill: SkillRegistryEntry): boolean {
  return skill.packId === "ling-generated" || skill.sourcePath?.startsWith("skill-candidates/") === true;
}

function skillEditorSeedFromDefinition(
  definition: SkillRegistryEntry["definition"],
  options: { readonly stripSourceFrontmatter?: boolean } = {},
): SkillEditorSeed {
  const promptFragments = options.stripSourceFrontmatter
    ? definition.promptFragments.map(stripMarkdownFrontmatter)
    : [...definition.promptFragments];
  return {
    form: {
      name: definition.name,
      summary: definition.summary,
      promptFragments: promptFragments.length > 0 ? promptFragments : [""],
      requiredTools: [...definition.requiredTools],
      requiredProviderCapabilities: [...definition.requiredProviderCapabilities],
      approvalMode: definition.approvalProfile.mode,
      approvalRisk: definition.approvalProfile.risk ?? "",
      approvalRequiredForTools: [...(definition.approvalProfile.requiredForTools ?? [])],
      approvalRequiredForActions: [...(definition.approvalProfile.requiredForActions ?? [])],
    },
    preserved: {
      skillId: definition.id,
      roleAffinity: [...definition.roleAffinity],
      stateEffects: [...definition.stateEffects],
    },
  };
}

function stripMarkdownFrontmatter(value: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(value);
  if (!match) return value;
  const body = value.slice(match[0].length).trim();
  return body || value;
}

function approvalProfileFromForm(form: SkillEditorForm): SkillApprovalProfile {
  if (form.approvalMode === "none") {
    return { mode: "none" };
  }
  return {
    mode: form.approvalMode,
    ...(form.approvalRisk ? { risk: form.approvalRisk } : {}),
    ...(form.approvalRequiredForTools.length > 0 ? { requiredForTools: unique(form.approvalRequiredForTools) } : {}),
    ...(form.approvalRequiredForActions.length > 0 ? { requiredForActions: unique(form.approvalRequiredForActions) } : {}),
  };
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
