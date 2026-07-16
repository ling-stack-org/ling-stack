# Channel Settings Tabbed Information Architecture

## Status

Implemented UI slice for the channel settings page.

This redesign changes layout and information hierarchy only. It does not change channel,
workspace, teammate, council, notification, or health persistence semantics.

## Problem

The previous channel settings page rendered every concern in one scrolling stack:

- channel identity and runtime policy,
- notification preferences,
- execution path and workspace handoff,
- direct channel teammates,
- AI councils,
- team health metrics.

This made editing and monitoring compete for attention. It also repeated channel-level
information and exposed a second refresh action even though the page header already owns
refresh.

## Product Decision

Use one horizontal settings navigation below the page header:

```text
常规 | 工作区 | 成员 | 智囊团 | 健康
```

Only the active section is mounted. The page header remains the single channel identity
surface and the single refresh entry point.

## Section Ownership

### 常规

- channel name,
- run provider,
- AI response language,
- execution mode summary,
- notification level.

### 工作区

- execution path,
- write-lock scope,
- local/worktree/external binding state,
- create, refresh, open, and handoff actions.

### 成员

- direct channel teammate membership,
- add and remove actions,
- entry to the workspace teammate manager.

### 智囊团

- attached councils,
- preferred council,
- council boundaries and health,
- projected specialists.

### 健康

- read-only team metrics,
- evidence health,
- risk and learning projections,
- agent activity.

## Layout Rules

- The horizontal navigation stays visible while section content scrolls.
- Tabs are equal-width on desktop and horizontally scrollable on narrow viewports.
- The general section uses a 60/40 information-to-notification split.
- Settings use aligned rows and separators instead of nested cards.
- Repeated objects such as teammates, councils, and metrics may retain compact item cards.
- The channel name and provider are not repeated in a separate profile or summary block.
- The header refresh command is the only page-level refresh command.

## Interaction Rules

- Opening settings starts on `常规`.
- Changing the selected channel resets the active section to `常规`.
- Left/right arrow keys, Home, and End move through the tab list.
- Each tab exposes an ARIA tab/tabpanel relationship.
- Existing save, directory selection, workspace handoff, member, council, notification,
  and health behaviors remain unchanged inside their owning section.

## Responsive Rules

- At widths below 900px, the general section becomes one column.
- At widths below 680px, setting rows stack their label and control while preserving icon
  alignment.
- Notification options stack vertically on narrow screens.
- The tab strip scrolls horizontally instead of compressing labels until they overflow.

## Acceptance Criteria

- `常规` does not render workspace, member, council, or health controls.
- Workspace controls are available only under `工作区`.
- Direct teammates and councils no longer share the same viewport.
- No duplicate channel summary or secondary page-level refresh action is visible.
- Existing settings actions remain functional after switching sections.
- Typecheck, focused channel settings E2E, Chinese localization E2E, and visual QA pass.
