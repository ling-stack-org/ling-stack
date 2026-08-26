# Sidebar, Approval, And Proposal Dialogs Implementation Plan

Status: active implementation plan
Owner: Web AppShell, conversation surfaces, and approval presentation

## Owning Contracts

- [AppShell, Sidebar, and Global Navigation](ui2.0升级/modules/01-AppShell与全局导航.md)
- [Runtime Approval Dialog Detailed Design](inline-runtime-approval-detailed-design.md)
- [Conversation Surface Contract](conversation-surface-contract.md)
- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)

## Guardrails

- Start from a clean worktree based on current `origin/main`; preserve existing dirty
  worktrees and the service already using port `5173`.
- Do not change daemon APIs, database records, approval policy, proposal state machines,
  shared Composer public props, button dimensions, or external-action review behavior.
- Keep dialogs in the existing global overlay root. Do not add feature-owned portals or
  private high z-index layers.

## Slice 1: Sidebar Titles

- Move status and row tools out of grid flow into a right overlay. Give the title the
  full row width and detect overflow with `ResizeObserver`.
- Apply right-edge fade only to overflowing labels. Hover/focus moves the title track to
  its measured end and leaves/blur resets it; reduced motion skips movement.
- Extend the shared Sidebar tooltip with an optional rich, non-interactive preview made
  only from already loaded row metadata.

Acceptance: no hard ellipsis on recent titles, no reserved hidden-action column, no
horizontal overflow, and tools remain pointer/keyboard reachable without navigation.

## Slice 1B: Unified Sidebar Object Context

- Use one shared non-interactive preview for channel, teammate private-chat, and recent
  conversation rows. The preview always contains the complete title and latest known
  activity time, with optional repository and branch labels. It does not repeat the
  surface type already communicated by the Sidebar section.
- Derive conversation workspaces from the newest loaded Run for each of the five visible
  conversation threads, but only when the Run uses an object-specific path distinct from
  the shared global workspace. Derive channel workspaces from the current workspace
  binding first, then a distinct newest channel Run, then a distinct explicit bound path.
  Derive teammate private-chat workspaces only from the newest non-channel Run for that
  teammate when it is also distinct from the global workspace. A historical Run in the
  shared workspace must not be relabeled with that directory's current branch. Do not add
  thread fields, database columns, or a new daemon API.
- Inspect each unique candidate workspace once through the existing workspace-changes
  endpoint and share the result across rows. A failed, unavailable, or non-Git result is
  an absent projection rather than a Sidebar error.
- Keep the normal row single-line title behavior unchanged. Show repository and branch
  only inside the shared rich hover/focus preview, using folder and branch icons. Do not
  expose an absolute local path in the preview and do not render a missing-data placeholder.
- Git inspection must be bounded to visible Sidebar objects, cancellable on projection
  changes, and independent from object loading and selection.

Acceptance: channel, private-chat, and conversation previews share one visual structure;
each object with a resolved Git workspace shows the repository directory name and current
branch, while objects without Git context preserve the base preview with no placeholder.

## Slice 2: Runtime Approval Dialog Queue

- Keep `buildInlineApprovalViews` as the selection and ordering adapter, but render its
  output through `RuntimeApprovalDialogQueue` outside Composer slots.
- Mount the queue in channel, normal conversation, and teammate private chat. Show one
  item at a time, prevent passive dismissal, show one localized action sentence, and keep
  mutation errors visible for retry. Remove reason, risk, payload, scope-delta, id, path,
  queue-count, and technical-detail fields from the active dialog.
- Give the blocking runtime queue precedence over the dismissible task proposal dialog;
  never mount two competing modal decisions at once.
- Derive `dialog_owned_pending` presentation from the same ordered
  `InlineApprovalView` collection consumed by the dialog. Pass that projection through
  normal conversation, channel, and private-chat renderers instead of re-deriving it
  from raw WorkCell rows.
- While dialog-owned, replace the owning WorkCell's expandable approval projection with
  one localized, non-interactive pending marker. Do not render raw approval titles,
  operation rows, evidence groups, or duplicate approval controls behind the modal.
- After resolution, use each surface's existing refresh path. Compact transcript and run
  history remain the durable status surface, while complete payloads stay in Run detail
  and audit views.

Acceptance: pending approvals never change Composer height, all three surfaces support
approve/deny and stale removal, no approve-all action exists, and the virtual feed behind
the modal contains no second expanded representation of the active approval.

## Slice 3: Channel Execution Proposal Dialog

- Replace `ChannelExecutionProposalCard` in the feed with a compact summary. Its action
  opens a centrally mounted `ChannelExecutionProposalDialog`.
- Auto-open the newest newly actionable proposal once per id/revision. The user may
  dismiss it and reopen it from the summary.
- Keep task title, assignee, localized required-permission labels, blockers, and primary
  actions visible. The default dialog contains no acceptance criteria, collaboration
  history, risk narrative, permission explanation, or technical disclosure. Editing uses
  a separate explicit state.
- Suppress the duplicate requirement-shaping transcript block whenever its proposal is
  present. Keep only an actual unanswered user question as a compact decision-needed row.

Acceptance: virtual-feed scrolling cannot unmount the dialog; save/authorize/cancel and
blocker repair preserve existing callbacks and error behavior.

## Verification

- Unit/component coverage: overflow measurement, queue sorting, stale items, focus,
  auto-open-once, dismiss/reopen, edit/save, mutation errors, shared Git-workspace
  inspection, and non-Git omission.
- Playwright coverage: expanded/collapsed Sidebar, channel/normal/private approvals,
  proposal dialog, proposal-assignee avatar identity, Git preview metadata, light/dark,
  `1280x800`, and `1440x960`.
- Pending-approval regression coverage must assert that the modal and one compact marker
  coexist without approval titles, raw permission ids, expandable evidence, duplicate
  action rows, or Composer geometry changes. It must also cover approve/deny transition
  back to normal or immutable history projection.
- Real-browser evidence must come from messages submitted through the running Web app:
  capture a blocking runtime approval, the compact channel proposal summary, the
  independently mounted proposal authorization dialog, and the shared channel,
  private-chat, and conversation previews. Static fixtures alone are not final acceptance
  evidence for message-driven states.
- Run Web typecheck, lint, i18n, build, relevant package tests, real-browser interaction,
  console/page-error checks, and `git diff --check`.
