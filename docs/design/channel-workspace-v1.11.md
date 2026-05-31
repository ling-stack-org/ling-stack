# Channel Workspace v1.11 Surface Simplification

## Status

Implemented Web-only slice after v1.10 Activity Layout Cleanup.

v1.11 does not add channel capability. It simplifies the default channel surface so the
workspace reads as a focused activity and task loop instead of an operations dashboard.

## Goals

- Keep the default channel viewport focused on channel identity, activity, and composer.
- Remove always-visible operational configuration from the first screen.
- Keep provider, path, runtime policy, and channel creation controls available through
  explicit settings.
- Keep theme and language preferences available from the Settings section instead of
  the global shell.
- Preserve high-signal warnings for daemon, provider, default teammate, approvals,
  leases, and non-active channel status.
- Keep task/run details available through existing Activity, Tasks, Runs, and details
  entry points without reserving a permanent right inspector on the workspace screen.

## Non-Goals

- No daemon routes, contracts, SQLite migrations, or API client changes.
- No removal of Activity saved views, filters, Files, Tasks, Context, or triage actions.
- No change to task/run execution semantics or provider selection persistence.
- No new right inspector data model.

## Product Behavior

The workspace route no longer opens with the global right inspector. Run and task detail
remain available through the existing task cards, run links, Activity details drawer, and
dedicated Runs/Tasks views.

The global top bar is removed from the Web shell. Daemon and provider health remain
visible only when they need attention on the channel header or in the relevant settings
surfaces.

The channel header action area is reduced to:

- Settings,
- New task.

Channel switching belongs to the left sidebar channel list. The selected channel is
already visible in the page header, so the workspace body should not render a second
channel selector.

The separate workspace toolbar is removed. Settings opens the operational controls that
were previously visible by default:

- workspace path,
- run provider,
- channel name,
- execution path,
- default AI teammate,
- runtime policy,
- refresh/create channel actions.

Interface preferences live in the main Settings section:

- theme,
- language.

The Activity tab keeps its compact view selector, search, and filter toggle, but saved
view management moves into the expanded filter panel. Empty attention state no longer
renders a visible row.

The Activity surface no longer renders a separate panel title bar above the tab row.
The tab group and refresh control share one compact row, and the message feed owns the
remaining middle height while the composer stays attached to the bottom of the channel
panel.

The composer default state shows:

- Discuss/Task mode,
- the message or task prompt field,
- More,
- Send/Create task.

Mentions, attachments, link preview, Ask AI, media-provider notice, and allowed tool
tokens are available from More. Pending attachments, links, mentions, and send/retry
states remain visible when active.

The `Channel protocol` tab label becomes `Context` in the Web UI. The underlying data
model and navigation behavior remain unchanged.

## Acceptance Criteria

- Desktop workspace first viewport shows Activity and the composer actions without a
  permanent right inspector or global top bar.
- Activity does not spend a separate row on a `Dynamic/Activity` title bar, and its
  composer remains at the bottom while the message feed scrolls independently.
- Desktop workspace body does not duplicate the left sidebar channel switcher.
- Mobile first viewport does not spend its initial space on workspace path and provider
  selectors unless Settings is open.
- Settings and composer More can be toggled and reveal the hidden controls.
- Main Settings exposes theme and language controls.
- Activity details, task opening, run opening, Files, and Context remain reachable.
- No backend contract or persisted data shape changes are introduced.

## Test Plan

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
git diff --check
```

Rendered QA:

- desktop viewport: app loads, workspace route is not blank, right inspector is hidden,
  Activity and composer actions are visible, and no duplicate body channel selector is
  rendered,
- desktop interaction: long Activity feeds scroll inside the message feed while the tabs
  and composer remain in place,
- desktop interaction: Settings opens operational controls,
- desktop interaction: More opens composer options,
- mobile viewport: app loads without framework overlay and Activity remains reachable.
