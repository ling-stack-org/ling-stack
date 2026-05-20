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
