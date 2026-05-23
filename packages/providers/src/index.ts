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

export interface MediaAdapterRegistryOptions {
  readonly factories?: readonly MediaAdapterFactory[];
  readonly enableStaticFallback?: boolean;
}

export class MediaAdapterRegistry {
  private readonly factoriesByKind = new Map<string, MediaAdapterFactory>();
  private readonly enableStaticFallback: boolean;

  constructor(options: MediaAdapterRegistryOptions = {}) {
    this.enableStaticFallback = options.enableStaticFallback ?? true;
    for (const factory of options.factories ?? []) {
      this.register(factory);
    }
  }

  register(factory: MediaAdapterFactory): void {
    for (const kind of factory.providerKinds) {
      this.factoriesByKind.set(kind, factory);
    }
  }

  resolve(provider: MediaAdapterProviderConfig): MediaAdapterResolution {
    if (provider.api !== "media-job") {
      return {
        ok: false,
        errorCode: "unsupported_capability",
        errorMessage: "Media adapters require a media-job provider preset.",
      };
    }

    const factory = this.factoriesByKind.get(provider.kind);
    if (factory) {
      return {
        ok: true,
        adapter: factory.create(provider),
      };
    }

    if (this.enableStaticFallback) {
      return {
        ok: true,
        adapter: createStaticMediaAdapter(),
      };
    }

    return {
      ok: false,
      errorCode: "unsupported_capability",
      errorMessage: `No media adapter is registered for provider kind ${provider.kind}.`,
    };
  }
}

export interface NormalizedMediaAdapterError {
  readonly code: MediaAdapterErrorCode;
  readonly message: string;
}

export class MediaAdapterExecutionError extends Error {
  readonly code: MediaAdapterErrorCode;

  constructor(code: MediaAdapterErrorCode, message: string) {
    super(message);
    this.name = "MediaAdapterExecutionError";
    this.code = code;
  }
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

export async function executeMediaJob(adapter: MediaAdapter, request: MediaExecutionRequest): Promise<MediaExecutionResult> {
  if (!adapter.supports(request.operation)) {
    return {
      status: "failed",
      artifacts: [],
      errorCode: "unsupported_capability",
      errorMessage: `${adapter.displayName} does not support ${request.operation}`,
    };
  }

  try {
    const result = await adapter.execute(request);
    if (result.status === "succeeded") {
      return {
        ...result,
        artifacts: result.artifacts,
        errorCode: undefined,
        errorMessage: undefined,
      };
    }
    return {
      status: "failed",
      artifacts: result.artifacts,
      errorCode: result.errorCode ?? "provider_internal_error",
      errorMessage: result.errorMessage ?? "Media adapter execution failed.",
    };
  } catch (error) {
    const normalized = normalizeMediaAdapterError(error);
    return {
      status: "failed",
      artifacts: [],
      errorCode: normalized.code,
      errorMessage: normalized.message,
    };
  }
}

export function normalizeMediaAdapterError(error: unknown): NormalizedMediaAdapterError {
  if (error instanceof MediaAdapterExecutionError) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof Error) {
    return {
      code: "provider_internal_error",
      message: error.message,
    };
  }
  return {
    code: "provider_internal_error",
    message: String(error),
  };
}

export interface StaticMediaAdapterOptions {
  readonly id?: string;
  readonly displayName?: string;
}

export function createStaticMediaAdapter(options: StaticMediaAdapterOptions = {}): MediaAdapter {
  const capabilities: readonly MediaOperation[] = ["image_generate", "image_edit", "video_generate"];
  return {
    id: options.id ?? "static-media",
    displayName: options.displayName ?? "Static Media Adapter",
    capabilities,

    supports(operation: MediaOperation): boolean {
      return capabilities.includes(operation);
    },

    async execute(request: MediaExecutionRequest): Promise<MediaExecutionResult> {
      if (request.input.forceFailure === true) {
        return {
          status: "failed",
          artifacts: [],
          errorCode: "provider_internal_error",
          errorMessage: "Static media adapter forced failure from input.forceFailure.",
        };
      }

      const forcedErrorCode = readForcedErrorCode(request.input);
      if (forcedErrorCode) {
        throw new MediaAdapterExecutionError(forcedErrorCode, `Static media adapter forced ${forcedErrorCode}.`);
      }

      return {
        status: "succeeded",
        artifacts: [
          {
            type: "markdown",
            title: `${formatMediaOperationLabel(request.operation)} static result`,
            contentType: "text/markdown; charset=utf-8",
            pathHint: "static-result.md",
            content: renderStaticMediaResult(request),
          },
        ],
      };
    },
  };
}

export function createDefaultMediaAdapterRegistry(): MediaAdapterRegistry {
  return new MediaAdapterRegistry({
    factories: [
      createStaticVendorMediaAdapterFactory("jimeng", "Jimeng"),
      createStaticVendorMediaAdapterFactory("seedream", "Seedream"),
      createStaticVendorMediaAdapterFactory("seedance", "Seedance"),
    ],
  });
}

export function createStaticVendorMediaAdapterFactory(kind: string, displayName: string): MediaAdapterFactory {
  return {
    id: `${kind}-static-factory`,
    providerKinds: [kind],
    create(): MediaAdapter {
      return createStaticMediaAdapter({
        id: `${kind}-static`,
        displayName: `${displayName} Static Adapter`,
      });
    },
  };
}

export function resolveMediaAdapter(registry: MediaAdapterRegistry, provider: MediaAdapterProviderConfig): MediaAdapterResolution {
  return registry.resolve(provider);
}

function readForcedErrorCode(input: Record<string, unknown>): MediaAdapterErrorCode | undefined {
  const value = input.forceErrorCode;
  if (typeof value !== "string") {
    return undefined;
  }
  return mediaAdapterErrorCodes.includes(value as MediaAdapterErrorCode) ? value as MediaAdapterErrorCode : "provider_internal_error";
}

function renderStaticMediaResult(request: MediaExecutionRequest): string {
  const redactedInput = JSON.stringify(redactSecrets(request.input), null, 2);
  return [
    "# Media job static result",
    "",
    `- Job: ${request.jobId}`,
    `- Operation: ${request.operation}`,
    `- Provider: ${request.provider.displayName} (${request.provider.providerId}/${request.provider.model})`,
    `- Generated at: ${request.requestedAt}`,
    "",
    "## Prompt",
    "",
    request.prompt,
    "",
    "## Input",
    "",
    "```json",
    redactedInput,
    "```",
    "",
    "This artifact was produced by the local static media adapter. No vendor media API was called.",
    "",
  ].join("\n");
}

function formatMediaOperationLabel(operation: MediaOperation): string {
  if (operation === "image_generate") {
    return "Image generate";
  }
  if (operation === "image_edit") {
    return "Image edit";
  }
  return "Video generate";
}

function redactSecrets(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return value.replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return value.map((item) => redactValue(item, seen));
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shouldRedactKey(key) ? "[REDACTED]" : redactValue(item, seen)]),
    );
  }
  return value;
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return (
    normalized === "apikey" ||
    normalized === "apikeyref" ||
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "password" ||
    normalized === "token" ||
    normalized === "secret" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password")
  );
}

const mediaAdapterErrorCodes: readonly MediaAdapterErrorCode[] = [
  "auth_failed",
  "model_not_found",
  "rate_limited",
  "quota_exceeded",
  "network_error",
  "timeout",
  "unsupported_capability",
  "provider_internal_error",
  "invalid_request",
];
