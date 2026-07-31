import {
  canUseWorkspaceDefaultModelBinding,
  type AiTeammate,
  type AiTeammateUpdateInput,
  type RunStore,
  type SecretResolver,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { assertRunnableConversationProvider } from "../providers/conversation-model-validation.js";

export function validateTeammateModelUpdate(input: {
  readonly store: RunStore;
  readonly cwd: string;
  readonly teammate: AiTeammate;
  readonly update: AiTeammateUpdateInput;
  readonly secretResolver: SecretResolver;
}): AiTeammateUpdateInput {
  if (input.update.modelBindingMode === undefined && input.update.providerPresetId === undefined) {
    return input.update;
  }
  if (input.teammate.protectedProfile) {
    throw new HttpError(400, "teammate_model_binding_invalid", "Ling Agent follows the workspace model in private chat and the channel Ling Agent model in channels.");
  }

  const nextMode = input.update.modelBindingMode
    ?? (typeof input.update.providerPresetId === "string" ? "fixed" : input.teammate.modelBindingMode);
  if (nextMode === "workspace_default") {
    if (!canUseWorkspaceDefaultModelBinding(input.teammate.id)) {
      throw new HttpError(400, "teammate_model_binding_invalid", "User-created teammates must use a fixed chat model.");
    }
    if (typeof input.update.providerPresetId === "string") {
      throw new HttpError(400, "teammate_model_binding_invalid", "A teammate following the workspace default cannot also select a fixed model.");
    }
    return { ...input.update, modelBindingMode: "workspace_default", providerPresetId: null };
  }

  const providerPresetId = input.update.providerPresetId === null
    ? undefined
    : input.update.providerPresetId ?? input.teammate.providerPresetId;
  const validatedProviderId = assertRunnableConversationProvider({
    store: input.store,
    cwd: input.cwd,
    providerPresetId,
    secretResolver: input.secretResolver,
    ownerLabel: "AI teammate",
  });
  return { ...input.update, modelBindingMode: "fixed", providerPresetId: validatedProviderId };
}
