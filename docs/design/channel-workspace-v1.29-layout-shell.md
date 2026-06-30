# Channel Workspace v1.29 Layout Shell

## Status

Implementation slice for the channel workspace layout shell.

This slice follows:

- [Channel Workspace v1.27 Environment Surface](channel-workspace-v1.27-environment-surface.md)
- [Channel Workspace v1.28 Environment Git Status](channel-workspace-v1.28-environment-git-status.md)

v1.29 does not change Environment or Git status data semantics. It fixes the UI
framework boundary around three visible rails:

```text
conversation rail | environment rail | right dock rail
```

## Problem

The current page lets `WorkspaceClientView` own too many layout concerns at once:

- conversation feed rendering and virtualized scroll,
- Environment popover visibility,
- right dock visibility and resize,
- CSS width variables,
- delayed right dock unmount,
- message-feed scroll-anchor restoration.

That makes the right dock fragile. Opening the dock can trigger extra layout reads,
`:has(.channel-side-panel)` selector changes, conditional grid children, and scroll
compensation. The visible failure is a small vertical shake in the conversation feed even
though the user only opened a horizontal rail.

## Product Decision

The channel workspace must behave like a stable three-rail shell:

```text
left navigation | channel shell

channel shell:
  header
  main grid:
    conversation rail
    optional environment rail
    right-dock resize rail
    right-dock rail
```

Only the shell computes rail widths. Child components render content only.

The right dock content may mount and unmount for animation, but the shell must decide:

- whether the right dock rail exists,
- how wide it is,
- whether the Environment rail is inline or hidden,
- where the conversation rail can center itself.

The conversation feed must not run scroll compensation solely because the right dock
opened or closed. A horizontal rail transition may change available width, but it must
not mutate `scrollTop` every animation frame.

## Layout Rules

### Right Dock Rail

- Default width: 304px.
- Minimum width: 304px.
- Maximum width: 50% of viewport, while preserving the minimum conversation width.
- Resize handle width: 8px.
- The right dock expands from the viewport right edge toward the left.
- Closing uses the same path in reverse.
- The content component receives `open=true` during the closing animation because
  `RightDockShell` returns `null` when `open=false`.
- The outer rail owns visibility and clipping.

### Toggle State

The toolbar toggle must use user intent, not mounted DOM state.

```text
intent open: sidePanelOpen && !utilityPageOpen
mounted: intentOpen || renderedDuringMotion || closingDuringMotion
expanded: visual width target
```

This distinction is required because close animation keeps the DOM mounted. If the button
uses `mounted` as its toggle source, rapid clicks during close will repeatedly call
`close` instead of reversing to `open`, which makes the button feel dead.

Correct behavior:

- intent open + click -> close,
- intent closed + click -> open,
- closing + click -> reverse to open,
- opening + click -> reverse to close.

The icon and `aria-expanded` should reflect intent, not animation mount state. The rail
can still stay mounted while the icon already shows the next possible action.

### Environment Rail

- The Environment popover stays independent from the right dock toggle state.
- If the right dock is open and enough width remains, Environment renders as an inline
  rail immediately to the left of the right dock.
- If width is not enough, Environment hides before it can overlap the conversation.
- Closing the right dock must not also close Environment state. It only changes
  Environment placement.
- Hidden Environment must not reserve layout width. Floating Environment is an overlay
  anchored to the shell edge, so it must not add padding, margin, transform, or hidden
  width to the conversation rail.
- Inline Environment is the only Environment placement allowed to consume grid width.
  If it cannot fit beside the right dock while preserving the minimum conversation
  width, it hides instead of partially reserving space.

### Conversation Rail

- Conversation and composer keep the same vertical position while right dock opens or
  closes.
- The rail may shrink horizontally when the right dock or Environment rail is visible.
- The rail remains centered inside the available shell space.
- No `scrollTop` restoration loop is allowed as a right-dock animation strategy.

## Implementation Plan

### Slice 1: Layout Model

Add a focused layout helper near the workspace feature:

```text
apps/web/src/features/workspace/layout/channel-workspace-layout.ts
```

It owns:

- rail constants,
- right dock width clamping,
- motion easing,
- Environment inline-placement decision,
- target layout widths for the right dock and resize handle.

### Slice 2: WorkspaceClientView Boundary

`WorkspaceClientView` keeps state but delegates calculations:

- `channelRightDockVisible`
- `progressPopoverInMainLayout`
- `channelRightDockLayoutTargets`
- right dock resize clamp

Remove the right-dock-specific message feed anchor restore path. Keep existing message
feed logic for older-message loading and user scroll intent.

### Slice 3: CSS Shell Cleanup

- Replace `:has(.channel-side-panel)` selectors with explicit shell classes.
- Delete old `.progress-open` layout selectors that changed conversation padding,
  margin, or transform. Environment visibility must not be expressed as a hidden
  conversation offset.
- Keep `.channel-side-panel-frame` as the clipping rail.
- The frame width animates from `0px` to the computed dock width.
- The dock content keeps fixed width and is justified to the rail's right edge.
- Environment inline rail is a grid column, not an overlay.

### Slice 4: Regression Tests

Add e2e assertions to the Environment/right-dock flow:

- Environment and right dock do not overlap when both are visible.
- When right dock is opened and closed, `.activity-chat-layout` top and height remain
  stable within 1px.
- When the dock is resized too wide, Environment hides instead of covering the
  conversation.
- Closing the dock does not close the Environment state; it can reappear when space is
  available.

## Non-Goals

- No full extraction into `@ling-stack/conversation-ui-react`.
- No cross-surface migration for normal conversation or private chat.
- No change to Git status, Review queue, or commit/push semantics.
- No new visual redesign of the dock contents.

## Acceptance Criteria

- Opening the right dock does not visibly move the conversation vertically.
- Closing the right dock reverses the same animation path.
- Environment rail pushes into available space when possible and hides when not possible.
- Right dock resize preserves the minimum conversation width.
- No `:has(.channel-side-panel)` selector remains in the channel shell path.
- Typecheck and targeted channel e2e pass.
