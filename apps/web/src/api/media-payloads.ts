import type { CreateMediaJobRequest, MediaJobFormState } from "../types.js";

export function mediaJobFormToPayload(form: MediaJobFormState): CreateMediaJobRequest {
  return {
    providerPresetId: form.providerPresetId,
    operation: form.operation,
    prompt: form.prompt,
    input: parseMediaInput(form.inputText),
  };
}

export function parseMediaInput(inputText: string): Record<string, unknown> | undefined {
  const trimmed = inputText.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Generation task input must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}
