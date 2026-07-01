import type { SecretStatus } from "./shared.js";

export type ProviderKind =
  | "openai"
  | "anthropic"
  | "google"
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
  | "web_search"
  | "embedding"
  | "image_generate"
  | "image_edit"
  | "video_generate"
  | "tts"
  | "asr";

export type ProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "mistral-conversations"
  | "media-job";

export type ProviderTransport = "auto" | "websocket" | "websocket-cached" | "sse";
export type ProviderThinkingMode = "off" | "auto" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ProviderThinkingSupport {
  readonly levels: readonly ProviderThinkingMode[];
  readonly minTokens?: number;
  readonly maxTokens?: number;
  readonly zeroAllowed?: boolean;
  readonly dynamicAllowed?: boolean;
}

export type ProviderModelOptionCapabilitySource =
  | "upstream"
  | "model_catalog"
  | "provider_template"
  | "user_override"
  | "conservative_default";

export type ProviderModelOptionCapabilityConfidence = "known" | "estimated" | "conservative";

export interface ProviderPreset {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: ProviderApi;
  readonly providerTransport?: ProviderTransport;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly apiKeyConfigured: boolean;
  readonly apiKeyStatus?: SecretStatus;
  readonly headers: Record<string, string>;
  readonly secretHeaderRefs: Record<string, string>;
  readonly secretHeaderStatuses?: Record<string, SecretStatus>;
  readonly authHeader?: boolean;
  readonly reasoning?: boolean;
  readonly thinkingModes?: readonly ProviderThinkingMode[];
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

export interface ProviderListResponse {
  readonly cwd: string;
  readonly providers: readonly ProviderPreset[];
}

export interface ProviderMutationResponse {
  readonly provider: ProviderPreset;
}

export interface ProviderSecretResponse {
  readonly providerId: string;
  readonly apiKey: string;
  readonly apiKeyRef?: string;
  readonly configured: boolean;
}

export interface ProviderKeychainSecretConfigureRequest {
  readonly secretRef: string;
  readonly apiKey: string;
  readonly clearLocalSecret?: boolean;
}

export interface ProviderKeychainSecretDeleteRequest {
  readonly secretRef?: string;
}

export interface ProviderKeychainSecretResponse {
  readonly provider: ProviderPreset;
  readonly secretRef: string;
  readonly status: SecretStatus;
}

export interface ProviderTemplate {
  readonly templateId: string;
  readonly description: string;
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: ProviderApi;
  readonly providerTransport?: ProviderTransport;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly headers?: Record<string, string>;
  readonly secretHeaderRefs?: Record<string, string>;
  readonly authHeader?: boolean;
  readonly reasoning?: boolean;
  readonly thinkingModes?: readonly ProviderThinkingMode[];
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly compat?: Record<string, unknown>;
  readonly capabilities: readonly ProviderCapability[];
  readonly enabled?: boolean;
}

export interface ProviderTemplateListResponse {
  readonly templates: readonly ProviderTemplate[];
}

export interface ProviderModelOption {
  readonly id: string;
  readonly displayName?: string;
  readonly ownedBy?: string;
  readonly createdAt?: string;
  readonly api?: ProviderApi;
  readonly input?: readonly ("text" | "image")[];
  readonly capabilities?: readonly ProviderCapability[];
  readonly thinkingModes?: readonly ProviderThinkingMode[];
  readonly thinkingSupport?: ProviderThinkingSupport;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly supportedParameters?: readonly string[];
  readonly capabilitySource?: ProviderModelOptionCapabilitySource;
  readonly capabilityConfidence?: ProviderModelOptionCapabilityConfidence;
}

export interface ProviderModelImportRequest {
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly providerId: string;
  readonly api: ProviderApi;
  readonly providerTransport?: ProviderTransport;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly secretHeaderRefs?: Record<string, string>;
  readonly authHeader?: boolean;
  readonly reasoning?: boolean;
  readonly thinkingModes?: readonly ProviderThinkingMode[];
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly compat?: Record<string, unknown>;
  readonly capabilities: readonly ProviderCapability[];
  readonly enabled?: boolean;
  readonly models: readonly ProviderModelOption[];
}

export interface ProviderModelImportResponse {
  readonly providers: readonly ProviderPreset[];
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly warnings: readonly string[];
}

export interface ProviderModelListRequest {
  readonly kind: ProviderKind;
  readonly providerId: string;
  readonly api: ProviderApi;
  readonly providerTransport?: ProviderTransport;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly secretHeaderRefs?: Record<string, string>;
  readonly authHeader?: boolean;
}

export interface ProviderModelListResponse {
  readonly source: string;
  readonly models: readonly ProviderModelOption[];
}

export interface ProviderCheckResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
  readonly checkedAt: string;
}

export interface ProviderDraftCheckRequest extends ProviderMutationRequest {}

export interface ProviderMutationRequest {
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: ProviderApi;
  readonly providerTransport?: ProviderTransport;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly apiKey?: string;
  readonly clearApiKey?: boolean;
  readonly headers?: Record<string, string>;
  readonly secretHeaderRefs?: Record<string, string>;
  readonly authHeader?: boolean;
  readonly reasoning?: boolean;
  readonly thinkingModes?: readonly ProviderThinkingMode[];
  readonly input?: readonly string[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly compat?: Record<string, unknown>;
  readonly capabilities?: readonly string[];
  readonly enabled?: boolean;
}
