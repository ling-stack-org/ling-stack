# Channel Workspace v1.8 Activity Source Drilldown Plan

## Status

Implemented Web-only slice after v1.7 Activity Saved Views and Attention Queue.

2026-06-24 conversation ownership update: this Activity drawer design is superseded for
conversation-owned details. Activity can still provide history/search entry points, but
conversation artifacts, attachments, links, agent operations, approvals, checks,
workflow/packet summaries, and source evidence must open from the owning conversation
turn through inline expansion or in-turn previews, not from a right-side conversation
drawer.

v1.8 originally turned the derived channel `Activity` timeline into a traceable event
entrypoint for messages, task/run events, approvals, state transitions, protocol records,
workflows, and attention queue items. Its old drawer behavior is historical for
conversation-owned material. New implementations should focus the owning conversation
turn, inline evidence, or in-turn preview instead. This remains Web-only and does not add
daemon contracts, durable channel events, ingestion, or background execution.

## Goals

- Let users inspect why an Activity item exists without leaving the chat workspace.
- Show source metadata, associated objects, and useful next actions in one compact place.
- Preserve existing Activity filters, saved views, attention queue, and sticky composer.
- Keep task detail inside `Tasks` and protocol records inside `Channel protocol`.

## Non-Goals

- No daemon routes, contracts, or SQLite schema.
- No durable `channel_events`.
- No notification persistence.
- No file, artifact, or webpage body ingestion.
- No automatic multi-agent loop.
- No workflow builder.
- No task/run/approval/workflow mutation from Activity detail itself.

## Product Behavior

Activity cards and Attention Queue rows gain a `Details` action. For conversation-owned
items, opening details focuses the owning conversation turn or its in-turn preview. The
old temporary drawer pattern is retained only as historical context for non-conversation
Activity metadata.

Historical Activity detail shows:

- event kind, status/attention, category, timestamp, and source id,
- source summary for the underlying message, task, run, approval, state transition,
  decision, handoff, context summary, workflow, or workflow step,
- related objects when available, such as task, run, approval, workflow, step,
  decision, handoff, or context summary,
- navigation/actions that reuse existing surfaces: open task, run detail, Inbox, or
  Channel protocol.

Closing Activity detail returns to the same Activity view. Search, filters, saved view
selection, queue expansion, and composer draft state stay intact.

## Implementation Plan

### 1. Derived Detail Model

- Add Web-only detail types for drilldown items, source packets, and action targets.
- Derive a detail packet from existing `ChannelActivityItem` data.
- Do not change the existing `ChannelActivityItem` wire shape.

### 2. Activity and Queue Entry Points

- Add `Details` actions to Activity cards without removing existing direct navigation.
- Add a details action to Attention Queue rows while keeping their direct target action.
- Store only the selected derived Activity item id in component state.

### 3. Details Surface

- Render conversation-owned details by focusing the owning conversation row or opening an
  in-turn preview. Historical non-conversation Activity metadata may use a lightweight
  floating panel inside the Activity tab.
- Show metadata, source summary, related object chips, and existing navigation actions.
- Keep any floating detail surface dismissible by close button and Escape where practical.
- Do not render `article.task-detail` inside Activity.

### 4. Documentation

- Update `docs/design/channel-workspace.md` with Phase 16 tracker items.
- Update `docs/design/web-ui-v0.1.md` after implementation.
- `docs/daemon-api.md` does not change.

## Test Plan

- Web e2e: message, task, run, approval, state transition, and workflow step events can
  open the appropriate owning conversation detail or historical Activity metadata detail.
- Web e2e: Attention Queue item details open from the expanded queue.
- Web e2e: detail surface shows source summary, metadata, related objects, and correct
  actions.
- Web e2e: closing details preserves search/filter/saved view/queue/composer state.
- Web e2e: detail actions focus owning conversation rows or existing non-conversation
  surfaces such as Inbox or Channel protocol.
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

- Activity and Attention Queue can explain the source of an item without backend changes.
- Any Activity detail surface is transient and does not reclaim the large task-detail
  layout in Activity.
- Existing Activity search/filter, saved views, attention queue, composer, Tasks, Files,
  and Channel protocol behavior do not regress.
