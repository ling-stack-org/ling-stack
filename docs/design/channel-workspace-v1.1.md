# Channel Workspace v1.1 Design and Implementation Plan

## Status

Implemented v1.1 slice after the channel workspace MVP.

This document is scoped to v1.1. The broader channel source of truth remains
[Channel Workspace Design](channel-workspace.md).

## Summary

The MVP made channels usable as a durable AI teammate workspace: messages, mentions,
attachments, link previews, Files/Tasks/Activity, default teammate, AI discussion, and
discussion-to-task conversion are now in place.

v1.1 makes multi-agent collaboration visible and trackable without starting a full
workflow engine. The slice adds four durable collaboration surfaces:

- Channel Brief: the current objective, scope, acceptance criteria, open questions, and
  risks for the channel.
- Decision Log: explicit decisions created from discussion, task, or manual input.
- Handoffs: manual records that show which participant should take the next step and why.
- Context Summaries: task/thread summaries that preserve discussion context before work is
  executed.

The key product rule is:

```text
v1.1 records and displays the collaboration protocol.
It does not autonomously run a multi-agent protocol.
```

## Product Goals

- Let the user understand channel intent before reading a long message history.
- Prevent agents from reopening settled decisions.
- Make "who owns the next step" visible before a task or review proceeds.
- Convert messy discussion into task-ready context.
- Keep all protocol state local-first, auditable, and bound to the selected channel.
- Preserve existing approval, provider preflight, channel status, and runtime lock behavior.

## Non-Goals

- No automatic multi-agent execution planner.
- No workflow engine or durable workflow-step scheduler.
- No file, PDF, Office, image, or webpage content ingestion into AI context.
- No notification persistence beyond existing UI state.
- No cloud team membership, realtime presence, or external channel adapters.
- No automatic approval of a handoff, decision, review gate, task completion, or risky run.
- No generic rich text editor for the Brief.

## User Workflows

### 1. Brief First

```text
open channel
-> inspect Brief summary
-> edit objective / acceptance criteria / open questions
-> save
-> Activity shows "Brief updated"
```

The Brief should be visible in the right inspector and reachable from the channel tabs or
header action. It should not replace Activity, Tasks, or Files as the default surface.

### 2. Decision From Discussion

```text
read message or AI reply
-> click Record decision
-> fill title, decision, rationale, alternatives
-> save
-> decision appears in Decision Log and Activity
-> Brief references the latest active decisions
```

Decisions are append-first. Editing can correct metadata, but changing a decision's
substance should create a new decision that supersedes the old one.

### 3. Manual Handoff

```text
select message/task/run
-> click Create handoff
-> choose from participant and to participant
-> enter reason, required input, expected output
-> save as proposed
-> receiver can mark accepted / completed / declined
```

A handoff is coordination metadata. It must not start a run, send a message, or grant
tools by itself.

### 4. Context Summary Before Task

```text
discussion produces executable work
-> click Create task
-> context summary is generated from selected messages plus active decisions
-> user edits the summary and task prompt
-> task is created with assignee fallback rules from the MVP
```

The first v1.1 implementation should support manual or deterministic summaries. AI
summary generation is optional and must use the same no-tools, text-only discussion
boundary as current AI replies.

## Data Model

### Participants

v1.1 should not add persisted teammate instances. Participant identity is resolved from
existing local data:

- `local-user`
- built-in teammate template ids such as `engineer`, `designer`, `qa`, `docs`
- local teammate draft ids from Web state, if present
- `system`

Records should store participant ids and labels as provided by the client. If a local
teammate draft disappears, the record still renders the stored label.

### Channel Brief

One Brief exists per channel.

```ts
interface ChannelBrief {
  id: string;
  workspaceId: string;
  channelId: string;
  objective: string;
  scope: string;
  acceptanceCriteria: readonly string[];
  openQuestions: readonly string[];
  risks: readonly string[];
  decisionIds: readonly string[];
  attachmentIds: readonly string[];
  linkPreviewIds: readonly string[];
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}
```

Defaults:

- Missing Brief returns an empty Brief-shaped response instead of 404.
- `decisionIds`, `attachmentIds`, and `linkPreviewIds` must reference the same channel.
- Brief update is a full replacement for the structured fields.

### Channel Decision

