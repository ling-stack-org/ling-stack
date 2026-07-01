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

export interface ProviderHealth {
  readonly ok: boolean;
  readonly message?: string;
}

export interface ModelInfo {
  readonly id: string;
  readonly displayName?: string;
  readonly capabilities: readonly ProviderCapability[];
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly stream?: boolean;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

export interface ChatChunk {
  readonly type: "text" | "tool_call" | "done" | "error";
  readonly text?: string;
}

export interface EmbeddingRequest {
  readonly model: string;
  readonly input: string | readonly string[];
}

export interface EmbeddingResponse {
  readonly vectors: readonly (readonly number[])[];
}

export interface ImageRequest {
  readonly model: string;
  readonly prompt: string;
}

export interface VideoRequest {
  readonly model: string;
  readonly prompt: string;
}

export type MediaOperation = "image_generate" | "image_edit" | "video_generate";

export type MediaExecutionStatus = "succeeded" | "failed";

export type MediaAdapterArtifactType = "file" | "json" | "markdown" | "image" | "video";

export type MediaAdapterErrorCode =
  | "auth_failed"
  | "model_not_found"
  | "rate_limited"
  | "quota_exceeded"
  | "network_error"
  | "timeout"
  | "unsupported_capability"
  | "provider_internal_error"
  | "invalid_request";

export interface MediaAdapterProviderConfig {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: string;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly capabilities: readonly ProviderCapability[];
}

export interface MediaExecutionRequest {
  readonly jobId: string;
  readonly provider: MediaAdapterProviderConfig;
  readonly operation: MediaOperation;
  readonly prompt: string;
  readonly input: Record<string, unknown>;
  readonly requestedAt: string;
}

export interface MediaExecutionArtifact {
  readonly type: MediaAdapterArtifactType;
  readonly title: string;
  readonly content?: string;
  readonly contentBytes?: Uint8Array;
  readonly contentType?: string;
  readonly pathHint?: string;
}

export interface MediaExecutionResult {
  readonly status: MediaExecutionStatus;
  readonly artifacts: readonly MediaExecutionArtifact[];
  readonly errorCode?: MediaAdapterErrorCode;
  readonly errorMessage?: string;
}

export interface MediaAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly MediaOperation[];

  supports(operation: MediaOperation): boolean;
  execute(request: MediaExecutionRequest): Promise<MediaExecutionResult>;
}

export interface MediaAdapterResolution {
  readonly ok: boolean;
  readonly adapter?: MediaAdapter;
  readonly errorCode?: MediaAdapterErrorCode;
  readonly errorMessage?: string;
}

export interface MediaAdapterFactory {
  readonly id: string;
  readonly providerKinds: readonly string[];
  create(provider: MediaAdapterProviderConfig): MediaAdapter;
}

export interface MediaVendorAdapterDefinition {
  readonly kind: string;
  readonly displayName: string;
  readonly capabilities: readonly MediaOperation[];
}

export interface MediaVendorRequestPlan {
  readonly mode: "static_vendor_request_plan";
  readonly liveCall: false;
  readonly vendor: string;
  readonly operation: MediaOperation;
  readonly provider: {
    readonly presetId: string;
    readonly kind: string;
    readonly providerId: string;
    readonly model: string;
    readonly baseUrl?: string;
    readonly apiKeyRef?: string;
  };
  readonly payload: {
    readonly prompt: string;
    readonly input: unknown;
  };
  readonly notes: readonly string[];
}

export type MediaVendorTransportMode = "disabled" | "fake" | "live";

export interface MediaVendorTransportRequest {
  readonly vendor: MediaVendorAdapterDefinition;
  readonly requestPlan: MediaVendorRequestPlan;
  readonly jobId: string;
  readonly requestedAt: string;
}

export interface MediaVendorTransportResult {
  readonly status: MediaExecutionStatus;
  readonly artifacts?: readonly MediaExecutionArtifact[];
  readonly errorCode?: MediaAdapterErrorCode;
  readonly errorMessage?: string;
}

export interface MediaVendorTransport {
  readonly mode: MediaVendorTransportMode;
  execute(request: MediaVendorTransportRequest): Promise<MediaVendorTransportResult>;
}

export type MediaVendorTransportGateMode = "disabled" | "live";

export interface MediaVendorTransportGateConfig {
  readonly mode: MediaVendorTransportGateMode;
}

export interface MediaVendorTransportGateResolution {
  readonly ok: boolean;
  readonly config?: MediaVendorTransportGateConfig;
  readonly errorCode?: MediaAdapterErrorCode;
  readonly errorMessage?: string;
}

export interface LiveMediaVendorTransportOptions {
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly apiKeyConfigured: boolean;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly redactionValues?: readonly string[];
  readonly httpClient?: MediaVendorHttpClient;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxPollAttempts?: number;
}

export interface MediaVendorHttpRequestInit {
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface MediaVendorHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers?: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type MediaVendorHttpClient = (url: string, init: MediaVendorHttpRequestInit) => Promise<MediaVendorHttpResponse>;

export interface MediaAdapterRegistryOptions {
  readonly factories?: readonly MediaAdapterFactory[];
  readonly enableStaticFallback?: boolean;
}

export interface DefaultMediaAdapterRegistryOptions {
  readonly enableStaticFallback?: boolean;
  readonly mediaVendorTransport?: MediaVendorTransport;
}

export interface NormalizedMediaAdapterError {
  readonly code: MediaAdapterErrorCode;
  readonly message: string;
}

export interface MediaJob {
  readonly id: string;
  readonly providerId: string;
  readonly status: "queued" | "running" | "succeeded" | "failed";
}

export interface MediaJobStatus extends MediaJob {
  readonly outputUrls?: readonly string[];
  readonly errorMessage?: string;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly ProviderCapability[];

  checkHealth(): Promise<ProviderHealth>;
  listModels(): Promise<readonly ModelInfo[]>;

  chat?(request: ChatRequest): AsyncIterable<ChatChunk>;
  embed?(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  generateImage?(request: ImageRequest): Promise<MediaJob>;
  generateVideo?(request: VideoRequest): Promise<MediaJob>;
  pollJob?(jobId: string): Promise<MediaJobStatus>;
}

export interface StaticMediaAdapterOptions {
  readonly id?: string;
  readonly displayName?: string;
}

export interface StaticVendorMediaAdapterFactoryOptions {
  readonly transport?: MediaVendorTransport;
}
