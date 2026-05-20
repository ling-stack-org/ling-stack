# Provider Presets Design

## Status

Draft for Milestone 2: Provider Presets.

This design follows `session-persistence`. Session persistence keeps a redacted request snapshot for direct `/runs` calls. Provider presets replace repeated inline provider JSON with reusable, user-facing configurations.

## Goal

Users should be able to configure model providers once and reuse them across CLI, daemon, Web UI, and future desktop flows.

Minimum outcome:

```text
create provider preset
-> store non-secret config locally
-> reference secret by name
-> check provider health
-> run task with providerPresetId
-> resolve preset into PiRunnerProviderConfig or media job config
```

Provider presets are a product concept. They are not only SDK adapters. A preset represents what the user sees and chooses in the workspace.

## Current Baseline

Implemented today:

- `POST /runs` accepts inline provider config.
- `PiRunnerAdapter` accepts `provider`, `model`, `apiKey`, `baseUrl`, `api`, `headers`, and compatibility settings.
- Custom OpenAI-compatible providers can be registered dynamically by the Pi runner adapter when `baseUrl` is present.
- `packages/providers` defines capability interfaces but has no concrete adapters.

Not implemented yet:

- Persistent provider preset storage.
- Secret references.
- Provider CRUD API.
- Provider health check API.
- Provider selection in CLI or Web UI.
- Media provider job routing.

## Scope

This slice includes:

- Provider preset data model.
- Provider preset SQLite schema.
- Secret reference format for development mode.
- CRUD API shape.
- Health check API shape.
- Mapping from preset to `PiRunnerProviderConfig`.
- Provider capability matrix.
- Backward-compatible `/runs` behavior.
- CLI and Web UI requirements for provider setup.

This slice does not include:

- Full Web UI implementation.
- Full CLI implementation.
- OS keychain integration.
- Concrete image/video job execution.
- Vendor-specific model catalog sync.
- Billing or quota management.
- Multi-user secret sharing.

## Design Principles

- Providers expose capabilities, not just chat endpoints.
- GPT, Claude, domestic providers, and OpenAI-compatible relays are first-class.
- Domestic provider support must not make the product China-only.
- Media providers such as Jimeng, Seedream, and Seedance should not be forced through chat abstractions.
- API keys must not be stored in SQLite, JSONL, summaries, events, or logs.
- Inline provider config remains useful for development but should not be the normal product path.

## Provider Kinds

```ts
type ProviderKind =
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
```

`openai-compatible` covers local relays and proxy services such as One API, New API, LiteLLM, OpenRouter-style services, and private compatible gateways.

`deepseek` should cover DeepSeek and DPV4-compatible endpoints as a configurable provider family. Do not hardcode `dpv4` as a fixed upstream model.

## Capabilities

Use the existing capability vocabulary:

```ts
type ProviderCapability =
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
```

Capabilities are declared on the preset because model support differs even inside the same vendor.

Example:

```json
{
  "kind": "openai-compatible",
  "displayName": "Local Relay DPV4",
  "model": "dpv4",
  "capabilities": ["chat", "reasoning"]
}
```

## Preset Model

