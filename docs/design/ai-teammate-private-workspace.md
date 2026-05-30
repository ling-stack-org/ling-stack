# Helio-Inspired AI Teammate Private Workspace

Status: Implemented first durable slice; editing polish and broader e2e remain follow-ups
Date: 2026-05-29
Scope: Web UI, daemon API, workspace storage, API client, docs, and e2e coverage

## Summary

Ling Stack should turn AI teammates from local UI drafts and sidebar presence into
durable workspace members with private conversations, inspectable work, scoped settings,
and explicit safety boundaries.

The Helio reference is useful for the interaction pattern: a selected AI teammate opens a
profile-like workspace with tabs for chat, tasks, activity, channels, skills, memory, and
settings. Ling Stack should adapt that pattern without copying the product model. The
Ling Stack version must stay local-first, auditable, provider-aware, and governed by
tools, approval policy, and state machines.

This document is the design, engineering landing plan, and implementation record for
the first durable AI teammate private workspace slice.

## Current State

Implemented before this slice:

- `gstack-default` provides built-in teammate templates and skills in `packages/core`.
- Web has an `AI Teammates` management page with role, model, profile, and scope steps.
- The sidebar has distinct active targets for workspace, tasks, channels, teammates, and
  direct messages.
- Channel messages can mention AI teammates and request a no-tools AI reply.
- Channels and tasks can reference `defaultTeammateId` and `assigneeTeammateId`.

Implemented in this slice:

- durable AI teammate instances in SQLite,
- deterministic seeded built-in teammates from `gstack-default`,
- legacy template id migration for `defaultTeammateId` and `assigneeTeammateId`,
- durable private teammate threads and message history,
- persisted teammate identity, provider, status, pin, hide, system prompt, tools, and
  approval profile settings,
- persisted teammate channel memberships, skill bindings, and memory scope metadata,
- daemon teammate CRUD, direct message, task read-model, and activity read-model APIs,
- API client and Web API wrappers for the teammate routes,
- sidebar roster rows backed by daemon teammates,
- `teammate:<id>` private workspace route with Chat, Tasks, Activity, Channels, Skills,
  Memory, and Settings tabs.

Still deferred:

- skill and memory editing controls inside the private workspace tabs,
- private attachments and avatar uploads,
- vector memory, automatic memory recall, and hidden ingestion,
- streaming private replies,
- hard delete and retention policy,
- multi-party direct messages,
- broad browser e2e coverage beyond the focused durable workspace flows.

## Product Principles

1. AI teammates are workspace members, not decorative model presets.
2. Private chat is for clarification and planning. Side effects must move through tasks,
   runs, approvals, and channel/workspace state machines.
3. Every tab must be backed by real state or clearly be out of scope. Avoid empty
   product-shaped panels that imply unsupported behavior.
4. Channel context, files, memory, and private chat must not leak into each other by
   default.
5. Provider readiness is part of teammate identity. A teammate with no working provider
   should show a blocked state before the user starts a conversation.
6. Built-in teammate templates remain stable role templates. Workspace teammate
   instances are user-configurable members created from those templates.

## Reference Pattern Translation

The Helio reference contributes these useful patterns:

- left sidebar roster with channels, AI teammates, and private messages,
- selected teammate header with avatar, display name, and model identity,
- horizontal tabs for teammate-specific surfaces,
- chat composer at the bottom of the primary conversation tab,
- settings page with identity, model, channel subscription, and danger zone.

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

### Teammate Workspace Shell

The selected teammate workspace uses a compact client surface:

```text
avatar + display name + AI badge + provider/model status
Chat | Tasks | Activity | Channels | Skills | Memory | Settings
main tab surface
optional right context drawer when the tab has a selected record
```

The first implementation should avoid a separate persistent right panel unless the tab
already has a selected record. Empty space is better than noisy placeholder cards.

### Chat Tab

Purpose: private human-to-teammate discussion.

Behavior:

- shows durable private messages for the selected teammate,
- supports user messages and AI replies,
- uses the selected teammate provider preset by default,
- shows blocked reply cards when provider preflight fails,
- does not include channel files, channel history, or private memory unless explicitly
  selected by a future permission model,
- provides a direct action to create a task from a message,
- does not run tools or mutate files from chat.

MVP composer:

- multiline text input,
- send button,
- blocked/failed status,
- no attachments until private attachment scope is designed.

Visual treatment:

- Web uses the same strict platform-console surface model as the rest of the Web shell.
- In dark mode, the private workspace hero, tabs, empty chat state, message rows, and
  composer stay on near-black semantic tokens instead of legacy glass or translucent
  light panels.
