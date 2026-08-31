# Conversation Right Dock Responsive Visibility Implementation Plan

Status: active implementation plan
Date: 2026-08-29
Scope: Web/Desktop channel, normal conversation, teammate private chat

Related contracts:

- [Conversation Right Dock Workspace Tools](conversation-right-dock-workspace-tools.md)
- [Conversation Surface Contract](conversation-surface-contract.md)

## Problem

The three conversation surfaces currently combine shared JavaScript open state with
surface-specific responsive CSS. At narrow widths, private chat can hide the dock frame
and resize handle while a higher-specificity grid rule still reserves their `304px + 8px`
columns. Normal conversation and channel avoid that exact white gap, but still project the
same request differently.

## State And Ownership

`useConversationRightDockController` is the source of truth for:

- `requestedOpen`: the caller's persisted user intent;
- `available`: viewport width is greater than `900px`;
- `renderedOpen`: the dock is actually available and present;
- `resizable`: the dock is rendered, expanded, and using the inline presentation;
- width and handle layout variables.

The controller sets layout width and handle width to zero whenever the dock is unavailable.
Channel, normal conversation, and private chat consume these projections for classes,
mounting, toolbar state, accessibility, and resize behavior. CSS only places the resulting
inline frame; it does not own responsive visibility.

## Implementation Slices

1. Extend the shared controller with viewport availability, actual rendered state, and
   resize capability. Drive panel presence from `requestedOpen && available`.
2. Update all three conversation surfaces and their toolbars to use actual visibility for
   active and `aria-expanded` state, and disable Details while unavailable.
3. Remove the three local `max-width: 900px` dock-hiding rules. Keep unrelated responsive
   feed, thread, and AppShell behavior unchanged.
4. Add regression coverage at `900px`, below `900px`, and above `900px`, including the
   private-chat specificity case that previously reserved a blank `312px` region.

## Acceptance

- At `901px` and above, all three surfaces show the inline dock and resize handle, and the
  dock can be resized without document-level horizontal scrolling.
- At `900px` and below, all three surfaces use the full conversation width; dock frame,
  resize handle, and reserved columns are absent.
- Details active state and `aria-expanded` match actual visibility. The unavailable action
  is disabled and cannot request an invisible page.
- Narrow-to-wide restoration may preserve an existing open intent, but never exposes a
  blank region during the transition.
- Tests cover light and dark themes, `866x994`, `900x800`, `901x800`, and at least one
  standard desktop viewport. Real-browser screenshots come from the running `5175` source
  server and include private chat, normal conversation, and channel.

## Non-Goals And Hard Stops

- Do not add an overlay drawer at narrow widths.
- Do not change Right Dock contents, backend APIs, persistence, or approval behavior.
- Do not change the Sidebar breakpoint or compact-rail behavior.
- Do not solve the defect with a higher-specificity one-off selector. The shared state and
  layout variables must make the invalid half-state unrepresentable.
