# Provider Presets Design

## Status

Draft for Milestone 2: Provider Presets.

Related docs:

- [Channel Context Budget Manager](channel-context-budget-manager.md)
- [Channel Context Processing Layer](channel-context-processing-layer.md)
- [Channel Context Processing Layer Implementation Plan](channel-context-processing-layer-implementation-plan.md)
- [Two-Layer Configuration](two-layer-configuration.md)
- [Runtime, Provider, and Secrets Inheritance](runtime-provider-secrets-inheritance.md)
- [Secrets and Keychain](secrets-keychain.md)
- [Provider Generation Runtime Resolver](provider-generation-runtime.md)
- [Conversation Model Binding And Creation Validation](conversation-model-binding-and-creation-validation.md)

2026-07-30 lifecycle update: the first successfully checked chat provider becomes the
workspace default only when no default exists. Later provider saves do not change it.
Deletion and disablement must respect workspace-default, active-channel and fixed-teammate
references; archived channels are repaired on restore rather than blocking deletion.

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

Provider presets are a product concept. They are not only SDK adapters. A preset
represents what the user sees and chooses in the workspace. User-level provider
profiles may seed presets, but the active preset referenced by channels, teammates,
and runs remains workspace state. The profile-to-preset inheritance boundary is
defined in [Runtime, Provider, and Secrets Inheritance](runtime-provider-secrets-inheritance.md).

## Current Baseline

Implemented today:

- `POST /runs` accepts inline provider config.
- `PiRunnerAdapter` accepts `provider`, `model`, `apiKey`, `baseUrl`, `api`, `headers`, and compatibility settings.
- Custom OpenAI-compatible providers can be registered dynamically by the Pi runner adapter when `baseUrl` is present.
- Persistent provider preset storage, daemon CRUD APIs, CLI/Web setup surfaces, built-in templates, and env secret refs are implemented.
- Provider health checks perform static validation plus live lightweight probes for OpenAI-compatible chat, OpenAI Responses, and Anthropic Messages.
- Batch model import persists presets immediately and runs chat preflights in a daemon-owned background queue with a maximum concurrency of three. Persisted `checking` state keeps the Web list truthful across refreshes; completed checks continue to publish the existing provider control-plane event.
- Provider model discovery supports OpenAI-compatible, Anthropic, native Gemini and Mistral response shapes. Missing model metadata is filled from the reviewed, versioned catalog defined by [P15 Provider Model Catalog And Discovery](provider-model-catalog-and-discovery-p15.md).
- `packages/providers` defines capability interfaces and media vendor adapters for the currently connected generation families.
- Generation runtime readiness is resolved by [Provider Generation Runtime Resolver](provider-generation-runtime.md), not by page-specific provider checks.

Not implemented yet:

- OS keychain secret refs.
- Direct vendor-specific catalog sync beyond the reviewed `models.dev` snapshot pipeline.

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
- Model context window and output-token limits are runtime capabilities. They should be
  automatically inferred by default and exposed to users only as advanced overrides.

## Web Model Workbench UI

The Web UI presents provider presets as a model workbench, not as a settings-card
collection. The main view is a dense table so users can scan model name, model id, Base
URL, API key state, check state, readiness, and row actions without opening each preset.

Default workbench layout:

- `Model Workbench` is the only visible page title in the main content. Do not nest a
  second `Model presets` panel title under it.
- Summary chips show available, needs-configuration, and disabled counts.
- Secondary summary text keeps capability totals visible: chat-capable, coding-ready,
  missing secrets, and template counts.
- Search covers display name, provider id, model, API protocol, and Base URL.
- Status filters are UI-only; they do not change provider persistence semantics.
- Row actions appear on hover/focus and keep the existing actions: use/stop using, edit,
  check, and delete.
- The workbench uses the same full-width content frame as other plain workspace pages.
  Do not center the provider table in a narrower max-width container.

Add/edit uses a right-side sheet. The sheet owns template selection, API key entry, Base
URL, API protocol, model discovery, capability flags, and save validation. Closing or
saving the sheet returns the user to the workbench table. Provider repair handoffs from
failed runs still open the same sheet for the affected preset.

