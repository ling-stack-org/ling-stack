# Channel Workspace v1.24 Right Drawer Workspace

## Summary

v1.24 turns the channel right side into a Codex-like multi-page drawer while keeping chat
as the permanent center workspace.

The drawer is a light detail area, not a second primary page. The root drawer pages are:

- Progress
- Files
- Context
- Settings

Task details and approval details are drill-down pages opened from proposals, progress
items, attention items, or event cards. They are not root navigation destinations.

## Product Model

The channel remains the user's workspace. The center chat column stays visible and keeps
the conversation context stable. The right drawer narrows the chat area when open and lets
the chat expand when hidden.

This matches the multi-agent studio model:

```text
channel chat = discussion and coordinator conclusions
right drawer = current-channel details
task / approval drill-down = execution detail inside the same channel
run page = fallback only when the channel cannot resolve the linked task/run
```

## Root Pages

### Progress

Progress is the default drawer page. It shows compact current-channel state:

- current task when explicitly selected,
- latest channel run without exposing run IDs,
- pending approvals,
- attention items,
- collapsed collaboration summaries,
- compact CI triage summaries when present.

No channel progress is shown for channels with no current-channel work. The UI must not
invent task detail or progress cards merely because another channel has runs or tasks.

### Files

Files continues to show channel attachments, shared links, and run artifacts.

### Context

Context reuses the channel inspector for Brief, Decisions, Handoffs, and Runtime context.
It is still a detail surface, not the main chat page.

### Settings

Settings edits only the current channel:

- channel notifications,
- current-channel teammate membership,
- current-channel provider/path/runtime policy.

It must not include global theme, language, or add-channel behavior. Creating a channel
stays owned by the left channel list `+` entry.

## Drill-Down Pages

### Task Detail

Task detail opens only from explicit task or run-related actions. The client must not
auto-select the first task on channel entry.

Run actions should resolve back to the linked task in the drawer when possible. If the
client cannot resolve the run's task in current state, it may fall back to the existing
run page.

### Approval Detail

Approval detail is a light approval panel:

- title,
- description,
- status,
- risk,
- action type,
- linked task/run actions,
- approve/deny controls.

It does not show raw audit payloads or long activity logs in the channel drawer.

## Interaction Rules

- `...` opens root drawer pages only.
- The header settings icon opens the Settings drawer page.
- The attention/progress icon opens the progress popover when the drawer is hidden and
  attention items exist; otherwise it opens the Progress drawer page.
- Opening the right drawer hides the progress popover.
- Opening the teammate manager hides the progress popover and the right drawer.
- The right drawer has no duplicate close button inside the drawer body; the header
  details icon owns show/hide.
- The drawer internal navigation is icon-only and switches between root pages.

## Visual Rules

- Drawer width is 380px on desktop.
- Drawer background is white.
- Chat remains visually primary and expands when the drawer is closed.
- Progress rows and approval panels are compact cards with neutral borders.
- Run IDs, raw event logs, and audit payload details are not shown in default channel
  details.

## Acceptance Criteria

- Chat remains the fixed center surface while right-side pages change.
- Root drawer pages are Progress, Files, Context, and Settings.
- Task and approval details are reachable as drill-down pages, not permanent tabs.
- Current-channel settings do not expose add-channel, theme, or language controls.
- Progress is bound to current-channel state and stays empty when the channel has no
  current work.
- Run event text and workflow step summaries do not expose run IDs.
