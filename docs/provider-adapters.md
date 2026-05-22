# Provider Adapters

## Principle

Providers expose capabilities, not just chat.

Ling Stack should route work by capability:

- `chat`
- `tool_call`
- `reasoning`
- `vision`
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
  embed?(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  generateImage?(request: ImageRequest): Promise<MediaJob>;
  generateVideo?(request: VideoRequest): Promise<MediaJob>;
  pollJob?(jobId: string): Promise<MediaJobStatus>;
}
```

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

- `createStaticMediaAdapter()` is the only executable media adapter,
- it produces redacted Markdown artifact candidates for success,
- it exposes deterministic failure/error paths for contract tests,
- it does not call Jimeng, Seedream, Seedance, billing, or approval services.

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

This adapter should support local relays like One API, New API, LiteLLM, OpenRouter-style endpoints, and private proxy services.

### Doubao / Volcengine Ark

Target capabilities:

- `chat`
- `tool_call` if enabled by the selected endpoint.
- `vision` where model support exists.

### DeepSeek V4 / DPV4-Compatible

Target capabilities:

- `chat`
- `reasoning`
- `tool_call` if endpoint support is present.

The name `dpv4` should be treated as a configurable model alias until the exact upstream is pinned.

### MiniMax

Target capabilities:

- `chat`
- future audio/video capabilities if the API key and model support them.

### GLM / Zhipu

Target capabilities:

- `chat`
- `tool_call`
- `embedding`
- coding-specific endpoint support where available.

### Jimeng / Seedream / Seedance

Target capabilities:

- `image_generate`
- `image_edit`
- `video_generate`

These should be modeled as async media jobs, not synchronous chat completions.

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

Current media contract coverage lives in `packages/providers/test/media-adapter-contract.test.mjs` and covers static success, forced failure, thrown error normalization, unsupported capability rejection, and secret redaction.

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
