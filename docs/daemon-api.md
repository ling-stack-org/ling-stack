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
      "status": "active",
      "boundPath": "/path/to/project",
      "defaultProviderPresetId": "provider_...",
      "defaultTeammateId": null,
      "allowedTools": ["read", "grep", "find", "ls"],
      "runtimePolicy": {
        "maxConcurrentRuns": 1,
        "executionMode": "serial",
        "writeLockScope": "boundPath",
        "allowReadOnlyParallel": true,
        "queueOnConflict": true
      },
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
  "status": "active",
  "boundPath": "/path/to/project",
  "defaultProviderPresetId": "provider_...",
  "defaultTeammateId": "teammate_...",
  "allowedTools": ["read", "grep", "find", "ls"],
  "runtimePolicy": {
    "maxConcurrentRuns": 1,
    "executionMode": "serial",
    "writeLockScope": "boundPath",
    "allowReadOnlyParallel": true,
    "queueOnConflict": true
  }
}
```

`allowedTools` may contain `read`, `grep`, `find`, `ls`, `bash`, `edit`, or `write`.
`status` may be `active`, `paused`, or `archived`. Paused channels can be edited but cannot start new runs. `runtimePolicy.writeLockScope` controls whether side-effectful runs lock the channel, bound path, or whole workspace.

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

## AI Teammates

AI teammates are durable workspace members. The daemon seeds built-in `gstack-default`
teammates with deterministic ids such as `teammate_builtin_engineer`, migrates legacy
template references such as `engineer`, and stores custom teammates in the workspace
SQLite database.

All teammate endpoints require `cwd`.

### List And Create Teammates

```http
GET /teammates?cwd=/path/to/project&includeHidden=false&includeDisabled=false&limit=100
POST /teammates?cwd=/path/to/project
```

`GET` returns active, visible teammates by default. `includeHidden=true` and
`includeDisabled=true` widen the roster.

```json
{
  "cwd": "/path/to/project",
  "teammates": [
    {
      "id": "teammate_builtin_engineer",
      "workspaceId": "workspace_default",
      "templateId": "engineer",
      "roleKey": "engineer",
      "displayName": "Engineer",
      "description": "Owns scoped implementation.",
      "providerPresetId": "provider_...",
      "appendSystemPrompt": [],
      "allowedTools": ["read", "grep", "find", "ls"],
      "approvalProfile": { "mode": "ask" },
      "status": "active",
      "pinned": true,
      "hidden": false,
      "createdAt": "2026-05-29T00:00:00.000Z",
      "updatedAt": "2026-05-29T00:00:00.000Z"
    }
  ]
}
```

`POST` creates a durable teammate:

```json
{
  "templateId": "engineer",
  "roleKey": "engineer",
  "displayName": "Ling Engineer",
  "description": "Owns scoped implementation in the Engineering channel.",
  "providerPresetId": "provider_...",
  "systemPrompt": "You are the Engineering AI teammate.",
  "allowedTools": ["read", "grep", "find", "ls"],
  "approvalProfile": { "mode": "ask" },
  "status": "active",
  "pinned": true,
  "hidden": false
}
```

### Get, Update, Disable Teammate

```http
GET /teammates/:id?cwd=/path/to/project
PATCH /teammates/:id?cwd=/path/to/project
DELETE /teammates/:id?cwd=/path/to/project
```

`PATCH` accepts partial identity, provider, prompt, allowed tool, approval profile,
status, pin, and hidden fields. Nullable fields can be cleared with `null`.

`DELETE` is a soft disable in this slice. It sets `status` to `disabled` and `hidden` to
`true`; private history and related records remain available for retention/audit.

### Channel Memberships

```http
GET /teammates/:id/channels?cwd=/path/to/project
PUT /teammates/:id/channels?cwd=/path/to/project
```

`PUT` replaces the teammate's memberships. When a membership has `isDefault: true`, the
daemon also updates the matching channel's `defaultTeammateId`.

```json
{
  "memberships": [
    { "channelId": "channel_...", "isDefault": true }
  ]
}
```

### Skill Bindings

```http
GET /teammates/:id/skills?cwd=/path/to/project
PUT /teammates/:id/skills?cwd=/path/to/project
```

Skill bindings are durable metadata. They do not grant execution authority by themselves;
runs still pass through provider capability checks, allowed tools, approval policy, and
state-machine gates. Disabled bindings are retained as user overrides, so a template skill
can be turned off without deleting the skill definition from the workspace library.
Template-default bindings are protected by storage: omitting them from a replacement
request does not delete them. Manually added `source: "user"` bindings can be deleted by
omitting them from the replacement set.

```json
{
  "bindings": [
    { "skillId": "implement", "source": "template", "enabled": true }
  ]
}
```

### Memory Scopes

```http
GET /teammates/:id/memory-scopes?cwd=/path/to/project
PUT /teammates/:id/memory-scopes?cwd=/path/to/project
```

Memory scopes are visible trust-boundary metadata in this slice. They do not automatically
feed private chat prompts.

```json
{
  "scopes": [
    { "kind": "private-chat-summary", "enabled": true },
    { "kind": "channel-brief", "channelId": "channel_...", "enabled": true }
  ]
}
```

Supported scope kinds:

```text
channel-brief, channel-decisions, private-chat-summary, private-notes
```

### Private Thread And Messages

```http
GET /teammates/:id/direct-thread?cwd=/path/to/project
GET /teammates/:id/direct-messages?cwd=/path/to/project&limit=100
POST /teammates/:id/direct-messages?cwd=/path/to/project
```

`direct-thread` creates the one-to-one teammate thread if it does not exist. Private
messages are durable. `POST` persists the local-user message before provider resolution;
if the teammate is paused, disabled, missing a provider, or the provider cannot run, the
daemon stores a blocked AI reply instead of dropping the user message.

```json
{
  "body": "Can you help refine this task?",
  "requestAiReply": true,
  "providerPresetId": "provider_..."
}
```

Response:

```json
{
  "message": {
    "id": "tdmsg_...",
    "authorType": "local-user",
    "status": "ready"
  },
  "aiReply": {
    "id": "tdmsg_...",
    "authorType": "ai-teammate",
    "status": "blocked",
    "errorMessage": "No provider preset is selected for this teammate."
  }
}
```

Private chat uses no tools and does not include channel messages, files, memory scopes, or
web content unless a future explicit inclusion model adds that behavior.

### Teammate Read Models

```http
GET /teammates/:id/tasks?cwd=/path/to/project&status=todo&limit=100
GET /teammates/:id/activity?cwd=/path/to/project&limit=100
```

`tasks` returns tasks assigned through `assigneeTeammateId`. `activity` composes private
messages, assigned tasks, teammate runs, approvals attached to teammate runs, and channel
messages that mention the teammate.

## Channel Messages, Attachments, and Links

Channel discussion is durable in the workspace SQLite database. Uploaded files are stored under:

```text
.ling-stack/attachments
```

### Messages

```http
GET /channels/:id/messages?cwd=/path/to/project&limit=100
POST /channels/:id/messages?cwd=/path/to/project
```

`POST` accepts a local/user/system message plus structured mentions, attachment ids, link preview ids, and optional `requestAiReply`. Referenced attachments and link previews must belong to the same channel. When AI reply is requested, the daemon uses the selected provider preset or the channel default provider in text-only, no-tools mode. If no provider is ready, the user message is still persisted and the AI reply is stored with `status: "blocked"`.

```json
{
  "body": "请 @Engineer 完善需求",
  "mentions": [{ "id": "engineer", "label": "Engineer", "kind": "ai-teammate" }],
  "attachmentIds": ["att_..."],
  "linkPreviewIds": ["link_..."],
  "requestAiReply": true,
  "providerPresetId": "provider_...",
  "teammateId": "engineer"
}
```

### Attachments

```http
GET /channels/:id/attachments?cwd=/path/to/project&limit=100
POST /channels/:id/attachments?cwd=/path/to/project
GET /attachments/:id/content?cwd=/path/to/project
DELETE /attachments/:id?cwd=/path/to/project
```

`POST` uses JSON with base64 content:

```json
{
  "fileName": "brief.pdf",
  "contentType": "application/pdf",
  "contentBase64": "JVBERi0x..."
}
```

`contentType` is accepted as an upload hint, but the daemon serves downloads with a content type derived from the validated extension. MVP limits: 25MB per file, at most 10 attachment ids per message, allowed extensions are `png`, `jpg`, `jpeg`, `webp`, `gif`, `pdf`, `docx`, `xlsx`, `pptx`, `txt`, `md`, `csv`, `json`, and `log`. Attachments are metadata and downloadable inputs only; AI ingestion is not automatic.

### Link Previews

```http
GET /channels/:id/link-previews?cwd=/path/to/project&limit=100
POST /channels/:id/link-previews?cwd=/path/to/project
POST /link-previews/:id/refresh?cwd=/path/to/project
```

The daemon fetches public HTML metadata only: title, description, image URL, and site name. It does not send cookies, credentials, page bodies, or extracted content to AI. Preview fetches block localhost, private, link-local, and metadata-network addresses, enforce redirect/timeout/body-size limits, and store failed or blocked previews as visible records.

## Channel Collaboration Protocol

v1.1 adds durable protocol records for channel coordination. These endpoints only record
state; they do not start runs, call an AI provider, mutate task/run status, or bypass
approval/runtime locks.

```http
GET /channels/:id/brief?cwd=/path/to/project
PATCH /channels/:id/brief?cwd=/path/to/project