```ts
type ProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "mistral-conversations"
  | "media-job";

interface ProviderPreset {
  id: string;
  kind: ProviderKind;
  displayName: string;
  providerId: string;
  model: string;
  api: ProviderApi;
  baseUrl?: string;
  apiKeyRef?: string;
  headers: Record<string, string>;
  authHeader?: boolean;
  reasoning?: boolean;
  input: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
  capabilities: ProviderCapability[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

Field notes:

- `id`: Ling Stack preset id, for example `provider_local_relay`.
- `providerId`: runtime provider id passed to Pi, for example `local-relay` or `openai`.
- `kind`: product/vendor family.
- `api`: runtime protocol.
- `baseUrl`: required for OpenAI-compatible relays and many domestic compatible endpoints.
- `apiKeyRef`: secret reference, never raw key.
- `headers`: static non-secret headers only. Secret headers should use a future secret reference model.
- `authHeader`: passed through to Pi for compatible providers when needed.
- `compat`: protocol compatibility options forwarded to Pi when needed.
- `enabled`: disabled presets remain stored but cannot be used for new runs.

## Secret References

Development mode secret refs:

```text
env:OPENAI_API_KEY
env:ANTHROPIC_API_KEY
env:DOUBAO_API_KEY
env:DEEPSEEK_API_KEY
env:MINIMAX_API_KEY
env:GLM_API_KEY
env:LOCAL_RELAY_API_KEY
env:JIMENG_API_KEY
```

Future desktop refs:

```text
keychain:provider_<id>
```

Rules:

- SQLite stores only `api_key_ref`.
- `.env` can define keys during development.
- Daemon resolves the secret at run or health-check time.
- Resolved secret values are never returned from API responses.
- Redacted API responses may show whether a secret is configured:

```json
{
  "apiKeyConfigured": true,
  "apiKeyRef": "env:OPENAI_API_KEY"
}
```

## SQLite Schema

```sql
CREATE TABLE provider_presets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  api TEXT NOT NULL,
  base_url TEXT,
  api_key_ref TEXT,
  headers_json TEXT NOT NULL,
  auth_header INTEGER,
  reasoning INTEGER,
  input_json TEXT NOT NULL,
  context_window INTEGER,
  max_tokens INTEGER,
  compat_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_provider_presets_kind ON provider_presets(kind);
CREATE INDEX idx_provider_presets_enabled ON provider_presets(enabled);
```

Optional health cache:

```sql
CREATE TABLE provider_health_checks (
  id TEXT PRIMARY KEY,
  provider_preset_id TEXT NOT NULL,
  ok INTEGER NOT NULL,
  code TEXT,
  message TEXT,
  checked_at TEXT NOT NULL,
  FOREIGN KEY(provider_preset_id) REFERENCES provider_presets(id) ON DELETE CASCADE
);

CREATE INDEX idx_provider_health_checks_preset_time
  ON provider_health_checks(provider_preset_id, checked_at);
