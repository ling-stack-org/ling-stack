# Conversation UI Framework Temporary Implementation Checklist

Status: temporary implementation checklist. P0 active-source design closeout complete;
P1 core transcript framework complete; P2 main conversation ownership verified for
approval/source overlays and workflow packet summaries; P3 blocked/waiting/failed
agent span visibility baseline verified; P4 requirement-shaping transcript and useful
participant contribution filtering verified; P5 rich text/code/diff/copy baseline
verified; P6 artifact preview and image compare baseline verified; P7 inline feedback,
background toast, focused block shortcuts, and safe mobile gesture baseline verified; P8
motion, auto-scroll, and scroll-anchor baseline verified; P9 accessibility, i18n, and
performance baseline verified; P10 conversation tokens, visual screenshots, and focused
visual accessibility checks verified; P11 Web-local modularization complete; P12/P13
package and Desktop/PC sync gates defined. Right-side root
utility is settings-only; Files/Review conversation drawer roots and preview components
removed.
Current e2e coverage follows that boundary: Files and Review are not root drawer views;
approval/source details open from the owning conversation surface.

Date: 2026-06-24

Purpose: keep the conversation UI, multi-agent UI, shared UI package, and cross-surface
implementation work aligned while the design is being implemented. Remove this document
or convert it into release notes after the checklist is complete.

Source docs:

- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
- [Conversation UI Framework And Copy Canon Implementation Plan](conversation-ui-framework-copy-implementation-plan.md)
- [Conversation Performance Deferral And Virtualization](conversation-performance-deferral-and-virtualization.md)
- [Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Desktop Shell](desktop-shell.md)

## Non-Negotiable Product Rules

- These are invariant guardrails, not completion tasks.
- The main conversation page owns conversation content: messages, agent operations,
  approvals, checks, command/file evidence, attachments, links, artifacts, source
  summaries, workflow/packet summaries, and previews.
- Right-side drawers or side utilities do not own conversation evidence, attachments,
  links, artifact lists, operation timelines, or workflow/packet summaries.
- Conversation UI is adaptive and block-driven. Do not force every turn through a
  fixed report, fixed card, or fixed template.
- UI structure comes from `ConversationTurn -> TranscriptBlock[] -> renderer
  registry`, not from assistant copy, markdown headings, or teammate labels.
- Running, waiting-for-approval, and blocked agent operations remain visible enough to
  inspect current action and required user authority.
- Completed agent operations may collapse, but inline expansion from the same turn
  must restore operation rows, artifacts, approvals, checks, and bounded output.
- Desktop and private chat consume the same conversation semantics as channel chat.

## P0. Design Closeout

- [x] Confirm this checklist links to all active design sources.
- [x] Mark or update old drawer/detail documents so they cannot be read as active
  conversation evidence design.
- [x] Confirm old collaboration-card/report layouts are superseded by transcript blocks.
- [x] Confirm all implementation docs use "inline expansion", "in-turn preview", or
  "lightbox" for conversation-owned details.
- [x] Confirm no active design says Files, Links, Artifacts, Sources, Approvals, Checks,
  or Result Review belong in a right drawer.

Acceptance:

- [x] `rg` over active design docs shows only negative or historical references for
  conversation-owned drawer evidence.
- [x] `git diff --check` passes for all edited docs.

## P1. Conversation Transcript Framework

- [x] Define `ConversationTranscript`, `ConversationTurn`, `TranscriptBlock`, and
  `TranscriptBlockKind`.
- [x] Define block lifecycle states and revision/update behavior.
- [x] Define display, expanded, preview, and raw/debug render modes.
- [x] Implement a renderer registry keyed by `TranscriptBlock.kind`.
- [x] Remove message-text regex layout inference from default rendering paths.
- [x] Add fixture turns for plain answer, command-only work, approval, artifact-producing
  work, requirement shaping, serial multi-agent, parallel multi-agent, blocked work, and
  interrupted redirect.

Acceptance:

- [x] A direct answer can render without empty operation/artifact/team sections.
- [x] A coding task can render operation, approval, checks, artifacts, and final result
  blocks only when those events exist.
- [x] No component decides first-level layout by matching localized copy.

## P2. Main Conversation Ownership

