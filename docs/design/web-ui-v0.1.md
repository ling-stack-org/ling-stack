# Web UI v0.1 Design

## Status

Partially implemented for Milestone 5: Web UI First Loop.

This design depends on:

- [Session persistence](session-persistence.md)
- [Provider presets](provider-presets.md)
- [Approval policy](approval-policy.md)
- [Channel workspace](channel-workspace.md)

The current `apps/web` package now provides the local app shell, Model Workbench provider setup with templates and health checks, approval list, approval policy settings, run history with persisted run detail/rerun, a client-style channel workspace, compact task creation/running, channel runtime policy controls, active lease/conflict signals, state-machine timelines, contextual readiness and first-run panels, and English / Chinese UI language switching. This document remains the target design for the remaining richer workspace flows.

The AI teammates page now uses the same client direction: a Helio-inspired, macOS-like wizard for choosing a default role, binding a model, filling profile details, and scoping channels/memory/files. Saving from the wizard now creates a durable daemon-backed workspace teammate.

The richer channel surface is tracked in [Channel Workspace Design](channel-workspace.md). That document is the source of truth for channel tabs, default AI teammate assignment, member/notification/settings inspector behavior, file/artifact access, and the phased implementation checklist.

Implemented MVP behavior: the channel workspace now has `Activity`, `Tasks`, `Files`,
and `Context` tabs; a unified channel composer with `Send` and `Task` actions;
structured `@` AI teammate mentions; durable channel messages; no-tools AI discussion
replies; user attachments; metadata-only web link previews; ordinary discussion
messages without inline conversion controls; and task creation from the current composer
input with `assigneeTeammateId` derived from the first AI mention or channel default
teammate.

Implemented v1.1 behavior: the channel inspector adds `Brief`, `Decisions`, `Handoffs`, and
`Runtime` modes. Activity now synthesizes channel messages with decision, handoff, and
context summary records. These protocol records are manual and auditable; they do not
start runs, call AI providers, ingest attachments/links, or mutate task/run state.

Implemented v1.2 behavior: handoff cards can create durable workflow/step records, the
channel protocol surface lives behind the `Context` tab beside Activity, Tasks, and
Files instead of occupying the task detail panel, Runtime shows a Workflow queue with
context packet metadata, blockers, linked task/run ids, and step controls, Activity
includes workflow/step items, and Task detail shows the source workflow/step for tasks
created from a workflow step. Task detail now lives inside the `Tasks` tab instead of
occupying the default channel chat view. `Start step` creates a task for review, while
`Start + run` enters the existing task/run stream and approval/runtime boundaries.

Implemented v1.3 behavior: the channel Activity tab now behaves like a focused chat
workspace with an independently scrollable message feed, sticky in-tab composer,
explicit send/AI reply/attachment/link-preview states, and complete English/Chinese
coverage for touched channel strings. v1.3 remains a Web experience polish slice and
does not add automatic multi-agent loops, file/webpage body ingestion, notification
persistence, or a custom workflow builder.

Implemented v1.4 behavior: the channel `Files` tab now separates user uploads, shared
links, and run artifacts. It shows selected-channel run artifacts, summary paths, and
event log paths through existing artifact APIs without reading artifact bodies or adding
backend contracts.

Implemented v1.5 behavior: the channel `Activity` tab is now a derived timeline that mixes
messages, protocol records, tasks, runs, approvals, state transitions, workflows, and
workflow steps. v1.5 remains Web-only and does not add durable channel event storage,
notification persistence, ingestion, automatic multi-agent loops, or a workflow builder.

Implemented v1.6 behavior: the channel `Activity` timeline now has local search,
category filters, attention filters, counts, and no-match empty states. v1.6 remains
Web-only and does not add backend contracts, durable channel events, notification
persistence, ingestion, automatic multi-agent loops, or a workflow builder.

Implemented v1.7 behavior: the channel `Activity` timeline now has local saved views and
a compact attention queue for blocked, failed, and pending items. v1.7 remains Web-only
and does not add backend contracts, durable channel events, notification persistence,
ingestion, automatic multi-agent loops, or a workflow builder.

Implemented v1.8 behavior: Activity cards and Attention Queue items now have a lightweight
source drilldown drawer that explains the selected event, related objects, and existing
navigation actions without restoring a persistent task-detail split pane. v1.8 remains
Web-only and does not add backend contracts, durable channel events, notification
persistence, ingestion, automatic multi-agent loops, or a workflow builder.

Implemented v1.9 behavior: the Activity details drawer now has lightweight triage actions
for creating follow-up tasks, handoffs, decisions, and context summaries from the
selected event. It preserves local Activity state, keeps drafts on mutation failure, and
uses existing task/protocol records for confirmations and navigation. v1.9 remains
Web-only and does not add backend contracts, durable channel events, persisted triage
resolution state, notification persistence, ingestion, automatic multi-agent loops, or a
workflow builder.