- Skills tab add rows, enabled skill rows, and phase tokens follow the same strict
  console dark/light tokens; no legacy pale green, gray, beige, or glass panels should
  appear in dark mode.
- The send button remains a compact primary action and must not stretch into a tall
  high-contrast column beside the textarea.

### Tasks Tab

Purpose: show work assigned to this teammate.

Behavior:

- filters tasks where `assigneeTeammateId` equals the selected teammate id,
- groups by status with compact counts,
- opens the existing task detail/run flow,
- creates a task with this teammate preselected as assignee,
- shows current run, approval, or blocked state when available.

### Activity Tab

Purpose: show teammate-relevant work history.

Sources:

- private messages and replies,
- tasks assigned to the teammate,
- runs where `teammateId` equals the selected teammate id,
- approvals waiting on runs started by this teammate,
- channel messages that mention the teammate.

The activity tab is read-only in the first slice. Mutations happen through the source
surface: chat, task detail, approvals, or channel.

### Channels Tab

Purpose: manage where the teammate participates.

Behavior:

- lists channel memberships,
- shows whether the teammate is the channel default teammate,
- allows adding/removing memberships,
- allows setting the teammate as channel default when the user has selected a channel,
- warns when the channel allowed tools are stricter than the teammate default tools.

Private chat should not automatically gain access to channel history just because a
teammate belongs to that channel.

### Skills Tab

Purpose: inspect and edit teammate skill bindings.

Behavior:

- lists the built-in skill library and any unknown durable bindings,
- shows workflow phase, required tools, provider capabilities, and approval profile,
- lets the user bind or disable a skill for the selected teammate,
- lets the user manually add a custom skill binding by id, repo shorthand, or URL,
- lets the user delete manually added `source: "user"` bindings,
- does not expose deletion for template-default `source: "template"` bindings,
- saves through `PUT /teammates/:id/skills`,
- treats disabled bindings as metadata, not as execution permission changes by
  themselves.

Skills are workflow templates. They do not grant execution authority by themselves.

### Memory Tab

Purpose: make teammate context boundaries visible.

MVP behavior:

- shows configured memory scopes as metadata records,
- supports channel brief, channel decisions, prior private chat summary, and private
  notes as scope types,
- does not implement vector memory, automatic recall, or hidden ingestion,
- does not feed memory into private chat until the prompt builder has an explicit
  inclusion decision.

The memory tab is primarily a trust surface in the first slice.

### Settings Tab

Purpose: edit durable teammate instance settings.

Fields:

- display name,
- description,
- avatar tone or image reference,
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
- Hard delete is not part of the first slice.

## Information Architecture

```text
Workspace shell
  Sidebar
    AI Teammates page
    teammate:<id> private workspace
    direct:<id> human/private conversations

Teammate private workspace
  Chat
  Tasks
  Activity
  Channels
  Skills
  Memory
  Settings
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

export type TeammateDirectMessageStatus = "ready" | "blocked" | "failed";

export interface TeammateDirectMessage {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly teammateId: string;
  readonly authorType: "local-user" | "ai-teammate" | "system";
  readonly authorId?: string;
  readonly body: string;
  readonly status: TeammateDirectMessageStatus;
  readonly errorMessage?: string;
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
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
```

`DELETE` soft-disables in the first slice:

```json
{
  "status": "disabled",
  "hidden": true
}
```

Hard delete should wait until retention and audit behavior is designed.

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

`PUT` replaces persisted bindings. The first Web workspace renders the read model; richer
editing controls remain a follow-up.

### Memory Scopes

```http
GET /teammates/:id/memory-scopes?cwd=/path/to/workspace
PUT /teammates/:id/memory-scopes?cwd=/path/to/workspace
```

Memory scopes are metadata only in the first slice. They do not alter prompt construction
until explicit inclusion rules are implemented.

### Private Thread And Messages

```http
GET /teammates/:id/direct-thread?cwd=/path/to/workspace
GET /teammates/:id/direct-messages?cwd=/path/to/workspace&limit=100
POST /teammates/:id/direct-messages?cwd=/path/to/workspace
```