GET /channels/:id/decisions?cwd=/path/to/project&status=active&limit=100
POST /channels/:id/decisions?cwd=/path/to/project
PATCH /decisions/:id?cwd=/path/to/project

GET /channels/:id/handoffs?cwd=/path/to/project&status=proposed&limit=100
POST /channels/:id/handoffs?cwd=/path/to/project
PATCH /handoffs/:id?cwd=/path/to/project

GET /channels/:id/context-summaries?cwd=/path/to/project&targetType=task&targetId=task_...&limit=100
POST /channels/:id/context-summaries?cwd=/path/to/project
PATCH /context-summaries/:id?cwd=/path/to/project
```

Brief `GET` returns an empty Brief-shaped record when no Brief has been saved yet.
Brief `PATCH` is a full replacement for objective, scope, criteria, questions, risks,
and linked source ids.

Decision `POST` creates an `active` decision by default. If `supersedesDecisionId` is
provided, the daemon marks the old decision `superseded` and creates a new active
decision. Decision `PATCH` can update text fields or set `status` to `active`,
`superseded`, or `rejected`.

Handoff `POST` records a manual from/to participant transfer with reason, required input,
expected output, and status. Handoff `PATCH` only updates the handoff record; completing a
handoff does not mark a task done.

Context summaries target either `task` or `thread`. `task` targets must reference a task in
the same channel. `thread` targets must reference a channel message id or an existing
message thread id in the same channel.

All source ids are channel-scoped. Unknown or cross-channel source references return a
displayable `400` error. Missing channels return `404 channel_not_found`.

## Channel Handoff Workflows

v1.2 upgrades handoffs into explicit, user-started workflow records. Workflow mutations
record coordination state and never bypass task/run state machines, provider preflight,
approval policy, or runtime leases.

```http
GET /channels/:id/workflows?cwd=/path/to/project&status=running&limit=100
POST /channels/:id/workflows?cwd=/path/to/project
GET /workflows/:id?cwd=/path/to/project
PATCH /workflows/:id?cwd=/path/to/project
POST /handoffs/:id/workflow?cwd=/path/to/project