Implemented v1.10 behavior: the channel Activity tab keeps the v1.6-v1.9 controls but
moves secondary surfaces behind progressive disclosure. Saved views are a compact view
selector, category and attention filters live behind a filter panel, empty attention
state no longer occupies a full card, composer AI teammate mentions collapse to the
default teammate plus picker, and details drawer metadata/triage sections are folded by
default. v1.10 remains Web-only and does not add backend contracts.

Implemented v1.11 behavior: the channel workspace default surface is simplified for
work-first use. The workspace route no longer reserves the global right inspector, the
global top bar is removed, the body no longer duplicates the left sidebar channel
switcher, Settings and New task live in the channel header, the separate workspace
toolbar is removed, path/provider/runtime controls move behind channel Settings,
theme/language controls move to the main Settings section, the protocol tab is labeled
`Context`, empty attention state is hidden, the separate Activity title bar is removed,
the Activity composer stays attached to the bottom of the channel panel, and composer
extras move behind More.
v1.11 remains Web-only and does not add backend contracts.

Implemented v1.12 behavior: channel Settings now includes a `Channel teammates` manager.
Channels can start without teammate members or a default teammate; existing workspace
teammates can be added to the selected channel, removed from that channel without
deleting the teammate, and set as the selected channel's default teammate. Composer
mention options prioritize teammates already in the selected channel. v1.12 remains
Web-only and reuses existing teammate channel membership routes.

Implemented v1.13 behavior: the channel Activity composer removes the explicit More
tools panel. Mentions are selected from an inline `@` teammate popover, dropped or pasted
files attach directly through the existing upload path, and URLs in the message body
create link previews automatically. Discussion messages request an AI reply only when an
AI teammate is explicitly mentioned. v1.13 remains Web-only and does not add backend
contracts.

Implemented v1.14 behavior: the channel Activity feed separates plain discussion from
work events. Ordinary user messages and AI replies show no inline task, handoff,
decision, context, workflow, or details buttons. Task, run, approval, protocol, workflow,
and state-transition cards keep their actions and use a colored left-edge cue. v1.14
remains Web-only and does not add backend contracts.

Implemented v1.15 behavior: the channel workspace now treats the default surface as
`Chat` rather than `Activity`. `Chat` and `Files` are the primary tabs, `Tasks` and
`Context` remain secondary channel views, Activity operations are folded behind
`Chat tools`, and ordinary chat messages can open a `threadId`-backed topic reply panel.
v1.15 remains Web-only and reuses the existing channel message contract.

Implemented v1.16 behavior: channel Settings is grouped into `Members`,
`Notifications`, and `Channel management`. Teammates are added through an explicit
select-then-add action, member rows keep default/remove controls, and notification level
preferences persist locally by workspace path and channel id. v1.16 remains Web-only and
does not add daemon contracts.

Implemented v1.17 behavior: channel AI teammate management moves out of Settings into a
dedicated channel header dock, while ordinary user/AI chat message chrome and topic
replies move to hover/focus-only bubble UI with a right-edge icon and `Reply in topic`
tooltip. v1.17 remains Web-only and reuses the existing teammate membership and channel
message contracts.

Implemented v1.18 behavior: the channel Chat composer removes the `Discuss` / `Task`
segmented control. One textarea now handles discussion text, inline `@` teammate
selection, dropped/pasted files, and URL previews. `Send` stores a discussion message;
`Task` creates a durable task from the same input and opens the `Tasks` tab. v1.18
remains Web-only and reuses the existing message and task APIs.

Accepted v1.19 design: channels are general multi-agent studios, not coding-only task
rooms. A coordinator can consult specialist teammates, show that process as a collapsed
collaboration record, and emit safe execution proposals instead of directly creating
tasks. The Web client will render an editable confirmation card; user confirmation
creates the durable task and starts the assignee's PI run when the proposal is
create-and-run. The user stays in channel context, approval cards surface in-channel,
and assignee provider/tool/preflight blockers do not silently fall back to another
provider.

## Goal

Users should be able to run and inspect Ling Stack without `curl`.

Minimum loop:

```text
open local web UI
-> configure provider preset
-> bind local project/channel
-> create task
-> start run
-> watch live SSE events
-> inspect tool calls and final result
-> handle approval requests
-> revisit persisted run history
```

The Web UI should prove the product shape: AI teammates do scoped work, Ling Stack makes the work visible, and risky actions route through review.

## Non-Goals

v0.1 Web UI does not include:

- Marketing landing page.
- Team collaboration.
- Cloud login.
- Billing.
- Desktop packaging.
- Rich notebook/editor replacement.
- Full file explorer.
- Complex dashboard analytics.
- In-browser code editing.

## UX Principle

The first screen must be the workspace, not a hero page.

This is an operational tool. It should feel dense, calm, inspectable, and built for repeated work:

- visible navigation,
- task and run status at a glance,
- clear provider state,
- live event stream,
- explicit approval cards,
- no decorative sections that hide the workflow.

The default Web entry should now behave like a strict platform console for the same
Ling Stack product model:

- open directly into the selected channel, usually `# engineering`,
- keep workspace, channels, AI teammates, and direct messages in the left sidebar,
- keep provider setup, approval inbox/policy, media jobs, and settings in the configuration rail or dedicated pages,
- give AI teammates a dedicated management page instead of leaving them as decorative sidebar presence,
- keep the center focused on channel activity and the unified composer by default,
- keep task detail inside the `Tasks` tab so chat is not squeezed by a persistent detail pane,
- keep readiness, first-run guidance, approvals, and live events in the right context panel,
- avoid showing channel/provider/policy forms as the first thing a ready user sees.
- keep the Web visual treatment distinct from Desktop: Web uses a strict OpenAI
  Platform-like console, while Desktop keeps the macOS glass client treatment.

## Surface And Theme Model

Ling Stack has one product model and two surface treatments:

| Surface | Light treatment | Dark treatment | Theme control |
| --- | --- | --- | --- |
| Web | Strict optical-white developer console | Strict dark technical console | system / light / dark |
| Desktop | macOS glass workspace | macOS dark glass workspace | system / light / dark |

Shared across both surfaces:

- navigation terms: Workspace, Channels, Tasks, Runs, Approvals, AI Teammates, Direct Messages, Model Workbench, Media Jobs, Settings,
- state semantics: ready, running, queued, pending approval, blocked, failed, succeeded,
- approval and run boundaries,
- daemon/provider health language,
- task/run/channel data shape.

The Web console should not use glass, blur, large shadows, decorative gradients, warm
paper backgrounds, or marketing composition. It should use exact white surfaces in light
mode, near-black technical surfaces in dark mode, 1px dividers, compact controls, and
small local state fills for selected/hovered rows. Typography stays sans-serif for UI
copy; monospace is reserved for IDs, logs, payloads, paths, commands, and model/runtime
metadata.

## Application Shape

Recommended stack:

```text
Vite
React
TypeScript
CSS modules or plain CSS
lucide-react for icons
```

Do not add a heavy UI framework until there is a concrete need. The first UI should be simple enough to maintain while the daemon API is still moving.

`apps/web` should call the local daemon:

```text
http://127.0.0.1:17891
```

The daemon base URL should be configurable:

```text
VITE_LING_STACK_DAEMON_URL=http://127.0.0.1:17891
```

## Layout

Use a three-region app shell with strict platform-console surfaces:

```text
┌──────────────────────────────────────────────────────────┐
│ Top bar: daemon status, provider status, theme, language │
├──────────────┬──────────────────────────────┬────────────┤
│ Sidebar      │ Channel workspace            │ Context    │
│ Workspace    │ # engineering activity       │ readiness  │
│ Inbox/Tasks  │ chat / task tabs             │ first-run   │
│ Channels     │                              │ approvals  │
│ AI teammates │                              │ event feed  │
│ DMs          │                              │            │
│ Config rail  │                              │            │
└──────────────┴──────────────────────────────┴────────────┘
```

Desktop widths:

- left nav: 220-260px,
- right panel: 320-420px,
- main: remaining space.

Mobile/tablet:

- left nav collapses into a drawer,
- right panel becomes tabs below main content,
- run viewer keeps event stream readable first.

## Navigation

Routes:

```text
/                         -> Workspace overview
/channels/:channelId      -> Channel task board
/tasks/:taskId            -> Task detail
/runs/:runId              -> Run viewer
/providers                -> Model Workbench
/approvals                -> Approval inbox
/settings                 -> Local app settings
```

v0.1 can ship with client-side routing only.

## Core Screens

### Workspace Overview

Purpose:

- show whether Ling Stack is ready to run,
- expose the next action,
- avoid empty dashboard noise.

Current homepage shape:

- left sidebar owns workspace navigation, channel selection, AI teammate presence, direct messages, and compact configuration icons,
- center channel window shows the selected channel header, daemon/provider chips, Activity chat/composer, and task queue/detail inside the Tasks tab,
- right context panel shows readiness, first-run state, pending approvals, and event stream,
- runtime state panel shows active runs, pending approvals, active resource leases, and recent state transitions,
- channel creation and other configuration controls are collapsed or moved out of the primary center flow.

Content:

- daemon health,
- provider readiness,
- compact readiness checklist,
- default channel,
- recent runs,
- pending approvals,
- quick task form.

Primary actions:

- create task,
- configure provider,
- create channel,
- open latest run.

### AI Teammates Management

Purpose:

- expose the default Ling/gstack-inspired AI teammate bench,
- make teammate roles, skills, tools, provider capability needs, and approval profiles inspectable,
- support durable teammate creation, private chat, and teammate-specific read models
  without bypassing the task/run/approval path.

