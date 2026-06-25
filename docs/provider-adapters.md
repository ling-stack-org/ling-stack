# Provider Adapters

## Principle

Providers expose capabilities, not just chat.

Ling Stack should route work by capability:

- `chat`
- `tool_call`
- `reasoning`
- `vision`
- `web_search`
- `embedding`
- `image_generate`
- `image_edit`
- `video_generate`
- `tts`
- `asr`

## Base Interface Draft

```ts
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

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly ProviderCapability[];

  checkHealth(): Promise<ProviderHealth>;
  listModels(): Promise<readonly ModelInfo[]>;

  chat?(request: ChatRequest): AsyncIterable<ChatChunk>;
  webSearch?(request: WebSearchRequest): Promise<WebSearchResult>;
  embed?(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  generateImage?(request: ImageRequest): Promise<MediaJob>;
  generateVideo?(request: VideoRequest): Promise<MediaJob>;
  pollJob?(jobId: string): Promise<MediaJobStatus>;
}
```

## Web Search Adapter Contract

`web_search` is a Ling global tool backed by provider-style backend presets. A backend preset is eligible only when Ling has an adapter that can translate its protocol into normalized evidence. Surfaces do not call adapters directly; they call the daemon web evidence service, which resolves a global web-search backend independently from the current chat provider, dispatches the adapter, and renders a bounded evidence prompt for channel or private replies.

```ts
interface WebSearchRequest {
  providerPreset: ProviderPreset;
  apiKey: string;
  query: string;
  timeoutMs?: number;
}

interface WebSearchResult {
  query: string;
  text: string;
  sources: Array<{
    title?: string;
    url: string;
    snippet?: string;
  }>;
  provider: {
    adapterId: string;
    providerPresetId: string;
    displayName: string;
  };
}

interface ProviderWebSearchAdapter {
  id: string;
  displayName: string;
  protocol: string;
  supportsProvider(provider: ProviderPreset): boolean;
  search(request: WebSearchRequest): Promise<WebSearchResult>;
}
```

Current implementation:

- `openai-responses-web-search` supports enabled official OpenAI Responses presets that declare `web_search`, plus explicit Responses-compatible presets such as xAI/Grok or private relays with `compat.webSearch.protocol = "responses-web-search"`.
- `openai-chat-completions-web-search` supports explicit Chat Completions search presets with `compat.webSearch.protocol = "openai-chat-completions-search"`.
- `google-interactions-web-search` supports Gemini Google Search grounding presets with `compat.webSearch.protocol = "google-interactions-search"`.
- `web-evidence-service` is the global daemon surface for web intent detection, URL reading, backend-backed search dispatch, blocked reasons, and prompt metadata.
- Channel replies and private teammate replies both reuse the same evidence service; workflow steps and automations should use this service instead of adding surface-local web-search logic.
- The current chat provider does not need `web_search`. Custom OpenAI-compatible, Grok, Gemini, domestic, and private models can consume global web evidence as plain context.
- Generic OpenAI-compatible chat/completions relays do not inherit `web_search`; each relay or vendor needs either a known protocol declaration or a dedicated adapter if it exposes search.
- Domestic providers are supported through the same protocol gate when their endpoint implements a known search protocol and returns citations/sources that Ling can normalize. If a domestic endpoint uses a vendor-specific extension, add a dedicated adapter and tests before advertising `web_search`.
- Perplexity/search-model providers, Anthropic, and additional domestic provider-specific search extensions remain future adapters.

Supported `compat.webSearch` protocols:

```json
{ "webSearch": { "protocol": "responses-web-search" } }
```

Use for OpenAI Responses-compatible hosted search, including xAI/Grok and private relays that expose `/responses` with `tools: [{ "type": "web_search" }]`.

```json
{ "webSearch": { "protocol": "openai-chat-completions-search" } }
```

Use for Chat Completions-compatible search models or gateways that accept `web_search_options` and return URL annotations.

```json
{ "webSearch": { "protocol": "google-interactions-search" } }
```

Use for Gemini Search grounding through the Gemini API Interactions endpoint.

`endpointPath` may be provided for relays that mount the same protocol at a non-standard path. It must be a relative path; full URLs are ignored so provider search cannot silently send the configured provider key to an unrelated host.

`timeoutMs` may be provided for slow relays. The default is 12 seconds and overrides are clamped to 12-120 seconds. This applies only to provider-backed `web_search`; public `open_url` reads keep their shorter bounded timeout.

## Media Execution Contract

Media execution is intentionally separate from chat provider adapters. Daemon media jobs call a `MediaAdapter` through `executeMediaJob(adapter, request)`, then persist returned artifact candidates under `.ling-stack/artifacts`.

```ts
type MediaOperation = "image_generate" | "image_edit" | "video_generate";

interface MediaExecutionRequest {
  jobId: string;
  provider: MediaAdapterProviderConfig;
  operation: MediaOperation;
  prompt: string;
  input: Record<string, unknown>;
  requestedAt: string;
}

interface MediaExecutionResult {
  status: "succeeded" | "failed";
  artifacts: MediaExecutionArtifact[];
  errorCode?: MediaAdapterErrorCode;
  errorMessage?: string;
}

interface MediaAdapter {
  id: string;
  displayName: string;
  capabilities: MediaOperation[];
  supports(operation: MediaOperation): boolean;
  execute(request: MediaExecutionRequest): Promise<MediaExecutionResult>;
}
```

