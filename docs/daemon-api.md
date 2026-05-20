# Daemon API

The daemon is the local process that connects the future CLI, web UI, and desktop shell to Ling Stack runners.

## Start

```bash
corepack pnpm --filter @ling-stack/daemon build
node packages/daemon/dist/cli.js
```

Environment variables:

```text
LING_STACK_HOST=127.0.0.1
LING_STACK_PORT=17891
```

Provider presets can reference secrets from the daemon process environment:

```text
LOCAL_RELAY_API_KEY=sk-local
```

## Health

```http
GET /health
```

Response:

```json
{"ok":true,"service":"ling-stack-daemon"}
```

## Run Task

```http
POST /runs
Content-Type: application/json
Accept: text/event-stream
```

`POST /runs` returns an SSE stream. Because native `EventSource` cannot send POST bodies, web clients should use `fetch()` and read the response body stream.

Request with inline provider config:

```json
{
  "cwd": "/path/to/project",
  "task": {
    "id": "task-1",
    "title": "Inspect the project",
    "prompt": "List the files and summarize the repo.",
    "channelId": "engineering"
  },
  "provider": {
    "provider": "openai",
    "model": "gpt-5.5",
    "apiKey": "env-or-runtime-key"
  },
  "tools": ["read", "grep", "find", "ls"],
  "thinkingLevel": "medium"
}
```

Inline provider config is useful for development, but normal product flows should use provider presets so raw API keys are not persisted in workspace records.

For OpenAI-compatible relays as inline config:

```json
{
  "cwd": "/path/to/project",
  "task": {
    "id": "task-2",
    "title": "Relay smoke test",
    "prompt": "Say hello."
  },
  "provider": {
    "provider": "local-relay",
    "displayName": "Local Relay",
    "model": "dpv4",
    "baseUrl": "http://127.0.0.1:3000/v1",
    "api": "openai-completions",
    "apiKey": "sk-local"
  },
  "tools": ["read"],
  "thinkingLevel": "off"
}
```

Request with a provider preset:

```json
{
  "cwd": "/path/to/project",
  "task": {
    "id": "task-3",
    "title": "Preset smoke test",
    "prompt": "Inspect the repo and summarize the main packages."
  },
  "providerPresetId": "provider_...",
  "tools": ["read", "grep", "find", "ls"],
  "thinkingLevel": "medium"
}
```

Rules:

- Request must include either `providerPresetId` or `provider`.
- Supplying both returns `bad_request`.
- `media-job` presets cannot run Pi coding tasks.
- Disabled presets return `provider_disabled`.
- Presets without `chat` capability return `unsupported_capability`.

SSE events:

```text
event: ready
data: {"ok":true,"runId":"run_..."}

event: run_start
data: {"type":"run_start","taskId":"task-1",...}

event: assistant_text_delta
data: {"type":"assistant_text_delta","text":"..."}

event: tool_start
data: {"type":"tool_start","toolName":"read",...}

event: tool_end
data: {"type":"tool_end","toolName":"read","isError":false,...}

event: run_end
data: {"type":"run_end","taskId":"task-1","messageCount":3}

event: result
data: {"taskId":"task-1","messageCount":3,"eventCount":12}
```

Errors are also sent as SSE once the stream has started:

```text
event: error
data: {"error":"run_failed","message":"..."}
```

## Run History

Runs and events are persisted in the workspace runtime directory:

```text
.ling-stack/ling-stack.sqlite
.ling-stack/sessions/<runId>.jsonl
.ling-stack/sessions/<runId>.summary.json
```

### List Runs

```http
GET /runs?cwd=/path/to/project&limit=50
```

Response:

