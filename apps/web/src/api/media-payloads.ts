import type { MediaJobFormState } from "../types.js";
import type { CreateMediaJobRequest } from "@ling-stack/contracts";

export function mediaJobFormToPayload(form: MediaJobFormState): CreateMediaJobRequest {
  return {
    providerPresetId: form.providerPresetId,
    operation: form.operation,
    prompt: form.prompt,
    input: mediaJobFormInputToPayload(form),
  };
}

export function mediaJobFormInputToPayload(form: MediaJobFormState): Record<string, unknown> | undefined {
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
  return Object.keys(structuredInput).length > 0 ? structuredInput : undefined;
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