GET /workflows/:id/steps?cwd=/path/to/project&status=queued&limit=100
POST /workflows/:id/steps?cwd=/path/to/project
PATCH /workflow-steps/:id?cwd=/path/to/project
POST /workflow-steps/:id/start?cwd=/path/to/project
```

Workflow statuses are `draft`, `ready`, `running`, `waiting_for_approval`, `blocked`,
`succeeded`, `failed`, and `cancelled`. Step statuses are `queued`, `claimed`,
`running`, `waiting_for_approval`, `blocked`, `succeeded`, `failed`, `skipped`, and
`cancelled`.

`POST /handoffs/:id/workflow` creates a draft `ChannelWorkflow` and first queued
`ChannelWorkflowStep` from the handoff. It does not start execution.

`POST /workflow-steps/:id/start` accepts:

```json
{
  "mode": "create_task",
  "providerPresetId": "provider_...",
  "assigneeTeammateId": "engineer",
  "idempotencyKey": "client-generated-key"
}
```

`create_task` creates a channel task from the step context, links it to the step, marks
the step succeeded, and returns JSON with `workflow`, `workflowStep`, and `task`.

`create_and_run_task` creates the task and then delegates to the existing run
coordinator. When a run starts, the response is the same POST/SSE stream used by
`POST /runs`; the step is updated with the linked task/run after the coordinator
finishes. If provider readiness, channel status, or runtime state blocks execution before
a run starts, the route returns JSON with `workflow`, `workflowStep`, and `blocker`.

Starting a step acquires a `workflow_step` lease. Duplicate starts return
`409 resource_conflict` while the lease is active. Step `skip` and `cancel` only mutate
workflow-step state; they do not mark linked task/run records terminal.

## External Work Import

Phase 1 adds a read-only GitHub manual import path. It parses a repository
`WORKFLOW.md`, normalizes a GitHub PR or issue payload, creates or reuses a
`ChannelWorkflow` and `ChannelWorkflowStep`, and writes local evidence artifacts. It
does not start a runner, poll GitHub, receive webhooks, post comments, add labels,
request reviews, push commits, or merge.

```http
POST /external-work/github/import?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "eventType": "pull_request.opened",
  "payload": {
    "repository": { "full_name": "owner/repo" },
    "pull_request": { "number": 123, "title": "Fix bug" }
  },
  "workflowPath": "WORKFLOW.md"
}
```

`workflowMarkdown` may be supplied instead of `workflowPath` for tests and manual
imports. If neither is supplied, the daemon reads `WORKFLOW.md` from the channel
`boundPath`. `workflowPath` may be absolute or relative, but it must resolve inside the
channel `boundPath`.

Response:

```json
{
  "externalWorkItem": {
    "sourceKind": "github",
    "kind": "github_pull_request",
    "identifier": "owner/repo#123",
    "idempotencyKey": "github:pull_request:owner/repo:123:head-sha:updated-at"
  },
  "workflow": {},
  "workflowStep": {},
  "artifacts": [],
  "duplicate": false
}
```

The same source idempotency key returns the existing workflow and step with
`duplicate: true`. Evidence artifacts currently include the normalized external work
item JSON and rendered workflow prompt markdown, both served through the existing
artifact endpoints.

SDK clients can use the same endpoint through:

```ts
await client.importGitHubExternalWork("/path/to/project", {
  channelId: "channel_...",
  eventType: "pull_request.opened",
  payload,
  workflowPath: "WORKFLOW.md",
});
```

The CLI exposes the same read-only manual import for local fixtures:

```bash
ling-stack --cwd /path/to/project external-work github import \
  --channel channel_... \
  --event-type pull_request.opened \
  --payload-file examples/external-work/github/pull-request-opened.json \
  --workflow-path WORKFLOW.md
