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

## Channels and Tasks

Channels bind a workspace workflow to optional defaults such as a local path, provider preset, teammate, and allowed tools. Tasks are persisted work items inside a channel.

All channel and task endpoints require `cwd` so the daemon can choose the local workspace database:

```text
.ling-stack/ling-stack.sqlite
```

### List Channels

```http
GET /channels?cwd=/path/to/project&limit=100
```

Response:

```json
{
  "cwd": "/path/to/project",
  "channels": [
    {
      "id": "channel_...",
      "workspaceId": "workspace_default",
      "name": "Engineering",
      "boundPath": "/path/to/project",
      "defaultProviderPresetId": "provider_...",
      "defaultTeammateId": null,
      "allowedTools": ["read", "grep", "find", "ls"],
      "createdAt": "2026-05-21T00:00:00.000Z",
      "updatedAt": "2026-05-21T00:00:00.000Z"
    }
  ]
}
```

### Create Channel

```http
POST /channels?cwd=/path/to/project
Content-Type: application/json
```

```json
{
  "name": "Engineering",
  "boundPath": "/path/to/project",
  "defaultProviderPresetId": "provider_...",
  "defaultTeammateId": "teammate_...",
  "allowedTools": ["read", "grep", "find", "ls"]
}
```

`allowedTools` may contain `read`, `grep`, `find`, `ls`, `bash`, `edit`, or `write`.

### Get, Update, Delete Channel

```http
GET /channels/:id?cwd=/path/to/project
PATCH /channels/:id?cwd=/path/to/project
DELETE /channels/:id?cwd=/path/to/project
```

`PATCH` accepts partial fields. Nullable fields can be cleared with `null`. `DELETE` returns `409 channel_has_tasks` when the channel still owns tasks.

### List Tasks

```http
GET /tasks?cwd=/path/to/project&channelId=channel_...&status=todo&limit=100
```

Supported statuses:

```text
todo, claimed, running, blocked, review, done, failed, cancelled
```

Response:

```json
{
  "cwd": "/path/to/project",
  "tasks": [
    {
      "id": "task_...",
      "workspaceId": "workspace_default",
      "channelId": "channel_...",
      "title": "Inspect daemon API",
      "prompt": "Read the daemon package and summarize the routes.",
      "status": "todo",
      "assigneeTeammateId": null,
      "currentRunId": null,
      "createdAt": "2026-05-21T00:00:00.000Z",
      "updatedAt": "2026-05-21T00:00:00.000Z"
    }
  ]
}
```

### Create Task

```http
POST /tasks?cwd=/path/to/project
Content-Type: application/json
```

```json
{
  "channelId": "channel_...",
  "title": "Inspect daemon API",
  "prompt": "Read the daemon package and summarize the routes.",
  "status": "todo",
  "assigneeTeammateId": "teammate_..."
}
```

The referenced channel must exist.

### Get, Update, Delete Task

```http
GET /tasks/:id?cwd=/path/to/project
PATCH /tasks/:id?cwd=/path/to/project
DELETE /tasks/:id?cwd=/path/to/project
```

`PATCH` accepts `channelId`, `title`, `prompt`, `status`, `assigneeTeammateId`, and `currentRunId`. Nullable fields can be cleared with `null`.

When a persisted task is run through `/runs`, the daemon updates the linked task status to `running`, then `done`, `failed`, or `cancelled`.

## Run Task

```http
POST /runs
Content-Type: application/json
Accept: text/event-stream
```

`POST /runs` returns an SSE stream. Because native `EventSource` cannot send POST bodies, web clients should use `fetch()` and read the response body stream.

