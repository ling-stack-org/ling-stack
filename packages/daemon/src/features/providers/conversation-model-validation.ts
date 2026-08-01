import type { RunStore, SecretResolver } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { resolveProviderForRun } from "../runs/providers.js";

export function assertRunnableConversationProvider(input: {
  readonly store: RunStore;
  readonly cwd: string;
  readonly providerPresetId: string | undefined;
  readonly secretResolver: SecretResolver;
  readonly ownerLabel: string;
}): string {
  const providerPresetId = input.providerPresetId?.trim();
  if (!providerPresetId) {
    throw new HttpError(400, "conversation_model_required", `${input.ownerLabel} requires a configured chat model.`);
  }

  try {
    resolveProviderForRun(input.store, {
      cwd: input.cwd,
      workspaceCwd: input.cwd,
      providerPresetId,
      task: {
        id: "conversation_model_validation",
        title: `Validate ${input.ownerLabel} model`,
        prompt: "Validate the selected conversation model without starting a run.",
      },
      tools: [],
      thinkingLevel: "off",
    }, input.secretResolver);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(400, "conversation_model_not_ready", message);
  }

  return providerPresetId;
}
