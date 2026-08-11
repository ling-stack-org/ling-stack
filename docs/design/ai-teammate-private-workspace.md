# Helio-Inspired AI Teammate Private Workspace

Status: Implemented durable private workspace, private data lifecycle, chat/settings IA split, and standard tool execution parity
Date: 2026-06-04
Updated: 2026-07-13
Scope: Web UI, daemon API, workspace storage, API client, docs, and e2e coverage

## Summary

Ling Stack should turn AI teammates from local UI drafts and sidebar presence into
durable workspace members with private conversations, inspectable work, scoped settings,
and explicit safety boundaries.

The Helio reference is useful for the interaction pattern: a selected AI teammate should
feel like a reachable workspace member with private conversation, profile, and scoped
configuration. Ling Stack adapts that pattern without copying a tab-heavy profile model:
clicking a teammate opens a pure private chat, while configuration lives behind a
separate single-agent settings page. The Ling Stack version must stay local-first,
auditable, provider-aware, and governed by tools, approval policy, and state machines.

This document is the design, engineering landing plan, and implementation record for
the first durable AI teammate private workspace slice.

## Current State

Implemented before this slice:

- `gstack-default` provides built-in teammate templates and skills in `packages/core`.
- Web has an `AI Teammates` management page with role, model, profile, and channel steps.
- The sidebar has distinct active targets for workspace, tasks, channels, teammates, and
  direct messages.
- Channel ConversationItems can mention AI teammates and request a supervised no-tools reply.
- Channels and tasks can reference `defaultTeammateId` and `assigneeTeammateId`.

Implemented in this slice:

- durable AI teammate instances in SQLite,
- deterministic seeded built-in teammates from `gstack-default`,
- legacy template id migration for `defaultTeammateId` and `assigneeTeammateId`,
- durable private teammate threads and message history,
- persisted teammate identity, provider, status, pin, hide, system prompt, tools, and
  approval profile settings,
- persisted teammate channel memberships, skill bindings, and default memory scope metadata,
- daemon teammate CRUD, direct message, task read-model, and activity read-model APIs,
- API client and Web API wrappers for the teammate routes,
- sidebar roster rows backed by daemon teammates,
- `teammate:<id>` private workspace route that opens a private chat first,
- single-agent settings page for Profile, Model, Permissions, Channels, Skills, Memory,
  MCP, and Danger Zone,
- streaming private replies over SSE with durable pending AI message updates,
- private teammate attachments and profile avatar uploads,
- hard delete for teammate private data with minimal retention tombstones,
- skill registry import drafts, publish-to-registry, bind, disable, archive, and
  Effective Skill blocked-reason controls inside the Skills settings section,
- persona import draft preview and apply controls inside Settings,
- teammate workspace task creation with `requestedSkillId`,
- built-in Development Council membership and channel council attachment by reference,
  without copying council members into direct channel memberships or changing teammate
  permissions.

Still deferred:

- broader skill editing beyond the import draft/publish/archive flow,
- skill-aware task/run controls outside the teammate private workspace,
- memory content review and management controls inside the single-agent settings page,
- optional vector retrieval provider installation and hidden ingestion,
- multi-party direct messages,
- broad browser e2e coverage beyond the focused durable workspace flows.

Approved correction, 2026-07-12:

- teammate private chat is not permanently discussion-only;
- the current runtime path still hardcodes `tools: []`, which is an implementation gap;
- the target path resolves the selected teammate's provider, runner, effective tools,
  skills, MCP authorization, direct workspace, composer permission snapshot, and approval
  policy;
- private execution stays single-agent and uses the shared WorkCell, approval, artifact,
  and TerminalReport components;
- private and normal-conversation TerminalReports do not render Participants.

The broader platform direction lives in [Ling Framework](ling-framework.md). The target
memory design for private, channel, shared, and task/run recall lives in
[Ling Memory v1](ling-memory-v1.md). The target skill import, persona draft, Effective
Skill, and skill-aware run model lives in [Skill Import Productization](./skill-import-productization.md).
The council grouping model for built-in and custom teammate rosters lives in
[AI Councils](ai-councils.md). The first daemon/core slice is implemented for the
built-in Development Council, channel reference attachments, effective channel specialist
projection, and restrict-only governance boundaries.
The routing model for teammate-private and channel-scoped governance notifications lives
in [Channel And Agent Governance Notifications](channel-and-agent-governance-notifications.md).
The shared Codex-style conversation, evidence folding, right drawer, and component
extraction direction lives in
[Conversation Surface Contract](./conversation-surface-contract.md) and
[Conversation Surface Contract](./conversation-surface-contract.md).
The approved shared UI, rich content, latest-message editing, and private execution
correction lives in [Conversation Shared Capabilities](conversation-shared-capabilities.md)
and [Conversation Shared Capabilities Detailed Design](conversation-shared-capabilities-detailed-design.md).
The boundary between teammate private chat, channel root messages, channel branches, topic
replies, and future session views lives in
[Conversation Surface Taxonomy](conversation-surface-taxonomy.md).

