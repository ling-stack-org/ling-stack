# Sidebar, Approval, And Proposal Gates Implementation Plan

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
- Keep only full-access confirmation in the existing global overlay root. Runtime approval
  and task proposal decisions are session-owned and stay in the Composer slot without a
  portal, backdrop, or private high z-index layer.

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

## Slice 2: Session-Owned Runtime Approval Gate

- Introduce one presentation-only `ConversationDecisionGate` for decision title, one
  human-readable sentence, one-line mutation error, and deny/allow actions. Runtime
  approval and task proposal adapters share this exact shell and button geometry.
- Keep `buildInlineApprovalViews` as the selection and ordering adapter, but render its
  output through `RuntimeApprovalComposerGate` in the owning Composer slot.
- Resolve ownership once through the shared owner resolver. Explicit channel ownership
  wins, then linked Run, Task or Workflow, then compatibility payload Run fields. Never
  use a global foreground `activeRunId` as ownership evidence, and leave unprovable
  approvals in the Approval Inbox.
- For a linked non-channel Run, use its durable Work Unit kind as the surface discriminator:
  `conversation_run` owns the normal conversation and `teammate_direct_reply` owns the
  private chat. Do not infer private ownership from `teammateId`, because normal Ling Agent
  Runs carry that field too. For private chat, map the execution thread to the visible
  direct-message thread through the Work Unit source message, linked reply, or matching
  `linkedRunId`; require every available link to agree. If a referenced Work Unit or direct
  message is not loaded, or the links conflict, fail closed to the Approval Inbox until
  ownership can be proven.
- Mount the gate in channel, normal conversation, and teammate private chat. Show one
  item at a time, show one localized action sentence, and keep mutation errors visible
  for retry. Remove reason, risk, payload, scope-delta, id, absolute path, queue-count,
  and technical-detail fields from the active gate.
- Do not give a background runtime approval global modal precedence. The active session
  remains usable unless it owns the approval; Sidebar navigation always remains usable.
- Derive `composer_gate_pending` presentation from the same ordered
  `InlineApprovalView` collection consumed by the gate. Pass that projection through
  normal conversation, channel, and private-chat renderers instead of re-deriving it
  from raw WorkCell rows.
- While Composer-gate-owned, replace the owning WorkCell's expandable approval projection with
  one localized, non-interactive pending marker. Do not render raw approval titles,
  operation rows, evidence groups, or duplicate approval controls in the feed.
- Project pending ownership into channel, private-chat, and recent-conversation Sidebar
  rows. Expanded rows show green `Waiting for approval` text; collapsed rail sections
  retain their aggregate status signal. Sidebar and Composer consume the same resolved
  owner so they cannot disagree about which session is waiting.
- After resolution, use each surface's existing refresh path. Compact transcript and run
  history remain the durable status surface, while complete payloads stay in Run detail
  and audit views.

Acceptance: a pending approval replaces only its owning Composer, background approvals do
not block the current conversation, all three surfaces support approve/deny and stale
removal, no approve-all action exists, and the feed contains no second expanded
representation of the active approval.

## Slice 2B: Full Access Confirmation

- Selecting full access opens the shared confirmation Dialog before changing the preset.
- Show files/folders, terminal commands, Internet/connected apps, and a concise sensitive
  data and prompt-injection warning.
- Cancel preserves the prior preset, draft, and focus. Confirm records the existing
  conversation-scoped evidence and then activates full access.
- Apply the same behavior to channel, normal conversation, and teammate private chat.

## Slice 3: Channel Execution Proposal Composer Gate

- Replace `ChannelExecutionProposalCard` in the feed with a compact summary. Its action
  selects that proposal for the owning channel's Composer slot; it never opens a portal.
- In the selected channel, presentation priority is runtime approval gate, selected
  actionable task proposal gate, then normal Composer. An actionable background proposal
  cannot replace the Composer of another channel.
- Render one sentence naming the task, assignee, and localized required-permission
  categories, then only `Deny` and `Allow`. Deny uses the existing proposal-cancel
  callback and Allow uses the existing confirm callback. Mutation failure remains as one
  retryable line.
- Do not render task/Agent/permission tables, Edit, Cancel proposal, Close, acceptance
  criteria, collaboration history, risk narrative, blockers as technical detail, or any
  expandable disclosure in the decision gate.
- Suppress the duplicate requirement-shaping transcript block whenever its proposal is
  present. Keep only an actual unanswered user question as a compact decision-needed row.

Acceptance: virtual-feed scrolling does not affect the Composer gate; summary activation,
deny/allow, failure retry, owner-channel isolation, and Composer restoration preserve the
existing proposal state machine.

## Slice 4: Operation-Shell Content Inset

- Keep `conversation-operation-shell` free of outer padding so expandable rows retain
  their existing alignment.
- Give every direct visual payload one semantic slot: head, body, or static content. The
  static content slot owns the shared inline inset and minimum width; pending approval
  markers use that slot instead of depending on incidental parent padding.
- Regression assertions measure the marker content against both shell edges. No
  screenshot-only selector or one-off margin is accepted.

## Verification

- Unit/component coverage: overflow measurement, queue sorting, stale items, focus,
  auto-open-once, dismiss/reopen, edit/save, mutation errors, shared Git-workspace
  inspection, and non-Git omission.
- Playwright coverage: expanded/collapsed Sidebar, channel/normal/private approvals,
  proposal Composer gate, proposal-assignee identity, Git preview metadata, light/dark,
  `1280x800`, and `1440x960`.
- Pending-approval regression coverage must assert that a background owner only marks its
  Sidebar row, the active unrelated Composer remains usable, and the owner replaces only
  its Composer with one gate and one compact marker. It must cover approve/deny transition
  back to the preserved Composer or immutable history projection.
- Real-browser evidence must come from messages submitted through the running Web app:
  capture a session-owned runtime approval gate, its Sidebar waiting label, the compact channel proposal summary, the
  channel-owned proposal Composer gate, and the shared channel,
  private-chat, and conversation previews. Static fixtures alone are not final acceptance
  evidence for message-driven states.
- macOS native-titlebar evidence must come from the built Electron client for this branch.
  A Web fixture with injected Desktop globals is supporting test coverage, not Desktop
  acceptance evidence.
- Run Web typecheck, lint, i18n, build, relevant package tests, real-browser interaction,
  console/page-error checks, and `git diff --check`.