Context-window and max-output-token fields should not be primary required fields in the
sheet. The default product behavior is:

```text
choose provider/model
  -> Ling resolves model capabilities automatically
  -> Context Budget Manager builds per-call effective budgets
  -> Context Processing auto-compacts when needed
```

The sheet should show a compact model-capability state instead:

| State | Main UI copy | Behavior |
| --- | --- | --- |
| `known` | `Context: Auto` or `Context: 128k detected` | Use registry/provider metadata/user template values. |
| `estimated` | `Context: Estimated` | Use conservative provider-family defaults. |
| `unknown` | `Context: Conservative` | Use small safe budget and compact early. |
| `override` | `Context: Custom override` | User explicitly set advanced values. |

Manual `contextWindow` and `maxTokens` inputs belong in an `Advanced` section labeled as
overrides, not in the default setup path. Leaving them blank means automatic, not
misconfigured. This keeps Codex-like automatic compaction as the normal user experience
while preserving a precise escape hatch for private relays and unusual gateways.

The UI must stay strict-daylight and low decoration: white surface, `#111111` primary
text, `#6B6B6B` secondary text, `#E5E5E5` borders, `#F5F5F5` selected/hover surface,
and 8px or smaller radii. Model Workbench should not reintroduce large nested cards or
a nested settings panel around the provider table.

## Provider Kinds

```ts
type ProviderKind =
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
```

`openai-compatible` covers local relays and proxy services such as One API, New API, LiteLLM, OpenRouter-style services, and private compatible gateways.

`google` covers Gemini API providers. Gemini web search uses Google Search grounding through an explicit `compat.webSearch.protocol` declaration rather than OpenAI tool-call compatibility.

`deepseek` should cover DeepSeek and DPV4-compatible endpoints as a configurable provider family. Do not hardcode `dpv4` as a fixed upstream model.

## Capabilities

Use the existing capability vocabulary:

```ts
type ProviderCapability =
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
```

Capabilities are declared on the preset because model support differs even inside the same vendor. `web_search` means the selected provider adapter can perform hosted web search and return citation evidence; it is not implied by generic OpenAI-compatible chat support.

Generation capabilities are not enough to prove a preset can run. `image_generate`,
`image_edit`, and `video_generate` all pass through the shared generation runtime
resolver. The resolver combines preset capabilities, known model-family metadata,
normalized live transport settings, secret/base URL readiness, and connected adapter
support. Provider presets remain vendor route records; the resolver is the single
runtime gate for generation readiness.

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
  /**
   * Optional user override. Blank means "auto".
   * Runtime budgets should prefer the effective capability resolver rather than treating
   * this as required setup.
   */
  contextWindow?: number;
  /**
   * Optional user override for max model output. Blank means "auto".
   */
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
- `contextWindow`: optional advanced override for the model context window. Blank means
  automatic capability resolution.
- `maxTokens`: optional advanced override for reserved model output tokens. Blank means
  automatic capability resolution.
- `compat`: protocol compatibility options forwarded to Pi when needed.
- `enabled`: disabled presets remain stored but cannot be used for new runs.

## Model Capability Auto-Detection

Provider presets store user intent and manual overrides. Runtime prompt budgeting should
use an effective capability resolver:

```ts
type ProviderCapabilitySource =
  | "user_override"
  | "template"
  | "model_registry"
  | "provider_metadata"
  | "health_check"
  | "runtime_observed"
  | "conservative_default";

interface ProviderModelCapabilitySnapshot {
  providerPresetId: string;
  model: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  tokenizer?: "openai-compatible" | "anthropic-compatible" | "estimated";
  supportsStructuredOutput?: boolean;
  source: ProviderCapabilitySource;
  confidence: "known" | "estimated" | "unknown";
  checkedAt?: string;
  notes?: string[];
}
```

Resolution order:

1. User advanced overrides on the preset.
2. Built-in template/model registry for known GPT, Claude, domestic, and media models.
3. Provider/model metadata discovered from supported model-list or health-check APIs.
4. Runtime-observed downgrades from context-length failures.
5. Conservative defaults for unknown custom OpenAI-compatible APIs.

