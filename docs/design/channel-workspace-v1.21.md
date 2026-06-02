# Channel Workspace v1.21 Codex-Style Chat Workspace

## Status

Implemented in the Web client only. This slice ports the accepted channel chat HTML
direction into the product surface without adding daemon contracts.

## Intent

The selected channel should read as a quiet working chat, not a dashboard with tabs and
always-open controls. Chat stays the center of the channel. Tasks, files, and context
remain available, but they move into a right-side details panel that compresses the chat
when open and lets the chat expand when hidden.

## Interaction Model

The channel header is a compact toolbar:

- channel name with a `#` identity marker,
- `...` menu for `Tasks`, `Files`, and `Context`,
- icon-only AI teammate management,
- icon-only channel settings,
- icon-only attention queue,
- icon-only details panel show/hide.

Header icons are borderless. The left drawer toggle, channel identity marker, `...`
button, and right-side action icons share the same dark icon color and 18px glyph size.
The attention queue button does not show a numeric badge; counts remain inside the
attention popover and activity surfaces.

The `...` menu opens the requested channel surface in the right details panel. It closes
on outside click, Escape, or menu item selection. The Chat surface is not listed because
chat is the permanent center surface.

The right details panel:

- is an in-layout sidebar, not an overlay,
- is a full-height drawer aligned to the top of the channel workspace, not a panel that
  starts below the channel header,
- compresses the chat when visible,
- hides without losing the selected detail view,
- reuses existing Files and Context components,
- shows the selected task detail directly instead of a task list,
- embeds the active run timeline inside task detail when run events exist,
- keeps task/run identifiers out of the default header chrome.
- does not duplicate the details close control inside the drawer; show/hide is controlled
  from the channel header icon.

The attention queue:

- opens as a floating popover from the header icon,
- hides while the right details panel is visible,
- restores when the details panel is hidden if the queue toggle is still on,
- keeps the accepted HTML natural spacing on wide viewports; narrower desktop widths
  align the chat body and composer against the popover lane with a small safety gap so
  the popover does not cover the conversation,
- nudges the chat/composer column slightly toward the attention popover on very wide
  collapsed-left layouts so the conversation does not feel detached from the floating
  progress surface,
- includes a progress preview with an icon-only collapse control,
- keeps the attention list visible when only the progress preview is collapsed.

The attention popover typography follows the accepted HTML scale: progress and attention
section titles are 14px/600, progress rows are 12px/500, secondary copy is 12px/400,
attention item titles are 13px/600, and status/meta chips stay compact at 11px/600.
Progress status icons are 18px with 2.4px stroke so check and waiting states have the
same visual weight. Avoid heavier 760/780 text weights in this popover.

## Message Boundary

Plain chat messages are quieter than work events.

- Local user messages align right, do not show the local user's name or timestamp, and
  render as plain text without the default bubble background or border.
- AI teammate and coordinator chat messages align left, keep author and AI tag, and do
  not show timestamps.
- Reply-in-topic remains available through a hover/focus icon.
- Task, run, approval, handoff, workflow, and state-transition events are audit records,
  not ordinary chat. They are hidden from the default chat feed.
- Audit records remain reachable through the header `...` menu's activity tools, saved
  views, search, attention queue, and activity drilldown.
- Execution proposal cards remain attached to their source chat message. Confirmation
  keeps the user in the channel and updates the right task/run detail panel.

## Visual Boundary

The accepted channel chat HTML is a strict daylight surface. The channel workspace owns
its own daylight token scope even when the global app theme is dark:

- structural surfaces use `#FFFFFF` with `#E5E5E5` borders,
- selected rows and local-user bubbles use `#F5F5F5`,
- primary channel actions use black buttons with white text,
- the channel page hides the global `PageInspector`; only the internal right details
  panel is visible.

## Sidebar Boundary

Channel creation lives beside the `Channels` section in the left sidebar. Channel
settings edits only the current channel. The left brand block is removed from the strict
workspace surface; Settings moves to the lower sidebar area.

The accepted HTML direction treats the left navigation as a shared app drawer, not merely
a fixed sidebar and not a channel-only variant. On desktop the expanded drawer is 232px
wide. Collapsing it leaves a 48px toolbar rail with a single left-panel icon; hovering or
focusing the drawer reveals it without navigating away from the current surface. Switching
to model workbench, runs, inbox, media jobs, AI teammates, or settings keeps the same
drawer geometry, row treatment, notification badges, and bottom settings group instead
of falling back to the older 220px responsive sidebar treatment on desktop widths.

The drawer should use the accepted chat HTML row treatment, not the older global sidebar
accent treatment: the current channel uses a full-row `#F5F5F5` selected background with
no left accent bar, AI teammates use circular initial avatars, and row-end markers are
notifications only. Channel rows do not show numeric attention badges; no notification
means no marker, unread means a green dot, and opening the channel clears that dot. AI
teammate rows may keep counted attention pills when they represent teammate-specific
work. Generic online/active status dots are not shown. Section header actions are
icon-only; empty or loading teammate sections must not show legacy `Create` text labels
beside the title. The right task/details drawer keeps header actions hidden until hover
or focus. The bottom
approval and Settings entries share a single bottom group with a top divider and render as
ordinary drawer rows, not as warning cards or global sidebar chrome. Long AI teammate
lists scroll inside the teammate section so the bottom group remains visible.

## Layout Geometry

The accepted HTML layout is the geometry source of truth:

- left drawer open + right details open: chat and composer are centered in the remaining
  center column while the right details drawer compresses that column,
- left drawer collapsed + right details open: the 48px rail remains and the chat stays
  centered in the remaining center column,
- the chat body starts directly below the top divider with no extra top inset before the
  scrollable message feed,
- left drawer collapsed + right details hidden + attention queue visible: wide viewports
  keep the accepted HTML gap between chat/composer and the popover; narrower viewports
  reserve a right-side lane only when needed to avoid overlap,
- the message feed scrolls independently without showing a visible scrollbar, entering
  or switching into a channel pins the feed to the latest visible conversation item, and
  scrolling away from the latest item reveals a centered floating down-arrow button that
  returns to the latest conversation position,
- restoring either drawer returns to the same selected channel and selected detail view.

Long conversation loading and DOM virtualization are covered by
`channel-workspace-v1.22.md`; v1.21 owns the Codex-style layout and message chrome only.

## Non-Goals

- No new channel persistence fields.
- No removal of Tasks, Files, Context, topic replies, proposal cards, or activity events.
- No change to provider routing, approval policy, or PI run isolation.
- No new stored notification preference schema.

## Validation

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
git diff --check
```