`cwd` is the execution directory passed to the runner. `workspaceCwd` is optional and selects where Ling Stack stores run/session records and resolves provider presets. If `workspaceCwd` is omitted, it defaults to `cwd`. Persisted channel/task flows should set `workspaceCwd` to the Ling Stack workspace path and `cwd` to the selected channel `boundPath`.

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
  "workspaceCwd": "/path/to/workspace",
  "cwd": "/path/to/channel/project",
  "task": {
    "id": "task-3",
    "title": "Preset smoke test",
    "prompt": "Inspect the repo and summarize the main packages."
  },
  "providerPresetId": "provider_...",
  "skipProviderPreflight": false,
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
- `providerPresetId` product runs require a successful saved provider check. If `lastCheck` is missing or `lastCheck.ok !== true`, the daemon returns `provider_preflight_failed` before creating a run session.
- Required `apiKeyRef` values are re-resolved from the current daemon environment at run startup. Missing required secrets return `provider_preflight_failed`.
- `skipProviderPreflight: true` is a development/debug escape hatch for direct callers and CLI `--skip-preflight`. It bypasses secret-readiness and `lastCheck` gates only; it does not allow disabled, media-only, or no-chat presets to run.
- Inline `provider` requests are development-only and are not checked against persisted provider `lastCheck`.
- Product runs default to read-only tools: `read`, `grep`, `find`, `ls`.
- If `bash`, `edit`, or `write` are enabled for a run, Pi tool execution is paused before the side effect and an approval request is created.
- The run stays `waiting_for_approval` until `/approvals/:id/approve` or `/approvals/:id/deny` resolves the request.

Preflight failure response:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

```json
{
  "error": "provider_preflight_failed",
  "message": "Local Relay: provider has not been checked. Run provider check before starting."
}
```

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

event: approval_requested
data: {"approvalId":"approval_...","actionType":"bash","risk":"medium",...}

event: approval_approved
data: {"approvalId":"approval_...","status":"approved",...}

event: approval_expired
data: {"approvalId":"approval_...","status":"expired",...}

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

For runs created with `workspaceCwd`, query run history using `cwd=<workspaceCwd>`. The returned run object's `cwd` remains the execution directory.

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
- `status`: one of `queued`, `running`, `waiting_for_approval`, `succeeded`, `failed`, `cancelled`.

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

### List Run Artifacts

```http
GET /runs/:id/artifacts?cwd=/path/to/project
```

Passing `cwd` is recommended after daemon restart. Artifact paths are local paths under `.ling-stack/artifacts` and are served only through the artifact content endpoint.

During run execution the daemon records `artifact_created` events for extracted Pi tool evidence. v0.1 extraction covers text, log, Markdown, diff output, and generated file path metadata. Image/video media bytes are not extracted yet.

Response:

```json
{
  "runId": "run_...",
  "artifacts": [
    {
      "id": "artifact_...",
      "runId": "run_...",
      "type": "markdown",
      "path": "run_.../summary.md",
      "title": "Summary",
      "contentType": "text/markdown; charset=utf-8",
      "sizeBytes": 1024,
      "createdAt": "2026-05-22T00:00:00.000Z"
    }
  ]
}
```

### Get Artifact Metadata

```http
GET /artifacts/:id?cwd=/path/to/project
```

Response:

```json
{
  "artifact": {
    "id": "artifact_...",
    "runId": "run_...",
    "type": "markdown",
    "path": "run_.../summary.md",
    "title": "Summary",
    "createdAt": "2026-05-22T00:00:00.000Z"
  }
}
```

### Get Artifact Content

```http
GET /artifacts/:id/content?cwd=/path/to/project
```

The daemon resolves artifact content relative to `.ling-stack/artifacts` and rejects paths outside that directory with `403 artifact_outside_root`.

## Media Jobs

Media jobs are persisted metadata for media-capable provider presets. The current execution interface uses a local fake/static adapter, so it does not call Jimeng, Seedream, Seedance, or any other live media API.

Supported statuses:

```text
queued, running, succeeded, failed, cancelled
```

Supported operations:

```text
image_generate, image_edit, video_generate
```

### Create Media Job

```http
POST /media-jobs?cwd=/path/to/project
Content-Type: application/json
```

```json
{
  "providerPresetId": "provider_...",
  "operation": "image_generate",
  "prompt": "Create a clean product screenshot style image.",
  "input": {
    "size": "1024x1024"
  }
}
```

Rules:

- `providerPresetId` must reference an enabled provider preset with `api: "media-job"`.
- The provider preset must include the requested media operation in `capabilities`.
- Chat provider presets return `unsupported_capability`.
- Creation only records queued metadata. Live vendor calls, cost approval, and image/video media bytes are still out of scope.

Response:

```json
{
  "mediaJob": {
    "id": "media_job_...",
    "workspaceId": "workspace_default",
    "providerPresetId": "provider_...",
    "operation": "image_generate",
    "prompt": "Create a clean product screenshot style image.",
    "input": {
      "size": "1024x1024"
    },
    "artifactIds": [],
    "status": "queued",
    "createdAt": "2026-05-23T00:00:00.000Z",
    "updatedAt": "2026-05-23T00:00:00.000Z"
  }
}
```

### List Media Jobs

```http
GET /media-jobs?cwd=/path/to/project&status=queued&providerPresetId=provider_...&limit=100
```

Response:

```json
{
  "cwd": "/path/to/project",
  "mediaJobs": []
}
```

### Get Media Job

```http
GET /media-jobs/:id?cwd=/path/to/project
```

Response:

```json
{
  "mediaJob": {
    "id": "media_job_...",
    "status": "queued"
  }
}
```

### Run Media Job

```http
POST /media-jobs/:id/run?cwd=/path/to/project
```

The current execution interface uses the media adapter contract with the local static adapter implementation. It re-validates the media provider preset, moves the job through `running`, and then records `succeeded` with a Markdown artifact under `.ling-stack/artifacts/media_jobs/:id/`. No Jimeng, Seedream, Seedance, billing, or `media_cost` approval call is made.

Runnable statuses are `queued`, `failed`, and `cancelled`. `running` and `succeeded` jobs return `409 media_job_not_runnable`. Tests can force the failure path with `input.forceFailure: true`.

Response:

```json
{
  "mediaJob": {
    "id": "media_job_...",
    "status": "succeeded",
    "artifactIds": ["artifact_..."]
  },
  "artifacts": [
    {
      "id": "artifact_...",
      "mediaJobId": "media_job_...",
      "type": "markdown",
      "path": "media_jobs/media_job_.../static-result-2026-05-23T00-00-00-000Z.md",
      "title": "Image generate static result",
      "contentType": "text/markdown; charset=utf-8"
    }
  ]
}
```

### List Media Job Artifacts

```http
GET /media-jobs/:id/artifacts?cwd=/path/to/project
```

Response:

```json
{
  "mediaJobId": "media_job_...",
  "artifacts": []
}
```

### Cancel Run

```http
POST /runs/:id/cancel?cwd=/path/to/project
```

Cancellation is best effort. For an active run, the daemon marks the run `cancelled`, appends a `run_cancelled` event, streams that event to the open SSE client when possible, and asks the Pi session to abort.

Response:

```json
{
  "cancelled": true,
  "active": true,
  "run": {
    "id": "run_...",
    "status": "cancelled"
  }
}
```

## Provider Presets

Provider presets store reusable non-secret provider configuration. API keys are represented as `apiKeyRef`, currently `env:NAME`.

### List Provider Templates

```http
GET /provider-templates
```

Response:

```json
{
  "templates": [
    {
      "templateId": "local-openai-compatible-relay",
      "kind": "openai-compatible",
      "displayName": "Local OpenAI-Compatible Relay",
      "description": "Local relay, One API, New API, LiteLLM, OpenRouter-style gateways, or private compatible gateways.",
      "providerId": "local-relay",
      "model": "dpv4",
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:8317/v1",
      "apiKeyRef": "env:LOCAL_RELAY_API_KEY",
      "capabilities": ["chat", "tool_call", "reasoning"],
      "input": ["text"],
      "enabled": false
    }
  ]
}
```

