# Channel Workspace v1.9 Activity Triage Actions

## Status

Implemented Web-only slice after v1.8 Activity Source Drilldown.

v1.9 turns the drilldown drawer from a read-only explanation surface into a light
triage entrypoint. Users can create the next work item from an Activity event without
leaving the channel conversation. This remains Web-only: it reuses existing task,
decision, handoff, and context-summary APIs and does not add daemon contracts, durable
channel events, triage resolution state, ingestion, or background execution.

## Goals

- Let users act on blocked, failed, pending, and protocol-relevant events from the
  Activity details drawer.
- Keep the action UI compact and contextual.
- Preserve Activity filters, saved views, attention queue expansion, drawer state, and
  sticky composer.
- Express triage outcomes through existing records: tasks, decisions, handoffs, and
  context summaries.

## Non-Goals

- No daemon routes, contracts, or SQLite schema.
- No durable `channel_events` or persisted triage resolution state.
- No notification persistence.
- No file, artifact, or webpage body ingestion.
- No automatic multi-agent loop.
- No workflow builder.
- No direct mutation of task, run, approval, or workflow status from the drawer.

## Product Behavior

The Activity details drawer gains a `Triage actions` section. Available actions are
derived from the selected Activity item, its attention state, and existing source
packet metadata.

Initial actions:

- `Create follow-up task` for messages, tasks, runs, workflow steps, and state changes.
- `Create handoff` for blocked or failed work, workflow steps, messages, and tasks.
- `Record decision` for pending approvals, messages, state changes, and protocol
  context that should become auditable.
- `Create context summary` for messages, tasks, runs, approvals, workflow steps, and
  state changes.

The drawer uses inline forms with prefilled source context. Successful actions show a
compact confirmation with a direct navigation action:

- task -> `Tasks`,
- decision, handoff, and context summary -> `Channel protocol`.

If an action fails, the drawer keeps the draft and offers retry and dismiss controls.
Closing the drawer or switching tabs does not clear unrelated composer drafts or Activity
filter state.

## Implementation Summary

### 1. Derived Triage Model

- Added Web-only triage types for action definitions, drafts, and results in
  `apps/web/src/lib/channel-activity-triage.ts`.
- Action availability is derived from `ChannelActivityDrilldownItem`.
- Existing daemon wire shapes and the `ChannelActivityItem` model remain unchanged.

### 2. Drawer UI

- Added a compact action picker and inline form to `ActivityDrilldownDrawer`.
- Titles/prompts/reasons/decision text are prefilled from the source packet and related
  object metadata.
- Pending, failed, retry, dismiss, and success confirmation states are local to the
  drawer.
- `article.task-detail` still does not render inside Activity.

### 3. Existing API Reuse

- Follow-up tasks use the existing channel task creation flow.
- Handoffs use the existing channel handoff creation flow.
- Decisions use the existing channel decision creation flow.
- Context summaries use the existing channel context summary flow.

### 4. Documentation

- Updated `docs/design/channel-workspace.md` with Phase 17 tracker completion.
- Updated `docs/design/web-ui-v0.1.md` with implemented v1.9 behavior.
- `docs/daemon-api.md` does not change.

## Test Plan

- Web e2e: failed task/run detail can create a follow-up task and open it in `Tasks`.
- Web e2e: blocked workflow step detail can create a handoff and open `Channel protocol`.
- Web e2e: pending approval detail can record a decision and show it in protocol/Activity.
- Web e2e: message or state transition detail can create a context summary and then a task.
- Web e2e: failed triage mutation preserves the draft and exposes retry/dismiss.
- Web e2e: closing details preserves Activity search/filter/saved view/queue/composer state.
- Web e2e: Activity still does not render `article.task-detail`.
- Web e2e: English and Chinese labels are readable.
- Regression:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web exec playwright test
corepack pnpm typecheck
git diff --check
```

## Acceptance Criteria

- Users can turn an Activity source item into a task, handoff, decision, or context
  summary without backend changes.
- Action results are visible through existing channel records and navigation surfaces.
- The drawer remains transient and does not become a persistent task-detail panel.
- Existing Activity search, filters, saved views, attention queue, composer, Tasks,
  Files, and Channel protocol behavior do not regress.