Current page shape:

- left sidebar `AI Teammates` opens the management page,
- main area starts with a four-step teammate wizard: `Role -> Model -> Profile -> Scope`,
- role selection prioritizes built-in `gstack-default` templates and also supports `Start from blank`,
- model selection binds a provider preset per teammate instead of assuming one global model,
- scope selection lets the user choose channels and planned memory/file sources,
- below the wizard, workspace teammates, built-in roles, selected template detail, and the `autoplan-lite` workflow remain inspectable,
- the left sidebar shows daemon-backed teammate presence and supports pin/hide controls,
- right context panel summarizes the active skill pack, workspace teammate count, and strict approval skills.

Current boundary:

- adding a teammate creates a durable daemon record,
- sidebar pin/hide, provider binding, status, and identity settings persist through
  teammate update APIs,
- channel memberships, skill bindings, and memory scopes are durable metadata,
- private chat persists local-user messages and ready/blocked AI replies,
- custom skill packs, vector memory, automatic recall, private attachments, avatar
  upload, hard delete, and AGENTS.md import remain future work.

Implemented design slice:

- [Helio-Inspired AI Teammate Private Workspace](ai-teammate-private-workspace.md)
  promotes AI teammates into durable workspace members with private chat, task/activity
  tabs, channel membership, skill inspection, memory scopes, and settings.

Empty state priority:

1. no daemon: show connection error and retry.
2. no provider: guide to Model Workbench.
3. no channel: guide to Channel Setup.
4. ready: show task form.

Compact readiness checklist:

- appears near the top of Workspace Overview before the task/channel workspace,
- uses existing daemon, provider, channel, and task state instead of a separate dashboard API,
- stays compact enough to scan while preserving the task board as the primary surface,
- shows status for daemon, provider preflight, channel setup, and task availability,
- provider readiness requires the same run preflight as the Run button: enabled, chat-capable, non-media, secret configured, and `lastCheck.ok === true`,
- task availability is informational, not blocking, because a user can create the first task from the same screen,
- each blocked item should expose the next action: retry daemon health, open Model Workbench, create/select channel, or create task.

Example:

```text
Workspace readiness
Daemon       Ready
Provider     Needs check     Open Model Workbench
Channel      Ready
Tasks        Empty           Create task
```

First run quick flow:

- appears under the readiness checklist when the workspace has not completed the first runnable task loop,
- aligns with CLI `doctor` next actions but keeps the Web flow action-oriented,
- uses the first preflight-ready chat provider for defaults when the user has not selected a provider,
- offers `Create default channel` when no channel exists,
- offers `Set as channel provider` when a selected channel has no preflight-ready default provider,
- offers `Create first task` when a channel exists but the selected channel has no task,
- offers `Check run` and `Run` once a selected task has a preflight-ready effective provider,
- should not create duplicate channels/tasks from repeated loading states; buttons must disable while the relevant collection is loading or a run is active.

The quick flow is a convenience layer. The normal channel/task forms remain the source of editable details.

Run-after loop:

- task cards should surface the latest linked run status from `currentRunId` when available,
- each task with a linked run should expose `Open run` to load the persisted run and switch to the run detail view,
- while a run is active, the first-run panel should show the active run id/status and offer `Open run` instead of looking like a fresh setup flow,
- after a successful run, Workspace readiness should include a compact run-history signal that the local loop has completed at least once,
- failed runs should point to the right repair surface:
  - provider/preflight failures -> Model Workbench,
  - pending approvals -> Approvals,
  - tool/runtime failure -> Run detail.
- runtime/tool repair must distinguish replaying the failed run snapshot from saving and running an edited task; edits to a task do not change the old persisted run request.

Run repair hints:

- the run repair classifier should be shared by first-run, task cards, and run detail,
- `waiting_for_approval` and runs with pending approval records should show an Approvals action,
- failed runs whose error mentions provider auth, preflight, key, secret, model, base URL, endpoint, or token should show a Model Workbench action,
- all other failed tool/runtime runs should show an Open run / run-detail action,
- run detail should show the repair hint near the status summary so the user does not need to infer the next repair surface from raw events.

### Model Workbench

Model Workbench is the Web name for provider preset setup. It still uses the existing provider APIs, but the user-facing job is broader than a settings page: configure models, prove readiness, and pick a runnable provider for workspace tasks.

Backed by:

- `GET /providers`
- `POST /providers`
- `GET /providers/:id`
- `PATCH /providers/:id`
- `DELETE /providers/:id`
- `POST /providers/:id/check`

Required UI:

- provider list with explicit coding-task readiness,
- add provider form,
- edit provider form,
- health check button,
- enabled/disabled toggle,
- secret configured indicator,
- capability chips,
- provider kind/template grouping,
- custom OpenAI-compatible access card for domestic gateways, private relays, One API, New API, LiteLLM, and similar endpoints.