Templates are reusable request bodies for `POST /providers`. They are disabled by default and use env secret refs only.

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
  "code": "ready",
  "message": "Provider is reachable and accepted the configured model.",
  "checkedAt": "2026-05-20T00:00:00.000Z"
}
```

The check validates base URL format, required secret refs, enabled state, and supported capabilities. For `openai-completions`, `openai-responses`, and `anthropic-messages`, it also performs a small live model request with a 10 second timeout. Common failure codes include `secret_missing`, `network_failed`, `auth_failed`, `model_unsupported`, `rate_limited`, `provider_disabled`, and `provider_error`.

## Approval Policy and Requests

Approval requests are persisted in the workspace SQLite database and can be listed or resolved through the daemon. v0.1 stores approval decisions, defaults product runs to read-only tools, and pauses Pi tool execution before `bash`, `edit`, or `write` proceeds.

### Workspace Policy

Approval policy controls whether Ling Stack automatically allows, asks for approval, or denies tool execution. It is workspace-scoped in v0.1.

Default policy:

```json
{
  "toolDecisions": {
    "read": "allow",
    "grep": "allow",
    "find": "allow",
    "ls": "allow",
    "bash": "ask",
    "edit": "ask",
    "write": "ask"
  },
  "allowedWritePaths": ["."]
}
```

`allowedWritePaths` entries are resolved relative to the run execution `cwd` unless they are absolute paths. `edit` and `write` requests outside these scopes are denied before they reach the approval inbox.

### Get Approval Policy

```http
GET /approval-policy?cwd=/path/to/workspace
```

Response:

```json
{
  "cwd": "/path/to/workspace",
  "policy": {
    "workspaceId": "workspace_default",
    "toolDecisions": {
      "read": "allow",
      "grep": "allow",
      "find": "allow",
      "ls": "allow",
      "bash": "ask",
      "edit": "ask",
      "write": "ask"
    },
    "allowedWritePaths": ["."],
    "createdAt": "2026-05-20T00:00:00.000Z",
    "updatedAt": "2026-05-20T00:00:00.000Z"
  }
}
```

### Update Approval Policy

```http
PATCH /approval-policy?cwd=/path/to/workspace
Content-Type: application/json
```

```json
{
  "toolDecisions": {
    "bash": "ask",
    "edit": "ask",
    "write": "deny"
  },
  "allowedWritePaths": [".", "src", "docs"]
}
```

Tool decisions must be `allow`, `ask`, or `deny`.

### List Approvals

```http
GET /approvals?cwd=/path/to/project&status=pending
```

Optional query parameters:

- `status`: one of `pending`, `approved`, `denied`, `expired`, `cancelled`.
- `runId`: filter by run id.
- `limit`: integer from `1` to `500`, default `100`.

Response:

```json
{
  "cwd": "/path/to/project",
  "approvals": [
    {
      "id": "approval_...",
      "runId": "run_...",
      "taskId": "task-1",
      "channelId": "workspace",
      "actionType": "bash",
      "risk": "high",
      "title": "Run shell command",
      "description": "The agent wants to run a shell command.",
      "payload": {
        "type": "bash",
        "cwd": "/path/to/project",
        "command": "git status",
        "riskFlags": ["unknown_shell"]
      },
      "status": "pending",
      "createdAt": "2026-05-20T00:00:00.000Z"
    }
  ]
}
```

### Get Approval

```http
GET /approvals/:id?cwd=/path/to/project
```

### Approve or Deny

```http
POST /approvals/:id/approve?cwd=/path/to/project
POST /approvals/:id/deny?cwd=/path/to/project
Content-Type: application/json
```

Request body is optional:

```json
{
  "reason": "Reviewed locally."
}
```

Approval decisions append `approval_approved`, `approval_denied`, or `approval_expired` to the linked run event log when the run still exists. Listing or fetching approvals lazily normalizes pending requests whose `expiresAt` is already in the past.

## Current Limits

- HTTP client disconnect does not imply cancellation; callers must use `POST /runs/:id/cancel`.
- Cancellation is best effort and depends on Pi session abort behavior.
- Inline API keys are accepted in `/runs` for early development only; production desktop builds should use OS keychain or a local secret store.
- Media provider health checks are static config checks until media job execution exists.
- v0.1 does not expire provider `lastCheck` by time. Provider edits clear old check state; future versions can add TTL-based recheck prompts.
- Artifact content is local-only and must live under `.ling-stack/artifacts`.