- [x] Move attachments and links out of conversation drawers and into owning turns.
- [x] Move artifacts, source summaries, checks, approvals, and workflow/packet summaries
  into inline detail or in-turn preview.
  - [x] Render artifact previews from owning operation turns instead of drawer preview
    roots.
  - [x] Open approval detail through a conversation-owned inline detail overlay.
  - [x] Open source summary detail through a conversation-owned inline detail overlay.
  - [x] Keep operation checks reachable from the owning operation row.
  - [x] Add fixture/e2e proof for approval and source overlay triggers.
  - [x] Add workflow/packet summary block rendering and preview ownership.
- [x] Replace drawer previews with in-turn preview or lightbox.
- [x] Preserve current per-agent operation rows such as file edit approvals, generated
  diff artifacts, checks, shell command approvals, and bounded command output.
- [x] Add regression fixtures for running, waiting approval, terminal folded, and terminal
  expanded operation states.

Acceptance:

- [x] Existing visible agent operation rows are not hidden, deleted, anonymized, or moved
  into a drawer.
- [x] A user can audit normal operation evidence without opening a drawer.

## P3. OperationCell And AgentActivitySpan

- [x] Make running operations update the same row in place.
- [x] Commit terminal operation state without appending a duplicate completion row.
- [x] Render serial multi-agent work as ordered agent spans.
- [x] Render safe parallel work as one mutable latest-action line per active agent.
- [x] Keep blocked, failed, and waiting-for-approval spans expanded enough for user action.
- [x] Fold completed teammate history while preserving inline expansion.

Acceptance:

- [x] Serial and parallel multi-agent work do not become raw group chat.
- [x] Agent labels remain visible for ownership: Product, Architect, Engineer, Docs, QA,
  Security, Release, or configured teammate display names.

Evidence:

- `ConversationWorkCell` renders `AgentActivitySpan` groups with latest-row summaries and
  inline expansion.
- `workflow-progress` preserves workflow step order for serial spans and emits one
  latest action per participant group.
- `collaboration-task-work-cell` groups parallel branches by owner, caps visible active
  participants, and keeps overflow inspectable.
- `apps/web/e2e/channel.spec.ts` verifies waiting-for-approval agent spans render their
  detail by default without requiring manual expansion.

## P4. Requirement Shaping UI

- [x] Render requirement analysis as a `requirement_shaping` transcript block.
- [x] Show participant contribution spans only when they affect scope, risk, acceptance,
  conflict, or decisions.
- [x] Show decision-needed rows inline.
- [x] Show proposed workflow preview inline when available.
- [x] Convert resolved shaping into workflow proposal or operation blocks in the same
  owning turn.

Acceptance:

- [x] Requirement shaping is not a free-form multi-agent chatroom.
- [x] Running shaping is expanded enough to show current useful participation.
- [x] Completed shaping can fold but remains inspectable inline.

Evidence:

- `apps/web/e2e/channel.spec.ts` verifies `requirement_shaping` and `decision_needed`
  transcript blocks render in the owning turn.
- `ChannelExecutionProposalCard` remains inline for draft workflow preview, and accepted
  proposals linked to workflows project as operation blocks in the owning turn.
- `conversation-turn-projector` filters low-signal participant contributions before
  rendering contribution spans; `apps/web/e2e/channel.spec.ts` verifies availability-only
  chatter is not shown in requirement shaping.

## P5. Rich Text, Code, Diff, And Markdown

- [x] Add safe markdown rendering with raw HTML disabled.
- [x] Add syntax-highlighted code blocks with language label and copy action.
- [x] Use plain monospace while code streams, then highlight after commit.
- [x] Add structured diff rendering with path, hunk, gutter, add/remove tone, and fallback.
- [x] Add long code/log caps with inline expansion.
- [x] Add copy actions for code, diff, command output, and file preview.

Acceptance:

- [x] Unknown languages and malformed diffs degrade to readable plain text.
- [x] Raw HTML from assistant markdown does not execute.

Evidence:

- `MessageBodyRenderer` routes fenced `diff`/`patch` blocks through `DiffCodeBlock`
  and keeps raw HTML as text through the existing safe markdown subset.
- `CodeBlock` adds local token highlighting for common languages, defers highlighting
  while streaming, caps long code/log content, and keeps copy on the full source.
- `ConversationWorkCell` exposes inline copy for command output/details without adding
  transcript rows.
- `ArtifactPreview` exposes copy for text previews, while code-like previews keep the
  code block copy action.
- `apps/web/e2e/channel.spec.ts` verifies raw HTML does not execute, code highlights
  after commit, pending code remains plain, structured diffs render path/hunk/add/delete,
  malformed diffs and unknown languages fall back to plain text, and long code expands
  inline.

