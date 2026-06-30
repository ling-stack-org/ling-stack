import type { CreateMediaJobRequest, MediaJobFormState } from "../types.js";

export function mediaJobFormToPayload(form: MediaJobFormState): CreateMediaJobRequest {
  return {
    providerPresetId: form.providerPresetId,
    operation: form.operation,
    prompt: form.prompt,
    input: mediaJobFormInputToPayload(form),
  };
}

export function mediaJobFormInputToPayload(form: MediaJobFormState): Record<string, unknown> | undefined {
  const legacyInput = parseMediaInput(form.inputText);
  const structuredInput: Record<string, unknown> = {};
  if (form.operation === "image_generate") {
    assignTrimmedString(structuredInput, "size", form.size);
    assignNumber(structuredInput, "n", form.count, { integer: true, min: 1 });
    assignNumber(structuredInput, "seed", form.seed, { integer: true });
    assignWatermark(structuredInput, form.watermark);
  } else if (form.operation === "video_generate") {
    assignTrimmedString(structuredInput, "ratio", form.ratio);
    assignNumber(structuredInput, "duration", form.duration, { min: 1 });
    assignWatermark(structuredInput, form.watermark);
  } else {
    assignTrimmedString(structuredInput, "imageUrl", form.imageUrl);
    assignTrimmedString(structuredInput, "maskUrl", form.maskUrl);
  }
  const input = { ...legacyInput, ...structuredInput };
  return Object.keys(input).length > 0 ? input : undefined;
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

function assignTrimmedString(target: Record<string, unknown>, key: string, value: string | undefined): void {
  const trimmed = (value ?? "").trim();
  if (trimmed) {
    target[key] = trimmed;
  }
}

function assignNumber(
  target: Record<string, unknown>,
  key: string,
  value: string | undefined,
  options: { readonly integer?: boolean; readonly min?: number } = {},
): void {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return;
  }
  const parsed = options.integer ? Number.parseInt(trimmed, 10) : Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) {
    return;
  }
  if (options.min !== undefined && parsed < options.min) {
    return;
  }
  target[key] = parsed;
}

function assignWatermark(target: Record<string, unknown>, watermark: MediaJobFormState["watermark"]): void {
  if (watermark === "true") {
    target.watermark = true;
  }
  if (watermark === "false") {
    target.watermark = false;
  }
}