Provider kinds:

```text
OpenAI
Claude
OpenAI-compatible relay
Doubao / Ark
DeepSeek / DPV4-compatible
MiniMax
GLM / Zhipu
Jimeng
Seedream
Seedance
```

Form fields:

| Field | Control |
| --- | --- |
| Provider kind | select |
| Display name | text input |
| Runtime provider id | text input |
| Model | text input |
| API protocol | select |
| Base URL | URL input |
| API key ref | text input, e.g. `env:LOCAL_RELAY_API_KEY` |
| Capabilities | checkbox group |
| Input modes | checkbox group |
| Enabled | toggle |

Custom compatible access should default to:

```text
kind: openai-compatible
api: openai-completions
displayName: Custom OpenAI-compatible
baseUrl: https://api.example.com/v1
model: your-model-id
apiKeyRef: env:CUSTOM_MODEL_API_KEY
capabilities: chat, tool_call, reasoning
input: text
```

Rules:

- never ask for raw API key in v0.1 persistent UI,
- only ask for `apiKeyRef`,
- show the setup/restart/check sequence for missing `env:NAME` values and fail-closed `keychain:NAME` refs,
- show `apiKeyConfigured: true/false`,
- do not reveal secret values,
- show health check result with stable error code.

Provider onboarding and repair:

- Model Workbench must make the path from template to runnable preset explicit: choose template, save preset, configure the secret ref if needed, run Check, then Use.
- The list summary should distinguish chat-compatible providers from preflight-ready providers. Compatibility means enabled, non-media, chat-capable, and secret-present; preflight-ready additionally requires `lastCheck.ok === true`.
- The primary batch action should read as `Check all` and only target enabled chat providers whose hard compatibility rules can be checked.
- A compact repair queue should show the next blocked providers before the full list:
  - missing env: show the env name and daemon restart hint,
  - unchecked compatible preset: show Check action,
  - failed check: show stable failure code/message and Check action,
  - disabled/media/no-chat preset: show Edit action.
- The `Use` shortcut should only be enabled for preflight-ready chat providers, because the daemon run gate will reject unchecked or failed presets.

Workspace provider selection:

- only preflight-ready chat providers should appear as runnable coding providers,
- unchecked or failed chat providers can be shown as setup-blocked entries with repair text,
- media providers must not appear in the normal coding task provider selection,
- if a task run is blocked by provider readiness, the action should open Model Workbench with the related provider/run context when available.

Provider run repair flow:

- when a failed run routes to Model Workbench, the app should carry the failed `runId` and provider preset into provider settings,
- Model Workbench should show a focused repair panel above the normal queue with: failed run id, provider preset, failure text, and next actions,
- repair actions should be executable without leaving the page: edit provider, save changes through the existing form, run Check, rerun after the provider becomes preflight-ready, or return to the failed run detail,
- rerun remains disabled until the provider used by the failed run is preflight-ready, matching the daemon run gate,
- clearing the repair panel should not delete the run or provider; it only exits the guided repair context.

### Channel Setup

Backed by channel APIs:

- `GET /channels`
- `POST /channels`
- `GET /channels/:id`
- `PATCH /channels/:id`
- `DELETE /channels/:id`

Required UI:

- channel list,
- channel name,
- bound local path,
- default provider preset,
- default allowed tools,
- default teammate.

Default tools for product runs:

```text
read
grep
find
ls
```

`write`, `edit`, and `bash` must be disabled or clearly marked unavailable until controlled approval wrappers exist.

### Task Board

Backed by future task APIs:

- `GET /tasks?channelId=...`
- `POST /tasks`
- `GET /tasks/:id`
- `PATCH /tasks/:id`
- `DELETE /tasks/:id`

Required columns:

```text
todo
running
review
done
failed
cancelled
```

Task card content:

- title,
- status,
- provider,
- current or latest run,
- last updated time,
- small error marker if failed.

Primary actions:

- create task,
- run task,
- open run,
- cancel run if supported,
- retry failed task.

### Task Composer

This should be available from overview and channel pages.

Fields:

- task title,
- prompt,
- channel/path,
- provider preset,
- allowed tools,
- thinking level.

Default behavior:

- use selected channel path as `cwd`,
- use channel/provider default,
- use read-only tools,
- start run immediately when submitted if requested.

### Run Viewer

Backed by:

- `POST /runs`
- `GET /runs/:id`
- `GET /runs/:id/events`
- future `POST /runs/:id/cancel`

Required regions:

1. Header:
   - task title,
   - status,
   - provider/model,
   - cwd,
   - start/end time,
   - cancel/retry buttons.

2. Assistant transcript:
   - assistant text deltas merged into readable messages,
   - thinking deltas hidden by default behind a disclosure,
   - error state clearly visible.