## P6. Artifacts, Preview, And Image Compare

- [x] Render artifact strip inline under the owning turn.
- [x] Render image thumbnails with stable dimensions and lightbox preview.
- [x] Add image compare viewer modes: single, side-by-side, slider, diff overlay.
- [x] Keep screenshot/image compare linked to the producing operation.
- [x] Preserve aspect ratio and avoid default cropping.

Acceptance:

- [x] Preview does not replace or hide operation evidence.
- [x] Full-screen compare is an explicit action.

Evidence:

- `ConversationWorkCell` keeps artifact strips under the owning operation turn and opens
  artifact preview as an explicit lightbox action.
- `ArtifactPreviewDrawer` is a legacy component name; its default render variant is the
  conversation-safe lightbox, and drawer-style preview is opt-in only.
- `PreviewContentResponse.compare` is optional metadata; normal image previews remain
  single-image previews unless before/after metadata is present.
- `ImageCompareViewer` supports single, side-by-side, slider, and diff-overlay modes
  with `object-fit: contain` and responsive side-by-side fallback.
- `apps/web/e2e/channel.spec.ts` verifies the operation evidence row remains visible,
  image artifact thumbnails stay in the owning work cell, lightbox opens explicitly, and
  image compare modes switch inside the lightbox.

## P7. Composer, Feedback, Shortcuts, And Mobile Gestures

- [x] Add inline feedback for copy, open, download, retry, and queued follow-up.
- [x] Reserve toast for background completion/failure when the user is not viewing the
  owning turn.
- [x] Add shortcut hints in tooltips or command palette, not permanent transcript text.
- [x] Support composer shortcuts: submit, newline, close preview/menu, expand evidence,
  copy focused block, move between blocks.
- [x] Add mobile composer height drag, preview swipe-down close, and long-press action
  menu.
- [x] Keep approve, cancel, interrupt, delete, and destructive actions button-only.

Acceptance:

- [x] Copy/open/download feedback does not create transcript rows.
- [x] Mobile gestures cannot accidentally approve, cancel, interrupt, or delete.

Progress:

- Message copy now uses inline button feedback through shared `CopyActionButton`; the
  button changes to `Copied` without creating transcript rows. Code, diff, command
  output, and text preview copy feedback were completed in P5.
- Open/download feedback now appears inside the lightbox footer; retry and queued
  follow-up feedback appear inside the composer status area. These feedback states do
  not create transcript rows.
- Composer shortcut discoverability is tooltip-only: input title describes Enter,
  Shift+Enter, and Esc behavior, and the send/queue action title includes Enter when
  Enter can submit.
- Mobile gesture baseline is intentionally non-destructive: the composer has a small
  touch resize handle and the lightbox supports swipe-down close. Approve, cancel,
  interrupt, delete, and destructive actions remain button-only.
- `ConversationVirtualFeed` exposes feed-level keyboard and pointer handlers without
  adding transcript rows. `WorkspaceClientView` supports Alt+Up/Down block navigation,
  Ctrl/Cmd+Shift+C copy for the focused block, Enter expansion for focused evidence
  blocks, Escape menu dismissal, background completion/failure toast, and a safe
  Copy/Focus-only long-press or context menu.
- Expandable evidence lookup is priority-ordered so a focused work-cell block expands
  the evidence summary before lower-level operation rows.
- `apps/web/e2e/channel.spec.ts` verifies background toast routing when the user is away
  from latest activity, focused block shortcuts and safe action menu behavior, and
  keyboard expansion of a durable work-cell evidence summary.

## P8. Motion And Microinteractions

- [x] Add active-only shimmer or scanning highlight for running rows.
- [x] Stop all active motion on terminal rows.
- [x] Add small enter/settle transitions for operations, agent spans, approvals, artifacts,
  and previews.
- [x] Add smart auto-scroll and scroll-to-latest.
- [x] Preserve scroll anchor while active content grows.
- [x] Respect `prefers-reduced-motion`.

Acceptance:

- [x] Motion makes state changes legible but does not hide evidence or create duplicate
  transcript surfaces.

Evidence:

- `ConversationWorkCell` running row and running agent span text use active-only
  `conversation-active-shimmer`; completed operation cells and terminal rows do not get
  active shimmer.
- Operations, agent spans, approval bubbles, artifact rows, transcript blocks, and
  preview panels use lightweight `conversation-settle-in` motion, with all conversation
  motion disabled under `prefers-reduced-motion`.
