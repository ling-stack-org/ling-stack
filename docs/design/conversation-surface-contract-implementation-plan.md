# Conversation Surface Contract Implementation Plan

Status: active implementation plan
Owner: conversation UI package and product-surface maintainers
Last verified: 2026-08-30

## Canonical Transcript Plan

对于会话正文、事实行、command/exploration batching、子 Agent 和环境浮窗，执行
[Ling Typed Transcript Detailed Design](conversation-typed-transcript-detailed-design.md)
及其 [Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md)。
本文下面的 WorkCell、evidence block 和 surface slice 记录的是已交付的迁移前基础；
新代码不得在这些旧边界上再造第二套 renderer 或 summary owner。

## Owning Contracts

- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation Surface Taxonomy](conversation-surface-taxonomy.md)
- [Conversation Shared Capabilities](conversation-shared-capabilities.md)
- [Conversation Media Generation Tools](conversation-media-generation-tools.md)

The contracts own product behavior. This plan tracks only the remaining shared-package
and consumption work.

## Current Baseline

- Shared conversation primitives and view models exist.
- Channel, normal conversation and teammate private chat reuse shared message, feedback,
  permission, avatar, source and Composer foundations.
- Compact work presentation and focused regression coverage are present.
- Core-only package extraction has started without moving API, routing or persistence into
  the presentation package.
- Cross-surface synchronization keeps normal conversation avatar-free, shares model blocker
  and drag/drop behavior, projects approvals and interventions, carries structured file
  references, and keeps active-run follow-ups in the original conversation thread.

## Completed Synchronization Slice

- Normal conversation, channel and private chat use policy-owned avatar visibility and
  shared ordinary-message geometry; normal conversation keeps both avatar flags disabled.
- Normal conversation and private WorkCells consume real associated approvals.
- Active normal-conversation messages reuse `queue_followup`, appear immediately as one
  ordinary user message and do not expose queue-specific chrome.
- Tool, approval, artifact and intervention events invalidate selected conversation detail
  through existing SSE/control-plane streams without idle polling.
- Shared message bodies use stable 15px/550 strong text from the first pending frame;
  the 13px pending spinner uses a shared 5px first-line offset.
- Channel optimistic sends retain one virtual render identity through acknowledgement and
  reply start. The daemon emits canonical `reply_pending` only for a message that owns an idle
  lane; queued follow-ups return durable dispatch directly and move out of the transcript.
  A measured tail observer follows once per frame only while
  the user remains at latest, and virtual `paddingEnd` owns the 38px Composer clearance.
- Channel, normal conversation and teammate private chat use one pending-asset component.
  Attachments and links stay in one non-wrapping row with internal horizontal scrolling.
- Successful text-only chat runs stay quiet. WorkCell remains for tools, approvals,
  artifacts, durable changes/risks and failed or approval-blocked runs.
- Final assistant text from `message_end` is persisted as a fallback when a compatible
  provider emits no text deltas; fully empty chat output becomes a localized message-level
  failure. Provider checks also reject successful HTTP responses with no displayable text
  as `empty_response`.
- A persisted conversation-media projection counts as a visible terminal result. Tool-only
  success keeps an empty, successful assistant row and renders the shared media block across
  normal, initial-channel, channel-continuation and private-chat paths; only runs with neither
  text nor media use the localized empty-response failure.
- Ordinary channel replies now execute as standard `RunSession` records. Their
  `channel_ai_reply` WorkUnit is only the supervision projection linked to that run and
  message; guidance reuses the existing `RunIntervention`, cancellation and continuation
  paths. The Composer has no target selector. The daemon resolves no mention to Ling Agent,
  one mention to that teammate, and multiple mentions back to Ling Agent for coordination;
  Web does not submit a second teammate-selection field. No second guidance queue or table
  is added.
- Channel guidance now uses the same lightweight composer projection as normal
  conversation: active replies add no standalone run card or empty guidance panel, the
  ordinary mention input is the only targeting control, and actionable approval/provider
  exceptions retain their shared status strips.
- Every non-empty submission is persisted through the ordinary channel-message path. If the
  channel has any active reply, it returns `replyDispatch.disposition=followup_queued`
  regardless of target availability; only an idle channel may return `reply_requested`.
- Message-backed interventions remain durable and appear once in the Composer queue while
  their source messages stay out of the transcript. At `starting_continuation`, the queue item
  leaves and the durable source message enters the transcript. Activity-transition refreshes
  are silent after the selected channel has completed its first load.
- A daemon-local pending-reply lane closes the materialization-to-Run-link race for rapid
  submits. It is keyed by workspace and channel, releases on failed or no-Run dispatch, and
  never replaces durable messages or `RunIntervention` rows.
- Target identity remains canonical across mention resolution, queue payload, pending reply,
  WorkUnit and Run. No mention resolves to `ling_agent`; no ordinary dispatch path may
  manufacture `ai-teammate` as an executor id. A later message joins the existing channel
  lane and creates `queue_followup` instead of starting a second root Run.
- Channel intervention payloads persist the source user-message id and resolved target
  teammate id explicitly. Every continuation re-resolves that target's current model binding,
  pre-creates its Agent reply, links the continuation WorkUnit from source user message to
  Agent reply, projects the run output into that reply, and writes
  `completedAt` for every terminal outcome.
- Channel continuation prompt ownership now matches ordinary channel replies: the durable
  guidance message is rebuilt as the Context Pack's current `User message`, while the
  source Run prompt and earlier completed continuation replies are reference context only.
  The old source prompt is never wrapped around the new guidance as the active instruction.