## Product Principles

1. AI teammates are workspace members, not decorative model presets.
2. Private chat supports clarification, planning, and single-agent execution. Side
   effects still move through supervised runs, approvals, and workspace state machines;
   chat text, persona, and skill prose cannot bypass those authorities.
3. Every surface or settings section must be backed by real state or clearly be out of
   scope. Avoid empty product-shaped panels that imply unsupported behavior.
4. Each AI teammate has isolated always-on memory. Channel membership provisions that
   teammate's own channel memory, but private chats, files, and other teammates' memory
   must not leak across scopes by default.
5. Provider readiness is part of teammate identity. A teammate with no working provider
   should show a blocked state before the user starts a conversation.
6. Built-in teammate templates remain stable role templates. Workspace teammate
   instances are user-configurable members created from those templates.

## Reference Pattern Translation

The Helio reference contributes these useful patterns:

- left sidebar roster with channels, AI teammates, and private messages,
- selected teammate header with avatar, display name, and model identity,
- a focused private chat surface with a direct settings entry,
- chat composer at the bottom of the primary conversation page,
- settings page with identity, model, permissions, skill execution, channel subscription,
  memory, MCP, and danger zone.

Ling Stack should not copy these parts:

- billing or trial status surfaces,
- generic calendar/file tabs before Ling Stack has backing event/file models,
- management pages that imply cloud identity, email, or organization membership,
- AI actions that bypass local approval policy.

## UX Contract

### Sidebar

- `AI Teammates` remains the management entry.
- Each active teammate instance appears in the AI teammates roster.
- Hidden teammates collapse behind the existing hidden row.
- Pinned teammates appear before unpinned teammates.
- Selecting a teammate sets `activeSidebarTarget = teammate:<teammateId>` and opens the
  teammate private workspace.
- Sidebar active state remains exclusive across workspace, tasks, channels, teammates,
  direct messages, providers, approvals, and settings.

### Teammate Private Chat Shell

The selected teammate workspace uses a compact client surface:

```text
avatar + display name + AI badge + provider/model status
private chat transcript + composer
right-side conversation context: summary, private attachments, recent Used Memory
settings button -> single-agent settings page
```

The private chat shell must not display configuration tabs. It only shows the durable
private conversation, private attachment chips, streaming reply state, Used Memory shown
beside the AI message, and a light conversation-context rail.

### Single-Agent Settings Page

Purpose: configure one durable teammate without mixing setup controls into the chat.

Layout:

```text
back to private chat + teammate settings header
left settings navigation: Profile, Model, Permissions, Channels, Skills, Memory, MCP, Danger
main section content
right configuration summary + import guidance
```

Settings sections:

- Profile: avatar upload/removal, persona draft import, display name, status, pinned,
  hidden, description, and system prompt.
- Model: provider preset selection, provider readiness, model workbench shortcut.
- Permissions: approval profile, allowed tools, and explicit persona boundary copy.
- Channels: channel memberships and default teammate controls.
- Skills: Effective Skill list, import draft, bind/disable/archive, blocked reasons.
- Memory: visible always-on memory scopes, review controls, and optional vector retrieval
  status. The surface must not include a disable/off control.
- MCP: explicit per-agent MCP authorization.
- Danger: soft disable and hard delete private data.

### Private Chat Page

Purpose: private human-to-teammate discussion.

Behavior:

- shows durable private messages for the selected teammate,
- supports user messages, private attachments, and streamed AI replies,
- uses the selected teammate provider preset by default,
- shows blocked reply cards when provider preflight fails,
- does not include channel files, channel history, or private memory unless explicitly
  selected by a future permission model,
- provides a direct action to create a task from a message,
- may run tools or mutate files when the selected teammate, direct workspace, effective
  tool set, runner, provider, skill/MCP bindings, composer authorization snapshot, and
  approval policy permit execution,
