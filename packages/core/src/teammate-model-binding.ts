import {
  LING_AGENT_ID,
  type AiTeammate,
  type AiTeammateModelBindingMode,
} from "./workspace-types.js";

export type TeammateConversationSurface = "private" | "channel";

export interface EffectiveTeammateProviderInput {
  readonly teammate: Pick<AiTeammate, "id" | "modelBindingMode" | "providerPresetId">;
  readonly surface: TeammateConversationSurface;
  readonly requestedProviderPresetId?: string;
  readonly workspaceDefaultProviderPresetId?: string;
  readonly channelDefaultProviderPresetId?: string;
}

export function isBuiltinAiTeammateId(teammateId: string): boolean {
  return teammateId === LING_AGENT_ID || teammateId.startsWith("teammate_builtin_");
}

export function canUseWorkspaceDefaultModelBinding(teammateId: string): boolean {
  return isBuiltinAiTeammateId(teammateId);
}

export function initialAiTeammateModelBinding(
  teammateId: string,
  requestedMode: AiTeammateModelBindingMode | undefined,
  providerPresetId: string | undefined,
): { readonly modelBindingMode: AiTeammateModelBindingMode; readonly providerPresetId?: string } {
  const modelBindingMode = requestedMode
    ?? (isBuiltinAiTeammateId(teammateId) && !providerPresetId ? "workspace_default" : "fixed");
  if (modelBindingMode === "workspace_default") {
    if (!canUseWorkspaceDefaultModelBinding(teammateId)) {
      throw new Error(`AI teammate ${teammateId} cannot use the workspace default model binding.`);
    }
    return { modelBindingMode };
  }
  return { modelBindingMode, ...(providerPresetId ? { providerPresetId } : {}) };
}

export function resolveEffectiveTeammateProviderPresetId(
  input: EffectiveTeammateProviderInput,
): string | undefined {
  if (input.surface === "private" && input.requestedProviderPresetId) {
    return input.requestedProviderPresetId;
  }
  if (input.teammate.modelBindingMode === "fixed") {
    return input.teammate.providerPresetId;
  }
  if (input.surface === "channel" && input.teammate.id === LING_AGENT_ID) {
    return input.channelDefaultProviderPresetId;
  }
  return input.workspaceDefaultProviderPresetId;
}