Request:

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
  "message": { "id": "msg_...", "authorType": "local-user", "status": "ready" },
  "aiReply": { "id": "msg_...", "authorType": "ai-teammate", "status": "ready" }
}
```

### Teammate Read Models

```http
GET /teammates/:id/tasks?cwd=/path/to/workspace
GET /teammates/:id/activity?cwd=/path/to/workspace
```

These endpoints are read-only composition endpoints. They should reuse existing task,
run, approval, and channel message stores rather than introducing duplicate durable state.

## AI Reply Flow

1. Validate teammate exists and is `active`.
2. Validate the direct thread exists or create it.
3. Persist the local-user message.
4. If `requestAiReply` is false, return the message.
5. Resolve provider preset from request override or teammate default.
6. Require provider preflight success.
7. Build a no-tools private chat prompt:
   - teammate display name,
   - role/template summary,
   - teammate description,
   - system prompt and append fragments,
   - recent private messages,
   - no channel or file content by default.
8. Run the configured runner with `tools: []`.
9. Persist an AI reply with `ready`, `blocked`, or `failed`.
10. Return both message records.

Private chat currently uses the runner/provider path without creating a durable run
session. It persists the local message first, then stores a ready or blocked AI reply.

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
  and memory-scope setup calls.

Implemented API client changes:

- added typed methods for teammate CRUD,
- added typed methods for direct messages,
- added typed read models for tasks and activity,
- expose blocked provider errors without throwing away the persisted message.

Visual constraints:

- match the existing dense client shell,
- use tabs and icon buttons consistently with the channel workspace,
- avoid nested cards inside cards,
- do not add a marketing hero or decorative gradients,
- keep the chat composer stable at the bottom of the chat tab,
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

Status: implemented with private chat, task creation, channel membership management, and
settings editing. Skill and memory tab editing remains deferred.

Work:

- [x] create `TeammateWorkspace`,
- [x] implement Chat, Tasks, Activity, Channels, Skills, Memory, and Settings tabs,
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
- [x] update `docs/design/web-ui-v0.1.md`,
- [x] update `README.md` current status.

## Acceptance Criteria

- [x] Selecting an AI teammate from the sidebar opens a real private workspace, not a
  placeholder.
- [x] Sidebar active state stays exclusive across channels, teammates, direct messages, and
  global pages.
- [x] Default built-in teammates are durable workspace instances after bootstrap.
- [x] Creating a custom teammate persists after page refresh and daemon restart.
- [x] Private chat message history persists after page refresh and daemon restart.
- [x] AI replies in private chat use the teammate's selected provider when one is ready.
- [x] Provider failures create a visible blocked reply record.
- [x] Private chat does not include channel messages, files, or memory unless a future scope
  decision explicitly adds them.
- [x] The Tasks tab only shows tasks assigned to the selected teammate.
- [x] The Channels tab can add/remove membership and set the channel default teammate through
  channel update logic.
- [x] The Skills tab accurately shows template skill requirements and approval profiles.
- [x] The Settings tab can rename, pause, hide, pin, and soft-disable a teammate.
- [x] E2E covers selecting teammate, sending private chat, creating teammate-assigned tasks,
  editing channel membership/defaults, blocked provider state, settings persistence, and
  returning to channel workspace.

## Risks And Controls

| Risk | Control |
| --- | --- |
| UI looks complete while backing state is missing | Only ship tabs with real read models or explicit metadata-only behavior |
| Private chat leaks channel context | Prompt builder includes private thread only by default |
| Built-in template ids conflict with custom teammate ids | Use deterministic `teammate_builtin_*` ids for seeded instances |
| Disabling a seeded teammate recreates it on bootstrap | Store disabled state and make bootstrap idempotent |
| Chat path bypasses approval policy | Private chat uses no tools; side effects require task/run path |
| Provider failure loses user message | Persist local message before provider resolution and create blocked reply |
| Migration breaks existing workspaces | Use additive tables and no destructive schema changes |

## Open Decisions

1. Should private chat create run sessions for audit, or use a lighter message-only
   record? Recommendation: message-only first, optional `linkedRunId` when the runner
   path already emits a session.
2. Should custom avatar images use the existing attachment store? Recommendation: yes,
   but defer image upload controls until after basic identity settings work.
3. Should memory scopes affect prompt construction immediately? Recommendation: no. First
   make scopes visible and editable; wire prompt inclusion in a later trust-reviewed
   slice.
4. Should Files and Calendar tabs exist now? Recommendation: no. Files can appear after
   private attachments or per-teammate artifacts exist. Calendar should wait for a
   scheduled task/event model.

## First Implementation Target

Implemented first code slice:

- durable teammate instances seeded from built-in templates,
- private teammate thread and message persistence,
- private chat tab with no-tools AI replies,
- tasks, skills, channels, memory, and settings tabs backed by real data or metadata,
- docs updates and focused unit/daemon coverage.

Calendar, private attachments, hard delete, custom skill-pack import, vector memory, and
streaming private replies are intentionally deferred.