- remains single-agent and never invites other teammates into the private run,
- renders private execution through the shared operation, approval, artifact, WorkCell,
  and TerminalReport components,
- omits TerminalReport Participants while preserving participant data in audit records
  when present.

MVP composer:

- multiline text input,
- send button,
- private attachment upload chips,
- blocked/failed status,
- pending AI bubble with incremental streamed text.

Visual treatment:

- Web uses the same strict platform-console surface model as the rest of the Web shell.
- Private chat uses the same shared `MessageComposer` shell as channel chat: a rounded
  composer panel, large multiline drop zone, left tool row, and compact icon send
  action. Private chat can expose a smaller tool set than channel chat, but the
  spacing, border, focus, and preview-strip treatment should stay shared.
- Private chat and single-agent settings must not override the shared left navigation
  drawer width, toolbar, or collapse behavior. Teammate pages adapt inside the workspace
  area so switching between channel, private chat, and teammate settings does not resize
  the drawer.
- In dark mode, the private chat header, empty chat state, message rows, and
  composer stay on near-black semantic tokens instead of legacy glass or translucent
  light panels.
- Skills settings section add rows, enabled skill rows, and phase tokens follow the same strict
  console dark/light tokens; no legacy pale green, gray, beige, or glass panels should
  appear in dark mode.
- The send button remains a compact primary action and must not stretch into a tall
  high-contrast column beside the textarea.
- Conversation message rows should converge toward a shared message/feed component after
  the channel feed's richer states (mentions, attachments, link previews, used memory,
  task actions, streamed private replies) are normalized behind common props.

### Tasks Surface

Purpose: show work assigned to this teammate.

Behavior:

- filters tasks where `assigneeTeammateId` equals the selected teammate id,
- groups by status with compact counts,
- opens the existing task detail/run flow,
- creates a task with this teammate preselected as assignee,
- shows current run, approval, or blocked state when available.

### Activity Surface

Purpose: show teammate-relevant work history.

Sources:

- private messages and replies,
- tasks assigned to the teammate,
- runs where `teammateId` equals the selected teammate id,
- approvals waiting on runs started by this teammate,
- channel messages that mention the teammate.

The activity surface is read-only in the first slice. Mutations happen through the source
surface: chat, task detail, approvals, or channel.

### Channels Settings Section

Purpose: manage where the teammate participates.

Behavior:

- lists channel memberships,
- shows whether the teammate is the channel default teammate,
- allows adding/removing memberships,
- allows setting the teammate as channel default when the user has selected a channel,
- warns when the channel allowed tools are stricter than the teammate default tools.

Private chat should not automatically gain access to channel history just because a
teammate belongs to that channel.

### Skills Settings Section

Purpose: inspect teammate skill bindings, import reviewed skills, and explain whether a
skill is executable for this teammate.

Behavior:

- lists the built-in skill library, workspace custom skills, imported skill drafts, and
  any unknown durable bindings,
- shows workflow phase, required tools, provider capabilities, and approval profile,
- shows binding source, binding state, executable state, and blocked reasons,
- lets the user import a skill pack or compatible skill directory as a reviewed draft,
- lets the user publish reviewed custom skill definitions into the workspace registry,
- lets the user bind or disable a skill for the selected teammate,
- lets the user manually add a custom skill binding by id, repo shorthand, or URL,
- lets the user delete manually added `source: "user"` bindings,
- does not expose deletion for template-default `source: "template"` bindings,
- saves through `PUT /teammates/:id/skills`,
- treats disabled bindings as metadata, not as execution permission changes by
  themselves.

Skills are workflow templates. They do not grant execution authority by themselves. The
The Skills settings section should use the daemon's Effective Skill read model instead of implying that
"enabled" equals "allowed to run".

### Memory Settings Section

Purpose: make teammate context boundaries visible.

MVP behavior:

- shows always-on default memory scopes as metadata records,
- supports channel brief, channel decisions, prior private chat summary, and private
  notes as scope types,
- does not implement vector memory, automatic recall, or hidden ingestion,
- does not feed memory into private chat until the prompt builder has an explicit
  inclusion decision.

The memory settings section is primarily a trust surface in the first slice.

### Profile Settings Section

Purpose: edit durable teammate instance settings.

Fields:

- display name,
- description,
- avatar tone or image upload,
- persona import from `AGENTS.md`, `AGENT.md`, `persona.md`, or pasted markdown as a
  reviewed draft,