- `WorkspaceClientView` keeps pinned feeds auto-following the latest item, shows a
  conversation-owned jump-to-latest button when the user scrolls away, and records a
  visible feed anchor to restore scroll position when active content above it grows.
- `apps/web/e2e/channel.spec.ts` verifies active shimmer, reduced-motion behavior,
  composer/feed separation during scrolling, streaming auto-follow, visible-anchor
  preservation while content above grows, and paginated history anchor preservation.

## P9. Accessibility, Internationalization, And Performance

- [x] Add focus-return behavior for previews, popovers, menus, and modals.
- [x] Add `aria-expanded` to expand/collapse controls.
- [x] Add accessible names to copy/open/preview/close/action buttons.
- [x] Add polite announcements for approval needed, blocked, failed, completed, and queued
  follow-up.
- [x] Move all user-facing copy to i18n keys.
- [x] Verify long Chinese and English labels do not overlap.
- [x] Add virtualization/windowing once transcript size crosses agreed thresholds.
- [x] Defer syntax highlighting, image decoding, and raw/debug rendering for large content.

Acceptance:

- [x] Keyboard and screen-reader users can operate approvals, previews, action bars,
  evidence expansion, and composer controls.
- [x] Long channels remain responsive.

Progress:

- Artifact and attachment previews now focus the close button on open and return focus to
  the triggering preview button on close or swipe-down close.
- Transcript block labels, preview target labels, transcript expand/collapse labels,
  guidance fallback action labels, and artifact preview empty states now use i18n keys
  instead of hard-coded English/Chinese copy.
- Conversation work cells expose polite status announcements for blocked, failed,
  completed, waiting-for-approval, and running status through an accessible live status;
  inline approval overlays and queued follow-up composer feedback also use polite status
  regions.
- `ConversationVirtualFeed` remains backed by `@tanstack/react-virtual`; e2e verifies a
  3000-message channel renders a bounded number of DOM rows and keeps long-channel
  scrolling responsive.
- Conversation block action menus now focus the first safe menu action on open and
  return focus to the owning block on Escape or outside dismissal. The focused block
  shortcut test verifies this focus-return path.
- Artifact type labels in the shared conversation path use i18n keys; remaining visible
  `AI` tokens are role markers, and helper label functions are used as i18n keys before
  rendering.
- Long mixed Chinese/English label coverage is included in the rich rendering e2e flow;
  screenshot evidence was captured under `/tmp/ling-stack-r32-screenshots` for
  `p9-long-labels-narrow.png` and `p9-long-labels-mobile.png`.
- Large code/log content stays folded and unhighlighted until expansion; images use lazy
  loading, and `raw_debug_ref` transcript blocks remain reference-style generic blocks
  instead of rendering raw payloads by default.
- The deeper large-code, diff, image-compare, raw/debug, measured-height, and
  virtualization follow-up is governed by
  [Conversation Performance Deferral And Virtualization](conversation-performance-deferral-and-virtualization.md).

## P10. Design Tokens And Visual Regression

- [x] Add conversation token names for background, text, muted text, border, focus ring,
  active background, status tones, code background, code border, diff add/remove, and
  agent guide line.
- [x] Replace ad hoc conversation CSS colors with tokens.
- [x] Add fixture-driven visual states for all major transcript blocks.
- [x] Capture desktop, narrow, mobile, reduced-motion, and long-label screenshots.
- [x] Add focused accessibility checks for component fixtures and key e2e flows.

Acceptance:

- [x] Code/diff themes match Ling tokens and pass contrast checks.
- [x] Visual regression catches duplicate drawer evidence and fixed-template regressions.

Evidence:

- `apps/web/src/styles/base.css` defines `--conversation-*` tokens in both light and dark
  theme roots; `apps/web/src/styles/components.css` routes message code, structured diff,
  artifact preview/lightbox, active status strip, transcript blocks, and operation shell
  rows through those tokens.
- Range scans over message code/preview, structured diff, work cell, active status, and
  transcript CSS found no ad hoc color literals outside token definitions.
- `apps/web/e2e/channel.spec.ts` asserts code and diff backgrounds resolve to
  `--conversation-code-bg`, verifies rich markdown/code/diff long content does not
  overflow, and keeps safe markdown/copy/folding behavior covered.
- Screenshot evidence was captured under `/tmp/ling-stack-r32-screenshots` for
  `p10-rich-code-diff-desktop.png`, `p10-rich-code-diff-narrow.png`,
  `p10-rich-code-diff-mobile.png`, and
  `p10-reduced-motion-active-work-desktop-reduced.png`.
