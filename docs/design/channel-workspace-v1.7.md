# Channel Workspace v1.7 Activity Saved Views and Attention Queue Plan

## Status

Implemented Web-only slice after v1.6 Activity Filters and Search.

v1.7 makes the derived channel `Activity` timeline easier to revisit by adding
local saved views and a compact attention queue. This remains a Web-only slice:
saved views live in browser local storage, attention items are derived from the
current Activity items, and no daemon contracts or durable channel events are added.

## Goals

- Let users save common Activity filters and searches per workspace/channel.
- Provide built-in views for common attention states without requiring manual filter
  setup.
- Surface blocked, failed, and pending items in a compact queue without taking over the
  chat workspace.
- Preserve v1.6 local search/filter behavior and channel isolation.

## Non-Goals

- No daemon routes, contracts, or SQLite schema.
- No durable `channel_events`.
- No notification persistence.
- No file, artifact, or webpage body ingestion.
- No automatic multi-agent loop.
- No workflow builder.

## Product Behavior

Activity keeps the existing v1.6 toolbar and adds saved view chips:

```text
All | Needs attention | Blocked | Failed | Pending approvals | Failed work | Runtime
Save view | Rename | Delete
Search activity
All | Messages | Work | Approvals | Protocol | Runtime
Needs attention | Blocked | Failed | Pending | Clear
```

Built-in views are always present and cannot be renamed or deleted. Custom views are
stored per `cwd + channelId`, up to 8 saved views per channel.

Saved views store:

- name,
- category filter,
- attention filter,
- search text.

Attention Queue appears below the toolbar. It is collapsed by default as a compact
summary, can expand to show the top 5 attention items, and sorts items by:

```text
blocked -> failed -> pending
newest first within each bucket
```

Each queue row opens the relevant surface:

- task items open `Tasks` and select the task,
- run items open Run detail,
- approval items open Inbox,
- protocol/workflow items open `Channel protocol`.

## Implementation Notes

### 1. Local Saved Views

- Added Web-only types for saved view filters, persisted custom views, and attention
  queue rows.
- Added local storage helpers keyed by `cwd + channelId`.
- Built-in views are kept in code and merged with custom views for rendering.
- The current filter resets to the built-in `All` view when the selected channel changes.

### 2. Activity Toolbar

- Extended `ActivityFilterToolbar` with saved view chips and custom view actions.
- `Save view` stores the current search/category/attention filters after asking for a
  local view name.
- `Rename` updates the selected custom view name.
- `Delete` removes the selected custom view.
- Rename/delete are disabled for built-in views.

### 3. Attention Queue

- Queue items are derived from filter-independent `activityItems`, not from the
  currently selected saved view.
- Blocked, failed, and pending items are counted separately.
- The queue renders a compact collapsed summary and an expanded top-5 list.
- Existing Activity navigation handlers are reused, so queue actions do not introduce
  new routing surfaces.

### 4. Documentation

- Update `docs/design/channel-workspace.md` with Phase 15 tracker items.
- Update `docs/design/web-ui-v0.1.md` with implemented behavior after code lands.
- `docs/daemon-api.md` does not change.

## Test Plan

- Web e2e: built-in views switch Activity results correctly.
- Web e2e: saving current filter plus search creates a custom view that survives reload.
- Web e2e: rename and delete custom views work, while built-in views cannot be renamed
  or deleted.
- Web e2e: switching channels resets to `All` and keeps custom views channel-local.
- Web e2e: Attention Queue shows blocked, failed, and pending counts plus top 5 rows.
- Web e2e: queue actions open Tasks, Run detail, Inbox, or Channel protocol as expected.
- Web e2e: no attention items show a compact empty state without hiding the composer.
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

- Saved views are local, channel-scoped, reload-safe, and capped at 8 custom views.
- Attention Queue highlights actionable blocked, failed, and pending work without
  changing backend behavior.
- The Activity composer remains sticky and visible in all saved-view and queue states.
- Existing Activity search/filter, Files, Tasks, Channel protocol, and v1.5/v1.6 event
  navigation do not regress.