- template id,
- role key,
- provider preset,
- system prompt override or append-only prompt fragment,
- allowed tools override,
- approval profile override,
- pinned,
- hidden,
- status: active, paused, disabled.

Danger zone:

- `Disable teammate` should hide the teammate from active surfaces but preserve history.
- `Hard delete teammate` physically deletes teammate private data and attachment bytes,
  then leaves only a minimal tombstone audit record.

Persona import must only update selected profile fields after user confirmation. Imported
persona text cannot update tools, MCP bindings, approvals, provider settings, memory
scopes, channel memberships, secrets, or external-send permission.

## Information Architecture

```text
Workspace shell
  Sidebar
    AI Teammates page
    teammate:<id> private workspace
    direct:<id> human/private conversations

Teammate private workspace
  Private Chat
    Conversation transcript
    Composer
    Conversation Context rail
  Single-Agent Settings
    Profile
    Model
    Permissions
    Channels
    Skills
    Memory
    MCP
    Danger Zone
```

`teammate:<id>` and `direct:<id>` remain separate sidebar targets. A teammate private
workspace is a workspace member surface. A direct message can later represent a human or
multi-party private conversation.

## Domain Model

### TypeScript Shapes

```ts
export type AiTeammateStatus = "active" | "paused" | "disabled";

export interface AiTeammate {
  readonly id: string;
  readonly workspaceId: string;
  readonly templateId?: string;
  readonly roleKey: string;
  readonly displayName: string;
  readonly description: string;
  readonly avatarTone?: string;
  readonly avatarImageAttachmentId?: string;
  readonly providerPresetId?: string;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt: readonly string[];
  readonly allowedTools: readonly RunTool[];
  readonly approvalProfile: SkillApprovalProfile;
  readonly status: AiTeammateStatus;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TeammateChannelMembership {
  readonly teammateId: string;
  readonly channelId: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TeammateSkillBinding {
  readonly teammateId: string;
  readonly skillId: string;
  readonly source: "template" | "user";
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TeammateMemoryScopeKind =
  | "channel-brief"
  | "channel-decisions"
  | "private-chat-summary"
  | "private-notes";

export interface TeammateMemoryScope {
  readonly id: string;
  readonly teammateId: string;
  readonly kind: TeammateMemoryScopeKind;
  readonly channelId?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TeammateDirectThread {
  readonly id: string;
  readonly workspaceId: string;
  readonly teammateId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TeammateDirectMessageStatus = "pending" | "ready" | "blocked" | "failed";

export interface TeammateDirectMessage {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly teammateId: string;
  readonly authorType: "local-user" | "ai-teammate" | "system";
  readonly authorId?: string;
  readonly body: string;
  readonly attachmentIds: readonly string[];
  readonly status: TeammateDirectMessageStatus;
  readonly errorMessage?: string;
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TeammatePrivateAttachmentScope =
  | "teammate_direct_thread"
  | "teammate_profile_avatar";

export interface TeammatePrivateAttachment {
  readonly id: string;
  readonly workspaceId: string;
  readonly teammateId: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly scope: TeammatePrivateAttachmentScope;
  readonly kind: "image" | "document" | "text" | "spreadsheet" | "presentation" | "other";
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly path: string;
  readonly createdAt: string;
}

export interface RetentionTombstone {
  readonly id: string;
  readonly workspaceId: string;
  readonly entityType: "ai-teammate";
  readonly entityId: string;
  readonly reason?: string;
  readonly deletedCounts: Readonly<Record<string, number>>;
  readonly createdAt: string;
}
```

### SQLite Tables

First migration:

```sql
CREATE TABLE ai_teammates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  template_id TEXT,
  role_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  avatar_tone TEXT,
  avatar_image_attachment_id TEXT,
  provider_preset_id TEXT,
  system_prompt TEXT,
  append_system_prompt_json TEXT NOT NULL,
  allowed_tools_json TEXT NOT NULL,
  approval_profile_json TEXT NOT NULL,
  status TEXT NOT NULL,
  pinned INTEGER NOT NULL,
  hidden INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_ai_teammates_workspace_status
  ON ai_teammates(workspace_id, status, hidden, pinned);

CREATE TABLE teammate_channel_memberships (
  teammate_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  is_default INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(teammate_id, channel_id),
  FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE,
  FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE INDEX idx_teammate_channel_memberships_channel
  ON teammate_channel_memberships(channel_id);

CREATE TABLE teammate_skill_bindings (
  teammate_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  source TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(teammate_id, skill_id),
  FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE
);

CREATE TABLE teammate_memory_scopes (
  id TEXT PRIMARY KEY,
  teammate_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  channel_id TEXT,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE,
  FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE INDEX idx_teammate_memory_scopes_teammate
  ON teammate_memory_scopes(teammate_id, enabled);

CREATE TABLE teammate_direct_threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  teammate_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_teammate_direct_threads_teammate
  ON teammate_direct_threads(workspace_id, teammate_id);

CREATE TABLE teammate_direct_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  teammate_id TEXT NOT NULL,
  author_type TEXT NOT NULL,
  author_id TEXT,
  body TEXT NOT NULL,
  attachment_ids_json TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  linked_task_id TEXT,
  linked_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY(thread_id) REFERENCES teammate_direct_threads(id) ON DELETE CASCADE,
  FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE
);

CREATE INDEX idx_teammate_direct_messages_thread_created
  ON teammate_direct_messages(thread_id, created_at);

CREATE TABLE teammate_private_attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  teammate_id TEXT NOT NULL,
  thread_id TEXT,
  message_id TEXT,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_teammate_private_attachments_owner
  ON teammate_private_attachments(teammate_id, scope, created_at);

CREATE TABLE retention_tombstones (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  reason TEXT,
  deleted_counts_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### Seeding Strategy

Workspace bootstrap now seeds active workspace teammate instances from `gstack-default`
templates.

Reasons:

- the sidebar can show real teammate rows without requiring the user to recreate default
  roles,
- built-in templates remain immutable while workspace instances can be renamed, hidden,
  paused, or rebound to providers,
- `assigneeTeammateId`, private chat, and settings can all reference stable workspace
  teammate ids.

Seed ids are deterministic per built-in template, for example
`teammate_builtin_engineer`. Bootstrap is idempotent; existing records are not recreated,
and missing template skill bindings are repaired. Legacy channel/task references such as
`engineer` are migrated to their seeded teammate ids.

## Daemon API Contract

All endpoints accept `cwd` and resolve the workspace store in the same way as channel and
task APIs.

### Teammates

```http
GET /teammates?cwd=/path/to/workspace
POST /teammates?cwd=/path/to/workspace
GET /teammates/:id?cwd=/path/to/workspace
PATCH /teammates/:id?cwd=/path/to/workspace
DELETE /teammates/:id?cwd=/path/to/workspace
POST /teammates/:id/hard-delete?cwd=/path/to/workspace
```

`DELETE` soft-disables:

```json
{
  "status": "disabled",
  "hidden": true
}
```

`POST /hard-delete` physically deletes teammate private data and returns a minimal
tombstone. It deletes private thread/messages, private attachments and avatar bytes,
teammate-scope memory, related used-memory events, and private teammate bindings. It does
not cascade-delete channel messages, tasks, or run history.

```json
{
  "reason": "owner request"
}
```

```json
{
  "tombstone": {
    "id": "tomb_...",
    "entityType": "ai-teammate",
    "entityId": "teammate_...",
    "reason": "owner request",
    "deletedCounts": {
      "directMessages": 12,
      "privateAttachments": 2,
      "memoryObjects": 3
    },
    "createdAt": "2026-06-04T00:00:00.000Z"
  }
}
```

### Channel Memberships

```http
GET /teammates/:id/channels?cwd=/path/to/workspace
PUT /teammates/:id/channels?cwd=/path/to/workspace
```

The `PUT` request replaces memberships for that teammate. Setting `isDefault` updates the
matching channel's `defaultTeammateId` through the channel update path, not by writing
around channel state.

### Skills

```http
GET /teammates/:id/skills?cwd=/path/to/workspace
PUT /teammates/:id/skills?cwd=/path/to/workspace
```

`GET` returns persisted bindings and, when available, Effective Skill diagnostics.
`PUT` replaces persisted bindings. The next skill slice should add workspace registry
APIs for custom skill definitions and import drafts; teammate binding remains separate
from registry publication.

### Memory Scopes

```http
GET /teammates/:id/memory-scopes?cwd=/path/to/workspace
PUT /teammates/:id/memory-scopes?cwd=/path/to/workspace
```

Memory scopes are default teammate capabilities, not user-toggleable setup choices. Every
AI teammate has `private-chat-summary` and `private-notes`; each channel membership adds
that teammate's own `channel-brief` and `channel-decisions` scopes for that channel. The
memory panel may let users inspect, review, or prune memory content, but it must not expose
an off switch. `enabled:false` is rejected for compatibility clients that still send the
field, and Ling Agent memory scopes are protected.

### Private Thread And Messages

```http
GET /teammates/:id/direct-thread?cwd=/path/to/workspace
GET /teammates/:id/direct-messages?cwd=/path/to/workspace&limit=100
POST /teammates/:id/direct-messages?cwd=/path/to/workspace
POST /teammates/:id/direct-messages/stream?cwd=/path/to/workspace
```

Request:

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
  "message": { "id": "msg_...", "authorType": "local-user", "status": "ready" },
  "aiReply": { "id": "msg_...", "authorType": "ai-teammate", "status": "ready" }
}
```

