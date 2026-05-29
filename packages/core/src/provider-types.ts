import { randomUUID } from "node:crypto";
import type { SecretStatus } from "./secrets.js";

export type ProviderKind =
  | "openai"
  | "anthropic"
  | "openai-compatible"
  | "doubao"
  | "deepseek"
  | "minimax"
  | "glm"
  | "jimeng"
  | "seedream"
  | "seedance";

export type ProviderCapability =
  | "chat"
  | "tool_call"
  | "reasoning"
  | "vision"
  | "embedding"
  | "image_generate"
  | "image_edit"
  | "video_generate"
  | "tts"
  | "asr";

export type ProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "mistral-conversations"
  | "media-job";

export interface ProviderPreset {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: ProviderApi;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly headers: Record<string, string>;
  readonly authHeader?: boolean;
  readonly reasoning?: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly compat: Record<string, unknown>;
  readonly capabilities: readonly ProviderCapability[];
  readonly enabled: boolean;
  readonly lastCheck?: ProviderCheckResult;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProviderPresetInput {
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: ProviderApi;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly headers?: Record<string, string>;
  readonly authHeader?: boolean;
  readonly reasoning?: boolean;
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly compat?: Record<string, unknown>;
  readonly capabilities: readonly ProviderCapability[];
  readonly enabled?: boolean;
}

export interface ProviderPresetUpdateInput {
  readonly kind?: ProviderKind;
  readonly displayName?: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly api?: ProviderApi;
  readonly baseUrl?: string | null;
  readonly apiKeyRef?: string | null;
  readonly headers?: Record<string, string>;
  readonly authHeader?: boolean | null;
  readonly reasoning?: boolean | null;
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number | null;
  readonly maxTokens?: number | null;
  readonly compat?: Record<string, unknown>;
  readonly capabilities?: readonly ProviderCapability[];
  readonly enabled?: boolean;
}

export interface PublicProviderPreset extends ProviderPreset {
  readonly apiKeyConfigured: boolean;
  readonly apiKeyStatus?: SecretStatus;
}

export interface ProviderCheckResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
  readonly checkedAt: string;
}

export interface ProviderModelOption {
  readonly id: string;
  readonly displayName?: string;
  readonly ownedBy?: string;
  readonly createdAt?: string;
}

export interface ProviderModelListRequest {
  readonly kind: ProviderKind;
  readonly providerId: string;
  readonly api: ProviderApi;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly authHeader?: boolean;
}

export interface ProviderModelListResponse {
  readonly source: string;
  readonly models: readonly ProviderModelOption[];
}

export interface ListProviderPresetsOptions {
  readonly enabled?: boolean;
}

export function createProviderPresetId(): string {
  return `provider_${randomUUID()}`;
}

export const providerKinds: readonly ProviderKind[] = [
  "openai",
  "anthropic",
  "openai-compatible",
  "doubao",
  "deepseek",
  "minimax",
  "glm",
  "jimeng",
  "seedream",
  "seedance",
];

export const providerApis: readonly ProviderApi[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
  "media-job",
];

export const providerCapabilities: readonly ProviderCapability[] = [
  "chat",
  "tool_call",
  "reasoning",
  "vision",
  "embedding",
  "image_generate",
  "image_edit",
  "video_generate",
  "tts",
  "asr",
];
