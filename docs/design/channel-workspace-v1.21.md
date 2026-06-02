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
- includes a progress preview with an icon-only collapse control,
- keeps the attention list visible when only the progress preview is collapsed.

## Message Boundary

Plain chat messages are quieter than work events.

- Local user messages align right and do not show the local user's name or timestamp.
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

The accepted HTML direction treats the left navigation as a drawer, not merely a fixed
sidebar. On desktop the expanded drawer is 232px wide. Collapsing it leaves a 48px
toolbar rail with a single left-panel icon; hovering or focusing the drawer reveals it
without navigating away from the channel. The strict channel shell should not fall back
to the older 220px responsive sidebar treatment on desktop widths.

The drawer should use the accepted chat HTML row treatment, not the older global sidebar
accent treatment: the current channel uses a full-row `#F5F5F5` selected background with
no left accent bar, AI teammates use circular initial avatars with small status dots,
and the right task/details drawer keeps header actions hidden until hover or focus.

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