The streaming endpoint uses the same request body, persists the local-user message first,
creates a pending AI message, then emits `ready`, `delta`, `done`, `blocked`, or `error`
SSE events while updating the same durable AI message.

### Private Attachments And Avatar

```http
GET /teammates/:id/direct-attachments?cwd=/path/to/workspace&limit=100
POST /teammates/:id/direct-attachments?cwd=/path/to/workspace
POST /teammates/:id/avatar?cwd=/path/to/workspace
DELETE /teammates/:id/avatar?cwd=/path/to/workspace
GET /attachments/:id/content?cwd=/path/to/workspace
DELETE /attachments/:id?cwd=/path/to/workspace
```

Private attachment scopes:

- `teammate_direct_thread` for private chat attachments.
- `teammate_profile_avatar` for avatar images.

Private message `attachmentIds` must belong to the selected teammate's private thread and
are capped at 10 ids. `PATCH /teammates/:id` may reference only avatar-scope attachments
owned by the same teammate. Attachments are not automatically ingested into memory or
given to AI; future inclusion must be explicit and auditable.

### Teammate Read Models

```http
GET /teammates/:id/tasks?cwd=/path/to/workspace
GET /teammates/:id/activity?cwd=/path/to/workspace
```

These endpoints are read-only composition endpoints. They should reuse existing task,
run, approval, Channel `conversation_items`, and teammate-private message stores rather
than introducing duplicate durable state.

## AI Reply And Execution Flow

1. Validate teammate exists and is `active`.
2. Validate the direct thread exists or create it.
3. Persist the local-user message.
4. If `requestAiReply` is false, return the message.
5. Resolve provider preset from request override or teammate default.
6. Resolve the direct-thread workspace binding and execution cwd.
7. Resolve the effective runner, tools, skills, MCP authorization, composer permission
   snapshot, and approval policy.
8. Require provider and runner preflight success.
9. Build the private teammate prompt:
   - teammate display name,
   - role/template summary,
   - teammate description,
   - system prompt and append fragments,
   - recent private messages,
   - effective skills and allowed capability context,
   - no channel or file content by default.
10. Create a pending AI reply record.
11. For a conversational response, run without unnecessary tools but keep the effective
    policy available.
12. For an executable response, create a supervised work unit/run, link it to the private
    reply, and invoke the runner with the effective tool set.
13. For streaming calls, append deltas and structured runtime events to the owning
    pending reply/run.
14. Route approval requests through the shared approval protocol.
15. Persist the AI reply with `ready`, `blocked`, or `failed` and commit a TerminalReport
    for executed work.
16. Return the linked message/run records, or close the SSE stream after terminal state.

Current implementation note: the direct-reply path still resolves and invokes the runner
with `tools: []`. The shared-capability implementation replaces that hardcoded boundary
with effective execution resolution. Plain discussion may remain message-only; executed
work must create/link durable run evidence.

## Frontend Architecture

New feature modules:

```text
apps/web/src/features/teammates/
  AiTeammatesPage.tsx
  TeammateWorkspace.tsx
  types.ts
```

Routing changes:

- keep `activeSidebarTarget` as the source of sidebar truth,
- map `teammate:<id>` to `TeammateWorkspace`,
- keep `activeView = "teammates"` for the management page only,
- preserve the existing channel and direct-message targets.

Implemented state changes:

- replaced `localTeammates` as the main source for sidebar teammates with daemon-backed
  `teammates`,
- kept the wizard as draft input only until the user saves,
- after save, create a durable teammate and refresh the roster,
- adapted the local draft shape into `CreateAiTeammateRequest` plus membership, skill,
  and default memory-scope provisioning.

Implemented API client changes:

- added typed methods for teammate CRUD,
- added typed methods for direct messages,
- added streaming private reply support,
- added private attachment and avatar upload methods,
- added hard delete support,
- added typed read models for tasks and activity,
- expose blocked provider errors without throwing away the persisted message.

Visual constraints:

- match the existing dense client shell,
- use settings navigation and icon buttons consistently with the channel workspace,
- avoid nested cards inside cards,
- do not add a marketing hero or decorative gradients,
- keep the chat composer stable at the bottom of the private chat page,
- keep settings forms narrow enough for comfortable desktop editing.

## Engineering Landing Plan

### Slice 1: Domain Contracts And Storage

Files:

- `packages/core/src/workspace-types.ts`
- `packages/contracts/src/index.ts`
- `packages/core/src/storage/sqlite-run-store.ts`
- `packages/core/test/channel-runtime-store.test.mjs` or a new teammate store test

Status: implemented.

Work:

- [x] add teammate, membership, skill binding, memory scope, thread, and message types,
- [x] add SQLite migration,
- [x] add mapping helpers and validation,
- [x] seed built-in teammate instances at workspace bootstrap,
- [x] migrate legacy template references to seeded teammate ids,
- [x] add CRUD/list methods to the run store,
- [x] add focused storage tests for migration, bootstrap idempotency, private message
  ordering, and channel membership writes.

### Slice 2: Daemon API

Files:

- `packages/daemon/src/index.ts`
- `packages/daemon/test/*.test.mjs`
- `docs/daemon-api.md`

Status: implemented.

Work:

- [x] add teammate CRUD routes,
- [x] add direct thread and direct message routes,
- [x] add read model routes for tasks and activity,
- [x] implement no-tools private AI reply,
- [x] persist blocked replies when provider resolution or teammate status fails,
- [x] update daemon API docs,
- [x] test blocked provider path.

### Slice 3: API Client And Web State

Files:

- `packages/api-client/src/client.ts`
- `apps/web/src/api.ts`
- `apps/web/src/types.ts`
- `apps/web/src/app/AppShell.tsx`

Status: implemented.

Work:

- [x] add typed client methods,
- [x] load teammate roster with channels/tasks/providers,
- [x] replace local teammate sidebar source with daemon-backed teammates,
- [x] preserve `activeSidebarTarget` exclusivity,
- [x] open `teammate:<id>` into a real workspace route,
- [x] keep the create wizard as a draft until save.

### Slice 4: Teammate Workspace UI

Files:

- `apps/web/src/features/teammates/*`
- `apps/web/src/styles/components.css`
- `apps/web/src/styles/teammates.css` if split later
- `apps/web/src/i18n.tsx`

Status: implemented with private chat, single-agent settings, task creation, channel
membership management, skill import, persona import UI, and hard delete. Broader
skill-aware task/run polish and memory editing remain deferred.

Work:

- [x] create `TeammateWorkspace`,
- [x] implement private chat plus single-agent settings sections for Profile, Model,
  Permissions, Channels, Skills, Memory, MCP, and Danger Zone,
- [x] wire chat send and blocked reply states,
- [x] wire settings save, hide, pin, pause, and disable,
- [x] wire task creation with the selected teammate prefilled,
- [x] show provider readiness in the header,
- [x] add Chinese and English translation keys.

### Slice 5: Verification And Documentation