Rules:

- The user should not have to know or type context windows for common models.
- A successful health check may refresh an effective capability snapshot, but should not
  silently overwrite user override fields.
- A `context_length_exceeded` or equivalent provider error may lower the effective
  runtime budget for future calls or mark the preset `estimated`, but must not mutate the
  user's configured model id, API key, channel protocol, or approval policy.
- Unknown custom providers use a small safe budget and early compaction rather than
  pretending to support long context.
- Model capability snapshots are diagnostics and budgeting inputs. They are not
  permission grants.

## Secret References

Supported secret refs:

```text
env:OPENAI_API_KEY
env:ANTHROPIC_API_KEY
env:DOUBAO_API_KEY
env:DEEPSEEK_API_KEY
env:MINIMAX_API_KEY
env:GLM_API_KEY
env:LOCAL_RELAY_API_KEY
env:JIMENG_API_KEY
keychain:provider_<id>
```

Desktop keychain storage is fail-closed in v0.1 unless a trusted desktop/keychain resolver is injected:

```text
keychain:provider_local
```

The full SecretResolver and keychain plan lives in [Secrets and Keychain](secrets-keychain.md).

Rules:

- SQLite stores only `api_key_ref`.
- `.env` can define keys during development.
- `keychain:` refs are stable but report `secret_store_unavailable` without a keychain resolver.
- Daemon resolves the secret at run or health-check time.
- Resolved secret values are never returned from API responses.
- Redacted API responses may show whether a secret is configured:

```json
{
  "apiKeyConfigured": true,
  "apiKeyRef": "env:OPENAI_API_KEY",
  "apiKeyStatus": {
    "ref": "env:OPENAI_API_KEY",
    "kind": "env",
    "configured": true
  }
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
  "capabilities": ["chat", "tool_call", "reasoning", "vision", "embedding", "web_search"],
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

`contextWindow` and `maxTokens` should be passed to the runner only when the user has
set explicit advanced overrides or when the daemon has a safe effective capability
snapshot to pass through. Blank preset values mean automatic runtime budgeting, not an
invalid provider configuration.

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

`contextWindow` and `maxTokens` are advanced overrides. `null`, missing, or empty values
mean automatic capability resolution and must not block saving the preset.

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
4. Live network/model call for `openai-completions`, `openai-responses`, and `anthropic-messages`.

For Milestone 2, provider health checks are conservative: fail missing key/base URL/model, perform a lightweight model request for the supported chat protocols, and keep media-job checks static until media execution exists.

When the protocol exposes model metadata or the check path can safely infer capability,
the check may refresh the effective capability snapshot used by Context Budget Manager.
It must not overwrite user-entered `contextWindow` or `maxTokens` overrides.

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
  skipProviderPreflight?: boolean;
  tools?: ToolName[];
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
  appendSystemPrompt?: string[];
  agentDir?: string;
}
```

### Run Preflight Gate

`providerPresetId` product runs must pass daemon-side preflight before a run session is created. Web and CLI can provide earlier guidance, but the daemon is the enforcement boundary because direct `POST /runs` callers must not bypass provider readiness.

Default preflight for `providerPresetId` checks:

- preset is enabled,
- preset is not `media-job`,
- preset includes `chat`,
- required `apiKeyRef` is configured in the current daemon environment,
- `lastCheck` exists,
- `lastCheck.ok === true`.

Live chat checks require more than HTTP success. `openai-completions`,
`openai-responses`, and `anthropic-messages` probes must parse a supported visible text
field from the response. A 2xx response containing only reasoning, thinking, unknown
blocks, or an empty body records `lastCheck.code = "empty_response"`. Raw response bodies
and reasoning content are never promoted to user-visible assistant text.

`skipProviderPreflight: true` is a development/debug escape hatch. It may bypass secret-readiness and `lastCheck` gates, but it must not bypass hard compatibility rules: disabled presets, media presets, and no-chat presets still fail before runner invocation.

Inline `provider` remains accepted for development and does not participate in preset preflight because there is no persisted `lastCheck`. Normal product flows should use `providerPresetId`.

