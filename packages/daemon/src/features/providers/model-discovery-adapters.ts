import {
  normalizeProviderBaseUrlForAdapter,
  type ProviderPreset,
} from "@ling-stack/core";

export interface ProviderModelDiscoveryRequest {
  readonly source: string;
  readonly headers: Record<string, string>;
}

export function supportsProviderModelDiscovery(preset: Pick<ProviderPreset, "api">): boolean {
  return preset.api !== "openai-codex-responses";
}

export function providerModelDiscoveryNeedsApiKey(
  preset: Pick<ProviderPreset, "api" | "authHeader">,
  headers: Readonly<Record<string, string>>,
): boolean {
  if (preset.api === "anthropic-messages") {
    return !hasHeader(headers, "x-api-key");
  }
  if (preset.api === "google-generative-ai") {
    return !hasHeader(headers, "x-goog-api-key");
  }
  return preset.authHeader !== false;
}

export function createProviderModelDiscoveryRequest(
  preset: Pick<ProviderPreset, "api" | "authHeader" | "baseUrl" | "kind">,
  baseHeaders: Readonly<Record<string, string>>,
  apiKey: string | undefined,
): ProviderModelDiscoveryRequest {
  const headers = { ...baseHeaders };
  if (preset.api === "anthropic-messages") {
    if (apiKey) headers["x-api-key"] = apiKey;
    setDefaultHeader(headers, "anthropic-version", "2023-06-01");
  } else if (preset.api === "google-generative-ai") {
    if (apiKey) headers["x-goog-api-key"] = apiKey;
  } else if (preset.authHeader !== false && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return {
    source: `${normalizeProviderBaseUrlForAdapter(preset)}/models`,
    headers,
  };
}

export function providerModelDiscoveryItems(
  body: unknown,
  preset: Pick<ProviderPreset, "api">,
): readonly unknown[] {
  if (preset.api === "google-generative-ai") {
    if (!isRecord(body) || !Array.isArray(body.models)) return [];
    return body.models
      .filter(isGeminiGenerationModel)
      .map(normalizeGeminiModel);
  }
  if (isRecord(body) && Array.isArray(body.data)) return body.data;
  return Array.isArray(body) ? body : [];
}

function isGeminiGenerationModel(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const methods = stringArray(value.supportedGenerationMethods);
  return methods.includes("generateContent") || methods.includes("streamGenerateContent");
}

function normalizeGeminiModel(value: Record<string, unknown>): Record<string, unknown> {
  const rawName = typeof value.name === "string" ? value.name.trim() : "";
  const id = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
  return {
    ...value,
    id,
    displayName: typeof value.displayName === "string" ? value.displayName : undefined,
    contextWindow: value.inputTokenLimit,
    maxTokens: value.outputTokenLimit,
  };
}

function setDefaultHeader(headers: Record<string, string>, name: string, value: string): void {
  if (!hasHeader(headers, name)) headers[name] = value;
}

function hasHeader(headers: Readonly<Record<string, string>>, name: string): boolean {
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((candidate) => candidate.toLowerCase() === normalizedName);
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