Commands:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web exec playwright test
corepack pnpm typecheck
git diff --check
```

Status: updated with this implementation record.

Docs:

- [x] update `docs/daemon-api.md`,
- [x] update `docs/design/ai-teammates-and-skills.md`,
- [x] update `docs/design/ui2.0升级/00-UI2.0整体升级方案.md`,
- [x] update `README.md` current status.

### Slice 6: Private Data Lifecycle

Files:

- `packages/core/src/workspace-types.ts`
- `packages/core/src/storage/sqlite-run-store.ts`
- `packages/daemon/src/index.ts`
- `packages/api-client/src/client.ts`
- `apps/web/src/features/teammates/TeammateWorkspace.tsx`
- `apps/web/src/styles/teammates.css`
- `docs/daemon-api.md`

Status: implemented.

Work:

- [x] add `POST /teammates/:id/direct-messages/stream`,
- [x] stream `ready`, `delta`, `done`, `blocked`, and `error` events,
- [x] persist pending AI replies and update the same message on deltas,
- [x] add private attachment storage with `teammate_direct_thread` and
  `teammate_profile_avatar` scopes,
- [x] validate direct message attachment ids are same-teammate private attachments,
- [x] support avatar upload, replacement, and removal,
- [x] keep `DELETE /teammates/:id` as soft disable,
- [x] add `POST /teammates/:id/hard-delete`,
- [x] delete teammate private data and file bytes while preserving only minimal tombstone
  metadata.

## Acceptance Criteria

- [x] Selecting an AI teammate from the sidebar opens a real private workspace, not a
  placeholder.
- [x] Sidebar active state stays exclusive across channels, teammates, direct messages, and
  global pages.
- [x] Default built-in teammates are durable workspace instances after bootstrap.
- [x] Creating a custom teammate persists after page refresh and daemon restart.
- [x] Private chat message history persists after page refresh and daemon restart.
- [x] Private chat can show streamed AI replies from one durable pending AI bubble.
- [x] Private chat can attach private files without exposing channel attachments.
- [x] AI replies in private chat use the teammate's selected provider when one is ready.
- [x] Provider failures create a visible blocked reply record.
- [x] Private chat can execute real Read/Edit/Shell/Check operations under effective
  teammate and workspace policy.
- [x] Private executed work renders the shared WorkCell, approval state, artifacts, and
  TerminalReport without Participants.
- [x] Private chat does not include channel messages, files, or memory unless a future scope
  decision explicitly adds them.
- [x] The teammate task surface only shows tasks assigned to the selected teammate.
- [x] The Channels settings section can add/remove membership and set the channel default teammate through
  channel update logic.
- [x] The Skills settings section accurately shows template skill requirements and approval profiles.
- [x] The Profile and Danger settings sections can rename, pause, hide, pin, and soft-disable a teammate.
- [x] The Profile settings section can upload/remove an avatar image.
- [x] Hard delete removes teammate private data and leaves a minimal tombstone audit record.
- [x] E2E covers selecting teammate, sending private chat, creating teammate-assigned tasks,
  editing channel membership/defaults, blocked provider state, settings persistence, and
  returning to channel workspace.

## Risks And Controls

| Risk | Control |
| --- | --- |
| UI looks complete while backing state is missing | Only ship surfaces/sections with real read models or explicit metadata-only behavior |
| Private chat leaks channel context | Prompt builder includes private thread only by default |
| Built-in template ids conflict with custom teammate ids | Use deterministic `teammate_builtin_*` ids for seeded instances |
| Disabling a seeded teammate recreates it on bootstrap | Store disabled state and make bootstrap idempotent |
| Chat path bypasses approval policy | Private execution always creates/uses supervised run authority and immutable permission snapshots; prompt text cannot grant tools |
| Provider failure loses user message | Persist local message before provider resolution and create blocked reply |
| Migration breaks existing workspaces | Use additive tables and no destructive schema changes |
| Hard delete removes too much shared history | Delete only teammate private data; clear references in channel/task/run history |
| Tombstone leaks sensitive data | Store counts and ids only; do not retain body text, prompt, file names, persona text, or snippets |
| Private attachments are mistaken for AI-readable context | Treat them as user-provided metadata/downloads until explicit inclusion exists |

## Open Decisions

1. Should memory scopes affect prompt construction immediately? Recommendation: no. First
   make always-on scopes visible and reviewable; wire prompt inclusion in a later
   trust-reviewed slice.
2. Should Files and Calendar tabs exist now? Recommendation: no. Files can appear after
   richer private attachment or per-teammate artifact workflows exist. Calendar should wait for a
   scheduled task/event model.

Private execution authority is no longer an open decision. Plain discussion can remain a
message-only response; any tool execution must create/link durable run evidence.

## Implemented Delivery

The private workspace now includes:

- durable teammate instances seeded from built-in templates,
- private teammate thread and message persistence,
- private chat discussion plus standard supervised tool execution,
- private attachments and avatar upload,
- soft disable plus hard delete with minimal tombstone audit,
- single-agent settings sections for skills, channels, memory, MCP, model, profile, and danger backed by real data or metadata,
- effective teammate provider, runner, tool, skill, MCP, workspace, permission, and
  approval resolution,
- linked private runs projected through shared WorkCell and participant-free
  TerminalReport components,
- cancellation, approval resume, attachment materialization, edit/rerun, and real Web E2E
  coverage.

Calendar, custom skill-pack import, optional vector retrieval provider installation, and
multi-party direct messages remain deferred. The skill-focused slice is specified in
[Skill Import Productization](./skill-import-productization.md).
