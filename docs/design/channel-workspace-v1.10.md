# Channel Workspace v1.10 Activity Layout Cleanup

## Status

Implemented Web-only slice after v1.9 Activity Triage Actions.

v1.10 does not add new channel capability. It reduces Activity visual density by moving
secondary controls behind progressive disclosure, so the default channel view reads as a
chat workspace first and an operations console only when the user asks for that depth.

## Goals

- Make the Activity default view calmer and easier to scan.
- Keep search, saved views, filters, attention queue, details, and triage actions
  available without occupying permanent vertical space.
- Preserve sticky composer behavior and independent feed scrolling.
- Keep task detail in `Tasks` and protocol work in `Channel protocol`.

## Non-Goals

- No daemon routes, contracts, or SQLite schema.
- No durable `channel_events`.
- No notification persistence.
- No file, artifact, or webpage body ingestion.
- No automatic multi-agent loop.
- No workflow builder.
- No triage outcome backlinks or persisted triage resolution state.

## Product Behavior

The Activity toolbar becomes a compact command strip. The default row shows:

- a `View` selector for built-in and custom saved views,
- a search field,
- a `Filter` button with an active-filter summary,
- a `Clear` button when a non-default filter or search is active.

Category and attention filters move into an expandable filter panel. The panel is closed
by default, remains local to the selected channel, and does not change data loading.
Saved-view management stays available through compact controls near the view selector
instead of a persistent chip row.

The Attention Queue becomes a small status entry. When there are no blocked, failed, or
pending items it should not consume a full card. When attention items exist, users can
expand the queue to see the top five and keep existing open/details actions.

The Activity details drawer becomes summary-first:

- source title, summary, and primary navigation actions stay visible,
- metadata, related objects, and triage actions are folded by default,
- triage forms expand only after the user chooses a triage action.

The composer should not show a large row of AI teammate candidates by default. It should
surface the default teammate and keep the `@` picker as the path to more participants.

## Implementation Summary

### 1. Activity Toolbar

- Replace the saved-view chip row with a compact selector.
- Keep saved-view create, rename, and delete actions available as small controls.
- Move category and attention chips into a collapsible filter panel.
- Show active filter summary when the filter panel is closed.

### 2. Attention Queue

- Hide or reduce the empty attention state to a small status indicator.
- Preserve count breakdown and top-five expansion when attention items exist.
- Keep task, run, approval, protocol, and details navigation behavior unchanged.

### 3. Details Drawer and Composer

- Convert source metadata, related objects, and triage actions to collapsible sections.
- Keep the drawer transient and do not restore a persistent right-side task detail pane.
- Collapse AI teammate suggestions in the composer to default teammate plus mention entry.

### 4. Documentation

- Updated `docs/design/channel-workspace.md` with Phase 18 tracker completion.
- Updated `docs/design/web-ui-v0.1.md` with implemented v1.10 behavior.
- `docs/daemon-api.md` does not change.

## Test Plan

- Web e2e: Activity default toolbar is compact and does not render the old saved-view chip
  row.
- Web e2e: filter panel expands, category and attention filters work, and a closed panel
  still shows an active summary.
- Web e2e: saved views can be selected, saved, renamed, deleted, and survive refresh.
- Web e2e: empty Attention Queue does not occupy a full card; populated queue expands to
  top five and keeps open/details actions.
- Web e2e: details drawer folded sections expand and triage actions still create records.
- Web e2e: composer remains sticky and does not show all AI teammate candidates by
  default.
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

- The default Activity tab has visibly less chrome above the feed.
- Existing v1.6-v1.9 search, saved views, attention queue, details, and triage behavior
  remain available through compact or folded entry points.
- No backend contract, schema, API client, task/run, approval, or protocol wire shape
  changes are introduced.