3. Tool timeline:
   - tool name,
   - status,
   - args preview,
   - result/error preview,
   - duration if available later.
   - each tool row should be expandable and show the raw event payload plus useful fields such as `toolCallId`, command, cwd, target path, and result/error output when present.

4. Raw events:
   - collapsible debug panel,
   - event sequence numbers,
   - event type filter.
   - timeline rows should stay scannable by default with a short preview, while error/result/tool payloads can be expanded inline for debugging.

5. Evidence:
   - v0.1 is derived from already-loaded run/session fields, events, approvals, assistant text, and artifact metadata; the UI does not fetch summary file contents yet,
   - show a run summary preview with status, task, provider, terminal event, error/result summary, assistant output preview, tool counts, errored tool count, and approval count,
   - show session files from `eventLogPath` and `summaryPath` with path wrapping,
   - keep request/provider/terminal raw snapshots below Evidence as debug details,
   - show recorded artifacts from `GET /runs/:id/artifacts`, with content links through `GET /artifacts/:id/content`,
   - show a per-run empty state when the artifact API is connected but the run has no artifact records.

6. Artifacts:
   - file/diff/log/media list when available.

Run viewer must support both live and historical modes.

Live mode:

```text
POST /runs returns SSE
-> append envelopes to UI state
-> update run status
-> show new tool/assistant events immediately
```

Historical mode:

```text
GET /runs/:id
-> GET /runs/:id/events
-> reconstruct transcript and timeline
```

Runtime/tool run repair flow:

- when a failed run routes to Run detail, the page should show a focused repair panel near the status summary instead of only a generic event timeline,
- the panel should identify the most relevant failure event, preferring the latest errored `tool_end`, then `run_error`, then the terminal run event,
- if a matching `tool_start` exists, the panel should carry forward useful context such as tool name, command, cwd, and target path,
- repair actions should keep the loop short: Edit task, Rerun, and Reload,
- Edit task should switch back to Workspace, select the run's channel/task, and let the user adjust the prompt/status before rerunning,
- Rerun should be labeled as snapshot replay, reuse the persisted run request, and remain disabled when the run cannot be replayed through a provider preset,
- Workspace should carry a focused task repair handoff when Edit task is opened from a failed run; it should show the failed run id, explain that the old snapshot is unchanged, and expose Save + run updated task plus a checked variant.

### Approval Inbox

Backed by:

- `GET /approvals?status=pending`
- `GET /approvals/:id`
- `POST /approvals/:id/approve`
- `POST /approvals/:id/deny`

Required UI:

- global pending approvals list,
- approval details drawer,
- risk indicator,
- command/path/diff/media preview,
- approve button,
- deny button,
- optional reason input.

Critical approvals:

- require a second confirmation,
- show explicit target and risk,
- never auto-approve.

Approval run repair flow:

- when a run routes to Approvals, the app should carry the `runId` into the approval inbox,
- the inbox should show a focused repair panel above the list with run id, task, pending approval count, highest risk, and involved action types,
- while focused on a run, the list should show approval records for that run instead of the global inbox,
- after approve/deny, the UI should refresh approvals, the linked run, and run history so the user can immediately return to the updated run detail,
- the repair panel should expose Reload, Back to run, and Clear; clearing only exits the guided approval context.

Approval cards also appear in the Run Viewer timeline.

### Artifacts Panel

Backed by artifact APIs:

- `GET /runs/:id/artifacts`
- `GET /artifacts/:id`
- `GET /artifacts/:id/content`

v0.1 Run detail shows artifacts inside Evidence:

- artifact metadata is loaded alongside the selected run and events,
- each artifact row shows type, title/path, and size when available,
- content links open `GET /artifacts/:id/content` in a new tab,
- image artifacts keep the list-and-open surface but also show explicit `Open` and `Download` actions for the same content endpoint,
- empty runs show `No artifacts recorded for this run`.

Artifact types:

```text
file
diff
log
json
markdown
image
video
```

The first implementation is list-and-open only. Image artifacts have explicit open/download actions, but no inline preview. Inline previews can be added after artifact volume, binary handling, and redaction rules are clearer.

## Event Rendering

The UI should consume the durable event envelope:

```ts
interface RunEventEnvelope {
  id: string;
  runId: string;
  seq: number;
  ts: string;
  type: string;
  data: unknown;
}
```

Render mapping:

| Event type | UI behavior |
| --- | --- |
| `run_created` | initialize run timeline |
| `run_start` | mark run running |
| `turn_start` | start model turn marker |
| `assistant_text_delta` | append to current assistant message |
| `assistant_thinking_delta` | append to hidden thinking panel |
| `message_end` | close current message |
| `tool_start` | create tool timeline item |
| `tool_update` | update tool item partial result |
| `tool_end` | mark tool item done/error |
| `approval_requested` | show approval card and mark run review |
| `approval_approved` | mark approval resolved |
| `approval_denied` | mark approval denied and run failed if applicable |
| `artifact_created` | add artifact link |
| `run_end` | mark run succeeded |
| `run_error` | show error panel and mark failed |
| `run_cancelled` | mark cancelled |
| `result` | show run summary |

