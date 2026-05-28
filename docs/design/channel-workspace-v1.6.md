# Channel Workspace v1.6 Activity Filters and Search Plan

## Status

Implemented in `codex/channel-v1.6-activity-filters`.

v1.6 makes the derived channel `Activity` timeline easier to use once it contains
messages, task/run events, approvals, protocol records, and runtime changes. This slice
adds local search, category filters, attention filters, and clearer empty states without
adding durable channel events or backend APIs.

## Goals

- Let users find relevant channel activity without opening Tasks, Runs, Inbox, or
  Channel protocol first.
- Keep filtering local to the selected channel and current browser session.
- Preserve v1.5 timeline derivation and cross-channel isolation.
- Keep Activity layout stable: independent feed scrolling and sticky composer.
- Keep the slice Web-only.

## Non-Goals

- No daemon routes, contracts, or SQLite schema.
- No durable `channel_events`.
- No notification persistence.
- No file, artifact, or webpage body ingestion.
- No automatic multi-agent loop.
- No workflow builder.

## Product Behavior

Activity gets a compact toolbar between channel tabs and the feed:

```text
Search activity
All | Messages | Work | Approvals | Protocol | Runtime
Needs attention | Failed | Pending | Clear
```

The toolbar filters the already-derived timeline only. It does not trigger new data
loads or mutate channel state. Counts on chips reflect the current search result set so
users can see whether a category has matching items before switching.

Filter defaults reset when the selected channel changes:

- category: `All`,
- attention: none,
- search text: empty.

Empty states:

- no activity at all: keep the default channel-ready message,
- activity exists but filters match nothing: show `No activity matches these filters`.

## Implementation Notes

### 1. Activity Metadata

- Web-only activity items now include:
  - `category`: `message | work | approval | protocol | runtime`,
  - `attention`: `blocked | pending | failed | none`,
  - `searchText`: lower-case local search text.
- Search text includes message body, task title/prompt/status, run id/status,
  approval title/status, decision/handoff/summary text, workflow/step title/prompt,
  and state-transition entity/event/status text.
- Filtering stays out of data loading; it only chooses which items render.

### 2. Activity Toolbar

- The Activity feed now has a toolbar with search, category chips, attention chips,
  and Clear.
- Category chips: `All`, `Messages`, `Work`, `Approvals`, `Protocol`, `Runtime`.
- Attention chips: `Needs attention`, `Failed`, `Pending`.
- `Needs attention` includes blocked, failed, and pending items.
- Clear resets search, category, and attention filter.
- Chip counts are based on the current search text.

### 3. Documentation

- `docs/design/channel-workspace.md` tracker is updated for the implemented slice.
- `docs/design/web-ui-v0.1.md` channel behavior summary reflects the implemented
  behavior.
- `docs/daemon-api.md` does not change.

## Test Plan

- Web e2e: Activity default shows the full timeline.
- Web e2e: searching message, task, run, approval, workflow, and state-transition text
  filters results.
- Web e2e: category chips show only their matching items and display counts.
- Web e2e: `Needs attention`, `Failed`, and `Pending` filters work.
- Web e2e: `Clear` restores the full timeline.
- Web e2e: switching channels resets filters and does not leak other-channel events.
- Web e2e: no-match filters show `No activity matches these filters` while composer
  remains visible.
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

- Activity can be searched and filtered without changing backend behavior.
- Filter state resets on channel switch.
- Chip counts match the current search scope.
- No-match and no-activity states are visually distinct.
- Existing Activity chat, Files, Tasks, Channel protocol, and v1.5 event navigation do
  not regress.