```

Recommendation: implement health cache only if the UI needs historical health display. It is not required for the first health-check endpoint.

## Preset Templates

Templates are suggested defaults. Users can edit model, base URL, API type, capabilities, and context limits.

### OpenAI

```json
{
  "kind": "openai",
  "displayName": "OpenAI",
  "providerId": "openai",
  "model": "gpt-5.5",
  "api": "openai-responses",
  "apiKeyRef": "env:OPENAI_API_KEY",
  "capabilities": ["chat", "tool_call", "reasoning", "vision", "embedding"],
  "input": ["text", "image"],
  "enabled": true
}
```

### Anthropic Claude

```json
{
  "kind": "anthropic",
  "displayName": "Claude",
  "providerId": "anthropic",
  "model": "claude-default",
  "api": "anthropic-messages",
  "apiKeyRef": "env:ANTHROPIC_API_KEY",
  "capabilities": ["chat", "tool_call", "reasoning", "vision"],
  "input": ["text", "image"],
  "enabled": true
}
```

### Generic OpenAI-Compatible Relay

```json
{
  "kind": "openai-compatible",
  "displayName": "Local Relay",
  "providerId": "local-relay",
  "model": "dpv4",
  "baseUrl": "http://127.0.0.1:3000/v1",
  "api": "openai-completions",
  "apiKeyRef": "env:LOCAL_RELAY_API_KEY",
  "capabilities": ["chat", "tool_call", "reasoning"],
  "input": ["text"],
  "enabled": true
}
```

### Doubao / Volcengine Ark

```json
{
  "kind": "doubao",
  "displayName": "Doubao / Ark",
  "providerId": "doubao",
  "model": "user-configured-model",
  "baseUrl": "user-configured-base-url",
  "api": "openai-completions",
  "apiKeyRef": "env:DOUBAO_API_KEY",
  "capabilities": ["chat", "tool_call", "vision"],
  "input": ["text", "image"],
  "enabled": true
}
```

### DeepSeek / DPV4-Compatible

```json
{
  "kind": "deepseek",
  "displayName": "DeepSeek / DPV4",
  "providerId": "deepseek",
  "model": "user-configured-model",
  "baseUrl": "user-configured-base-url",
  "api": "openai-completions",
  "apiKeyRef": "env:DEEPSEEK_API_KEY",
  "capabilities": ["chat", "reasoning", "tool_call"],
  "input": ["text"],
  "enabled": true
}
```

### MiniMax

```json
{
  "kind": "minimax",
  "displayName": "MiniMax",
  "providerId": "minimax",
  "model": "user-configured-model",
  "baseUrl": "user-configured-base-url",
  "api": "openai-completions",
  "apiKeyRef": "env:MINIMAX_API_KEY",
  "capabilities": ["chat"],
  "input": ["text"],
  "enabled": true
}
```

### GLM / Zhipu

```json
{
  "kind": "glm",
  "displayName": "GLM / Zhipu",
  "providerId": "glm",
  "model": "user-configured-model",
  "baseUrl": "user-configured-base-url",
  "api": "openai-completions",
  "apiKeyRef": "env:GLM_API_KEY",
  "capabilities": ["chat", "tool_call", "embedding"],
  "input": ["text"],
  "enabled": true
}
```

### Jimeng / Seedream / Seedance

Media providers are represented as presets, but they do not route through `PiRunnerAdapter`.

```json
{
  "kind": "jimeng",
  "displayName": "Jimeng",
  "providerId": "jimeng",
  "model": "user-configured-model",
  "api": "media-job",
  "apiKeyRef": "env:JIMENG_API_KEY",
  "capabilities": ["image_generate", "image_edit"],
  "input": ["text", "image"],
  "enabled": true
}
```

Seedance should use `video_generate`. Seedream should use `image_generate` and `image_edit` depending on the configured endpoint.

## Provider-to-Runner Mapping

For coding runs, daemon resolves a preset into `PiRunnerProviderConfig`:

```ts
interface PiRunnerProviderConfig {
  provider: string;
  model: string;
  displayName?: string;
  apiKey?: string;
  baseUrl?: string;
  api?: ProviderApi;
  headers?: Record<string, string>;
  authHeader?: boolean;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
}
```

Mapping:

| Preset field | Runner field |
| --- | --- |
| `providerId` | `provider` |
| `model` | `model` |
| `displayName` | `displayName` |
| resolved `apiKeyRef` | `apiKey` |
| `baseUrl` | `baseUrl` |
| `api` | `api` |
| `headers` | `headers` |
| `authHeader` | `authHeader` |
| `reasoning` | `reasoning` |
| `input` | `input` |
| `contextWindow` | `contextWindow` |
| `maxTokens` | `maxTokens` |
| `compat` | `compat` |

If `api` is `media-job`, the preset cannot be used with `POST /runs` for Pi coding sessions. The daemon should return `unsupported_capability`.

## API Design

### List Providers

```http
GET /providers
```

Response:

```json
{
  "providers": [
    {
      "id": "provider_local_relay",
      "kind": "openai-compatible",
      "displayName": "Local Relay",
      "providerId": "local-relay",
      "model": "dpv4",
      "baseUrl": "http://127.0.0.1:3000/v1",
      "api": "openai-completions",
      "apiKeyRef": "env:LOCAL_RELAY_API_KEY",
      "apiKeyConfigured": true,
      "capabilities": ["chat", "reasoning"],
      "enabled": true
    }
  ]
}
```

### Create Provider

```http
POST /providers
Content-Type: application/json
```

Request:

```json
{
  "kind": "openai-compatible",
  "displayName": "Local Relay",
  "providerId": "local-relay",
  "model": "dpv4",
  "baseUrl": "http://127.0.0.1:3000/v1",
  "api": "openai-completions",
  "apiKeyRef": "env:LOCAL_RELAY_API_KEY",
  "capabilities": ["chat", "reasoning"],
  "input": ["text"]
}
```

Response:

```json
{
  "provider": {
    "id": "provider_..."
  }
}
```

Raw `apiKey` should not be accepted for persistent provider creation. The user must provide `apiKeyRef`.

### Get Provider

```http
GET /providers/:id
```

### Update Provider

```http
PATCH /providers/:id
```

Editable fields:

- `displayName`
- `providerId`
- `model`
- `baseUrl`
- `api`
- `apiKeyRef`
- `headers`
- `authHeader`
- `reasoning`
- `input`
- `contextWindow`
- `maxTokens`
- `compat`
- `capabilities`
- `enabled`

### Delete Provider

```http
DELETE /providers/:id
```

Delete should be blocked if a channel or teammate references the provider. Before those models exist, delete can be allowed if no run is currently using it.

### Check Provider

```http
POST /providers/:id/check
```

Response:

```json
{
  "ok": false,
  "code": "auth_failed",
  "message": "API key is missing or rejected.",
  "checkedAt": "2026-05-20T10:00:00.000Z"
}
```

Check levels:

1. Config validation.
2. Secret resolution.
3. Base URL syntax validation.
4. Optional network/model call if the adapter supports it.

For Milestone 2, a provider health check can be conservative: fail missing key/base URL/model, and perform a lightweight model request only where implementation is straightforward.

## `/runs` Integration

Keep current inline provider support for development:

```json
{
  "provider": {
    "provider": "local-relay",
    "model": "dpv4",
    "baseUrl": "http://127.0.0.1:3000/v1",
    "apiKey": "sk-local"
  }
}
```

Add preferred preset support:

```json
{
  "providerPresetId": "provider_local_relay"
}
```

Rules:

- Request must include either `providerPresetId` or inline `provider`.
- If both are present, `providerPresetId` wins and inline provider is ignored or rejected.
- Recommendation: reject both-present requests with `bad_request` to avoid ambiguity.
- Resolved provider config should be included in the run request snapshot only after redaction.
- Raw resolved API key should be passed only to `PiRunnerAdapter.runTask()`.

Updated request shape:

```ts
interface RunRequest {
  cwd: string;
  task: {
    id: string;
    title: string;
    prompt: string;
    channelId?: string;
  };
  providerPresetId?: string;
  provider?: InlineProviderConfig;
  tools?: ToolName[];
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
  appendSystemPrompt?: string[];
  agentDir?: string;
}
```

## Validation Rules

Provider preset validation:

- `kind` must be a known provider kind.
- `displayName` must be non-empty.
- `providerId` must be non-empty and URL-safe enough for runtime use.
- `model` must be non-empty unless the provider is a model-list-only future adapter.
- `api` must be compatible with `kind`.
- `baseUrl` is required for `openai-compatible` and most domestic compatible presets.
- `apiKeyRef` must use a supported scheme: `env:` now, `keychain:` later.
- `capabilities` must be non-empty.
- `media-job` presets must include at least one media capability.
- non-media coding presets must include `chat`.

## Error Codes

Provider endpoints should normalize errors:

```text
bad_request
provider_not_found
provider_disabled
secret_missing
auth_failed
model_not_found
unsupported_capability
network_error
timeout
provider_internal_error
```

## CLI Requirements

Commands:

```text
ling-stack provider add
ling-stack provider list
ling-stack provider show <id>
ling-stack provider check <id>
ling-stack provider update <id>
ling-stack provider remove <id>
```

Recommended first version:

```bash
ling-stack provider add openai-compatible \
  --name "Local Relay" \
  --provider-id local-relay \
  --model dpv4 \
  --base-url http://127.0.0.1:3000/v1 \
  --api openai-completions \
  --api-key-ref env:LOCAL_RELAY_API_KEY \
  --capability chat \
  --capability reasoning