The UI should keep raw events available for debugging, but the default view should be semantic: transcript, tools, approvals, artifacts.

## SSE Client

Because native `EventSource` cannot send POST bodies, use `fetch()` and stream the response body.

Client responsibilities:

- send `POST /runs`,
- read stream chunks,
- parse SSE frames,
- parse JSON event data,
- append event envelopes,
- handle reconnect through historical events after run id exists.

Recommended flow:

```text
submit run
-> receive ready with runId
-> append live events from stream
-> if stream drops, call GET /runs/:id/events?afterSeq=<lastSeq>
```

The UI should not assume stream disconnect means run cancellation.

## Local State Model

Use small local stores or React state by domain:

```text
providers
channels
tasks
runs
eventsByRun
approvals
artifacts
daemonStatus
```

Avoid global state frameworks until the app is larger. A thin API client plus React hooks is enough for v0.1.

## API Client Modules

Recommended files:

```text
apps/web/src/api/client.ts
apps/web/src/api/providers.ts
apps/web/src/api/channels.ts
apps/web/src/api/tasks.ts
apps/web/src/api/runs.ts
apps/web/src/api/approvals.ts
apps/web/src/api/artifacts.ts
apps/web/src/api/sse.ts
```

`client.ts` owns:

- daemon base URL,
- JSON request helpers,
- error normalization,
- auth token header once daemon auth exists.

`sse.ts` owns:

- POST stream parsing,
- frame buffering,
- JSON parse errors,
- last sequence tracking.

## Component Plan

Recommended files:

```text
apps/web/src/App.tsx
apps/web/src/main.tsx
apps/web/src/styles.css

apps/web/src/components/AppShell.tsx
apps/web/src/components/DaemonStatus.tsx
apps/web/src/components/ProviderBadge.tsx
apps/web/src/components/StatusPill.tsx
apps/web/src/components/ToolTimeline.tsx
apps/web/src/components/RunTranscript.tsx
apps/web/src/components/ApprovalCard.tsx
apps/web/src/components/ArtifactList.tsx
apps/web/src/components/EmptyState.tsx

apps/web/src/pages/WorkspacePage.tsx
apps/web/src/pages/ProvidersPage.tsx
apps/web/src/pages/ChannelPage.tsx
apps/web/src/pages/TaskPage.tsx
apps/web/src/pages/RunPage.tsx
apps/web/src/pages/ApprovalsPage.tsx
apps/web/src/pages/SettingsPage.tsx
```

Keep components compact. Avoid nested card layouts. Repeated items can be cards; page sections should be full-width panels or simple split panes.

## Visual System

Style goal:

```text
quiet local operations console
```

Use:

- neutral background,
- clear borders,
- restrained accent colors by status,
- compact typography,
- monospace only for code, paths, commands, and event payloads,
- lucide icons for actions.

Status colors:

| Status | Use |
| --- | --- |
| running | blue or cyan accent |
| review | amber |
| succeeded | green |
| failed | red |
| cancelled | gray |

Risk colors:

| Risk | Use |
| --- | --- |
| low | neutral |
| medium | amber |
| high | orange/red |
| critical | red with confirmation |

Do not rely on color alone. Include labels.

## Empty and Loading States

Daemon unavailable:

- show daemon URL,
- show retry button,
- show CLI command hint only in compact text.

No providers:

- show Model Workbench action.

No channel:

- show Create Channel action.

No runs:

- show Task Composer.

Pending approval:

- show approval count in top bar and right panel.

## Error Handling

UI should normalize daemon errors:

```ts
interface UiError {
  code: string;
  message: string;
  details?: unknown;
}
```

Display rules:

- inline form validation for bad input,
- toast or banner for daemon/network errors,
- run error panel for `run_error`,
- provider health result in Provider Settings,
- approval denial inside run timeline.

Do not show raw stack traces by default. Put raw error details behind a disclosure.

## Security and Privacy

Minimum UI rules:

- never display raw API keys,
- never store API keys in browser localStorage,
- show only `apiKeyRef`,
- redact event payloads already redacted by daemon,
- do not let browser choose arbitrary filesystem paths without daemon validation,
- mark risky tools disabled until approval wrappers exist,
- show local daemon URL and auth state.

When daemon auth lands, store token in memory for v0.1 dev mode or use a local session bootstrap from CLI. Do not design cloud login into v0.1.

## Accessibility

Minimum requirements:

- keyboard reachable primary actions,
- visible focus states,
- buttons have accessible labels,
- approval decisions are not color-only,
- event stream can be paused from auto-scroll,
- text does not overflow panels,
- compact but readable font sizes.

## Localization

v0.1 Web UI supports a lightweight locale layer for product chrome and core workflow text:

