import type { MediaJob, MediaJobFormState } from "../../types.js";
import { defaultMediaJobForm } from "../../domains/media/use-media-domain.js";
import type { MediaJobFormErrors, MediaJobFormValidationOptions } from "./media-job-types.js";

export function validateMediaJobForm(
  form: MediaJobFormState,
  options: MediaJobFormValidationOptions,
): MediaJobFormErrors {
  const errors: MediaJobFormErrors = {};
  if (!options.cwd.trim()) errors.workspace = "A workspace is required.";
  if (!form.operation) errors.operation = "Choose a task type.";
  if (!form.providerPresetId || !options.providerAvailable) errors.providerPresetId = "Choose a runnable generation model.";
  const promptLength = form.prompt.trim().length;
  if (promptLength === 0) errors.prompt = "Enter a prompt.";
  else if (promptLength > 2_000) errors.prompt = "Prompt must be 2000 characters or fewer.";
  if (form.operation === "image_edit") {
    if (form.imageUrl && !isHttpUrl(form.imageUrl)) errors.imageUrl = "Use an http or https image URL.";
    if (form.maskUrl && !isHttpUrl(form.maskUrl)) errors.maskUrl = "Use an http or https mask URL.";
  }
  if (form.count && (!isInteger(form.count) || Number(form.count) < 1)) errors.count = "Result count must be an integer of 1 or more.";
  if (form.seed && !isInteger(form.seed)) errors.seed = "Seed must be an integer.";
  if (form.operation === "video_generate") {
    const duration = Number(form.duration);
    if (!Number.isFinite(duration) || duration < 1 || (options.allowedDurations?.length && !options.allowedDurations.includes(duration))) {
      errors.duration = "Choose a supported duration of 1 second or more.";
    }
    if (options.allowedRatios?.length && !options.allowedRatios.includes(form.ratio)) errors.operation = "Choose a supported aspect ratio.";
  }
  return errors;
}

export function mediaJobToReusableForm(job: MediaJob, providerAvailable: boolean): MediaJobFormState {
  const input = job.input;
  return {
    ...defaultMediaJobForm,
    providerPresetId: providerAvailable && job.executionSource?.kind !== "workflow" ? job.providerPresetId ?? "" : "",
    operation: job.operation,
    prompt: job.prompt,
    size: readInput(input, ["size"]),
    count: readInput(input, ["n", "count"]),
    seed: readInput(input, ["seed"]),
    watermark: readWatermark(input.watermark),
    imageUrl: readInput(input, ["imageUrl", "image_url"]),
    maskUrl: readInput(input, ["maskUrl", "mask_url"]),
    ratio: readInput(input, ["ratio", "aspect_ratio"]) || defaultMediaJobForm.ratio,
    duration: readInput(input, ["duration", "duration_seconds"]) || defaultMediaJobForm.duration,
    inputText: "",
  };
}

function readInput(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function readWatermark(value: unknown): MediaJobFormState["watermark"] {
  if (value === true || value === "true") return "true";
  if (value === false || value === "false") return "false";
  return "";
}

function isInteger(value: string): boolean {
  return /^-?\d+$/u.test(value.trim());
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
