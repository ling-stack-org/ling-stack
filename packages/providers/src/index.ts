import type { ProviderExtensionMetadata } from "@ling-stack/plugin-sdk";

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
  readonly httpClient?: MediaVendorHttpClient;
  readonly timeoutMs?: number;
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

const MAX_MEDIA_VENDOR_IMAGE_BYTES = 25 * 1024 * 1024;

export interface MediaAdapterRegistryOptions {
  readonly factories?: readonly MediaAdapterFactory[];
  readonly enableStaticFallback?: boolean;
}

export interface DefaultMediaAdapterRegistryOptions {
  readonly enableStaticFallback?: boolean;
  readonly mediaVendorTransport?: MediaVendorTransport;
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

export function createDefaultMediaAdapterRegistry(options: DefaultMediaAdapterRegistryOptions = {}): MediaAdapterRegistry {
  return new MediaAdapterRegistry({
    enableStaticFallback: options.enableStaticFallback,
    factories: defaultMediaVendorAdapterDefinitions().map((definition) =>
      createStaticVendorMediaAdapterFactory(definition.kind, definition.displayName, {
        transport: options.mediaVendorTransport,
      }),
    ),
  });
}

export interface StaticVendorMediaAdapterFactoryOptions {
  readonly transport?: MediaVendorTransport;
}

export function createStaticVendorMediaAdapterFactory(
  kind: string,
  displayName: string,
  options: StaticVendorMediaAdapterFactoryOptions = {},
): MediaAdapterFactory {
  const definition = getMediaVendorAdapterDefinition(kind) ?? {
    kind,
    displayName,
    capabilities: ["image_generate", "image_edit", "video_generate"],
  };
  return {
    id: `${kind}-static-factory`,
    providerKinds: [kind],
    create(): MediaAdapter {
      return createStaticVendorMediaAdapter({
        id: `${kind}-static`,
        displayName: `${displayName} Static Adapter`,
        definition: {
          ...definition,
          displayName,
        },
        transport: options.transport,
      });
    },
  };
}

export function defaultMediaVendorAdapterDefinitions(): readonly MediaVendorAdapterDefinition[] {
  return defaultMediaVendorDefinitions;
}

export function listBuiltinProviderExtensions(): readonly ProviderExtensionMetadata[] {
  return defaultMediaVendorDefinitions.map((definition) => ({
    manifest: {
      id: `provider:media:${definition.kind}`,
      name: `${definition.displayName} Media Provider`,
      version: "0.1.0",
      kind: "provider",
      trustLevel: "internal",
      capabilities: [
        `provider-kind:${definition.kind}`,
        "provider-api:media-job",
        ...definition.capabilities.map((capability) => `media:${capability}`),
      ],
      requiredSecrets: [`env:${definition.kind.toUpperCase()}_API_KEY`],
    },
    providerKind: definition.kind,
    providerApi: "media-job",
    providerCapabilities: [...definition.capabilities],
    mediaOperations: [...definition.capabilities],
  }));
}

export function getBuiltinProviderExtension(id: string): ProviderExtensionMetadata | undefined {
  return listBuiltinProviderExtensions().find((extension) => extension.manifest.id === id);
}

export function createMediaVendorRequestPlan(
  definition: MediaVendorAdapterDefinition,
  request: MediaExecutionRequest,
): MediaVendorRequestPlan {
  return {
    mode: "static_vendor_request_plan",
    liveCall: false,
    vendor: definition.kind,
    operation: request.operation,
    provider: {
      presetId: request.provider.id,
      kind: request.provider.kind,
      providerId: request.provider.providerId,
      model: request.provider.model,
      baseUrl: request.provider.baseUrl,
      apiKeyRef: request.provider.apiKeyRef,
    },
    payload: {
      prompt: request.prompt,
      input: redactSecrets(request.input),
    },
    notes: [
      `${definition.displayName} is resolved through the media adapter registry.`,
      "This is a local request plan only. No live vendor HTTP request was made.",
    ],
  };
}

export function createDisabledMediaVendorTransport(): MediaVendorTransport {
  return {
    mode: "disabled",
    async execute(): Promise<MediaVendorTransportResult> {
      return {
        status: "succeeded",
        artifacts: [],
      };
    },
  };
}

export function createLiveMediaVendorTransport(options: LiveMediaVendorTransportOptions): MediaVendorTransport {
  return {
    mode: "live",
    async execute(request: MediaVendorTransportRequest): Promise<MediaVendorTransportResult> {
      if (!options.baseUrl) {
        return {
          status: "failed",
          errorCode: "invalid_request",
          errorMessage: `${request.vendor.displayName} live media transport requires provider baseUrl.`,
        };
      }
      if (!options.apiKeyRef) {
        return {
          status: "failed",
          errorCode: "auth_failed",
          errorMessage: `${request.vendor.displayName} live media transport requires provider apiKeyRef.`,
        };
      }
      if (!options.apiKeyConfigured) {
        return {
          status: "failed",
          errorCode: "auth_failed",
          errorMessage: `${request.vendor.displayName} live media transport secret is not configured: ${options.apiKeyRef}.`,
        };
      }
      if (!options.apiKey) {
        return {
          status: "failed",
          errorCode: "auth_failed",
          errorMessage: `${request.vendor.displayName} live media transport secret value is not available for ${options.apiKeyRef}.`,
        };
      }
      if (request.vendor.kind !== "seedream") {
        return {
          status: "failed",
          errorCode: "unsupported_capability",
          errorMessage: `Live media vendor transport currently supports seedream image_generate only, not ${request.vendor.kind}.`,
        };
      }
      if (request.requestPlan.operation !== "image_generate") {
        return {
          status: "failed",
          errorCode: "unsupported_capability",
          errorMessage: "Seedream live media transport currently supports image_generate only.",
        };
      }
      return await executeSeedreamImageGeneration(request, options);
    },
  };
}

export function resolveMediaVendorTransportGateConfig(compat: unknown): MediaVendorTransportGateResolution {
  const disabled: MediaVendorTransportGateResolution = {
    ok: true,
    config: { mode: "disabled" },
  };
  if (!isRecord(compat)) {
    return disabled;
  }

  const mediaVendorTransport = compat.mediaVendorTransport;
  if (mediaVendorTransport === undefined) {
    return disabled;
  }
  if (!isRecord(mediaVendorTransport)) {
    return {
      ok: false,
      errorCode: "invalid_request",
      errorMessage: "compat.mediaVendorTransport must be an object with mode disabled or live.",
    };
  }

  const mode = mediaVendorTransport.mode;
  if (mode === undefined || mode === "disabled") {
    return disabled;
  }
  if (mode === "live") {
    return {
      ok: true,
      config: { mode },
    };
  }
  if (mode === "fake") {
    return {
      ok: false,
      errorCode: "invalid_request",
      errorMessage: "compat.mediaVendorTransport.mode=fake is reserved for test injection and cannot be enabled from provider presets.",
    };
  }
  return {
    ok: false,
    errorCode: "invalid_request",
    errorMessage: "compat.mediaVendorTransport.mode must be disabled or live.",
  };
}

async function executeSeedreamImageGeneration(
  request: MediaVendorTransportRequest,
  options: LiveMediaVendorTransportOptions,
): Promise<MediaVendorTransportResult> {
  const endpoint = `${options.baseUrl?.replace(/\/+$/, "")}/images/generations`;
  const payload = buildSeedreamImageGenerationPayload(request.requestPlan);
  const httpClient = options.httpClient ?? defaultMediaVendorHttpClient;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await httpClient(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: abortController.signal,
    });
    if (!response.ok) {
      return await normalizeSeedreamHttpFailure(response, options.apiKey);
    }