- locales: `en-US` and `zh-CN`,
- default locale: saved `localStorage` value, then browser language, then `en-US`,
- persistence key: `ling-stack.locale`,
- switcher location: top bar,
- scope: navigation, page titles, readiness, channel/task workflow, run history/detail, provider settings, media jobs, approval inbox, and policy settings.

Daemon payloads, provider names, task prompts, run ids, event types, raw JSON, and artifact content remain source data and are not machine-translated by the UI.

## Responsive Behavior

Desktop-first is acceptable because this is a local developer tool, but the UI should not break on narrow screens.

Breakpoints:

```text
>= 1200px: three-pane app shell
800-1199px: left nav + main, right panel as drawer
< 800px: top nav + single-column pages
```

Run viewer on mobile:

- transcript first,
- tabs for tools/events/approvals/artifacts,
- no horizontal overflow except code blocks.

## First Implementation Slice

Build the UI in this order:

1. App shell and daemon health.
2. Provider Settings list/create/check.
3. Direct Run page with task composer and provider preset selection.
4. SSE Run Viewer.
5. Historical Run Viewer.
6. Approval Inbox shell.
7. Channel and Task pages after backend APIs exist.

Reason: channel/task APIs may not exist at the same time as the first UI. A direct run page can prove the runtime while still aligning with the later task model.

## Temporary Direct Run Page

Until channel and task CRUD exist, provide:

Fields:

- `cwd`,
- `title`,
- `prompt`,
- `providerPresetId`,
- `tools`,
- `thinkingLevel`.

Default tools:

```text
read
grep
find
ls
```

Dangerous tool toggle:

- hidden or disabled by default,
- show explicit warning,
- only works if daemon supports unsafe development flag.

This page should be removed or folded into Task Composer after tasks/channels are implemented.

## Backend Dependencies

Required for full Web UI:

| UI feature | Required backend |
| --- | --- |
| Daemon status | `GET /health` |
| Provider settings | provider preset APIs |
| Direct run | `POST /runs` with `providerPresetId` |
| Live run viewer | SSE envelopes |
| Historical run viewer | `GET /runs/:id`, `GET /runs/:id/events` |
| Approval inbox | approval APIs |
| Channel pages | channel APIs |
| Task board | task APIs |
| Artifacts panel | `GET /runs/:id/artifacts`, `GET /artifacts/:id/content` |

The UI can be built incrementally as these APIs land.

## Test Plan

Unit/component tests:

- Provider form validates required fields.
- Provider list redacts secrets.
- SSE parser handles split frames.
- Event reducer merges assistant text deltas.
- Tool timeline updates start/update/end events.
- Approval card renders risk and payload.
- Run status derives correctly from events.

Browser tests with Playwright:

- daemon unavailable state renders.
- provider create flow works against mock daemon.
- direct run starts and renders SSE events.
- historical run page reconstructs events from API.
- approval approve/deny buttons call correct endpoints.
- layout has no obvious overflow at desktop and mobile widths.

Manual smoke:

```bash
corepack pnpm build
corepack pnpm --filter @ling-stack/web dev
node packages/daemon/dist/cli.js
```

Then verify:

- open Web UI,
- health indicator is green,
- create provider preset,
- start direct run,
- see live `run_start`, assistant, tool, and result events.

## Implementation Checklist

1. Choose and install web dependencies.
2. Add Vite/React/TypeScript app structure.
3. Add daemon API client.
4. Add app shell and routing.
5. Add daemon health indicator.
6. Add provider settings page.
7. Add direct run page.
8. Add SSE parser.
9. Add run event reducer.
10. Add run viewer.
11. Add historical run loader.
12. Add approval inbox shell.
13. Add artifact panel shell.
14. Add English / Chinese locale switcher.
15. Add responsive layout.
16. Add component tests or minimal browser tests.
17. Run `corepack pnpm typecheck`.
18. Run `corepack pnpm build`.
19. Start local dev server and verify with browser.

## Open Decisions

### UI Framework

Question: should v0.1 use a component library?

Recommendation: no. Use simple React components and CSS first. Add a component library only if repeated controls become expensive.

### Router

Question: should v0.1 use React Router?

Recommendation: yes if multiple pages are built at once. If the first slice is only a direct run page, a small local router is acceptable temporarily.

### State Library

Question: should v0.1 use Zustand, Redux, or TanStack Query?

Recommendation: start without global state library. Add TanStack Query later if API caching and invalidation become noisy.

### First Screen

Question: should the first screen be overview or direct run?

Recommendation: direct workspace overview with embedded task composer. If provider or channel is missing, guide to setup inline.

### Desktop Readiness

Question: should the Web UI assume it will be embedded in Electron/Tauri?

Recommendation: keep daemon URL configurable and avoid browser APIs that will block desktop embedding. Do not optimize for desktop shell before the web flow works.
