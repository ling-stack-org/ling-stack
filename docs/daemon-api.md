# Daemon API

The daemon is the local process that connects the future CLI, web UI, and desktop shell to Ling Stack runners.

## Start

Current manual foreground start:

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

Background daemon lifecycle commands are not part of the current HTTP API contract.
The P0 design for `ling-stack daemon start`, `status`, `stop`, `restart`, `logs`, and
read-only doctor checks lives in [Daemon Lifecycle and Doctor P0](design/daemon-lifecycle-p0.md).

## Health

```http
GET /health
```

Response:

```json
{
  "ok": true,
  "service": "ling-stack-daemon",
  "defaultWorkspaceCwd": "/path/to/workspace"
}
```

This endpoint is the live process reachability check. The current implementation does
not expose lifecycle metadata such as pid, version, started time, host, port, state
path, or log path. The P0 daemon lifecycle design may extend `/health` with those
fields after `.ling-stack/daemon/daemon.json` and `.ling-stack/logs/daemon.log` exist.
Until then, clients must treat those fields as optional and unavailable.

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
POST /teammates/:id/hard-delete?cwd=/path/to/project
```

`PATCH` accepts partial identity, provider, prompt, allowed tool, approval profile,
status, pin, hidden, and avatar reference fields. Nullable fields can be cleared with
`null`. `avatarImageAttachmentId`, when set directly, must reference a
`teammate_profile_avatar` private attachment owned by the same teammate.

`DELETE` is a soft disable. It sets `status` to `disabled` and `hidden` to `true`;
private history and related records remain available for retention/audit.

`POST /hard-delete` is the destructive retention path. It accepts an optional reason and
returns a minimal tombstone. It deletes teammate private thread/messages, private
attachments and avatar bytes, teammate-scope memory, related used-memory events, and
teammate private bindings. It does not cascade-delete channel messages, tasks, or run
history; those records clear teammate references or render as a deleted teammate.

Request:

```json
{
  "reason": "owner request"
}
```

Response:

```json
{
  "tombstone": {
    "id": "tomb_...",
    "workspaceId": "workspace_default",
    "entityType": "ai-teammate",
    "entityId": "teammate_...",
    "reason": "owner request",
    "deletedCounts": {
      "aiTeammates": 1,
      "directThreads": 1,
      "directMessages": 8,
      "privateAttachments": 2,
      "memoryObjects": 1,
      "usedMemoryEvents": 3
    },
    "createdAt": "2026-06-04T00:00:00.000Z"
  }
}
```

The tombstone intentionally omits message text, prompt text, persona text, snippets,
file names, and attachment content.

## Skill Registry

The skill registry lists built-in and workspace custom skill definitions. Skill
definitions are workflow templates; teammate bindings and Effective Skill checks still
decide whether a skill can run.

```http
GET /skills?cwd=/path/to/project
POST /skills/refresh?cwd=/path/to/project
POST /skills/import-draft?cwd=/path/to/project
GET /skills/import-drafts/:id?cwd=/path/to/project
POST /skills/import-drafts/:id/publish?cwd=/path/to/project
DELETE /skills/:id?cwd=/path/to/project
```

`GET /skills` returns built-in definitions projected from `gstack-default` plus published
workspace registry definitions. Built-in definitions are not duplicated into SQLite.

`POST /skills/refresh` recomputes the effective registry and returns a process-local
`registryGeneration` plus `refreshedAt`. In the current slice this is a lightweight
explicit refresh hook over built-ins and SQLite-backed custom skills; future local
file/plugin scanners should attach to the same endpoint instead of adding client-side
registry guesses.

Refresh response:

```json
{
  "cwd": "/path/to/project",
  "refreshedAt": "2026-06-06T00:00:00.000Z",
  "registryGeneration": 1,
  "skills": []
}
```

`POST /skills/import-draft` accepts Ling-native JSON or markdown/`SKILL.md` content and
returns a reviewed draft. Draft creation does not bind the skill to any teammate and does
not grant tools, approvals, provider capabilities, secrets, memory access, or
external-send permission.

```json
{
  "source": "skill-directory",
  "sourcePath": "SKILL.md",
  "content": "---\nname: Custom QA Review\ndescription: Run a focused QA pass.\n---\n\nReport failures first."
}
```

Draft response:

```json
{
  "cwd": "/path/to/project",
  "draft": {
    "id": "skill_draft_...",
    "source": "skill-directory",
    "definitions": [
      {
        "definition": {
          "id": "custom-qa-review",
          "name": "Custom QA Review",
          "workflowPhase": "operate",
          "requiredTools": ["read", "grep", "find", "ls"],
          "requiredProviderCapabilities": ["chat", "reasoning"],
          "approvalProfile": { "mode": "none" }
        },
        "warnings": []
      }
    ],
    "warnings": []
  }
}
```

Publishing a draft writes registry definitions and still does not bind them:

```http
POST /skills/import-drafts/skill_draft_.../publish?cwd=/path/to/project
```

New teammate bindings must reference a built-in or published registry skill. Existing
unknown durable bindings can be preserved for legacy visibility, but new unknown binding
ids are rejected.

`DELETE /skills/:id` archives a custom/imported registry skill. Built-in skills are
projected from code and cannot be deleted through this endpoint.

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
omitting them from the replacement set. The `GET` response includes `effectiveSkills`
when the daemon can compute current executability.

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

Memory scopes are visible trust-boundary metadata and are always provisioned for every AI
teammate. Each teammate gets private `private-chat-summary` and `private-notes` scopes by
default; each channel membership adds that teammate's own `channel-brief` and
`channel-decisions` scopes for that channel. There is no supported off switch.
`enabled:false` is rejected, and Ling Agent scopes are protected system memory.

```json
{
  "scopes": [
    { "kind": "private-chat-summary", "enabled": true },
    { "kind": "private-notes", "enabled": true },
    { "kind": "channel-brief", "channelId": "channel_...", "enabled": true },
    { "kind": "channel-decisions", "channelId": "channel_...", "enabled": true }
  ]
}
```

Supported scope kinds:

```text
channel-brief, channel-decisions, private-chat-summary, private-notes
```

### Ling Memory

```http
GET /memory?cwd=/path/to/project
POST /memory?cwd=/path/to/project
PATCH /memory/:id?cwd=/path/to/project
GET /memory/consolidation-jobs?cwd=/path/to/project
POST /memory/consolidation-jobs?cwd=/path/to/project
POST /memory/recall?cwd=/path/to/project
GET /memory/used?cwd=/path/to/project
GET /memory/review-policy?cwd=/path/to/project
PATCH /memory/review-policy?cwd=/path/to/project
GET /memory/promotion-inbox?cwd=/path/to/project
POST /memory/:id/review?cwd=/path/to/project
```

Manual memory created through `POST /memory` may still default to active. Extracted
or reflected memory should create candidates and then use the review policy and
promotion inbox before active/shared/persona recall.

`POST /memory/consolidation-jobs` is an explicit trigger, not an automatic daemon
startup scheduler. It creates a durable job record, runs the memory review classifier,
creates a candidate memory, records the review decision, and returns the created
candidate. Even if the classifier would otherwise return `auto-active`, consolidation
jobs store the output as `auto-candidate` with `reasonCode:
"consolidation_candidate_only"`.

```json
{
  "kind": "task_run_lesson",
  "sourceScopeType": "channel",
  "confidence": "high",
  "candidate": {
    "scopeType": "channel",
    "ownerId": "channel_...",
    "title": "Consolidated run lesson",
    "body": "When Model Workbench width regresses, check the workspace frame before editing cards.",
    "tags": ["model-workbench"],
    "sourceRefs": [
      { "type": "run-event", "id": "run_event_...", "label": "Run succeeded" }
    ]
  }
}
```

Review policy modes are `conservative`, `balanced`, and `fast`; the default is
`balanced`. Candidate and disabled memories are not returned by default recall.
`POST /memory/:id/review` accepts actions:

```text
approve, edit_and_approve, keep_candidate, reject, archive, quarantine
```

For `edit_and_approve`, pass changed memory fields under `editedMemory`:

```json
{
  "action": "edit_and_approve",
  "editedMemory": {
    "title": "Provider routing order",
    "body": "Provider routing resolves teammate, explicit run, channel default, then workspace selected.",
    "scopeType": "workspace",
    "ownerId": "workspace_default",
    "sensitivity": "normal"
  },
  "reason": "Stable workspace rule confirmed by user."
}
```

### Private Thread And Messages

```http
GET /teammates/:id/direct-thread?cwd=/path/to/project
GET /teammates/:id/direct-messages?cwd=/path/to/project&limit=100
POST /teammates/:id/direct-messages?cwd=/path/to/project
POST /teammates/:id/direct-messages/stream?cwd=/path/to/project
```

`direct-thread` creates the one-to-one teammate thread if it does not exist. Private
messages are durable. `POST` persists the local-user message before provider resolution;
if the teammate is paused, disabled, missing a provider, or the provider cannot run, the
daemon stores a blocked AI reply instead of dropping the user message.

```json
{
  "body": "Can you help refine this task?",
  "attachmentIds": ["tpatt_..."],
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
    "attachmentIds": ["tpatt_..."],
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

Private chat uses no tools and does not include channel messages, files, memory objects, or
web content unless a future explicit prompt-inclusion model adds that behavior. The
teammate's default memory scopes still exist and remain inspectable.

`POST /direct-messages/stream` uses the same request body and returns
`text/event-stream`. The daemon first persists the local-user message, then creates a
pending AI reply and updates that same record as deltas arrive.

SSE events:

```text
ready
delta
done
blocked
error
```

Event payload shapes:

```json
{ "message": { "id": "tdmsg_user_..." }, "aiReply": { "id": "tdmsg_ai_...", "status": "pending" } }
```

```json
{ "messageId": "tdmsg_ai_...", "delta": "partial text", "body": "full text so far" }
```

```json
{ "message": { "id": "tdmsg_user_..." }, "aiReply": { "id": "tdmsg_ai_...", "status": "ready" } }
```

Provider preflight failures emit `blocked`; provider/runtime errors emit `error` and the
AI reply is stored as `failed` when one exists. Client aborts stop streaming and abort the
provider request; already persisted messages remain durable.

### Private Attachments And Avatar

Private attachments share the same file root and validation policy as channel
attachments, but are scoped to a teammate private thread or teammate profile avatar.

```http
GET /teammates/:id/direct-attachments?cwd=/path/to/project&limit=100
POST /teammates/:id/direct-attachments?cwd=/path/to/project
POST /teammates/:id/avatar?cwd=/path/to/project
DELETE /teammates/:id/avatar?cwd=/path/to/project
GET /attachments/:id/content?cwd=/path/to/project
DELETE /attachments/:id?cwd=/path/to/project
```

`POST /direct-attachments` accepts JSON with base64 content:

```json
{
  "fileName": "notes.md",
  "contentType": "text/markdown",
  "contentBase64": "IyBOb3Rlcw=="
}
```

Response:

```json
{
  "attachment": {
    "id": "tpatt_...",
    "teammateId": "teammate_...",
    "threadId": "tdthread_...",
    "scope": "teammate_direct_thread",
    "fileName": "notes.md",
    "contentType": "text/markdown",
    "sizeBytes": 7
  }
}
```

`GET /direct-attachments` lists only `teammate_direct_thread` attachments for that
teammate's private thread. A private direct message can reference at most 10
`attachmentIds`, and every id must belong to the same teammate private thread.

`POST /avatar` stores a `teammate_profile_avatar` attachment, sets
`avatarImageAttachmentId` on the teammate, and deletes the previous avatar file if it is
being replaced. `DELETE /avatar` clears the field and deletes the avatar attachment bytes.
Avatar upload uses the image subset of the same attachment validation policy.

`GET /attachments/:id/content` and `DELETE /attachments/:id` resolve both channel
attachments and teammate private attachments. Deleting a private avatar attachment also
clears the owning teammate's avatar reference.

Private attachments are user-provided context only. They do not automatically enter
memory and are not automatically provided to AI; future AI file inclusion must use an
explicit, auditable path.

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
POST /channels/:id/messages/stream?cwd=/path/to/project
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

`POST /messages/stream` uses the same request body and returns `text/event-stream`.
It persists the local message, creates durable pending AI reply messages, and streams
visible assistant text into those same message rows.

SSE events:

- `ready`: `{ "message": ChannelMessage, "aiReply"?: ChannelMessage, "aiReplies"?: ChannelMessage[] }`
- `delta`: `{ "messageId": string, "delta": string, "body": string }`
- `done`: `{ "message": ChannelMessage, "aiReply"?: ChannelMessage, "aiReplies"?: ChannelMessage[], "autoStartedWorkflow"?: ... }`
- `blocked`: `{ "message": ChannelMessage, "aiReply"?: ChannelMessage, "aiReplies"?: ChannelMessage[], "error"?: string }`
- `error`: `{ "message"?: ChannelMessage, "aiReply"?: ChannelMessage, "aiReplies"?: ChannelMessage[], "error": string }`

Hidden `<ling_task_proposal>` blocks are not streamed as visible deltas. The daemon
continues to extract and persist proposals through the channel proposal pipeline.

### Attachments

```http
GET /channels/:id/attachments?cwd=/path/to/project&limit=100
POST /channels/:id/attachments?cwd=/path/to/project
GET /attachments/:id/content?cwd=/path/to/project
DELETE /attachments/:id?cwd=/path/to/project
```

The shared content and delete routes resolve both channel attachments and private
teammate attachments. Channel upload/list routes only manage channel-scoped
attachments.

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

## External Work

Phase 1 adds a read-only GitHub manual import path. Phase 2 adds manual read-only
GitHub polling and local scheduler reconciliation. Phase 3 adds approval-gated action
records for GitHub comments and labels. Phase 4 adds manual GitHub CI triage for
existing PR external-work items: it reads failing checks, workflow jobs, and bounded
redacted logs, then creates local evidence and fix tasks by default. Phase 4.1 adds a
separate explicit SSE endpoint to start the linked local fix task through the normal
task/run path; it still does not mutate GitHub. Phase 5 adds strict approval-gated PR
review actions. Propose, list, show, and cancel remain local only; the explicit execute
endpoint is the only path that can call allowed GitHub mutation APIs after approval and
stale-target revalidation. Phase 6 adds explicitly registered GitHub background
polling and reconciliation; background ticks reuse the read-only poll/reconcile paths
and still do not start runners or execute GitHub mutations. Phase 7 adds Linear as a
second read-only source adapter for manual import and poll. Linear operations create or
reuse local Ling records and evidence only; they do not start runners, propose hidden
actions, or call Linear mutation APIs.
Import parses a repository
`WORKFLOW.md`, normalizes a GitHub PR or issue payload, creates or reuses a
`ChannelWorkflow` and `ChannelWorkflowStep`, and writes local evidence artifacts. It
does not start a runner, receive webhooks, post comments, add labels, request reviews,
push commits, close issues, or merge. Polling only uses GitHub `GET` endpoints.

Setup/status surface: Web Settings and CLI use the local-only status endpoint to show
workflow file health, source target, status-only token readiness, local external-work
counts, CI triage counts, action counts, and background scheduler state without calling
GitHub, Linear, hooks, runners, or mutation APIs. The design is in
[External Work Status Surface](design/external-work-status-surface.md).
Web Settings also exposes explicit local workflow setup plus Keychain token setup and
removal. Workflow setup writes or repairs a minimal channel-bound `WORKFLOW.md` from a
user-entered GitHub repository or Linear project slug; token setup only writes/deletes
local Keychain entries and may update `WORKFLOW.md` to point at a `keychain:` ref. None
of these setup endpoints call GitHub or Linear.

### Show External Work Status

```http
GET /external-work/status?cwd=/path/to/project&channelId=channel_...&workflowPath=WORKFLOW.md
```

`channelId` is required. `workflowPath` is optional and defaults to `WORKFLOW.md` under
the channel bound path. If supplied, it must resolve inside the channel bound path.
Missing or invalid workflow files return `200` with `workflow.exists`, `workflow.valid`,
and `workflow.error` set so Settings can still render setup guidance. Missing channels
return `404`; missing `channelId` or out-of-bounds paths return `400`.

Response:

```json
{
  "cwd": "/path/to/project",
  "channel": {
    "id": "channel_...",
    "name": "Engineering",
    "boundPath": "/path/to/project"
  },
  "workflow": {
    "path": "/path/to/project/WORKFLOW.md",
    "exists": true,
    "valid": true,
    "sourceKind": "github",
    "repository": "owner/repo",
    "events": ["pull_request.opened"],
    "secretRef": "env:GITHUB_TOKEN"
  },
  "secret": {
    "ref": "env:GITHUB_TOKEN",
    "purpose": "github_token",
    "status": "configured"
  },
  "records": {
    "externalWork": { "total": 0, "ready": 0, "blocked": 0, "retryWait": 0, "terminal": 0 },
    "ciTriage": { "total": 0, "triaged": 0, "taskCreated": 0, "runRequested": 0, "blocked": 0, "stale": 0, "failed": 0 },
    "actions": { "total": 0, "waitingForApproval": 0, "approved": 0, "failed": 0, "succeeded": 0, "cancelled": 0, "staleTarget": 0 }
  },
  "background": {
    "supported": true,
    "running": false,
    "status": "not_configured"
  },
  "lastErrors": {}
}
```

SDK clients can use:

```ts
await client.getExternalWorkStatus("/path/to/project", {
  channelId: "channel_...",
  workflowPath: "WORKFLOW.md",
});
```

CLI:

```bash
ling-stack external-work status --channel channel_... --workflow-path WORKFLOW.md
```

### Configure External Work Workflow

```http
POST /external-work/workflow/configure?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md",
  "sourceKind": "github",
  "repository": "owner/repo"
}
```

For GitHub, `repository` accepts either `owner/repo` or a GitHub URL such as
`https://github.com/owner/repo`; the daemon stores the normalized `owner/repo` value in
`WORKFLOW.md`. For Linear, send `"sourceKind": "linear"` and `projectSlug` instead of
`repository`. `workflowPath` defaults to `WORKFLOW.md` under the channel bound path and
must stay inside that bound path. If the file is missing or invalid, the daemon writes a
minimal local workflow with safe default events and prompt text. If the existing
workflow is already valid, the endpoint is a no-op and returns the current workflow
summary.

This endpoint is local-only: it writes `WORKFLOW.md` but does not call GitHub, Linear,
hooks, runners, polling, reconciliation, or mutation APIs.

Response:

```json
{
  "cwd": "/path/to/project",
  "channelId": "channel_...",
  "sourceKind": "github",
  "workflow": {
    "path": "/path/to/project/WORKFLOW.md",
    "exists": true,
    "valid": true,
    "sourceKind": "github",
    "repository": "owner/repo",
    "events": ["pull_request.opened", "pull_request.synchronize", "issue.opened"]
  },
  "workflowCreated": true,
  "workflowUpdated": true
}
```

SDK:

```ts
await client.configureExternalWorkWorkflow("/path/to/project", {
  channelId: "channel_...",
  sourceKind: "github",
  repository: "owner/repo",
});
```

### Configure External Work Secret

```http
POST /external-work/secrets/configure?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md",
  "token": "<github-token>",
  "secretRef": "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
  "updateWorkflow": true
}
```

`channelId` and `token` are required. `workflowPath` defaults to `WORKFLOW.md` under
the channel bound path and must stay inside that bound path. `secretRef` is optional; if
omitted, the daemon derives a stable `keychain:LING_STACK_GITHUB_<OWNER>_<REPO>_TOKEN`
or `keychain:LING_STACK_LINEAR_<PROJECT>_TOKEN` ref from the workflow source. Web setup
accepts only `keychain:` refs. `env:` remains supported for manual status/polling, but
cannot be written or removed from Web Settings.

When `updateWorkflow` is not `false`, the daemon updates only `source.secretRef` in the
workflow front matter. The token value is sent once to the daemon, saved in macOS
Keychain, and never returned in the response.

Response:

```json
{
  "cwd": "/path/to/project",
  "channelId": "channel_...",
  "sourceKind": "github",
  "secretRef": "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
  "secret": {
    "ref": "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
    "purpose": "github_token",
    "status": "configured"
  },
  "workflow": {
    "path": "/path/to/project/WORKFLOW.md",
    "exists": true,
    "valid": true,
    "sourceKind": "github",
    "repository": "owner/repo",
    "events": ["pull_request.opened"],
    "secretRef": "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN"
  },
  "workflowUpdated": true
}
```

SDK:

```ts
await client.configureExternalWorkSecret("/path/to/project", {
  channelId: "channel_...",
  token: "<github-token>",
});
```

### Delete External Work Secret

```http
POST /external-work/secrets/delete?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md",
  "secretRef": "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN"
}
```

`secretRef` is optional and defaults to the current workflow `source.secretRef`. Only
`keychain:` refs can be removed through this endpoint. The daemon deletes the local
Keychain item and leaves `WORKFLOW.md` unchanged so the UI can still show which ref is
missing.

SDK:

```ts
await client.deleteExternalWorkSecret("/path/to/project", {
  channelId: "channel_...",
});
```

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

### Poll GitHub

```http
POST /external-work/github/poll?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md",
  "limit": 50,
  "executeHooks": false
}
```

The daemon reads the channel-bound `WORKFLOW.md`, resolves `source.secretRef` through
the existing secret resolver when present, calls GitHub read-only PR/issue list
endpoints, claims source and subject leases, creates or reuses local workflow records,
and writes scheduler state in the same SQLite workspace store. `executeHooks` defaults
to `false`; when true, only `afterCreate` and `beforeRun` run inside the isolated
external workspace with hook evidence artifacts.

For reproducible live polling, prefer `source.secretRef: env:GITHUB_TOKEN` and start
the daemon with `GITHUB_TOKEN` in its environment. Unauthenticated GitHub reads can hit
low API rate limits before the smoke path finishes.

Response:

```json
{
  "candidates": 1,
  "claimed": 1,
  "duplicates": 0,
  "blocked": 0,
  "retryScheduled": 0,
  "terminalIgnored": 0,
  "artifacts": [],
  "results": [],
  "schedulerStates": []
}
```

### Import Linear

```http
POST /external-work/linear/import?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "eventType": "issue.created",
  "payload": {
    "id": "linear-issue-123",
    "identifier": "LIN-123",
    "title": "Wire Linear external work",
    "state": { "name": "Todo" },
    "project": { "slug": "ling-stack" }
  },
  "workflowPath": "WORKFLOW.md"
}
```

The parsed `WORKFLOW.md` must use `source.kind: linear` and must include
`source.projectSlug`. `workflowMarkdown` may be supplied instead of `workflowPath` for
tests and fixtures. The endpoint normalizes a `linear_issue`, creates or reuses the same
local workflow and workflow-step records used by GitHub external work, and writes the
normalized item plus rendered prompt artifacts.

Response:

```json
{
  "externalWorkItem": {
    "sourceKind": "linear",
    "kind": "linear_issue",
    "identifier": "LIN-123",
    "idempotencyKey": "linear:issue:ling-stack:LIN-123:2026-06-01T00:00:00.000Z"
  },
  "workflow": {},
  "workflowStep": {},
  "artifacts": [],
  "duplicate": false
}
```

### Poll Linear

```http
POST /external-work/linear/poll?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md",
  "limit": 50,
  "executeHooks": false
}
```

The daemon reads the channel-bound Linear `WORKFLOW.md`, resolves `source.secretRef`
through the existing secret resolver with the `linear_token` purpose, and calls Linear's
read-only GraphQL API to list issues. Candidates are filtered by
`source.projectSlug`. Poll then reuses the existing scheduler-state, source/subject
lease, isolated workspace, hook evidence, and artifact pipeline.

Phase 7 Linear poll does not add a background scheduler and does not perform Linear
mutations. Local reconcile can still repair leases, missing workflow/step rows,
terminal local workflow state, and retry waits, but remote Linear terminal checks are
deferred.

Response:

```json
{
  "candidates": 1,
  "claimed": 1,
  "duplicates": 0,
  "blocked": 0,
  "retryScheduled": 0,
  "terminalIgnored": 0,
  "artifacts": [],
  "results": [],
  "schedulerStates": []
}
```

### Start GitHub Background Polling

```http
POST /external-work/github/background/start?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md",
  "limit": 50,
  "executeHooks": false,
  "runImmediately": true
}
```

This Phase 6 endpoint registers a process-local background scheduler for one explicit
`cwd`, channel, and channel-bound workflow path. It does not scan all workspaces and it
does not install a webhook receiver. Duplicate registration for the same resolved
`cwd + channelId + workflowPath` returns the existing scheduler with `duplicate: true`
instead of creating another timer.

`runImmediately` defaults to `true`. When the parsed workflow has
`scheduler.reconcileOnStartup: true`, registration runs reconcile once before the first
poll tick. The tick then reuses the same read-only GitHub poll and local reconcile
services as the manual endpoints. GitHub token resolution follows `source.secretRef`;
token values are never stored in scheduler state or artifacts.

Response:

```json
{
  "cwd": "/path/to/project",
  "scheduler": {
    "id": "external_work_background_...",
    "sourceKind": "github",
    "channelId": "channel_...",
    "workflowPath": "WORKFLOW.md",
    "repository": "owner/repo",
    "pollIntervalMs": 30000,
    "limit": 50,
    "executeHooks": false,
    "status": "running",
    "startedAt": "2026-06-01T00:00:00.000Z",
    "lastPollAt": "2026-06-01T00:00:00.000Z",
    "nextPollAt": "2026-06-01T00:00:30.000Z",
    "lastReconcileAt": "2026-06-01T00:00:00.000Z",
    "tickCount": 1,
    "lastPoll": {},
    "lastReconcile": {}
  },
  "duplicate": false,
  "startupReconcile": {}
}
```

If a poll tick fails, the scheduler remains inspectable and stores
`lastErrorCode: "background_tick_failed"` plus a readable `lastErrorMessage`; it should
schedule the next tick instead of crashing the daemon. Background ticks may read GitHub
and create or reuse local workflows, scheduler state, leases, workspaces, hooks, and
artifacts. They must not start local runners, propose hidden mutations, or execute
external actions.

### List External Work Background Schedulers

```http
GET /external-work/background?cwd=/path/to/project
```

Response:

```json
{
  "cwd": "/path/to/project",
  "schedulers": [
    {
      "id": "external_work_background_...",
      "status": "running",
      "channelId": "channel_...",
      "repository": "owner/repo",
      "pollIntervalMs": 30000,
      "tickCount": 1,
      "nextPollAt": "2026-06-01T00:00:30.000Z"
    }
  ]
}
```

This endpoint reads only process-local scheduler registry state. It does not call
GitHub, reconcile state, run hooks, start runners, or mutate approvals/actions.

### Stop External Work Background Scheduler

```http
POST /external-work/background/:schedulerId/stop?cwd=/path/to/project
```

Response:

```json
{
  "cwd": "/path/to/project",
  "scheduler": {
    "id": "external_work_background_...",
    "status": "stopped",
    "stoppedAt": "2026-06-01T00:01:00.000Z"
  }
}
```

Stop clears the process-local timer and removes the duplicate-registration key so the
same channel/workflow can be started again later. It does not delete durable external
work, scheduler-state rows, workflows, steps, artifacts, or approvals.

### Triage GitHub CI

```http
POST /external-work/github/ci/triage?cwd=/path/to/project
```

Request:

```json
{
  "externalWorkId": "external_work_...",
  "workflowPath": "WORKFLOW.md",
  "limit": 5,
  "createTask": true,
  "startRun": false
}
```

The target must be an existing `github_pull_request` external-work record. The daemon
loads the record's channel, reads the channel-bound `WORKFLOW.md`, resolves
`source.secretRef` as `github_token` when present, re-reads the current PR, and refuses
stale head SHAs before inspecting CI. It uses only GitHub `GET` endpoints for check
runs, workflow runs, workflow jobs, and job logs. Tokens are never stored in SQLite or
artifacts; logs are bounded and redacted before artifact write.

`createTask` defaults to `true`. Created tasks are local Ling tasks in the same channel
and include an explicit instruction not to push, comment, review, merge, or otherwise
mutate GitHub without a separate approval-gated external action. `startRun` remains
rejected on this JSON triage endpoint; Phase 4.1 starts local fix runs through the
separate explicit SSE endpoint below.

Response:

```json
{
  "cwd": "/path/to/project",
  "triaged": 1,
  "taskCreated": 1,
  "duplicates": 0,
  "blocked": 0,
  "stale": 0,
  "failed": 0,
  "records": [
    {
      "triage": {
        "id": "external_work_ci_triage_...",
        "status": "task_created",
        "checkName": "web e2e",
        "repository": "owner/repo",
        "subjectNumber": 123,
        "headSha": "head-sha"
      },
      "externalWork": {},
      "task": {},
      "artifacts": []
    }
  ]
}
```

Repeating the same failing check/job for the same PR head SHA returns existing triage
records as `duplicates` and does not create a second task. Stale PR heads create a
`stale` local triage record and do not read old CI.

### List GitHub CI Triage

```http
GET /external-work/github/ci/triage?cwd=/path/to/project&channelId=channel_...&status=task_created&limit=25
```

This Phase 4.2 endpoint is local-only. It reads persisted CI triage records and joins
the linked external work item, local fix task, optional run, and artifacts. It does not
read GitHub and does not start a runner.

Query parameters:

- `externalWorkId`: optional external-work id filter.
- `channelId`: optional channel filter.
- `status`: optional triage status filter: `triaged`, `task_created`, `run_requested`,
  `blocked`, `stale`, or `failed`.
- `limit`: optional positive integer, defaulting to the daemon limit.

Response:

```json
{
  "cwd": "/path/to/project",
  "records": [
    {
      "triage": {
        "id": "external_work_ci_triage_...",
        "status": "task_created",
        "repository": "owner/repo",
        "subjectNumber": 123,
        "checkName": "web e2e"
      },
      "externalWork": {},
      "task": {},
      "run": {},
      "artifacts": []
    }
  ]
}
```

### Show GitHub CI Triage

```http
GET /external-work/github/ci/triage/:triageId?cwd=/path/to/project
```

This endpoint returns one local CI triage view with the same shape as list. Missing
records return `404 ci_triage_not_found`. It is also local-only: no GitHub reads and no
runner startup.

### Start GitHub CI Fix Run

```http
POST /external-work/github/ci/triage/:triageId/run?cwd=/path/to/project
```

This Phase 4.1 endpoint starts a local fix run for one existing CI triage record. It
does not read or mutate GitHub. The record must already have a local task, and stale
triage records are rejected. The daemon uses the same run startup path as normal task
runs: provider resolution, provider preflight unless skipped, task status CAS,
resource leases, approval policy, and SSE runner streaming.

Request:

```json
{
  "providerPresetId": "provider_...",
  "skipProviderPreflight": false,
  "idempotencyKey": "optional-custom-key",
  "tools": ["read", "grep", "bash", "edit"],
  "thinkingLevel": "medium",
  "systemPrompt": "optional override",
  "appendSystemPrompt": ["optional extra instruction"],
  "agentDir": ".ling-stack/agents/default"
}
```

Response:

The response is `text/event-stream`, matching `POST /runs`. The first event is:

```text
event: ready
data: {"ok":true,"runId":"run_..."}
```

When the run is accepted or deduplicated, the triage record is updated to
`status: "run_requested"` with `runId`. Repeating the same request uses a deterministic
default idempotency key for the triage record, task, and head SHA, so it returns the
existing run instead of starting another runner. Use this endpoint only after triage has
created the local task; it does not push commits, comment, label, review, merge, or
release.

### List External Work

```http
GET /external-work?cwd=/path/to/project&channelId=channel_...&status=ready&limit=50
```

Query filters are optional:

- `channelId`
- `sourceKind`: `github` or `linear`
- `workItemKind`: `github_pull_request`, `github_issue`, or `linear_issue`
- `status` or `schedulerStatus`: `discovered`, `claimed`, `workspace_preparing`,
  `ready`, `blocked`, `retry_wait`, or `terminal`
- `limit`: 1-500

Response:

```json
{
  "cwd": "/path/to/project",
  "externalWork": [
    {
      "externalWork": {},
      "workflow": {},
      "workflowStep": {},
      "schedulerState": {},
      "artifacts": []
    }
  ]
}
```

The list endpoint is local-only. It reads existing SQLite records and artifacts; it
does not call GitHub, run hooks, start runners, or reconcile state.

### Show External Work

```http
GET /external-work/external_work_...?cwd=/path/to/project
```

Response:

```json
{
  "cwd": "/path/to/project",
  "externalWork": {
    "externalWork": {},
    "workflow": {},
    "workflowStep": {},
    "schedulerState": {},
    "artifacts": []
  }
}
```

Missing workflow or workflow-step records are omitted rather than synthesized so local
repair tools can see stale mappings directly. Missing external work ids return
`404 external_work_not_found`.

### Propose External Work Action

```http
POST /external-work/actions/propose?cwd=/path/to/project
```

Request for a comment proposal:

```json
{
  "externalWorkId": "external_work_...",
  "actionKind": "github_comment",
  "approvalRequirement": "standard",
  "payload": {
    "type": "github_comment",
    "body": "Proposed comment body"
  }
}
```

Request for a label proposal:

```json
{
  "externalWorkId": "external_work_...",
  "actionKind": "github_label",
  "payload": {
    "type": "github_label",
    "labels": ["agent-ready", "needs-review"]
  }
}
```

Request for a PR review proposal:

```json
{
  "externalWorkId": "external_work_...",
  "actionKind": "github_pr_review",
  "approvalRequirement": "strict",
  "payload": {
    "type": "github_pr_review",
    "event": "REQUEST_CHANGES",
    "body": "Please fix the failing CI before merge."
  }
}
```

`github_pr_review` is allowed only for `github_pull_request` external work. It always
requires `strict` approval; `standard` is rejected. Supported events are `COMMENT`,
`APPROVE`, and `REQUEST_CHANGES`. The body must be non-empty.

Response:

```json
{
  "cwd": "/path/to/project",
  "action": {
    "id": "external_work_action_...",
    "status": "waiting_for_approval",
    "approvalId": "approval_..."
  },
  "approval": {},
  "artifacts": [],
  "duplicate": false
}
```

The daemon writes a target snapshot, proposed payload, and approval preview as local
artifacts owned by the external work item and linked from the action. The same action
idempotency key returns the existing action with `duplicate: true`. Propose never calls
GitHub mutation APIs.

### List External Work Actions

```http
GET /external-work/actions?cwd=/path/to/project&externalWorkId=external_work_...&status=waiting_for_approval
```

Query filters are optional:

- `externalWorkId`
- `channelId`
- `actionKind`: `github_comment`, `github_label`, or `github_pr_review`
- `status`: `proposed`, `waiting_for_approval`, `approved`, `executing`, `succeeded`,
  `failed`, `cancelled`, `denied`, `expired`, or `stale_target`
- `limit`: 1-500

Response:

```json
{
  "cwd": "/path/to/project",
  "actions": [
    {
      "action": {},
      "externalWork": {},
      "approval": {},
      "artifacts": []
    }
  ]
}
```

The list endpoint is local-only. It does not call GitHub, start runners, execute hooks,
or mutate approval decisions.

### Show External Work Action

```http
GET /external-work/actions/external_work_action_...?cwd=/path/to/project
```

Response:

```json
{
  "cwd": "/path/to/project",
  "action": {
    "action": {},
    "externalWork": {},
    "approval": {},
    "artifacts": []
  }
}
```

Missing action ids return `404 external_work_action_not_found`.

### Cancel External Work Action

```http
POST /external-work/actions/external_work_action_.../cancel?cwd=/path/to/project
```

Request:

```json
{
  "reason": "No longer needed"
}
```

Only `proposed`, `waiting_for_approval`, and `approved` actions can be cancelled. A
pending approval is denied with the cancellation reason, the action is marked
`cancelled`, and a local cancellation artifact is linked. Cancel never calls GitHub.

### Execute External Work Action

```http
POST /external-work/actions/external_work_action_.../execute?cwd=/path/to/project
```

Request:

```json
{
  "workflowPath": "WORKFLOW.md"
}
```

`workflowPath` is optional and defaults to `WORKFLOW.md` inside the action channel's
bound path. The daemon parses the workflow to resolve `source.secretRef` through the
existing secret resolver. The resolved GitHub token is passed to the adapter only for
the current request; it is not stored in SQLite or written to artifacts.

Execute requires the linked approval to be `approved` and the action status to be
`approved`. Denied, expired, cancelled, stale, failed, executing, and already-succeeded
actions are rejected before any GitHub call. When eligible, the daemon acquires the
`external_subject` lease, re-reads the current GitHub PR or issue with a read-only
`GET`, and compares the durable target snapshot. A stale state or PR head SHA marks the
action `stale_target`, writes a stale-target evidence artifact, and skips mutation.

Allowed mutation endpoints are limited to:

- `POST /repos/{owner}/{repo}/issues/{number}/comments`
- `POST /repos/{owner}/{repo}/issues/{number}/labels`
- `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`

Response:

```json
{
  "cwd": "/path/to/project",
  "action": {
    "id": "external_work_action_...",
    "status": "succeeded",
    "executionAttemptCount": 1,
    "executedAt": "2026-05-31T00:00:00.000Z"
  },
  "approval": {},
  "artifacts": []
}
```

Successful execution writes redacted request/response evidence, including GitHub result
URLs when present. GitHub permission, validation, rate-limit, unavailable, and network
failures mark the action `failed`, persist normalized error evidence, and do not expose
authorization headers or token values.

### Web External Action Approval Cards

The Web Inbox consumes the existing approval and external action endpoints; it does not
add a separate mutation path. For approvals with `externalWorkActionId`, Web loads
`GET /external-work/actions/:id`, shows the target snapshot, comment body or label set,
action status, last error, and linked artifacts, then uses the normal approval endpoints
for Approve/Deny.

Approval and execution stay separate. After a user approves an external action, Web
refreshes the action detail and only shows `Execute action` when the action status is
`approved`. Clicking that button calls `POST /external-work/actions/:id/execute`.
Cancelling from Web calls `POST /external-work/actions/:id/cancel`. Web does not support
edit-and-approve in this phase; users cancel and create a fresh proposal instead.

### Reconcile External Work

```http
POST /external-work/reconcile?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md"
}
```

`channelId` and `workflowPath` are optional. Without `workflowPath`, reconcile only
repairs local state: expired leases, missing workflow/step records, terminal workflow
steps, and retry rows whose backoff has elapsed. With `workflowPath`, it may also use
GitHub read-only single-item `GET` requests to detect remote terminal state.

SDK clients can use the same endpoint through:

```ts
await client.importGitHubExternalWork("/path/to/project", {
  channelId: "channel_...",
  eventType: "pull_request.opened",
  payload,
  workflowPath: "WORKFLOW.md",
});

await client.importLinearExternalWork("/path/to/project", {
  channelId: "channel_...",
  eventType: "issue.created",
  payload,
  workflowPath: "WORKFLOW.md",
});

await client.pollGitHubExternalWork("/path/to/project", {
  channelId: "channel_...",
  workflowPath: "WORKFLOW.md",
  limit: 50,
});

await client.pollLinearExternalWork("/path/to/project", {
  channelId: "channel_...",
  workflowPath: "WORKFLOW.md",
  limit: 50,
});

await client.startGitHubExternalWorkBackground("/path/to/project", {
  channelId: "channel_...",
  workflowPath: "WORKFLOW.md",
  limit: 50,
  runImmediately: true,
});

await client.listExternalWorkBackgroundSchedulers("/path/to/project");

await client.stopExternalWorkBackgroundScheduler(
  "/path/to/project",
  "external_work_background_...",
);

await client.triageGitHubExternalWorkCi("/path/to/project", {
  externalWorkId: "external_work_...",
  workflowPath: "WORKFLOW.md",
  limit: 5,
  createTask: true,
});

await client.listGitHubExternalWorkCiTriage("/path/to/project", {
  channelId: "channel_...",
  status: "task_created",
  limit: 25,
});

await client.getGitHubExternalWorkCiTriage(
  "/path/to/project",
  "external_work_ci_triage_...",
);

const runStream = await client.startGitHubExternalWorkCiTriageRun(
  "/path/to/project",
  "external_work_ci_triage_...",
  {
    providerPresetId: "provider_...",
    tools: ["read", "grep", "bash", "edit"],
  },
);

await client.listExternalWork("/path/to/project", {
  channelId: "channel_...",
  schedulerStatus: "ready",
  limit: 50,
});

await client.getExternalWork("/path/to/project", "external_work_...");

await client.proposeExternalWorkAction("/path/to/project", {
  externalWorkId: "external_work_...",
  actionKind: "github_comment",
  payload: { type: "github_comment", body: "Proposed comment body" },
});

await client.proposeExternalWorkAction("/path/to/project", {
  externalWorkId: "external_work_...",
  actionKind: "github_pr_review",
  approvalRequirement: "strict",
  payload: {
    type: "github_pr_review",
    event: "REQUEST_CHANGES",
    body: "Please fix the failing CI before merge.",
  },
});

await client.listExternalWorkActions("/path/to/project", {
  externalWorkId: "external_work_...",
  status: "waiting_for_approval",
});

await client.getExternalWorkAction("/path/to/project", "external_work_action_...");

await client.cancelExternalWorkAction("/path/to/project", "external_work_action_...", {
  reason: "No longer needed",
});

await client.executeExternalWorkAction("/path/to/project", "external_work_action_...", {
  workflowPath: "WORKFLOW.md",
});

await client.reconcileExternalWork("/path/to/project", {
  channelId: "channel_...",
  workflowPath: "WORKFLOW.md",
});
```

The CLI exposes the same external-work surfaces:

```bash
ling-stack --cwd /path/to/project external-work github import \
  --channel channel_... \
  --event-type pull_request.opened \
  --payload-file examples/external-work/github/pull-request-opened.json \
  --workflow-path WORKFLOW.md

ling-stack --cwd /path/to/project external-work github poll \
  --channel channel_... \
  --workflow-path WORKFLOW.md \
  --limit 50

ling-stack --cwd /path/to/project external-work github background start \
  --channel channel_... \
  --workflow-path WORKFLOW.md \
  --limit 50

ling-stack --cwd /path/to/project external-work github background list

ling-stack --cwd /path/to/project external-work github background stop \
  external_work_background_...

ling-stack --cwd /path/to/project external-work linear import \
  --channel channel_... \
  --event-type issue.created \
  --payload-file issue.json \
  --workflow-path WORKFLOW.md

ling-stack --cwd /path/to/project external-work linear poll \
  --channel channel_... \
  --workflow-path WORKFLOW.md \
  --limit 50

ling-stack --cwd /path/to/project external-work github ci triage \
  --external-work external_work_... \
  --workflow-path WORKFLOW.md \
  --limit 5

ling-stack --cwd /path/to/project external-work github ci run \
  --triage external_work_ci_triage_... \
  --provider provider_...

ling-stack --cwd /path/to/project external-work list \
  --channel channel_... \
  --status ready

ling-stack --cwd /path/to/project external-work show external_work_...

ling-stack --cwd /path/to/project external-work actions propose-comment \
  --external-work external_work_... \
  --body-file comment.md \
  --approval standard

ling-stack --cwd /path/to/project external-work actions propose-labels \
  --external-work external_work_... \
  --label agent-ready \
  --label needs-review

ling-stack --cwd /path/to/project external-work actions propose-review \
  --external-work external_work_... \
  --event REQUEST_CHANGES \
  --body-file review.md

ling-stack --cwd /path/to/project external-work actions list \
  --external-work external_work_... \
  --status waiting_for_approval

ling-stack --cwd /path/to/project external-work actions show external_work_action_...

ling-stack --cwd /path/to/project external-work actions cancel external_work_action_... \
  --reason "No longer needed"

ling-stack --cwd /path/to/project external-work actions execute external_work_action_... \
  --workflow-path WORKFLOW.md

ling-stack --cwd /path/to/project external-work reconcile \
  --channel channel_... \
  --workflow-path WORKFLOW.md
```

`--workflow-markdown-file <path>` may be used instead of `--workflow-path` for inline
manual import tests. CI triage creates local fix tasks by default; use
`--no-create-task` to write only triage records and artifacts. `external-work github ci
run` is the explicit Phase 4.1 bridge from a triage record to the normal local runner.
The CLI and SDK only call local daemon endpoints. Action proposal creates local proposed
action and approval records only. Import, poll, background start/list/stop, CI triage,
list/show, action proposal/cancel, and reconcile do not start a runner. Only
`external-work github ci run` starts a local runner. Only `external-work actions execute`
can mutate GitHub, and only after approval and revalidation. PR review actions are
strict approval actions; the Web and CLI do not support edit-and-approve, so users
cancel and re-propose if the review event or body is wrong. Linear import and poll are
read-only Phase 7 surfaces and have no action execution path.

For a copy-pasteable temp workspace smoke, use
`examples/external-work/github/README.md`. That smoke copies the example `WORKFLOW.md`
into a temporary channel bound path, starts an isolated daemon on a non-default port,
creates a channel, imports the PR or issue fixture, reads evidence artifacts through
`/artifacts/:id/content`, runs an authenticated read-only poll/reconcile cycle, and
confirms the runner list stays empty.

For a real repository smoke, use `docs/external-work-live-smoke.md` or the helper:

```bash
corepack pnpm build
export GITHUB_TOKEN="$(gh auth token)"
node examples/external-work/github/live-readonly-smoke.mjs --repo owner/repo --limit 1
```

The helper uses live GitHub read endpoints, creates and cancels a local proposed action,
and verifies no runner starts. It never approves or executes the action, so it never
calls GitHub mutation APIs. The same doc contains the explicit optional mutation smoke
for disposable test PRs or issues.

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
GET /runtime/extensions?cwd=/path/to/project
```

`/state-transitions` returns persisted transition facts for `task`, `run`, `approval`, `media_job`, `workflow`, or `workflow_step`.

`/runtime/leases` returns active, released, or expired leases. Resource types are `channel`, `bound_path`, `workspace`, `provider`, `task`, and `workflow_step`.

`/runtime/extensions` returns safe internal extension metadata for diagnostics. It does
not report plugin lifecycle state, health checks, install actions, secrets, or dynamic
code paths. Product-managed plugin state remains under `/plugins`.

Response:

```json
{
  "cwd": "/path/to/project",
  "extensions": [
    {
      "id": "tool:write",
      "name": "Write",
      "version": "0.1.0",
      "kind": "tool",
      "trustLevel": "internal",
      "capabilities": ["filesystem:write"],
      "defaultApproval": "ask",
      "sideEffectLevel": "write"
    }
  ]
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

## MCP Servers And Tools

MCP server config stores transport metadata and secret refs. Runtime status is reported
through short-lived status snapshots, not by returning or mutating raw secret values.

### List MCP Servers

```http
GET /mcp/servers?cwd=/path/to/project
```

Response:

```json
{
  "servers": [
    {
      "id": "mcp_...",
      "workspaceId": "default",
      "displayName": "GitHub MCP",
      "enabled": true,
      "required": false,
      "transport": {
        "type": "streamable-http",
        "url": "http://127.0.0.1:3000/mcp",
        "headers": {
          "X-Client": "ling-stack"
        },
        "secretHeaderRefs": {
          "X-Api-Key": "keychain:MCP_REMOTE_API_KEY"
        }
      },
      "status": {
        "kind": "ready",
        "message": "MCP server is reachable.",
        "checkedAt": "2026-06-06T00:00:00.000Z"
      },
      "statusSnapshot": {
        "serverId": "mcp_...",
        "checkedAt": "2026-06-06T00:00:00.000Z",
        "expiresAt": "2026-06-06T00:05:00.000Z",
        "status": "ready",
        "toolCount": 3,
        "missingSecretRefs": [],
        "authStatus": {
          "kind": "configured",
          "refs": ["keychain:MCP_REMOTE_API_KEY"],
          "missingRefs": []
        }
      },
      "secretConfigured": {
        "X-Api-Key": true
      },
      "secretStatuses": [
        {
          "ref": "keychain:MCP_REMOTE_API_KEY",
          "kind": "keychain",
          "configured": true
        }
      ],
      "legacySecretMigrationRequired": false,
      "createdAt": "2026-06-06T00:00:00.000Z",
      "updatedAt": "2026-06-06T00:00:00.000Z"
    }
  ]
}
```

`secretStatuses` and `secretConfigured` are status-only metadata. They never include
resolved env, keychain, bearer-token, or header values.

### Create MCP Server

```http
POST /mcp/servers?cwd=/path/to/project
Content-Type: application/json
```

Stdio transport:

```json
{
  "displayName": "Local Filesystem MCP",
  "enabled": true,
  "required": false,
  "transport": {
    "type": "stdio",
    "command": "node",
    "args": ["server.js"],
    "env": {
      "NODE_ENV": "production"
    },
    "secretEnvRefs": {
      "GITHUB_TOKEN": "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN"
    }
  }
}
```

Streamable HTTP transport:

```json
{
  "displayName": "Remote MCP",
  "enabled": true,
  "transport": {
    "type": "streamable-http",
    "url": "http://127.0.0.1:3000/mcp",
    "headers": {
      "X-Client": "ling-stack"
    },
    "secretHeaderRefs": {
      "X-Api-Key": "keychain:MCP_REMOTE_API_KEY"
    },
    "bearerTokenRef": "env:MCP_BEARER_TOKEN"
  }
}
```

Raw `secrets`, `clearSecretNames`, persisted `status`, and legacy transport secret
fields are rejected for new writes. Use `secretEnvRefs`, `secretHeaderRefs`, and
`bearerTokenRef`. Use either `secretHeaderRefs.Authorization` or `bearerTokenRef`
for bearer auth; `bearerTokenRef` is the shorthand that produces
`Authorization: Bearer <value>`.

### Get, Update, Delete MCP Server

```http
GET /mcp/servers/:id?cwd=/path/to/project
PATCH /mcp/servers/:id?cwd=/path/to/project
DELETE /mcp/servers/:id?cwd=/path/to/project
```

`PATCH` accepts the same redacted config fields as create. It does not accept raw
secret values and does not write runtime status.

### Check MCP Server

```http
POST /mcp/servers/:id/check?cwd=/path/to/project
```

Response:

```json
{
  "server": {
    "id": "mcp_...",
    "displayName": "Remote MCP",
    "status": {
      "kind": "ready",
      "message": "MCP server is reachable.",
      "checkedAt": "2026-06-06T00:00:00.000Z"
    },
    "secretStatuses": [],
    "legacySecretMigrationRequired": false
  },
  "statusSnapshot": {
    "serverId": "mcp_...",
    "checkedAt": "2026-06-06T00:00:00.000Z",
    "expiresAt": "2026-06-06T00:05:00.000Z",
    "status": "ready",
    "protocolVersion": "2025-03-26",
    "toolCount": 3,
    "missingSecretRefs": [],
    "authStatus": {
      "kind": "configured",
      "refs": [],
      "missingRefs": []
    },
    "latencyMs": 32
  }
}
```

If required refs are missing, the daemon fails closed and returns a structured failed
snapshot with `errorCode` such as `mcp_secret_missing`; it still does not expose values.

### Get MCP Status Snapshot

```http
GET /mcp/servers/:id/status?cwd=/path/to/project
```

This endpoint reads the cached snapshot only. It does not open a live MCP connection,
sync tools, or repair config.

Response:

```json
{
  "server": {
    "id": "mcp_...",
    "displayName": "Remote MCP",
    "legacySecretMigrationRequired": false
  },
  "statusSnapshot": null
}
```

`statusSnapshot` is `null` when no snapshot exists. Expired snapshots may be returned
with `status: "expired"` and a remediation message.

### Sync MCP Tools

```http
POST /mcp/servers/:id/sync-tools?cwd=/path/to/project
```

Response:

```json
{
  "server": {
    "id": "mcp_...",
    "displayName": "Remote MCP"
  },
  "statusSnapshot": {
    "serverId": "mcp_...",
    "checkedAt": "2026-06-06T00:00:00.000Z",
    "expiresAt": "2026-06-06T00:05:00.000Z",
    "status": "ready",
    "toolCount": 3,
    "missingSecretRefs": [],
    "authStatus": {
      "kind": "configured",
      "refs": [],
      "missingRefs": []
    }
  },
  "tools": [
    {
      "id": "mcp_tool_...",
      "serverId": "mcp_...",
      "rawName": "search",
      "displayName": "search",
      "callableNamespace": "mcp",
      "callableName": "search",
      "sideEffectLevel": "read",
      "defaultApproval": "allow",
      "enabled": true
    }
  ]
}
```

Tool sync persists the tool catalog after successful listing and persists a redacted
status snapshot for the attempted check/list operation.

### List MCP Tools

```http
GET /mcp/tools?cwd=/path/to/project&serverId=mcp_...
```

Response:

```json
{
  "tools": []
}
```

### Removed MCP Secret Read

```http
GET /mcp/servers/:id/secret?cwd=/path/to/project&name=Authorization
```

Response:

```json
{
  "error": "mcp_secret_endpoint_removed",
  "message": "MCP secret values are not readable. Use secret refs and /secrets/status."
}
```

The route returns HTTP `410 Gone`. Clients that need secret readiness should use
`GET /secrets/status`.

## Secrets

### Get Secret Status

```http
GET /secrets/status?ref=env%3AOPENAI_API_KEY&purpose=provider_api_key
```

`purpose` is optional. Supported values are `provider_api_key`, `github_token`, `linear_token`, `webhook_secret`, `custom_header`, and `automation_token`.

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