    const json = await response.json();
    const imageUrls = extractSeedreamImageUrls(json);
    if (imageUrls.length === 0) {
      return {
        status: "failed",
        errorCode: "invalid_request",
        errorMessage: "Seedream image generation response did not include image URL data.",
      };
    }
    const imageArtifacts = await downloadSeedreamImageArtifacts(imageUrls, httpClient, abortController.signal);

    return {
      status: "succeeded",
      artifacts: [
        {
          type: "json",
          title: "Seedream image_generate response",
          contentType: "application/json; charset=utf-8",
          pathHint: "seedream-image-response.json",
          content: JSON.stringify(redactSecrets({
            mode: "live_seedream_image_generate",
            vendor: request.vendor.kind,
            operation: request.requestPlan.operation,
            endpoint,
            imageCount: imageUrls.length,
            request: payload,
            response: json,
          }, [options.apiKey]), null, 2),
        },
        ...imageArtifacts,
      ],
    };
  } catch (error) {
    if (error instanceof MediaAdapterExecutionError) {
      return {
        status: "failed",
        errorCode: error.code,
        errorMessage: redactSecretText(error.message, [options.apiKey]),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      errorCode: error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error",
      errorMessage: redactSecretText(message, [options.apiKey]),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildSeedreamImageGenerationPayload(plan: MediaVendorRequestPlan): Record<string, unknown> {
  const input = isRecord(plan.payload.input) ? plan.payload.input : {};
  return removeUndefined({
    model: plan.provider.model,
    prompt: plan.payload.prompt,
    response_format: typeof input.response_format === "string" ? input.response_format : "url",
    size: typeof input.size === "string" ? input.size : undefined,
    n: typeof input.n === "number" ? input.n : undefined,
    watermark: typeof input.watermark === "boolean" ? input.watermark : undefined,
    seed: typeof input.seed === "number" ? input.seed : undefined,
  });
}

async function downloadSeedreamImageArtifacts(
  imageUrls: readonly string[],
  httpClient: MediaVendorHttpClient,
  signal: AbortSignal,
): Promise<MediaExecutionArtifact[]> {
  const artifacts: MediaExecutionArtifact[] = [];
  for (const [index, imageUrl] of imageUrls.entries()) {
    const parsedUrl = parseMediaImageUrl(imageUrl);
    const response = await httpClient(parsedUrl.toString(), {
      method: "GET",
      headers: {},
      signal,
    });
    if (!response.ok) {
      throw new MediaAdapterExecutionError(
        mapSeedreamHttpStatus(response.status),
        `Seedream image download failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
      );
    }
    const contentType = getMediaVendorResponseHeader(response, "content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!contentType.startsWith("image/")) {
      throw new MediaAdapterExecutionError(
        "invalid_request",
        `Seedream image URL returned non-image content type: ${contentType || "unknown"}.`,
      );
    }
    const declaredLength = parseContentLength(getMediaVendorResponseHeader(response, "content-length"));
    if (declaredLength !== undefined && declaredLength > MAX_MEDIA_VENDOR_IMAGE_BYTES) {
      throw new MediaAdapterExecutionError(
        "invalid_request",
        `Seedream image exceeds ${MAX_MEDIA_VENDOR_IMAGE_BYTES} byte limit.`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_MEDIA_VENDOR_IMAGE_BYTES) {
      throw new MediaAdapterExecutionError(
        "invalid_request",
        `Seedream image exceeds ${MAX_MEDIA_VENDOR_IMAGE_BYTES} byte limit.`,
      );
    }
    artifacts.push({
      type: "image",
      title: `Seedream image ${index + 1}`,
      contentType,
      pathHint: `seedream-image-${index + 1}.${imageExtensionForContentType(contentType)}`,
      contentBytes: bytes,
    });
  }
  return artifacts;
}

function parseMediaImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaAdapterExecutionError("invalid_request", "Seedream image response included an invalid image URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MediaAdapterExecutionError("invalid_request", "Seedream image URL must use http or https.");
  }
  return url;
}

function getMediaVendorResponseHeader(response: MediaVendorHttpResponse, name: string): string | undefined {
  return response.headers?.get(name) ?? response.headers?.get(name.toLowerCase()) ?? undefined;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function imageExtensionForContentType(contentType: string): string {
  if (contentType === "image/jpeg" || contentType === "image/jpg") {
    return "jpg";
  }
  if (contentType === "image/webp") {
    return "webp";
  }
  if (contentType === "image/gif") {
    return "gif";
  }
  if (contentType === "image/svg+xml") {
    return "svg";
  }
  return "png";
}

async function normalizeSeedreamHttpFailure(response: MediaVendorHttpResponse, apiKey: string | undefined): Promise<MediaVendorTransportResult> {
  const body = await readHttpResponseBody(response);
  const redactedBody = redactSecretText(body, [apiKey]);
  return {
    status: "failed",
    errorCode: mapSeedreamHttpStatus(response.status),
    errorMessage: `Seedream image generation failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.${redactedBody ? ` ${redactedBody}` : ""}`.trim(),
  };
}

async function readHttpResponseBody(response: MediaVendorHttpResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function mapSeedreamHttpStatus(status: number): MediaAdapterErrorCode {
  if (status === 401 || status === 403) {
    return "auth_failed";
  }
  if (status === 404) {
    return "model_not_found";
  }
  if (status === 408 || status === 504) {
    return "timeout";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 400 && status < 500) {
    return "invalid_request";
  }
  return "provider_internal_error";
}

function extractSeedreamImageUrls(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return [];
  }
  return value.data
    .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.url === "string")
    .map((item) => item.url as string);
}

async function defaultMediaVendorHttpClient(url: string, init: MediaVendorHttpRequestInit): Promise<MediaVendorHttpResponse> {
  return await fetch(url, init);
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

function createStaticVendorMediaAdapter(options: StaticMediaAdapterOptions & {
  readonly definition: MediaVendorAdapterDefinition;
  readonly transport?: MediaVendorTransport;
}): MediaAdapter {
  const capabilities = options.definition.capabilities;
  const transport = options.transport ?? createDisabledMediaVendorTransport();
  return {
    id: options.id ?? `${options.definition.kind}-static`,
    displayName: options.displayName ?? `${options.definition.displayName} Static Adapter`,
    capabilities,

    supports(operation: MediaOperation): boolean {
      return capabilities.includes(operation);
    },

    async execute(request: MediaExecutionRequest): Promise<MediaExecutionResult> {
      if (!capabilities.includes(request.operation)) {
        throw new MediaAdapterExecutionError(
          "unsupported_capability",
          `${options.definition.displayName} static adapter does not support ${request.operation}.`,
        );
      }

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

      const requestPlan = createMediaVendorRequestPlan(options.definition, request);
      const transportResult = await transport.execute({
        vendor: options.definition,
        requestPlan,
        jobId: request.jobId,
        requestedAt: request.requestedAt,
      });
      if (transportResult.status === "failed") {
        return {
          status: "failed",
          artifacts: [],
          errorCode: transportResult.errorCode ?? "provider_internal_error",
          errorMessage: transportResult.errorMessage ?? "Media vendor transport failed.",
        };
      }

      return {
        status: "succeeded",
        artifacts: [
          {
            type: "markdown",
            title: `${options.definition.displayName} ${formatMediaOperationLabel(request.operation)} request plan`,
            contentType: "text/markdown; charset=utf-8",
            pathHint: "vendor-request-plan.md",
            content: renderStaticVendorMediaResult(options.definition, request, requestPlan, transport.mode),
          },
          ...(transportResult.artifacts ?? []),
        ],
      };
    },
  };
}

function renderStaticVendorMediaResult(
  definition: MediaVendorAdapterDefinition,
  request: MediaExecutionRequest,
  plan: MediaVendorRequestPlan,
  transportMode: MediaVendorTransportMode,
): string {
  const requestPlan = JSON.stringify(plan, null, 2);
  return [
    "# Media job static result",
    "",
    `- Job: ${request.jobId}`,
    `- Operation: ${request.operation}`,
    `- Vendor: ${definition.displayName} (${definition.kind})`,
    `- Provider: ${request.provider.displayName} (${request.provider.providerId}/${request.provider.model})`,
    `- Transport: ${transportMode}`,
    `- Generated at: ${request.requestedAt}`,
    "",
    "## Prompt",
    "",
    request.prompt,
    "",
    "## Vendor request plan",
    "",
    "```json",
    requestPlan,
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

function redactSecrets(value: unknown, extraSecrets: readonly (string | undefined)[] = []): unknown {
  return redactValue(value, new WeakSet<object>(), extraSecrets.filter((secret): secret is string => Boolean(secret)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function redactSecretText(value: string, extraSecrets: readonly (string | undefined)[] = []): string {
  const secrets = extraSecrets.filter((secret): secret is string => Boolean(secret));
  return redactValue(value, new WeakSet<object>(), secrets) as string;
}

function redactValue(value: unknown, seen: WeakSet<object>, extraSecrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return extraSecrets.reduce(
      (text, secret) => text.split(secret).join("[REDACTED]"),
      value.replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"),
    );
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return value.map((item) => redactValue(item, seen, extraSecrets));
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shouldRedactKey(key) ? "[REDACTED]" : redactValue(item, seen, extraSecrets)]),
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

const defaultMediaVendorDefinitions: readonly MediaVendorAdapterDefinition[] = [
  {
    kind: "jimeng",
    displayName: "Jimeng",
    capabilities: ["image_generate", "image_edit"],
  },
  {
    kind: "seedream",
    displayName: "Seedream",
    capabilities: ["image_generate", "image_edit"],
  },
  {
    kind: "seedance",
    displayName: "Seedance",
    capabilities: ["video_generate"],
  },
];

function getMediaVendorAdapterDefinition(kind: string): MediaVendorAdapterDefinition | undefined {
  return defaultMediaVendorDefinitions.find((definition) => definition.kind === kind);
}