```

`ling-stack run` should support:

```bash
ling-stack run --provider provider_local_relay "Inspect this repo"
```

## Web UI Requirements

Provider Settings page:

- List provider presets.
- Show enabled/disabled state.
- Show configured capabilities.
- Show whether secret is configured without revealing the value.
- Add/edit/delete provider preset.
- Check provider health.
- Mark unsupported provider capability clearly.

The UI must not show raw API keys.

## Module Plan

### `packages/core`

Add:

```text
packages/core/src/provider-types.ts
packages/core/src/secrets.ts
packages/core/src/storage/provider-store.ts
```

Responsibilities:

- Provider preset types.
- Provider validation.
- Secret reference parsing.
- Secret resolution from `process.env`.
- Provider CRUD storage.
- Redacted public response mapping.

### `packages/daemon`

Add:

```text
GET /providers
POST /providers
GET /providers/:id
PATCH /providers/:id
DELETE /providers/:id
POST /providers/:id/check
```

Update:

```text
POST /runs
```

to support `providerPresetId`.

### `packages/providers`

Keep current interface package. Add concrete adapters only where needed:

- config validation helpers,
- optional OpenAI-compatible health check helper,
- media provider interfaces later.

### `packages/runner-pi`

No required change if daemon resolves presets into existing `PiRunnerProviderConfig`.

## Test Plan

Unit tests:

- Provider preset validation rejects bad kind, missing model, bad secret ref.
- Secret resolver reads `env:` values.
- Secret resolver never returns key values in public response mappers.
- Preset-to-runner mapping is correct.
- Media presets reject Pi coding runs.

Daemon tests:

- `POST /providers` creates preset.
- `GET /providers` redacts secrets.
- `PATCH /providers/:id` updates allowed fields.
- `DELETE /providers/:id` removes unused preset.
- `POST /providers/:id/check` fails when secret is missing.
- `POST /runs` with `providerPresetId` invokes runner with resolved provider config.
- `POST /runs` with both `providerPresetId` and inline `provider` returns `bad_request`.

Manual smoke:

```bash
export LOCAL_RELAY_API_KEY=sk-local
corepack pnpm build
node packages/daemon/dist/cli.js

