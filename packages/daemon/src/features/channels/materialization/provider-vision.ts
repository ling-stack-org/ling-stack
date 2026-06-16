import { readFile } from "node:fs/promises";
import {
  normalizeProviderBaseUrlForAdapter,
  type Channel,
  type ProviderPreset,
  type ResolvedSecret,
  type RunStore,
  type SecretResolver,
} from "@ling-stack/core";
import { readLimitedResponseText } from "../../../shared/http.js";
import { redactTextWithSecrets } from "../../../shared/redaction.js";
import { isRecord } from "../../../shared/validation.js";
import { resolveProviderSecret } from "../../providers/secrets.js";
import type { LingImageVisionSummarizer } from "./registry.js";

const SUPPORTED_VISION_APIS = new Set<ProviderPreset["api"]>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);
const SUPPORTED_IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const IMAGE_VISION_TIMEOUT_MS = 20_000;
const IMAGE_VISION_MAX_OUTPUT_TOKENS = 700;

export interface CreateProviderBackedImageVisionSummarizerInput {
  readonly store: RunStore;
  readonly channel?: Pick<Channel, "defaultProviderPresetId">;
  readonly requestedProviderPresetId?: string;
  readonly secretResolver: SecretResolver;
  readonly fetch?: typeof globalThis.fetch;
}