v0.1 does not expire `lastCheck` by time. Editing a provider clears the prior check result, and daemon run startup re-resolves env secrets so obvious env drift still fails unless the caller explicitly sets `skipProviderPreflight`.

### Onboarding and Repair UX

Provider setup should present a short, repeatable path:

```text
choose template -> save preset -> set env -> check provider -> use in workspace
```

Web Model Workbench should expose:

- template groups for GPT/Claude, OpenAI-compatible relays, custom OpenAI-compatible access, domestic AI, and media providers,
- a custom compatible card for domestic gateways, private relays, One API, New API, LiteLLM, and similar endpoints,
- summary counters for chat-compatible providers, preflight-ready providers, missing env refs, and templates,
- a compact repair queue ordered by next action,
- `Check all` for enabled chat providers,
- per-provider `Set default`, `Check`, `Edit`, and `More` actions; `Set default` is a star
  icon and the fixed action column remains `184px`.
- model capability status (`Auto`, `Estimated`, `Conservative`, or `Custom override`)
  without requiring token fields in the default setup path.

Repair queue rules:

- missing env is highest priority and should show the exact env var name derived from `apiKeyRef`,
- unchecked compatible providers should point to `Check`,
- failed checks should show `lastCheck.code` and guidance,
- disabled, media-only, or no-chat providers should point to `Edit`,
- `Use` is enabled only when provider preflight is ready, not merely when hard compatibility checks pass.
- Workspace task provider pickers should include preflight-ready chat providers and setup-blocked chat providers, but should keep `media-job` presets out of coding task selection.

CLI `doctor` and Web readiness should use the same readiness meaning: a provider can start product runs only when it passes the daemon preflight gate.

## Validation Rules

Provider preset validation:

- `kind` must be a known provider kind.
- `displayName` must be non-empty.
- `providerId` must be non-empty and URL-safe enough for runtime use.
- `model` must be non-empty unless the provider is a model-list-only future adapter.
- `api` must be compatible with `kind`.
- `baseUrl` is required for `openai-compatible` and most domestic compatible presets.
- `apiKeyRef` must use a supported scheme: `env:` or `keychain:`.
- `contextWindow` and `maxTokens`, when provided, must be positive integers within a
  sane implementation limit. They are optional and blank values mean automatic.
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
- Hide context-window and max-output-token inputs behind Advanced, labeled as optional
  overrides.

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
- `POST /runs` with unchecked `providerPresetId` returns `provider_preflight_failed`.
- `POST /runs` with failed `lastCheck` returns `provider_preflight_failed`.
- `POST /runs` with `skipProviderPreflight: true` can start a debug run for an unchecked preset.
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
10. Add effective model capability resolver and capability snapshot mapping.
11. Move Web token fields into Advanced as optional overrides.
12. Update `POST /runs` parsing for `providerPresetId`.
13. Resolve presets into `PiRunnerProviderConfig`.
14. Persist redacted provider snapshots through session persistence.
15. Add daemon run preflight for `providerPresetId`.
16. Add unit tests.
17. Add daemon route tests.
18. Run `corepack pnpm typecheck`.
19. Run `corepack pnpm build`.

## Open Decisions

### Provider IDs

Question: should `providerId` be user-editable after creation?

Recommendation: allow edits only if no active runs reference the preset. Runtime provider ids affect Pi model lookup and audit history.

### Health Checks

Question: should health checks perform real model calls?

Recommendation: implemented for chat protocols. Do not block preset creation just because a network check fails.

### Built-In Defaults

Question: should `ling-stack init` create disabled default templates?

Recommendation: yes. Create disabled templates for OpenAI, Claude, local relay, Doubao, DeepSeek/DPV4, MiniMax, and GLM. Users enable them by setting `apiKeyRef`, model, and base URL where required.

### Secret Storage

Question: should `.env` be the only v0.1 secret source?

Recommendation: yes for development. `SecretResolver` is now the shared boundary for `env:` and fail-closed `keychain:` refs, so OS keychain storage can be added without changing provider presets.
The follow-up design is [Secrets and Keychain](secrets-keychain.md).
