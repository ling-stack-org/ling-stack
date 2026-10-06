import type { ProviderFormState, ProviderModelOption } from "../types.js";

export function providerFormWithSelectedModel(
  form: ProviderFormState,
  model: ProviderModelOption,
  sourceForm?: ProviderFormState,
): { readonly form: ProviderFormState; readonly notice?: string } {
  const baseForm = sourceForm ?? form;
  const nextForm = {
    ...baseForm,
    model: model.id,
    api: model.api ?? baseForm.api,
    capabilitiesText: model.capabilities !== undefined ? model.capabilities.join(", ") : baseForm.capabilitiesText,
    inputText: model.input?.length ? model.input.join(", ") : baseForm.inputText,
    reasoning: model.thinkingModes?.some((mode) => mode !== "off") ?? baseForm.reasoning,
    thinkingModes: model.thinkingModes ?? baseForm.thinkingModes,
    contextWindow: model.contextWindow ? String(model.contextWindow) : baseForm.contextWindow,
    maxTokens: model.maxTokens ? String(model.maxTokens) : baseForm.maxTokens,
  };
  if (sourceForm) {
    return { form: nextForm };
  }
  return { form: nextForm };
}
