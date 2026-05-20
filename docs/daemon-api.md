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

Request:

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

For OpenAI-compatible relays:

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

SSE events:

```text
event: ready
data: {"ok":true}

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

## Current Limits

- `POST /runs` does not yet cancel the pi runner when the HTTP client disconnects.
- Events are streamed but not persisted yet.
- Approval policy is not wired into tool execution yet.
- API keys are accepted in the request for early development only; production desktop builds should use OS keychain or a local secret store.
