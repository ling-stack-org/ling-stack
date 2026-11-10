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
- Healthy attached councils do not render a `Health clear` row. Council health appears only
  when a warning or critical finding needs attention.
- Attached-count and preferred-state metadata must not collapse into unexplained compact
  dots. The checked `Preferred` action is the single visible preferred-state owner.

### 健康

- read-only team metrics,
- evidence health,
- risk and learning projections,
- agent activity.
- The summary surface shows primary labels and counts without generic read-only explanations,
  raw English metric sentences, or backend policy notes. Independently meaningful risk,
  reliability, learning, and agent-activity values must remain visible rather than being
  collapsed into one aggregate number.
- The selected `健康` tab already identifies the page. A detached `健康` status pill is not
  rendered; delayed, unavailable, risk, reliability, and critical counts carry the actionable
  state directly.
- Real agent activity may show its latest summary. An empty activity list is represented by
  its zero count and does not add a second empty-state sentence.
- Notification controls remain owned by `常规`; `健康` does not duplicate or hide them.

## Notification Semantics

- Notification levels are persisted by workspace and channel identity. They do not change
  private-message notifications and never pause channel tasks, runs, or approvals.
- `all` surfaces ordinary unread messages and activity, mentions, approval requests, and
  blockers.
- `mentions` surfaces local-user mentions, approval requests, and blockers. Ordinary
  messages and running activity remain quiet.
- `muted` suppresses ordinary messages, activity, mentions, failures, and low/medium/high
  approval requests. Only pending approvals whose canonical risk is `critical` surface.
- A paused channel remains visible as paused in every level because pause is persistent
  channel state, not a notification.
- The shared segmented control owns selected-state styling through `data-state="on"`.
  Feature compatibility CSS must not replace that state with a legacy `.active` selector.

## Layout Rules

- The horizontal navigation stays visible while section content scrolls.
- Tabs are equal-width on desktop and horizontally scrollable on narrow viewports.
- The general section uses a 60/40 information-to-notification split.
- Each tab panel owns its own maximum width and uses the shared centered panel
  contract. Inner settings surfaces fill that panel; they must not apply a second
  narrower, left-aligned width.
- Settings use aligned rows and row separators instead of nested cards.
- The tab strip owns the only visible divider between navigation and content. Content
  surfaces do not repeat that boundary with their own top borders; parallel divider
  segments are a layout ownership defect.
- Repeated objects such as teammates, councils, and metrics may retain compact item cards.
- The health summary owns its vertical rhythm at the panel level. Its heading, metric
  grid, breakdown grid, and teammate activity are separate sibling groups with one
  shared gap; child cards must not simulate that spacing with local margins.
- The channel name and provider are not repeated in a separate profile or summary block.
- The header refresh command is the only page-level refresh command.
- In `工作区`, the upper controls edit the channel's persistent execution path and
  write lock. `当前工作区` reports the effective runtime location and owns worktree,
  refresh, open, and handoff actions. Its `本地 / 工作树 / 外部` mode remains visible
  as plain text without a decorative status dot. When the effective path equals the
  already displayed workspace root, it is not repeated below as the Unix `.` alias;
  distinct child, worktree, and external paths remain visible in compact form.

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
- The general information and notification surfaces have no top border; the tab strip
  retains the single navigation-to-content divider.
- Existing settings actions remain functional after switching sections.
- Each notification level has one visually distinct selected segment, persists for the
  current workspace/channel only, and applies the sidebar filtering semantics above.
- Typecheck, focused channel settings E2E, Chinese localization E2E, and visual QA pass.