Current implementation:

- `createStaticMediaAdapter()` remains the local fallback adapter,
- `createDefaultMediaAdapterRegistry()` maps `jimeng`, `seedream`, and `seedance` provider kinds to vendor adapter factory stubs,
- static vendor stubs expose vendor-specific operation capabilities and emit a redacted `static_vendor_request_plan`,
- `MediaVendorTransport` is present as a disabled-by-default seam; tests can inject fake transports, and provider preset `compat.mediaVendorTransport.mode = "live"` enables the live gate,
- live transport currently supports only Seedream `image_generate` through the OpenAI-compatible `/images/generations` endpoint, records redacted JSON metadata artifacts, and downloads returned HTTP(S) image URLs into local image artifact candidates,
- unknown media providers fall back to the static adapter by default, while tests can disable that fallback to assert missing-adapter errors,
- it produces redacted Markdown artifact candidates for success,
- it exposes deterministic failure/error paths for contract tests,
- it does not call Jimeng, Seedance, Seedream operations beyond `image_generate`, billing, or approval services.

## Initial Adapter List

### Pi Runner

Ling Stack should use `earendil-works/pi` as the first coding-agent kernel. This is not a provider adapter in the media/model sense; it is a runner adapter that already understands coding-agent sessions, streaming, tool calls, read/write/edit/bash tools, and many LLM providers.

Keep this adapter thin:

- Use pi for agent loop and coding tools.
- Use Ling Stack for tasks, channels, approvals, audit logs, artifacts, and UI.
- Do not fork pi unless upstream blocks a required product behavior.

### OpenAI

Target capabilities:

- `chat`
- `tool_call`
- `reasoning`
- `vision`
- `embedding`
- `web_search` only for official Responses presets with the OpenAI web-search adapter.

### Anthropic Claude

Target capabilities:

- `chat`
- `tool_call`
- `reasoning`
- `vision`

### Generic OpenAI-Compatible

Target capabilities:

- `chat`
- `tool_call` when supported by the relay.
- optional `embedding`.
- no implicit `web_search`.
- explicit `web_search` only when `compat.webSearch.protocol` names a supported search protocol.

This adapter should support local relays like One API, New API, LiteLLM, OpenRouter-style endpoints, and private proxy services.

### xAI / Grok

Target capabilities:

- `chat`
- `tool_call` when model support exists.
- `reasoning` where model support exists.
- `web_search` through `responses-web-search`.

Ling models Grok as an OpenAI-compatible Responses provider with an explicit web-search protocol declaration rather than adding a hidden xAI-only key path.

### Google Gemini

Target capabilities:

- `chat`
- `tool_call` where model support exists.
- `vision` where model support exists.
- `web_search` through `google-interactions-search`.

Gemini does not use OpenAI tool-call citations. Its adapter maps Google Search grounding annotations or grounding chunks into Ling's normalized source list.

### Doubao / Volcengine Ark

Target capabilities:

- `chat`
- `tool_call` if enabled by the selected endpoint.
- `vision` where model support exists.
- `web_search` only if the configured Ark endpoint implements one of Ling's supported search protocols or a future Ark-specific adapter.

### DeepSeek V4 / DPV4-Compatible

Target capabilities:

- `chat`
- `reasoning`
- `tool_call` if endpoint support is present.
- `web_search` only if the configured endpoint implements one of Ling's supported search protocols or a future DeepSeek-specific adapter.

The name `dpv4` should be treated as a configurable model alias until the exact upstream is pinned.

### MiniMax

Target capabilities:

- `chat`
- future audio/video capabilities if the API key and model support them.
- `web_search` only if the configured endpoint implements one of Ling's supported search protocols or a future MiniMax-specific adapter.

### GLM / Zhipu

Target capabilities:

- `chat`
- `tool_call`
- `embedding`
- coding-specific endpoint support where available.
- `web_search` only if the configured endpoint implements one of Ling's supported search protocols or a future GLM-specific adapter.

### Jimeng / Seedream / Seedance

Target capabilities:

- `image_generate`
- `image_edit`
- `video_generate`

These should be modeled as async media jobs, not synchronous chat completions. Seedream `image_generate` is the first live HTTP adapter behind `compat.mediaVendorTransport.mode = "live"` and can store returned image URL bytes as local artifacts. All other Jimeng, Seedream, and Seedance live operations remain deferred.

## Contract Tests

Every adapter should have contract tests for:

- Missing API key.
- Invalid model.
- Health check.
- Streaming chat.
- Non-streaming chat if supported.
- Tool-call shape if supported.
- Rate-limit or provider error normalization.
- Secret redaction in logs.

Current media contract coverage lives in `packages/providers/test/media-adapter-contract.test.mjs` and covers static success, forced failure, thrown error normalization, unsupported capability rejection, provider-kind registry wiring, vendor request planning, disabled/fake/live transport seams, live gate validation, Seedream `image_generate` mock HTTP success/failure, image URL byte download validation, vendor operation capability boundaries, missing adapter errors, non-media provider rejection, and secret redaction.

## Error Normalization

Provider errors should become a small internal set:

- `auth_failed`
- `model_not_found`
- `rate_limited`
- `quota_exceeded`
- `network_error`
- `timeout`
- `unsupported_capability`
- `provider_internal_error`
- `invalid_request`

Raw provider responses can be stored only after secret redaction.
