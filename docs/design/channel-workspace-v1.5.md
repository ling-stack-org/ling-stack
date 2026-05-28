# Channel Workspace v1.5 Activity Events

## Status

Implemented implementation slice after v1.4 Files and Run Artifacts.

v1.5 turns channel `Activity` into a channel timeline. The tab already shows durable
messages and manual protocol records. This slice derives lightweight events from
existing tasks, runs, approvals, state transitions, workflows, and workflow steps so a
channel reads like a working log instead of a chat-only surface.

## Goals

- Show important work events in `Activity` without forcing users to open Tasks, Runs, or
  Inbox first.
- Keep chat messages, protocol records, and runtime events in one chronological feed.
- Reuse existing APIs and contracts; do not add durable `channel_events`.
- Preserve v1.3 layout behavior: independent feed scrolling and sticky composer.
- Keep events lightweight with clear jumps to Tasks, Run detail, Inbox, or Channel
  protocol.

## Non-Goals

- No daemon routes, contracts, or SQLite schema.
- No durable channel event persistence.
- No automatic multi-agent loop.
- No file, artifact, or webpage body ingestion.
- No notification persistence.
- No custom workflow builder.
- No task detail rendering inside Activity.

## Product Behavior

`Activity` renders one unified timeline from existing local records:

```text
channel messages
+ channel protocol records
+ selected-channel tasks
+ selected-channel runs
+ approvals tied to those runs/tasks
+ state transitions for recent related entities
+ workflows and workflow steps
-> sorted by event time
-> rendered as lightweight activity cards
```

Channel isolation matches v1.4 run artifact derivation:

```text
task belongs when task.channelId === selectedChannel.id
run belongs when run.channelId === selectedChannel.id
run also belongs when run.taskId belongs to a selected-channel task
approval belongs when approval.runId or approval.taskId belongs to the selected channel
workflow/step belongs through selected-channel protocol data
```

Event cards should be compact. They summarize what changed and provide a next action:

- task event: open `Tasks` and select the task,
- run event: open Run detail,
- approval event: open Inbox,
- decision, handoff, workflow, and step events: open `Channel protocol`.

The existing synthetic latest-run Hopper card should be removed once run timeline events
cover the same information.

## Implementation Plan

### 1. Web Data Flow

- Add a Web-only channel activity event builder.
- Extend the existing `buildChannelActivityItems` path to include messages, tasks,
  runs, approvals, state transitions, decisions, handoffs, summaries, workflows, and
  workflow steps.
- Derive selected-channel task and run ownership in one helper so Activity and Files do
  not drift.
- Load state transitions for the newest 20 related tasks/runs/workflows/steps, with
  `limit=20` per entity.
- Keep transition loading failures local to transition-derived cards; messages and chat
  must still render.

### 2. Activity UI

- Add event card variants for:
  - task created, updated, and status changes,
  - run queued, running, waiting, succeeded, failed, and cancelled,
  - approval pending, approved, denied, and expired,
  - state transition rows,
  - workflow and workflow-step status events.
- Keep message and protocol actions already available in Activity.
- Add lightweight navigation actions for each derived event.
- Keep `.channel-options`, `article.task-detail`, and `Task inspector` selectors stable.
- Add English and Chinese strings for all new labels.

### 3. Documentation

- Update `docs/design/channel-workspace.md` tracker after implementation.
- Update `docs/design/web-ui-v0.1.md` if shipped behavior changes the channel summary.
- `docs/daemon-api.md` does not change because v1.5 reuses existing endpoints.

## Test Plan

- Web e2e: Activity shows message, task, run, approval, state transition, and workflow
  step events together.
- Web e2e: derived events are rebuilt after refresh from existing records.
- Web e2e: another channel's task/run/event does not appear in the selected channel.
- Web e2e: task event opens `Tasks` and selects the task.
- Web e2e: run event opens Run detail.
- Web e2e: approval event opens Inbox.
- Web e2e: Activity does not render `article.task-detail`.
- Web e2e: composer stays sticky and feed scrolls independently.
- Web e2e: English/Chinese labels are readable.
- Regression:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web exec playwright test
corepack pnpm typecheck
git diff --check
```

## Acceptance Criteria

- `Activity` works as a channel work timeline, not only a chat feed.
- The implementation introduces no new public API, daemon route, contract, or storage
  table.
- Cross-channel task/run/approval/state-transition leakage is covered by e2e.
- Derived events provide clear navigation without moving task detail back into Activity.
- Existing Activity chat, Files, Tasks, and Channel protocol behavior do not regress.
