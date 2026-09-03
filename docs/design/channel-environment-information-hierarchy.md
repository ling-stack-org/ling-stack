# Channel environment information hierarchy

Status: current product and information-architecture contract
Owner: Web and Daemon maintainers
Last verified: 2026-09-03
Document type: product and information-architecture contract
Code anchors: `apps/web/src/features/workspace/ChannelEnvironmentPage.tsx`, `apps/web/src/styles/channel-task-environment.css`
Test anchors: `apps/web/e2e/ui2-channel-task-environment.spec.ts`

## Scope

The channel Environment page reports the execution directory, Git context, review
work, commit preview, and linked evidence. Visual simplification must preserve
these existing information and interaction paths. The page does not repeat the
current channel identity already owned by the channel header.

## Rendering contract

- The page title is `Environment`. It does not repeat the channel name as a gray
  subtitle.
- The header keeps the existing overall state indicator. Error, conflict, loading,
  attention, and ready states must remain distinguishable.
- The workspace row owns the execution path, workspace mode, and directory picker.
  The path is rendered as compact monospace text on one line, truncates with an
  ellipsis when space is constrained, and exposes the full value through a title.
  It must never wrap or displace the directory action.
- Every environment row shares the same desktop columns for identity, detail,
  state, and action. Desktop state indicators share one fixed column and one left
  edge, while actions remain right-aligned in their own column. Missing actions
  leave their column empty instead of shifting the detail or state columns.
  Constrained layouts collapse all rows to the same two-column, two-line pattern.
- Changes, review, branch, and commit-preview rows stay present so users can inspect
  both available and unavailable states without losing established entry points.
- The commit/push surface remains a read-only preview until the daemon exposes an
  executable, policy-governed operation; the preview and its explanation are still
  part of the existing product contract.
- Browser, source, and output categories remain visible when empty as well as when
  populated. Empty labels explain the absence of evidence without removing the
  category itself.

## Ownership

The same environment projection feeds the channel summary popover and the full
page. CSS owns density, alignment, truncation, and responsive layout only. It must
not remove a capability or data category to create a quieter appearance.