```

`--workflow-markdown-file <path>` may be used instead of `--workflow-path` for inline
manual tests. The CLI and SDK only call the local daemon import endpoint; they do not
call GitHub APIs, start a runner, or create external mutation actions.

For a copy-pasteable temp workspace smoke, use
`examples/external-work/github/README.md`. That smoke copies the example `WORKFLOW.md`
into a temporary channel bound path, creates a channel, imports the PR or issue fixture,
and reads the returned evidence artifacts through `/artifacts/:id/content`.

### Run Persisted Task

```http
POST /tasks/:id/run?cwd=/path/to/project
Content-Type: application/json
Accept: text/event-stream
```

```json
{
  "providerPresetId": "provider_...",
  "teammateId": "engineer",
  "idempotencyKey": "client-generated-key",
  "tools": ["read", "grep", "find", "ls"]
}
```

The daemon loads the task and channel, rejects paused or archived channels, checks provider readiness, acquires resource leases, claims the task with compare-and-set, creates a run, streams events, and releases leases on terminal state. Repeating the same `idempotencyKey` returns the original run id and does not start another runner.

Conflicts return `409 resource_conflict` with the blocking resource in the message. v0.1 exposes conflict visibility; durable queued-attempt scheduling is a later slice.

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

## Runtime Diagnostics

These endpoints are read-only and intended for Web timelines, CLI doctor, and debugging stuck work.

```http
GET /state-transitions?cwd=/path/to/project&entityType=task&entityId=task_...
GET /runtime/leases?cwd=/path/to/project&status=active
```

`/state-transitions` returns persisted transition facts for `task`, `run`, `approval`, `media_job`, `workflow`, or `workflow_step`.

`/runtime/leases` returns active, released, or expired leases. Resource types are `channel`, `bound_path`, `workspace`, `provider`, `task`, and `workflow_step`.

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

During run execution the daemon records `artifact_created` events for extracted Pi tool evidence. v0.1 extraction covers text, log, Markdown, diff output, and generated file path metadata. Media job artifacts use the same artifact API; Seedream `image_generate` can now store returned image URL bytes as local image artifacts, while video and other media byte outputs remain deferred.

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

Media jobs are persisted metadata for media-capable provider presets. By default the execution interface uses local static adapters and does not call live media APIs. Seedream `image_generate` can make live HTTP calls only when the provider preset explicitly sets `compat.mediaVendorTransport.mode = "live"`. See [Seedream live smoke](seedream-live-smoke.md) for the full live approval, execution, and artifact verification path.

Supported statuses:

```text
queued, running, waiting_for_approval, succeeded, failed, cancelled
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
    "size": "2K"
  }
}
```

Rules:

- `providerPresetId` must reference an enabled provider preset with `api: "media-job"`.
- The provider preset must include the requested media operation in `capabilities`.
- Chat provider presets return `unsupported_capability`.
- Creation only records queued metadata. Live vendor calls happen only through explicit run execution after required approvals; billing, video bytes, and non-Seedream media byte outputs are still out of scope.

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
      "size": "2K"
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

The current execution interface uses the media adapter contract and provider-kind registry. `jimeng`, `seedream`, and `seedance` resolve to vendor adapter stubs that emit a redacted vendor request plan and use a disabled-by-default vendor transport seam. A provider preset can set `compat.mediaVendorTransport.mode = "live"` to enter the live gate; the daemon then requires `baseUrl`, `apiKeyRef`, and a configured env secret. Live transport currently supports only Seedream `image_generate` through the OpenAI-compatible `/images/generations` endpoint. It records JSON metadata artifacts and downloads returned HTTP(S) image URLs into local image artifacts under `.ling-stack/artifacts` without sending the provider authorization header to those image URLs. Jimeng, Seedance, billing, video bytes, and other Seedream operations remain out of scope.

Live-gated jobs do not execute immediately. The first run creates a pending `media_cost` approval, returns it in the response, and moves the job to `waiting_for_approval`. Re-running while the approval is pending returns the existing approval instead of creating a duplicate. Once approved, the next run proceeds to the adapter; for Seedream `image_generate`, the adapter calls the configured `/images/generations` endpoint. Denied or expired approvals fail the job without executing the adapter.

Runnable statuses are `queued`, `waiting_for_approval`, `failed`, and `cancelled`. `running` and `succeeded` jobs return `409 media_job_not_runnable`. Tests can force the static failure path with `input.forceFailure: true`.

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

Live approval response:

```json
{
  "mediaJob": {
    "id": "media_job_...",
    "status": "waiting_for_approval",
    "artifactIds": []
  },
  "approval": {
    "id": "approval_...",
    "mediaJobId": "media_job_...",
    "actionType": "media_cost",
    "risk": "high",
    "payload": {
      "type": "media_cost",
      "providerPresetId": "provider_...",
      "model": "doubao-seedream-5-0-260128",
      "operation": "image_generate",
      "promptPreview": "Create a clean product screenshot style image."
    },
    "status": "pending"
  },
  "artifacts": []
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

Provider presets store reusable non-secret provider configuration. API keys are represented as `apiKeyRef`, using `env:NAME` or `keychain:NAME`.

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

Templates are reusable request bodies for `POST /providers`. They are disabled by default and use secret refs rather than raw keys.

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
      "apiKeyStatus": {
        "ref": "env:LOCAL_RELAY_API_KEY",
        "kind": "env",
        "configured": true
      },
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

`apiKeyStatus` is status-only metadata. It never includes the resolved secret value.

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

Raw `apiKey` is not accepted for persistent provider presets. `apiKeyRef` accepts only supported secret refs such as `env:LOCAL_RELAY_API_KEY` or `keychain:provider_local`.

### Get, Update, Delete

```http
GET /providers/:id?cwd=/path/to/project
PATCH /providers/:id?cwd=/path/to/project
DELETE /providers/:id?cwd=/path/to/project
```

`PATCH` accepts partial provider fields. The daemon validates the merged provider shape before writing.

Media provider presets can prepare the live transport gate without changing the media job API:

```json
{
  "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
  "model": "doubao-seedream-5-0-260128",
  "apiKeyRef": "env:SEEDREAM_API_KEY",
  "compat": {
    "mediaVendorTransport": {
      "mode": "live"
    }
  }
}
```

CLI equivalent:

```bash
ling-stack provider update provider_... --base-url https://ark.cn-beijing.volces.com/api/v3 --model doubao-seedream-5-0-260128 --api-key-ref env:SEEDREAM_API_KEY --compat-json '{"mediaVendorTransport":{"mode":"live"}}'
```

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

The check validates base URL format, required secret refs, enabled state, and supported capabilities. For `media-job` presets, the check remains static: default disabled transport reports no live vendor HTTP, while `compat.mediaVendorTransport.mode = "live"` validates the Seedream `image_generate` live gate configuration without creating media. For `openai-completions`, `openai-responses`, and `anthropic-messages`, it also performs a small live model request with a 10 second timeout. Common failure codes include `secret_missing`, `network_failed`, `auth_failed`, `model_unsupported`, `rate_limited`, `provider_disabled`, and `provider_error`.

## Secrets

### Get Secret Status

```http
GET /secrets/status?ref=env%3AOPENAI_API_KEY&purpose=provider_api_key
```

`purpose` is optional. Supported values are `provider_api_key`, `github_token`, `webhook_secret`, `custom_header`, and `automation_token`.

Response:

```json
{
  "status": {
    "ref": "env:OPENAI_API_KEY",
    "kind": "env",
    "configured": true
  }
}
```

For unavailable keychain storage:

```json
{
  "status": {
    "ref": "keychain:provider_local",
    "kind": "keychain",
    "configured": false,
    "errorCode": "secret_store_unavailable",
    "message": "Keychain secret store is unavailable in this runtime."
  }
}
```

This endpoint is read-only and never returns a raw secret value.

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
- `mediaJobId`: filter by media job id.
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
Media job approvals are owned by `mediaJobId`; they are listed and resolved through the same approval endpoints, but do not append media job event stream entries in this slice.

## Current Limits

- HTTP client disconnect does not imply cancellation; callers must use `POST /runs/:id/cancel`.
- Cancellation is best effort and depends on Pi session abort behavior.
- Inline API keys are accepted in `/runs` for early development only; production desktop builds should use OS keychain or a local secret store.
- Media provider health checks are static config checks until media job execution exists.
- v0.1 does not expire provider `lastCheck` by time. Provider edits clear old check state; future versions can add TTL-based recheck prompts.
- Artifact content is local-only and must live under `.ling-stack/artifacts`.