curl -sS http://127.0.0.1:17891/providers \
  -H 'content-type: application/json' \
  -d '{
    "kind": "openai-compatible",
    "displayName": "Local Relay",
    "providerId": "local-relay",
    "model": "dpv4",
    "baseUrl": "http://127.0.0.1:3000/v1",
    "api": "openai-completions",
    "apiKeyRef": "env:LOCAL_RELAY_API_KEY",
    "capabilities": ["chat", "reasoning"],
    "input": ["text"]
  }'
```

Then run:

```bash
curl -N http://127.0.0.1:17891/runs \
  -H 'content-type: application/json' \
  -d '{
    "cwd": "'$PWD'",
    "task": {
      "id": "task-provider-smoke",
      "title": "Provider smoke",
      "prompt": "Say hello."
    },
    "providerPresetId": "provider_local_relay",
    "tools": ["read"],
    "thinkingLevel": "off"
  }'
```

## Implementation Checklist

1. Add provider preset types.
2. Add provider validation.
3. Add secret reference parser.
4. Add environment secret resolver.
5. Add provider preset schema migration.
6. Add provider store CRUD.
7. Add public response mapper with redaction.
8. Add provider routes.
9. Add provider health check route.
10. Update `POST /runs` parsing for `providerPresetId`.
11. Resolve presets into `PiRunnerProviderConfig`.
12. Persist redacted provider snapshots through session persistence.
13. Add unit tests.
14. Add daemon route tests.
15. Run `corepack pnpm typecheck`.
16. Run `corepack pnpm build`.

## Open Decisions

### Provider IDs

Question: should `providerId` be user-editable after creation?

Recommendation: allow edits only if no active runs reference the preset. Runtime provider ids affect Pi model lookup and audit history.

### Health Checks

Question: should health checks perform real model calls?

Recommendation: start with config and secret validation, then add lightweight provider-specific checks. Do not block preset creation just because a network check fails.

### Built-In Defaults

Question: should `ling-stack init` create disabled default templates?

Recommendation: yes. Create disabled templates for OpenAI, Claude, local relay, Doubao, DeepSeek/DPV4, MiniMax, and GLM. Users enable them by setting `apiKeyRef`, model, and base URL where required.

### Secret Storage

Question: should `.env` be the only v0.1 secret source?

Recommendation: yes for development. Design `SecretResolver` so OS keychain can be added without changing provider presets.