```json
{
  "cwd": "/path/to/project",
  "runs": [
    {
      "id": "run_...",
      "status": "succeeded",
      "cwd": "/path/to/project",
      "taskId": "task-1",
      "providerName": "local-relay",
      "providerModel": "gpt-5.5",
      "eventLogPath": "/path/to/project/.ling-stack/sessions/run_....jsonl",
      "createdAt": "2026-05-20T00:00:00.000Z",
      "updatedAt": "2026-05-20T00:00:10.000Z"
    }
  ]
}
```

Optional query parameters:

- `limit`: integer from `1` to `200`, default `50`.
- `status`: one of `queued`, `running`, `succeeded`, `failed`, `cancelled`.

### Get Run

```http
GET /runs/:id?cwd=/path/to/project
```

Passing `cwd` is recommended after daemon restart because the in-memory run-to-store index is rebuilt lazily.

### Get Run Events

```http
GET /runs/:id/events?cwd=/path/to/project&afterSeq=0&limit=200
```

Response:

```json
{
  "runId": "run_...",
  "events": [
    {
      "id": "evt_...",
      "runId": "run_...",
      "seq": 1,
      "ts": "2026-05-20T00:00:00.000Z",
      "type": "run_created",
      "data": {
        "taskId": "task-1",
        "cwd": "/path/to/project",
        "providerName": "local-relay",
        "providerModel": "gpt-5.5"
      }
    }
  ],
  "nextSeq": 2
}
```

## Provider Presets

Provider presets store reusable non-secret provider configuration. API keys are represented as `apiKeyRef`, currently `env:NAME`.

### List Providers

```http
GET /providers?cwd=/path/to/project
```

Response:

```json
{
  "cwd": "/path/to/project",
  "providers": [
    {
      "id": "provider_...",
      "kind": "openai-compatible",
      "displayName": "Local Relay",
      "providerId": "local-relay",
      "model": "gpt-5.5",
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:8317/v1",
      "apiKeyRef": "env:LOCAL_RELAY_API_KEY",
      "apiKeyConfigured": true,
      "headers": {},
      "input": ["text"],
      "compat": {},
      "capabilities": ["chat", "tool_call", "reasoning"],
      "enabled": true,
      "createdAt": "2026-05-20T00:00:00.000Z",
      "updatedAt": "2026-05-20T00:00:00.000Z"
    }
  ]
}
```

### Create Provider

```http
POST /providers?cwd=/path/to/project
Content-Type: application/json
```

```json
{
  "kind": "openai-compatible",
  "displayName": "Local Relay",
  "providerId": "local-relay",
  "model": "gpt-5.5",
  "api": "openai-completions",
  "baseUrl": "http://127.0.0.1:8317/v1",
  "apiKeyRef": "env:LOCAL_RELAY_API_KEY",
  "capabilities": ["chat", "tool_call", "reasoning"],
  "input": ["text"],
  "enabled": true,
  "authHeader": true,
  "reasoning": true,
  "contextWindow": 128000,
  "maxTokens": 16384
}
```

Raw `apiKey` is not accepted for persistent provider presets.

### Get, Update, Delete

```http
GET /providers/:id?cwd=/path/to/project
PATCH /providers/:id?cwd=/path/to/project
DELETE /providers/:id?cwd=/path/to/project
```

`PATCH` accepts partial provider fields. The daemon validates the merged provider shape before writing.

### Check Provider

```http
POST /providers/:id/check?cwd=/path/to/project
```

Response:

```json
{
  "ok": true,
  "message": "Provider preset configuration is valid.",
  "checkedAt": "2026-05-20T00:00:00.000Z"
}
```

The current check validates shape, base URL format, enabled state, supported capability, and whether `apiKeyRef` resolves in the daemon environment. It does not yet perform provider-specific network model calls.

## Current Limits

- `POST /runs` does not yet cancel the pi runner when the HTTP client disconnects.
- Approval policy is not wired into tool execution yet.
- Inline API keys are accepted in `/runs` for early development only; production desktop builds should use OS keychain or a local secret store.
- Provider health checks are config checks only, not live model probes yet.