- Channel message text never selects `interrupt_redirect`. Empty submit stops the one active
  channel reply. While that reply exists, no idle target may start a parallel normal reply;
  every later message becomes the next FIFO intervention while retaining its own target.
- All three conversation surfaces now use one owner-scoped send lifecycle. The initial
  payload is accepted once, a durable `reply_linked` target unlocks the Composer even when
  its status is still `queued`, and each rapid follow-up retains an independent request
  identity until accepted or failed. A later send cannot invalidate an earlier in-flight
  request or clear newly entered text. Owner changes still reject stale SSE events. Older Run
  detail snapshots cannot overwrite newer list state, and every unmentioned channel message
  resolves to Ling Agent without inheriting a previous target.
- File paste is controlled inside `TokenizedComposerInput`: files use the existing shared
  attachment controller and text paste uses `text/plain` only, so clipboard HTML cannot
  create oversized raw image nodes.
- Pre-accept failures restore the draft and pending assets. Post-accept failures keep the
  payload consumed to avoid duplicating a message that may already be durable.
- Channel-only teammate routing, topic replies, goals, plans and multi-agent activity remain
  channel-only.

## Active Approval And Proposal Dialog Slice

- Replace Composer-owned pending approval strips with one shared blocking dialog queue.
  Channel, normal conversation, and teammate private chat keep their existing eligibility
  projections and domain callbacks; no shared component fetches or mutates daemon state.
- Reduce the active dialog to one localized action sentence and direct allow/deny actions.
  Keep raw payload, policy context, ids, risk metadata, and optional decision reasons in
  durable audit surfaces rather than progressively disclosing them in the dialog.
- Keep immutable approval outcomes in WorkCell/transcript history and keep external-action
  approvals in their existing Review Queue path.
- Replace the large channel execution-proposal feed card with a compact summary and mount
  the editable, dismissible proposal dialog at `WorkspaceClientView` level. Auto-open only
  the newest newly actionable proposal once per proposal revision.
- Make that compact proposal summary the sole default feed projection for requirement
  shaping. Suppress internal status and collaboration records; preserve only real
  unanswered user questions as compact decision-needed rows.
- Preserve existing approval endpoints, proposal endpoints, policy semantics, virtual-feed
  ownership, and `ConversationComposerShell.approvalNode` API while removing its production
  consumers.
- Acceptance requires stable Composer geometry, single-item risk/time queue ordering,
  mutation retry, focus restoration, proposal dismiss/reopen, and all three conversation
  surfaces.

## Active Recent Conversation Git Preview Slice

- Project optional repository/branch metadata from the newest loaded Run associated with
  each of the five visible recent conversations.
- Deduplicate workspace checks and use the existing `getWorkspaceChanges` API. Keep the
  check asynchronous and fail-quiet so Sidebar loading, selection, and status projection
  never wait on Git.
- Extend the existing rich Sidebar preview with repository and branch rows. Preserve the
  title row geometry, overflow animation, status/action overlays, and collapsed rail.
- Verify Git, non-Git, duplicate-workspace, unavailable, light/dark, and horizontal
  overflow states. Final evidence also includes a real message-submission run in the
  in-app browser rather than fixture screenshots only.

## Remaining Work

### Generated Media Capability

- Execute the four batches in the dedicated
  [Conversation Media Generation Tools Implementation Plan](conversation-media-generation-tools-implementation-plan.md):
  Runner Tool, generation routing, background projection, and three-surface consumption.
- Keep MediaJob as the artifact owner and pass typed generated-media views into the shared
  conversation package; no shared presentation package may fetch MediaJob state.
- Register paid generation tools only for user-visible conversation runs with a runnable
  target. Observer and summary runs remain excluded.

### WorkCell Boundary

- Finish the shared WorkCell shell and typed operation/result projections.
- Keep run, approval and artifact state in existing domains; the package receives view
  models and callbacks only.
- Preserve quiet normal messages and compact durable warning/approval history.

### Evidence And Attachments

- Consolidate source, artifact, diff and command evidence into shared typed projections.
- Finish sent-attachment rendering, failure and recovery states without exposing raw
  payloads. Pending Composer previews are already shared across all three Web surfaces.
- Keep large content lazy and cancellable; stale hydration cannot replace newer content.

### Package CSS

- Move only component-owned selectors into the shared package.
- Keep page geometry and product-specific layout in the consuming application.
- Remove compatibility selectors only after every production consumer and test is migrated.

### Desktop Consumption

- Let Desktop renderers consume the same primitives, tokens and state semantics through
  typed adapters.
- Do not move Electron IPC, window lifecycle or media ownership into the UI package.
- Verify compact windows independently from full AppShell geometry.

## Module Boundaries

```text
@ling-stack/conversation-ui-core
  -> framework-neutral types, parsing and view-model helpers

@ling-stack/conversation-ui-react
  -> React presentation over ui-react primitives

apps/web and Desktop renderers
  -> API, i18n, routing, domain state and product geometry
```

No shared package may own daemon requests, storage, permission decisions or route state.

## Verification

- Unit tests cover view-model normalization, long content and stale response rejection.
- Web E2E covers all three conversation surfaces, keyboard behavior, Light/Dark and error
  ownership.
- Desktop focused tests cover compact consumption and theme/locale propagation.
- Package extraction must not weaken existing run, approval or artifact assertions.

## Closure

Close after WorkCell, evidence, attachment, package CSS and Desktop consumption boundaries
are complete. Merge durable rules into the owning contracts and delete this plan.
