import {
  LING_AGENT_ID,
  type AiTeammate,
  type AiTeammateModelBindingMode,
} from "./workspace-types.js";
import type {
  ConversationModelBindingOwnerV1,
  ConversationModelRepairTargetV1,
  EffectiveConversationModelSourceV1,
  WorkflowParticipantProviderBindingV1,
  WorkflowParticipantProviderBlockerReasonV1,
} from "@ling-stack/contracts";

export type TeammateConversationSurface = "private" | "channel";

export interface EffectiveTeammateProviderInput {
  readonly teammate: Pick<AiTeammate, "id" | "modelBindingMode" | "providerPresetId">;
  readonly surface: TeammateConversationSurface;
  readonly requestedProviderPresetId?: string;
  readonly workspaceDefaultProviderPresetId?: string;
  readonly channelDefaultProviderPresetId?: string;
}

export type EffectiveTeammateProviderResolution =
  | {
      readonly kind: "resolved";
      readonly binding: WorkflowParticipantProviderBindingV1;
    }
  | {
      readonly kind: "blocked";
      readonly reasonCode: Extract<
        WorkflowParticipantProviderBlockerReasonV1,
        "workspace_default_provider_missing" | "channel_ling_agent_provider_missing" | "fixed_provider_missing"
      >;
      readonly participantId: string;
      readonly bindingMode: AiTeammateModelBindingMode;
      readonly source: EffectiveConversationModelSourceV1;
      readonly owner: ConversationModelBindingOwnerV1;
      readonly repairTarget: ConversationModelRepairTargetV1;
    };

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
  const resolution = resolveEffectiveTeammateProvider(input);
  return resolution.kind === "resolved" ? resolution.binding.providerPresetId : undefined;
}

export function resolveEffectiveTeammateProvider(
  input: EffectiveTeammateProviderInput,
): EffectiveTeammateProviderResolution {
  if (input.surface === "private" && input.requestedProviderPresetId) {
    return resolved(input, "private_request_override", input.requestedProviderPresetId);
  }
  if (input.teammate.modelBindingMode === "fixed") {
    return input.teammate.providerPresetId
      ? resolved(input, "teammate_fixed", input.teammate.providerPresetId)
      : blocked(input, "fixed_provider_missing", "teammate_fixed", "teammate", "teammate_settings");
  }
  if (input.surface === "channel" && input.teammate.id === LING_AGENT_ID) {
    return input.channelDefaultProviderPresetId
      ? resolved(input, "channel_ling_agent_model", input.channelDefaultProviderPresetId)
      : blocked(
          input,
          "channel_ling_agent_provider_missing",
          "channel_ling_agent_model",
          "channel",
          "channel_settings",
        );
  }
  return input.workspaceDefaultProviderPresetId
    ? resolved(input, "workspace_default", input.workspaceDefaultProviderPresetId)
    : blocked(
        input,
        "workspace_default_provider_missing",
        "workspace_default",
        "workspace",
        "model_workbench",
      );
}

function resolved(
  input: EffectiveTeammateProviderInput,
  source: EffectiveConversationModelSourceV1,
  providerPresetId: string,
): Extract<EffectiveTeammateProviderResolution, { readonly kind: "resolved" }> {
  return {
    kind: "resolved",
    binding: {
      schemaVersion: 1,
      participantId: input.teammate.id,
      bindingMode: input.teammate.modelBindingMode,
      source,
      providerPresetId,
    },
  };
}

function blocked(
  input: EffectiveTeammateProviderInput,
  reasonCode: Extract<
    WorkflowParticipantProviderBlockerReasonV1,
    "workspace_default_provider_missing" | "channel_ling_agent_provider_missing" | "fixed_provider_missing"
  >,
  source: EffectiveConversationModelSourceV1,
  owner: ConversationModelBindingOwnerV1,
  repairTarget: ConversationModelRepairTargetV1,
): Extract<EffectiveTeammateProviderResolution, { readonly kind: "blocked" }> {
  return {
    kind: "blocked",
    reasonCode,
    participantId: input.teammate.id,
    bindingMode: input.teammate.modelBindingMode,
    source,
    owner,
    repairTarget,
  };
}