export function createProviderBackedImageVisionSummarizer(
  input: CreateProviderBackedImageVisionSummarizerInput,
): LingImageVisionSummarizer | undefined {
  const provider = resolveImageVisionProvider(input);
  if (!provider) {
    return undefined;
  }
  return async (request) => {
    const bytes = await readFile(request.absolutePath);
    const contentType = normalizeImageContentType(request.attachment.contentType);
    if (!SUPPORTED_IMAGE_CONTENT_TYPES.has(contentType)) {
      throw new Error(`Image content type is not supported for provider vision summary: ${contentType || "unknown"}.`);
    }
    if (bytes.byteLength > request.maxBytes) {
      throw new Error(`Image attachment is too large for provider vision summary (${bytes.byteLength} bytes).`);
    }
    const secret: ResolvedSecret = provider.apiKeyRef
      ? resolveProviderSecret(input.store, provider, input.secretResolver)
      : { configured: false };
    if (providerNeedsSecret(provider) && !secret.configured) {
      throw new Error(secret.status?.message ?? "Provider API key is missing for image vision summary.");
    }
    const dataUrl = `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
    const fetchImpl = input.fetch ?? globalThis.fetch;
    const response = await fetchImpl(buildProviderVisionUrl(provider), {
      method: "POST",
      headers: buildProviderVisionHeaders(provider, secret),
      body: JSON.stringify(buildProviderVisionBody(provider, dataUrl)),
      signal: AbortSignal.timeout(IMAGE_VISION_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(await providerVisionHttpFailureMessage(response, secret.value));
    }
    const body = await response.json() as unknown;
    const contentText = extractProviderVisionText(provider, body).trim();
    if (!contentText) {
      throw new Error("Provider image vision summary response did not include text.");
    }
    return {
      contentText,
      byteCount: bytes.byteLength,
      tokenEstimate: Math.ceil(contentText.length / 4),
      policyDecision: {
        providerPresetId: provider.id,
        providerApi: provider.api,
        providerKind: provider.kind,
        model: provider.model,
        contentType,
        byteCount: bytes.byteLength,
        declaredVisionCapability: provider.capabilities.includes("vision") || provider.input.includes("image"),
      },
    };
  };
}

function resolveImageVisionProvider(input: CreateProviderBackedImageVisionSummarizerInput): ProviderPreset | undefined {
  const candidateIds = [
    input.requestedProviderPresetId,
    input.channel?.defaultProviderPresetId,
    ...input.store.listProviderPresets({ enabled: true }).map((preset) => preset.id),
  ].filter((id): id is string => Boolean(id));
  for (const providerPresetId of [...new Set(candidateIds)]) {
    const preset = input.store.getProviderPreset(providerPresetId);
    if (!preset || !canAttemptProviderVision(preset)) {
      continue;
    }
    return preset;
  }
  return undefined;
}

function canAttemptProviderVision(preset: ProviderPreset): boolean {
  return preset.enabled && preset.capabilities.includes("chat") && SUPPORTED_VISION_APIS.has(preset.api);
}

function providerNeedsSecret(preset: ProviderPreset): boolean {
  return preset.api === "anthropic-messages" || preset.authHeader !== false;
}

function normalizeImageContentType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

function buildProviderVisionUrl(provider: ProviderPreset): string {
  const baseUrl = normalizeProviderBaseUrlForAdapter(provider);
  if (provider.api === "anthropic-messages") {
    return `${baseUrl}/messages`;
  }
  if (provider.api === "openai-responses") {
    return `${baseUrl}/responses`;
  }
  return `${baseUrl}/chat/completions`;
}

function buildProviderVisionHeaders(provider: ProviderPreset, secret: ResolvedSecret): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...provider.headers,
  };
  if (provider.api === "anthropic-messages") {
    if (secret.value) {
      headers["x-api-key"] = secret.value;
    }
    headers["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
    return headers;
  }
  if (provider.authHeader !== false && secret.value) {
    headers.Authorization = `Bearer ${secret.value}`;
  }
  return headers;
}

function buildProviderVisionBody(provider: ProviderPreset, imageDataUrl: string): Record<string, unknown> {
  const prompt = [
    "Read this image from the current Ling channel turn.",
    "Return a concise factual visual summary for the assistant to use.",
    "Include visible text, UI elements, errors, highlighted/boxed areas, and details relevant to the user's latest message.",
    "Do not infer content that is not visible.",
  ].join("\n");
  if (provider.api === "anthropic-messages") {
    const { mediaType, data } = splitDataUrl(imageDataUrl);
    return {
      model: provider.model,
      max_tokens: IMAGE_VISION_MAX_OUTPUT_TOKENS,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image", source: { type: "base64", media_type: mediaType, data } },
        ],
      }],
    };
  }
  if (provider.api === "openai-responses") {
    return {
      model: provider.model,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: imageDataUrl },
        ],
      }],
      max_output_tokens: IMAGE_VISION_MAX_OUTPUT_TOKENS,
      stream: false,
    };
  }
  return {
    model: provider.model,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    }],
    max_tokens: IMAGE_VISION_MAX_OUTPUT_TOKENS,
    stream: false,
  };
}

function splitDataUrl(dataUrl: string): { readonly mediaType: string; readonly data: string } {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(dataUrl);
  if (!match) {
    throw new Error("Image data URL is invalid.");
  }
  return { mediaType: match[1] ?? "application/octet-stream", data: match[2] ?? "" };
}

function extractProviderVisionText(provider: ProviderPreset, body: unknown): string {
  if (!isRecord(body)) {
    return "";
  }
  if (provider.api === "openai-completions") {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    return choices.map((choice) => isRecord(choice) ? extractText(choice.message) : "").filter(Boolean).join("\n").trim();
  }
  if (provider.api === "openai-responses") {
    if (typeof body.output_text === "string") {
      return body.output_text;
    }
    return extractText(body.output);
  }
  if (provider.api === "anthropic-messages") {
    return extractText(body.content);
  }
  return "";
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("\n");
  }
  if (!isRecord(value)) {
    return "";
  }
  const directText = typeof value.text === "string" ? value.text : "";
  const nested = [
    extractText(value.content),
    extractText(value.output),
    extractText(value.message),
  ].filter(Boolean).join("\n");
  return [directText, nested].filter(Boolean).join("\n");
}

async function providerVisionHttpFailureMessage(response: Response, secret?: string): Promise<string> {
  const bodyText = redactTextWithSecrets(await readLimitedResponseText(response, 800), [secret]);
  return `Image vision provider returned HTTP ${response.status}${bodyText ? `: ${bodyText}` : "."}`;
}
