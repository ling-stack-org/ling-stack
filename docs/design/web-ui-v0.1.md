# Web UI v0.1 Design

## Status

Partially implemented for Milestone 5: Web UI First Loop.

This design depends on:

- [Session persistence](session-persistence.md)
- [Provider presets](provider-presets.md)
- [Approval policy](approval-policy.md)

The current `apps/web` package now provides the local app shell, provider settings, approval list, run history with persisted run detail/rerun, channel/task workspace, channel detail editing, task detail editing, and first task-run entry. This document remains the target design for the remaining richer workspace flows.

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

Use a three-region app shell:

```text
┌────────────────────────────────────────────────────┐
│ Top bar: workspace, daemon status, provider health │
├──────────────┬──────────────────────┬──────────────┤
│ Left nav     │ Main workspace       │ Right panel  │
│              │                      │              │
│ Channels     │ Task board / run     │ Run context  │
│ Runs         │ viewer / settings    │ approvals    │
│ Providers    │                      │ artifacts    │
│ Approvals    │                      │              │
└──────────────┴──────────────────────┴──────────────┘
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
/providers                -> Provider settings
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

Content:

- daemon health,
- provider readiness,
- default channel,
- recent runs,
- pending approvals,
- quick task form.

Primary actions:

- create task,
- configure provider,
- create channel,
- open latest run.

Empty state priority:

1. no daemon: show connection error and retry.
2. no provider: guide to Provider Settings.
3. no channel: guide to Channel Setup.
4. ready: show task form.

### Provider Settings

Backed by:

- `GET /providers`
- `POST /providers`
- `GET /providers/:id`
- `PATCH /providers/:id`
- `DELETE /providers/:id`
- `POST /providers/:id/check`

Required UI:

- provider list,
- add provider form,
- edit provider form,
- health check button,
- enabled/disabled toggle,
- secret configured indicator,
- capability chips,
- provider kind filter.

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

Rules:

- never ask for raw API key in v0.1 persistent UI,
- only ask for `apiKeyRef`,
- show `apiKeyConfigured: true/false`,
- do not reveal secret values,
- show health check result with stable error code.

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

4. Raw events:
   - collapsible debug panel,
   - event sequence numbers,
   - event type filter.

5. Artifacts:
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

Approval cards also appear in the Run Viewer timeline.

### Artifacts Panel

Backed by future artifact APIs:

- `GET /runs/:id/artifacts`
- `GET /artifacts/:id`
- `GET /artifacts/:id/content`

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

v0.1 can start with list-only artifacts and basic text previews.

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

- show Provider Settings action.

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
| Artifacts panel | artifact APIs |

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
14. Add responsive layout.
15. Add component tests or minimal browser tests.
16. Run `corepack pnpm typecheck`.
17. Run `corepack pnpm build`.
18. Start local dev server and verify with browser.

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