- Focused e2e coverage verifies accessible preview/close/copy/action names,
  `aria-pressed` image compare modes, focus return after lightbox close,
  `aria-expanded` expansion controls, reduced-motion disabling, and no right-drawer
  conversation evidence regression.

## P11. Web Internal Modularization

- [x] Split `apps/web/src/shared/conversation` into internal areas:
  `transcript`, `blocks`, `composer`, `preview`, `feedback`, `tokens`, and `fixtures`.
- [x] Keep channel and private chat on the same component entrypoints.
- [x] Remove channel-only CSS selector dependencies from shared components.
- [x] Keep route state, channel membership, teammate identity, and daemon API calls outside
  reusable components.

Acceptance:

- [x] Channel and private chat use shared message/body, attachment, evidence, code/diff,
  preview, action bar, and composer primitives.

Evidence:

- `apps/web/src/shared/conversation/index.ts` remains the stable public entrypoint while
  implementation files live under `blocks`, `composer`, `preview`, `feedback`, `tokens`,
  `fixtures`, and `transcript`.
- `TokenizedComposerInput` and composer input parsing moved under
  `shared/conversation/composer`; `shared/components/index.ts` keeps compatibility
  exports for existing app imports.
- Shared conversation components no longer contain `channel-*` class names; channel
  layout ownership remains in `WorkspaceClientView` and app CSS.
- Shared conversation components no longer import app API clients or preview loader
  helpers. Artifact preview and diff preview loading are injected by feature/app-layer
  callers.
- `corepack pnpm --filter @ling-stack/web typecheck`, `lint`, and focused channel e2e
  flows passed after the split.

## P12. Package Extraction Gate

- [x] Do not extract `packages/conversation-ui-core` until channel and private chat share
  stable Web-local APIs.
- [x] Define the future core package scope: headless types, renderer registry contracts,
  action contracts, token names, command-output folding, grouping helpers, and preview
  metadata helpers.
- [x] Do not extract `packages/conversation-ui-react` until React components are
  app-agnostic.
- [x] Keep daemon/API client, route state, app shell, membership, settings, and private
  memory policy outside shared UI packages.

Acceptance:

- [x] No package extraction happens in this slice; Web-local internal modularization is
  complete first.
- [x] Future shared UI packages must not import daemon routes, API clients, or app shell
  modules.
- [x] Web still owns channel/private assembly after extraction.

Evidence:

- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md) defines
  `packages/conversation-ui-core` and `packages/conversation-ui-react` ownership and
  exclusions.
- [Conversation UI Framework And Copy Canon Implementation Plan](conversation-ui-framework-copy-implementation-plan.md)
  defines the package extraction sequence and keeps extraction after shared Web-local
  APIs stabilize.
- P11 now places Web-local primitives under app-agnostic internal areas without creating
  a misleading package boundary.

## P13. Desktop And Future PC Surface Sync Gate

- [x] Define that Desktop consumes `ConversationTranscript` snapshot/delta from daemon.
- [x] Define that Desktop uses future `conversation-ui-core` semantics.
- [x] Define that Desktop reuses future `conversation-ui-react` where practical for
  Electron/Tauri renderer.
- [x] Define that Desktop may map tokens to native visual treatment, but must not fork
  transcript semantics.
- [x] Define OS notification deep-link behavior to owning transcript turns.

Acceptance:

- [x] Desktop implementation remains deferred until a renderer exists.
- [x] Desktop can later render fixture transcript data without copying channel Web logic.
- [x] Desktop must not parse coordinator prose or raw run events to build its own
  transcript.

Evidence:

- [Desktop Shell](desktop-shell.md) defines daemon ownership, transcript snapshot/delta
  consumption, reusable package boundaries, native visual treatment, notification
  deep-links, and the rule that Desktop must not fork transcript semantics.
- `docs/design/runtime-supervisor.md` and `docs/design/contracts-api-client.md` already
  state that Web/Desktop/CLI should consume shared transcript DTOs instead of parsing raw
  runtime events independently.

## Completion Criteria

- [x] P1-P4 completed before visual polish work is considered complete.
- [x] P5-P8 completed before UI quality is considered production-ready.
- [x] P9-P10 completed before broad visual regression or accessibility signoff.
- [x] P11 completed before package extraction.
- [x] P12 package extraction gate completed before Desktop/PC depends on reusable UI
  components.
- [x] P13 Desktop/PC sync gate completed before Desktop/PC implementation starts.