```ts
type ChannelDecisionStatus = "active" | "superseded" | "rejected";

interface ChannelDecision {
  id: string;
  workspaceId: string;
  channelId: string;
  sourceMessageId?: string;
  sourceTaskId?: string;
  sourceRunId?: string;
  title: string;
  decision: string;
  rationale: string;
  alternatives: readonly string[];
  status: ChannelDecisionStatus;
  supersedesDecisionId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

Rules:

- New decisions default to `active`.
- Superseding a decision marks the old record `superseded` and creates a new active
  record.
- Source ids are optional, but when present they must belong to the same channel.
- Rejected decisions stay visible in the log and should not appear as Brief defaults.

### Channel Handoff

```ts
type ChannelHandoffStatus =
  | "proposed"
  | "accepted"
  | "declined"
  | "completed"
  | "cancelled";

interface ChannelHandoff {
  id: string;
  workspaceId: string;
  channelId: string;
  sourceMessageId?: string;
  sourceTaskId?: string;
  sourceRunId?: string;
  fromParticipantId: string;
  fromParticipantLabel: string;
  toParticipantId: string;
  toParticipantLabel: string;
  reason: string;
  requiredInput: string;
  expectedOutput: string;
  status: ChannelHandoffStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

Rules:

- Handoff status changes are manual in v1.1.
- A handoff can reference a task/run/message but must not mutate that source record.
- Completed handoff does not mark a task done.
- Declined handoff should preserve reason text and remain visible.

### Channel Context Summary

```ts
type ChannelContextSummaryTargetType = "thread" | "task";
type ChannelContextSummaryAuthorType = "local-user" | "ai-teammate" | "system";

interface ChannelContextSummary {
  id: string;
  workspaceId: string;
  channelId: string;
  targetType: ChannelContextSummaryTargetType;
  targetId: string;
  sourceMessageIds: readonly string[];
  decisionIds: readonly string[];
  summary: string;
  acceptanceCriteria: readonly string[];
  openQuestions: readonly string[];
  authorType: ChannelContextSummaryAuthorType;
  authorId?: string;
  createdAt: string;
  updatedAt: string;
}
```

Rules:

- `targetType="task"` references a task in the same channel.
- `targetType="thread"` references a channel message `threadId` or source message id.
- Source messages and decisions must stay within the same channel.
- The summary is user-visible before task creation or task update.
- It is not hidden prompt state.

## Public Interfaces

Add shared contract/core types:

- `ChannelBrief`
- `ChannelDecision`
- `ChannelHandoff`
- `ChannelContextSummary`
- list/mutation response types for each collection

Add daemon routes:

```http
GET /channels/:id/brief?cwd=
PATCH /channels/:id/brief?cwd=

GET /channels/:id/decisions?cwd=&limit=
POST /channels/:id/decisions?cwd=
PATCH /decisions/:id?cwd=

GET /channels/:id/handoffs?cwd=&limit=
POST /channels/:id/handoffs?cwd=
PATCH /handoffs/:id?cwd=

GET /channels/:id/context-summaries?cwd=&targetType=&targetId=&limit=
POST /channels/:id/context-summaries?cwd=
PATCH /context-summaries/:id?cwd=
```

API defaults:

- Collection list order is newest first.
- `limit` defaults to 100 and caps at 500.
- Mutation responses return the mutated record.
- Unknown source ids return 400 with a displayable error.
- Cross-channel source references return 400.
- Missing channel returns 404.

No existing MVP routes should change shape.

## Storage Plan

Add SQLite tables in one new self-healing migration:

- `channel_briefs`
- `channel_decisions`
- `channel_handoffs`
- `channel_context_summaries`

Indexes:

- `channel_briefs(channel_id)` unique.
- `channel_decisions(channel_id, created_at)`.
- `channel_decisions(channel_id, status, created_at)`.
- `channel_handoffs(channel_id, status, created_at)`.
- `channel_context_summaries(channel_id, target_type, target_id, updated_at)`.

JSON columns can store arrays for v1.1:

- Brief criteria/questions/risks/source ids.
- Decision alternatives.
- Summary source message ids and decision ids.

Do not introduce a durable `channel_events` table in v1.1. Web can synthesize Activity
items from messages, decisions, handoffs, summaries, tasks, runs, approvals, and state
transitions.

## Web UX Plan

### Inspector

Add a channel inspector surface in the existing workbench shell:

- Brief
- Decisions
- Handoffs
- Runtime

The inspector should be dense and operational. Avoid nested cards and avoid moving the
task detail panel into the inspector.

### Brief Panel

Brief panel fields:

- Objective
- Scope
- Acceptance criteria
- Open questions
- Risks
- Linked decisions

Use simple text inputs/textareas and repeatable list rows. v1.1 does not need rich text.

### Activity Integration

Activity should show:

- brief updated items,
- decision items,
- handoff items,
- context summary items,
- existing channel messages and AI replies.

These are rendered as combined view models. They do not need a new daemon event stream.

### Message Actions

Add actions to eligible messages:

- Record decision
- Create handoff
- Create task with context

Keep existing `Create task` behavior. The new context flow is an enhanced path, not a
replacement.

### Tasks

Task detail should show linked context summaries and active decisions when present.

No task status changes are automatic from decisions or handoffs.

## Implementation Plan

### Phase 1: Contracts and Store

- Add contract/core types and request/response shapes.
- Add SQLite migration with self-healing old-database behavior.
- Add store CRUD for Brief, Decisions, Handoffs, and Context Summaries.
- Validate same-channel references for messages, tasks, runs, attachments, links, and
  decisions.
- Add focused core store tests for create/list/update and migration from an old database.

### Phase 2: Daemon API

- Add route parsing and handlers for new endpoints.
- Use existing workspace `cwd` store registry pattern.
- Return displayable validation errors for cross-channel or missing references.
- Do not call AI providers from these handlers.
- Add daemon tests for CRUD, same-channel validation, and not mutating tasks/runs when
  handoff state changes.

### Phase 3: API Client and Web Data Flow

- Add API client methods for new routes.
- Add AppShell state loaders and mutators keyed by selected channel.
- Refresh Brief/Decisions/Handoffs/Summaries after selected channel changes and after
  mutations.
- Keep MVP message, file, and link loaders unchanged.

### Phase 4: Web UI

- Add channel inspector tabs or segmented modes for Brief, Decisions, Handoffs, Runtime.
- Add Brief editor with save/cancel and dirty-state handling.
- Add Decision Log list plus Record decision modal/panel.
- Add Handoff list plus Create handoff modal/panel.
- Add context-summary creation flow from message to task.
- Render decisions/handoffs/summaries in Activity as synthesized items.
- Keep the current workbench task detail panel and `.channel-options` selectors stable.

### Phase 5: Docs and Tracker

- Update `docs/design/channel-workspace.md` implementation tracker.
- Update `docs/daemon-api.md` after the API is implemented.
- Update `docs/design/web-ui-v0.1.md` only if user-visible Web behavior changes.

## Test Plan

Core/store:

- Brief round-trip and singleton-per-channel behavior.
- Decision create/list/update/supersede behavior.
- Handoff create/status update behavior.
- Context summary target/source validation.
- Migration self-heals old databases.

Daemon:

- `GET/PATCH /channels/:id/brief`.
- decision, handoff, and summary list/create/update routes.
- Cross-channel message/task/run/decision references rejected.
- Missing channel/source ids return displayable errors.
- Handoff completion does not mutate task status.

API client:

- Routes, query params, and mutation bodies match daemon contract.
- Error body mapping remains stable.

Web:

- Brief editor saves and reloads after refresh.
- Record decision from message creates a Decision Log row and Activity item.
- Superseded decision remains visible but not active.
- Create handoff from task/message shows from/to participant, reason, expected output, and
  status.
- Create task with context summary preserves the source discussion and active decisions.
- Existing MVP flows still pass: Activity/Tasks/Files tabs, `@Engineer` assignment,
  attachments, link previews, and Task inspector.

Regression commands:

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

## Acceptance Criteria

v1.1 is ready to land when:

- every channel can show and update a durable Brief,
- decisions can be recorded from messages or manually and can be superseded,
- handoffs can be created and manually moved through proposed/accepted/declined/completed,
- context summaries can be created for tasks or discussion threads,
- Activity and task detail expose this protocol state without hiding MVP chat/tasks/files,
- no new record grants tools, reads files, fetches webpages, starts runs, or approves work,
- all existing PR #19 MVP e2e scenarios still pass.

## Assumptions

- Built-in teammate template ids are stable enough for v1.1 participant records.
- Local teammate drafts may appear in Web participant pickers but are not daemon-persisted
  teammate instances.
- JSON columns are acceptable for v1.1 structured arrays because querying individual
  criteria/questions is not required yet.
- AI-generated summaries are optional. If implemented, they must use a no-tools text path
  and persist the final visible summary.
- Durable `channel_events`, workflow persistence, attachment ingestion, and web extraction
  are separate follow-up slices.
