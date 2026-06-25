# Conversation UI Framework And Copy Canon Implementation Plan

Status: active implementation plan; Slice 1 and Slice 2 require conformance recovery
Date: 2026-06-14
Scope: channel conversation feed, semantic operation projection, Ling Agent copy,
multi-agent activity spans, floating run popover, conversation-owned result/detail
preview, active motion, and regression fixtures

Related docs:

- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
- [Conversation UI Design Conformance Recovery Plan](conversation-ui-design-conformance-recovery-plan.md)
- [Codex-Inspired Conversation Experience v1](codex-inspired-conversation-v1.md)
- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)
- [Ling Agent Session Implementation Plan](ling-agent-session-implementation-plan.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Multi-Agent Collaboration Cards Implementation Plan](multi-agent-collaboration-cards-implementation-plan.md)
- [Conversation UI Framework Temporary Implementation Checklist](conversation-ui-framework-implementation-checklist.md)
- [Conversation Operation Bubble And Performance Store](conversation-operation-bubble-and-performance-store.md)
- [Conversation Performance Deferral And Virtualization](conversation-performance-deferral-and-virtualization.md)

## Summary

Implementation note, 2026-06-15: the first Slice 1 and Slice 2 pass did not satisfy the
design contract because main-feed inline detail still exposed Context Pack, provider/token
metadata, workflow ids, and raw artifact paths. Do not continue with Slice 3 until
[Conversation UI Design Conformance Recovery Plan](conversation-ui-design-conformance-recovery-plan.md)
R1-R3 pass.

This plan turns the conversation UI design into an implementation sequence. The goal is
not to add another runtime system. The goal is to insert a semantic Web UI layer between
existing daemon records and React surfaces.

Long-term correction: the first Web implementation may prototype the projection, but the
stable owner must become shared contracts plus daemon/core projection so Web, Desktop, and
CLI can consume the same transcript model. `apps/web/src/lib` must not remain the only
place where turn grouping, active-cell lifecycle, terminal folding, and raw/detail
boundaries are understood.

Target pipeline:

```text
existing daemon/channel/runtime records
  -> shared semantic projection
  -> ConversationTurn / TranscriptBlock[] view models
  -> block renderer registry
  -> Display / Expanded / Raw render modes
  -> main feed / floating popover / inline previews / blocking surfaces
```

The default user experience should be:

```text
User request
Ling Agent coordinator message when useful
Operation rows that update in place
AgentActivitySpan rows for multi-agent work
Final Ling Agent result
Artifact / file / check summary
```

The default user experience must not be:

```text
Ling Agent start banner
workflow row
run row
work-unit row
collaboration card
raw event log
right drawer duplicate
Ling Agent completion duplicate
```

## Source Of Truth

[Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md) is the product and UI
contract. This document is the execution plan. If implementation disagrees with the
design contract, the design contract wins unless a new decision is recorded.

Hard product rules:

- One user task gets one default visible work object.
- Raw runtime records are evidence, not first-level conversation concepts.
- The main feed owns narrative and semantic operation rows.
- The floating popover owns only current active status.
- The main conversation owns completed result review, file/artifact preview, source
  metadata, approvals, checks, attachments, links, and operation evidence through inline
  expansion or in-turn previews.
- A right-side workspace utility, if present, owns only non-conversation settings/tools or
  an explicit developer/support raw inspector. It does not own conversation artifacts,
  links, operation evidence, or process detail.
- Ling Agent copy describes task state and outcome, not the UI mechanism.
- Conversation UI is adaptive. It renders the blocks produced by the projector for the
  current task and must not force every turn through a fixed report/card template.

Hard copy rules:

- First-person wording is allowed when it is the most natural user-facing sentence.
- No empty self-announcement or UI-explainer copy: `细节放在折叠证据里`,
  `主会话会同步状态`, `查看右侧抽屉了解完整细节`.
- No default feed labels for `workflow`, `run`, `work-unit`, `packet`, `attempt`,
  `selector`, `raw event`, provider metadata, token budgets, or JSON.
- Coordinator messages are for confirmation, clarification, blockers, and final result.
- Operation rows use verb + object + state.
- Coordinator copy is not a parser contract. Do not use prefixes such as `确认需求` or
  `完成` to decide whether a message is start, terminal, or delegated.
- Running and terminal labels are states of the same semantic row, for example
  `正在连接浏览器` becoming `已连接浏览器`.

## Codex Source Alignment

The implementation should borrow the framework shape from these Codex TUI modules, not
their terminal layout:

| Codex module | Implementation takeaway for Ling |
| --- | --- |
| `chatwidget.rs` | Event handlers create/update active cells and commit them once. Ling needs active `OperationCell` mutation, not append-only status rows. |
| `chatwidget/transcript.rs` | Transcript state owns `active_cell`, revisions, turn flags, and copy history. Ling needs turn-level state and stable active revision fields. |
| `chatwidget/turn_lifecycle.rs` | Turn running state is independent from any one visible surface. Ling popovers derive from lifecycle and must clear on terminal state. |
| `history_cell/mod.rs` | Each cell provides rich display, raw output, and transcript/detail output. Ling cells need display/expanded/raw contracts. |
| `exec_cell/model.rs` | Command calls are keyed by call id; stdout chunks update the same call; completion records output/duration. Ling command rows need stable ids and mutable evidence. |
| `exec_cell/render.rs` | Commands render as `Running`/`Ran`; read/list/search coalesce as exploration; output is bounded. Ling should group low-level exploration and cap inline output. |
| `history_cell/search.rs` | Lightweight search cells mutate from running to completed text on the same row. Ling browser/search/memory rows should follow that pattern. |
| `pager_overlay.rs` | Transcript detail shows committed cells plus a live tail keyed by active-cell revision. Ling drawer/detail should not duplicate main feed and must refresh active detail. |
| `chatwidget/streaming.rs` | Assistant deltas stream and consolidate into one markdown cell; reasoning/status does not become transcript spam. Ling coordinator text should stream naturally inside one turn transcript. |

Guardrail: any implementation that uses message body regexes to infer the conversation
cell structure is out of conformance unless it is explicitly marked as a temporary legacy
fallback and covered by a migration issue.

## Adaptive Framework Implementation Contract

The implementation target is a headless conversation framework:

```text
normalized semantic event
  -> TranscriptBlock
  -> TranscriptBlockRenderer
  -> display / expanded / preview / raw modes
```

Required model pieces:

```ts
type TranscriptBlockKind =
  | "coordinator_message"
  | "operation"
  | "agent_activity"
  | "approval"
  | "artifact_strip"
  | "source_summary"
  | "requirement_shaping"
  | "decision_needed"
  | "final_result"
  | "raw_debug_ref";

interface TranscriptBlock {
  readonly id: string;
  readonly turnId: string;
  readonly kind: TranscriptBlockKind;
  readonly ownerId?: string;
  readonly status?:
    | "queued"
    | "running"
    | "waiting_for_approval"
    | "blocked"
    | "failed"
    | "cancelled"
    | "succeeded";
  readonly display: readonly DisplayLine[];
  readonly expanded?: ExpandedDetail;
  readonly previewTargets?: readonly ConversationPreviewTarget[];
  readonly raw?: RawDetailRef;
}
```

Renderer rules:

- Register renderers by `TranscriptBlock.kind`.
- Keep renderer input headless and semantic. React components should not import raw
  workflow/run packet types to decide first-level layout.
- A turn renders the exact ordered block list supplied by the projector; it does not add
  placeholder headings for missing sections.
- Do not infer block kinds from coordinator copy, teammate labels, markdown headings, or
  message text regexes.
- Add fixture tests for varied turn shapes: plain answer, command-only task, approval
  task, artifact-producing task, requirement shaping, serial multi-agent, parallel
  multi-agent, blocked task, and interrupted redirect.

Open-source references are directional only:

- assistant-ui: borrow runtime/thread/message separation and external store thinking.
- Vercel AI Elements: borrow composable block/component registry style.
- Chainlit: borrow separation between message, step, element, and action.

Do not adopt any external framework as Ling's source of truth. Ling's source of truth is
daemon/core projection over channel, workflow, task, approval, artifact, and evidence
records.

## Assistant-UI Borrowing Plan

assistant-ui should influence interaction polish, not data ownership.

The detailed borrowing contract for assistant-ui-style tool folding and high-performance
view state is defined in [Conversation Operation Bubble And Performance Store](conversation-operation-bubble-and-performance-store.md).
Use that document for Operation Bubble headers, section rendering, collapse defaults,
hover/focus action bars, and scoped view-store state. Use
[Conversation Performance Deferral And Virtualization](conversation-performance-deferral-and-virtualization.md)
for large code, diff, image, raw/debug, measured-height, and deep virtualization rules.

Borrow these implementation ideas:

- typed message/block parts rendered through a registry;
- thread viewport behavior: scroll-to-bottom, stable anchors, composer height accounting;
- message/action bars for copy, retry, edit/fork, feedback, open/download;
- tool UI registry with known renderers and a safe fallback;
- human-in-the-loop tool states mapped to Ling approvals;
- attachment rendering in composer and message turns;
- error boundaries for failed message/tool parts;
- grouped tool/output parts that expand while active and collapse after completion.

Do not borrow:

- assistant-ui's runtime/store as Ling's source of truth;
- default component layout when it conflicts with Strict Daylight transcript design;
- branch picker semantics for multi-agent workflow branches. Ling workflow branches are
  execution state, not alternative assistant responses.

## Rich Text And Code Rendering Slice

Type: Web renderer polish and safety.

Goal: make code, markdown, diffs, logs, and artifacts readable without making the main
conversation a raw file viewer.

Suggested files:

```text
apps/web/src/shared/conversation/MarkdownBlock.tsx
apps/web/src/shared/conversation/CodeBlock.tsx
apps/web/src/shared/conversation/DiffPreview.tsx
apps/web/src/shared/conversation/MessageActionBar.tsx
apps/web/src/shared/conversation/AttachmentPreview.tsx
apps/web/src/styles/components.css
apps/web/e2e/channel.spec.ts
```

Work:

- Add a safe markdown renderer with raw HTML disabled and safe-link handling.
- Add syntax-highlighted code blocks with language label, copy action, wrapping rules,
  fallback plain text, and streaming-safe delayed highlighting.
- Add structured diff preview with path summary, hunk rendering, add/remove gutter, and
  plain-text fallback.
- Add message/action bar affordances for copy, open, download, retry/fork/edit, and
  feedback where appropriate.
- Add attachment/image thumbnails that open in-turn preview/lightbox from the owning
  message or artifact row.
- Add renderer tests for markdown, fenced code, unknown language, long code, malicious
  HTML, malformed diff, image preview, and copy action.

Acceptance:

- Code blocks are visibly syntax highlighted after commit and remain readable while
  streaming.
- Long code/log blocks do not resize the whole conversation uncontrollably.
- Diff preview distinguishes additions/removals and degrades safely on malformed input.
- Copy action exists for code, diff, command output, and file preview.
- Attachments and previews stay in the main conversation path, not the right drawer.
- No raw HTML executes from assistant markdown.

## Motion And Interaction Polish Slice

Type: Web interaction polish.

Goal: make conversation state changes legible without turning the transcript into an
animated dashboard.

Suggested files:

```text
apps/web/src/shared/conversation/ConversationTurn.tsx
apps/web/src/shared/conversation/TranscriptBlockRenderer.tsx
apps/web/src/shared/conversation/OperationCell.tsx
apps/web/src/shared/conversation/AgentActivitySpan.tsx
apps/web/src/shared/conversation/MessageActionBar.tsx
apps/web/src/shared/conversation/ScrollToLatestButton.tsx
apps/web/src/shared/conversation/InTurnPreview.tsx
apps/web/src/styles/components.css
apps/web/e2e/channel.spec.ts
```

Work:

- Add stable turn anchors and smart auto-scroll: follow active work only when the user is
  already near the bottom.
- Add a scroll-to-latest affordance when new work arrives while the user is scrolled up.
- Add small enter/settle transitions for operation rows, agent spans, approvals,
  artifacts, and in-turn previews.
- Add active-only shimmer or scanning highlight for running rows. Stop it immediately on
  terminal states.
- Add collapse/expand transitions for small evidence sections, with instant fallback for
  large logs, diffs, and previews.
- Add hover/focus action bars for copy/open/download/retry/edit/fork/feedback where the
  owning block supports the action.
- Add `prefers-reduced-motion` handling for all non-essential motion.
- Add e2e or component tests for scroll anchoring, reduced motion, action bar focus, and
  active-to-terminal animation cleanup.

Acceptance:

- Running rows feel active, but completed transcript content is still.
- Active updates do not cause viewport jumps when the user is reading older content.
- Approvals remain visually obvious and keyboard reachable.
- Expanding/collapsing evidence does not hide command/file/check/approval rows.
- Reduced-motion mode removes shimmer and layout animation while preserving state changes.
- Motion never introduces a duplicate transcript, hidden evidence, or drawer dependency.

## Conversation Polish Micro-Spec Slice

Type: Web interaction and visual detail.

Goal: close the small UI gaps that make the conversation feel unfinished.

Suggested files:

```text
apps/web/src/shared/conversation/ConversationToast.tsx
apps/web/src/shared/conversation/InlineFeedback.tsx
apps/web/src/shared/conversation/ShortcutHints.tsx
apps/web/src/shared/conversation/MobileComposer.tsx
apps/web/src/shared/conversation/ConversationEmptyState.tsx
apps/web/src/shared/conversation/ImageCompareViewer.tsx
apps/web/src/shared/conversation/CodeBlockTheme.ts
apps/web/src/shared/conversation/CommandOutputBlock.tsx
apps/web/src/styles/components.css
apps/web/e2e/channel.spec.ts
```

Work:

- Add inline feedback for copy/open/download/retry/queued-follow-up and reserve toast for
  cross-surface background completion/failure.
- Add shortcut hints in tooltips, command palette metadata, and composer focused state.
- Add mobile composer gestures: preview swipe-down close, composer height drag, long-press
  action menu, explicit buttons for approvals/interrupts.
- Add quiet empty states for new channels with at most three compact suggestions.
- Add image compare viewer modes: single, side-by-side, slider, diff overlay, metadata
  strip.
- Add code block theme tokens for Strict Daylight and dark mode without high-saturation
  code islands.
- Add command output folding thresholds for success, failure, build/test, install logs,
  watch/server logs, and huge/binary output.

Acceptance:

- Copy/open/download feedback does not create transcript rows.
- Background toasts focus the owning conversation turn and never open a drawer.
- Shortcuts are discoverable but not permanently explained inside transcript copy.
- Mobile gestures never approve, cancel, interrupt, or delete by accident.
- Empty state is quiet, task-oriented, and disappears after first user message.
- Image compare viewer preserves aspect ratio and keeps operation evidence visible.
- Code block theme matches Strict Daylight and passes contrast checks.
- Command output uses the documented line/character thresholds and never streams chunks as
  separate rows.

## Framework Hardening Slice

Type: accessibility, performance, token governance, and fixture infrastructure.

Goal: make the conversation framework durable under long channels, multiple locales,
keyboard/screen-reader use, and visual regression testing.

Suggested files:

```text
apps/web/src/shared/conversation/ConversationTranscript.tsx
apps/web/src/shared/conversation/TranscriptVirtualizer.tsx
apps/web/src/shared/conversation/FocusManager.tsx
apps/web/src/shared/conversation/ConversationA11y.ts
apps/web/src/shared/conversation/conversation-tokens.css
apps/web/src/shared/conversation/fixtures/
apps/web/src/styles/components.css
apps/web/e2e/channel.spec.ts
```

Work:

- Add focus-return behavior for previews, action menus, popovers, and modals.
- Add `aria-expanded`, accessible names, polite live announcements for actionable state
  changes, and keyboard parity for transcript actions.
- Move conversation colors, spacing, status tones, code colors, and diff colors into
  conversation design tokens.
- Add locale-safe labels, durations, file sizes, and long-label layout checks.
- Add transcript virtualization/windowing once block count crosses the documented
  thresholds while preserving turn anchors and active rows.
- Defer heavy syntax highlighting, image decoding, and raw/debug preview rendering under
  [Conversation Performance Deferral And Virtualization](conversation-performance-deferral-and-virtualization.md).
- Add fixture-driven visual regression states for plain, streaming, operation,
  multi-agent, approval, artifacts, code, diff, image compare, mobile, reduced motion,
  and long localized labels.

Acceptance:

- Keyboard users can operate approvals, action bars, previews, copy buttons, composer
  actions, and evidence expansion.
- Screen reader announcements happen for approval needed, blocked, failed, completed, and
  queued-follow-up, but not every token or stdout chunk.
- Long Chinese and English labels do not overlap or force horizontal scrolling outside
  code/log containers.
- Long channels stay responsive with large transcript histories.
- Active operation rows remain visible and stable while older completed rows are
  virtualized.
- Component fixtures exist for the required state matrix and pass focused visual checks.
- CSS for conversation states uses conversation tokens rather than ad hoc hex values.

## Shared Conversation UI Package Slice

Type: package extraction and cross-surface reuse.

Goal: let Channel, teammate private chat, and future Desktop/PC render the same
conversation semantics without duplicating UI logic.

Current anchors:

- `apps/web/src/shared/conversation/` already acts as a Web-local conversation component
  library.
- `TeammatePrivateChatSurface` already reuses `ConversationShell`,
  `ConversationVirtualFeed`, `MessageBubble`, `ConversationAttachmentStrip`,
  `MessageEvidencePanel`, `MessageFooterActions`, `ConversationGuidanceStrip`, and
  composer primitives.
- Desktop docs already require consuming the shared `ConversationTranscript` contract
  instead of forking product semantics.

Package target:

```text
packages/conversation-ui-core
packages/conversation-ui-react
```

`packages/conversation-ui-core` owns:

- headless `ConversationTranscript`, `TranscriptBlock`, `ConversationAction`,
  `ConversationPreviewTarget`, and renderer registry contracts;
- design token names and semantic class names;
- pure helpers for command-output folding, block grouping, action availability, source
  summarization, and preview metadata;
- test fixtures that can be consumed by Web and Desktop.

`packages/conversation-ui-react` owns:

- React transcript renderer;
- block renderers for coordinator message, operation, agent activity, approval, artifact,
  source summary, requirement shaping, decision needed, final result, and raw/debug ref;
- composer primitives;
- action bars, inline feedback, preview/lightbox components, image compare viewer,
  code/diff renderers;
- accessibility/focus helpers that are browser/React-specific.

Apps keep:

- daemon/API fetching and mutations;
- route state, selected channel/teammate identity, membership, settings, and app shell;
- platform-specific notifications, native menus, file picker, keychain, and window
  treatment.

Implementation order:

1. Refactor `apps/web/src/shared/conversation` into internal subfolders:
   `transcript`, `blocks`, `composer`, `preview`, `feedback`, `tokens`, and `fixtures`.
2. Make channel and private chat consume the same component entrypoints and token names.
3. Move pure types/helpers into `packages/conversation-ui-core` once both surfaces use
   them.
4. Move React components into `packages/conversation-ui-react` only after imports are
   app-agnostic.
5. Add Desktop renderer smoke fixtures against the shared transcript contract before
   Desktop-specific styling diverges.

Acceptance:

- Channel and private chat use the same message/body, attachment, action bar, preview,
  code block, evidence, and composer primitives.
- No channel-only CSS selector is required for a shared conversation component to render.
- Shared packages do not import daemon/API client or app route modules.
- Desktop can render fixture transcript data without copying channel Web logic.
- Private memory/context policy remains outside the UI package.

## Existing Anchors

| Concern | Current anchor | Reuse plan |
| --- | --- | --- |
| Web operation read model | `apps/web/src/lib/conversation-work-cell.ts` | Reuse as the first semantic projection, then tighten naming and fields. |
| Workflow progress model | `apps/web/src/lib/workflow-progress.ts` | Reuse as workflow input to OperationCell. |
| Collaboration projection | `apps/web/src/lib/collaboration-task-work-cell.ts` | Reuse, but remove card/report copy and map to AgentActivitySpan. |
| Legacy collaboration card read model | `apps/web/src/lib/collaboration-task-card.ts` | Keep as internal input; stop treating it as a first-level UI card. |
| Main operation renderer | `apps/web/src/shared/conversation/ConversationWorkCell.tsx` | Convert from work-cell/card rendering to borderless transcript rendering. |
| Conversation detail shell | `apps/web/src/shared/conversation/` | Keep detail tied to the owning transcript row; add completed result-review/file-preview contract in parent view. |
| Channel assembly | `apps/web/src/features/workspace/WorkspaceClientView.tsx` | Keep orchestration in place for first slices; avoid large file split until behavior is correct. |
| Floating progress popover | `apps/web/src/features/workspace/WorkspaceClientView.tsx`, `.channel-progress-popover` | Keep the popover, reduce content to active status. |
| Styling | `apps/web/src/styles/components.css` | Apply Strict Daylight v3 transcript rules and remove residual card treatments. |
| E2E regression | `apps/web/e2e/channel.spec.ts` | Extend existing mock-state tests instead of creating a new test system first. |

## Target Data Model

Do not create daemon storage in the first implementation wave. Build a Web projection
first. Add contracts only after the shape proves stable.

After the first visible Web pass proves the shape, extract the semantic model into:

```text
packages/contracts/src/conversation-transcript.ts
packages/core/src/conversation-transcript-projector.ts
packages/daemon/src/features/channels/conversation-transcript.ts
```

The Web renderer should then consume `ConversationTranscript` snapshots/deltas from the
daemon, not raw channel/workflow/run records for default display. Desktop should start on
the shared contract directly.

```ts
interface ConversationTranscript {
  readonly schemaVersion: 1;
  readonly channelId: string;
  readonly turns: readonly ConversationTurnViewModel[];
}

interface ConversationTurnViewModel {
  readonly id: string;
  readonly sourceMessageId: string;
  readonly blocks: readonly TranscriptBlock[];
}

interface OperationBlockViewModel extends TranscriptBlock {
  readonly kind: "operation";
  readonly id: string;
  readonly turnId: string;
  readonly sourceKind: "run_thread" | "workflow" | "collaboration_task";
  readonly status: "queued" | "running" | "waiting_for_approval" | "blocked" | "failed" | "cancelled" | "succeeded";
  readonly title: string;
  readonly displayLabel: string;
  readonly terminalLabel?: string;
  readonly summary: string;
  readonly activeOperation?: OperationRowViewModel;
  readonly operationRows: readonly OperationRowViewModel[];
  readonly agentSpans: readonly AgentActivitySpanViewModel[];
  readonly evidence: EvidenceSummaryViewModel;
  readonly sourceRefs: readonly EvidenceSourceRefViewModel[];
  readonly artifacts: readonly ArtifactStripItemViewModel[];
  readonly rawDetailRef?: RawDetailRef;
}

interface EvidenceSourceRefViewModel {
  readonly id: string;
  readonly kind: "tool" | "app" | "web" | "memory" | "file" | "artifact";
  readonly label: string;
  readonly icon: "tool" | "app" | "globe" | "memory" | "file" | "artifact";
  readonly href?: string;
  readonly relatedOperationIds: readonly string[];
  readonly rawDetailRef?: RawDetailRef;
}

interface SourceSummaryStripViewModel {
  readonly placement: "floating_popover" | "expanded_operation" | "detail_summary";
  readonly sources: readonly EvidenceSourceRefViewModel[];
}
```

Implementation note: keep `ConversationOperationCellViewModel` as a compatibility type
while call sites migrate. Do not rename every file in the first slice.

## Render Surfaces

```text
ConversationTurn
  UserMessageCell
  TranscriptBlock[]
    coordinator_message?
    operation?
      OperationDisplayLine[]
      AgentActivitySpan[]
      ExpandedDetail?
    approval?
    artifact_strip?
    source_summary?
    requirement_shaping?
    decision_needed?
    final_result?

FloatingRunPopover
  Active actor + elapsed + latest action + optional source icons + stop/approval action

ConversationDetail
  Inline: operation evidence | files/links | checks | approvals | sources
  Preview: file preview | diff review | artifact preview | image lightbox | source metadata
  Raw/debug: explicit developer/support inspector
```

Surface ownership:

| Surface | Owns | Must not own |
| --- | --- | --- |
| Main feed | user text, coordinator narrative, operation rows, agent spans, final result, artifact strip, attachments, links, image thumbnails | raw logs, ids, duplicate side-panel copy |
| Inline expansion | bounded semantic evidence, operation process detail, agent process history | unbounded stdout, JSON, provider metadata |
| Floating popover | current active status, one action, compact source icons | transcript, branch history, completed summaries |
| In-turn preview / lightbox | file previews, diffs, artifact previews, approval detail, source metadata, selected raw/debug payloads | default conversation summary or copied OperationCell rows |
| Optional right-side workspace utility | non-conversation settings, global workspace tools, non-conversation file browser, explicit support inspector | conversation timeline, attachments, links, agent operations, checks, approvals, artifacts, source lists |
| Modal/blocking surface | approval, destructive confirmation, missing input | passive status |

## Implementation Phases

### Implementation Gate Order

Do not implement the remaining slices as independent UI patches. The previous drift came
from changing visible components before the transcript lifecycle was correct.

Required order:

```text
Gate A: Phase 1 core message framework
  R0 baseline audit
    -> R1 ConversationTurn projection boundary
    -> R2 borderless transcript renderer
    -> R3/R3.1 AgentActivitySpan lifecycle and copy
    -> R3.2 core message framework tests and screenshots

Gate B: later surfaces
  R4 floating popover active-state boundary
    -> R5 conversation detail de-dup boundary
    -> R7 SourceSummaryStrip
    -> Slice 6 full surface cleanup and fixture matrix

Gate C: shared contract extraction
  packages/contracts ConversationTranscript
    -> core/daemon projector
    -> Web/Desktop/CLI consume shared snapshots and deltas
```

Gate A is the user's original message-framework problem. It is mandatory before any new
source-detail, preview/detail, or popover work. The only exception is a small fix that restores a
previously working floating surface if it was accidentally removed; that fix must not
change transcript structure.

Implementation intent:

- R1 owns turn grouping and prevents the two-Ling-Agent-replies problem.
- R2 owns the borderless Codex-like transcript renderer.
- R3/R3.1 owns multi-agent visibility and ensures completed agent process rows fold
  instead of disappearing.
- R4/R5/R7 own later surfaces only. They must consume the transcript model, not define or
  repair it.
- Source work starts only after operation/span ids are stable.

### CUI0. Baseline Inventory

Type: read-only.

Goal: capture the current broken surfaces before changing behavior.

Work:

- Identify current main-feed work cell states: active, completed, blocked, approval,
  multi-agent serial, multi-agent parallel.
- Identify current duplicate surfaces from the old UI: main feed card, legacy right-side
  progress card, side-panel/process detail, floating popover, raw run bubble.
- Capture screenshots for at least desktop and narrow viewport.
- Record current failing copy examples from UI fixtures.

Acceptance:

- No code changes.
- A short local note or PR comment lists current surfaces and target replacement.

### CUI1. Semantic Projection Layer

Type: Web model.

Goal: make React render from semantic UI models, not raw workflow/run/collaboration
records directly.

Suggested files:

```text
apps/web/src/lib/conversation-work-cell.ts
apps/web/src/lib/workflow-progress.ts
apps/web/src/lib/collaboration-task-work-cell.ts
apps/web/src/lib/conversation-copy-canon.ts
```

Work:

- Keep current builders, but treat them as the normalizer/projection boundary.
- Add explicit operation status and kind mapping.
- Add `agentSpans` as the canonical field; keep `agentBranches` as compatibility until
  render migration is complete.
- Add `evidence` and `artifacts` projection fields without changing daemon APIs.
- Normalize lower-level statuses to user-facing states.
- Collapse duplicate start/progress/completion records into one operation model.
- Treat stale terminal events as evidence if the visible state has been superseded.

Acceptance:

- A workflow/run pair produces one OperationCell model.
- A collaboration task produces OperationCell + AgentActivitySpan models, not a separate
  default card model.
- No default display field contains `workflow`, `run`, `work-unit`, `packet`,
  `attempt`, `selector`, or `raw event`.
- Existing call sites still compile.

### CUI2. Copy Canon Helper

Type: Web copy rules.

Goal: centralize default UI copy so implementation cannot drift back to self-referential
or raw-event wording.

Suggested file:

```text
apps/web/src/lib/conversation-copy-canon.ts
```

Work:

- Add formatter functions for coordinator state, operation row labels, agent span labels,
  approval labels, blocked copy, completed copy, and artifact strip copy.
- Add a lightweight `assertDefaultConversationCopy()` helper for tests and fixtures.
- Move the remaining `I finished...`, `Expand evidence...`, `Run in progress`, and
  `Open run` default-feed copy behind the formatter or replace it.
- Keep technical labels available only for explicit raw/debug detail.
- Remove message-body regex rules that recognize generated phrases such as `确认需求` or
  `完成` as structural markers. Replace them with projection metadata or preserve the
  original assistant text when metadata is missing.

Acceptance:

- Default feed copy has no empty self-announcement or UI-mechanism explanation.
- Default feed copy has no UI-explainer phrases.
- Default feed copy is Chinese-first except file names, commands, model/provider names,
  and teammate names.
- Approval copy states action, scope, and consequence.

### CUI3. OperationCell Transcript Renderer

Type: React UI.

Goal: replace the card-like `ConversationWorkCell` rendering with a borderless transcript
group while preserving existing data flow.

Suggested files:

```text
apps/web/src/shared/conversation/ConversationWorkCell.tsx
apps/web/src/styles/components.css
```

Work:

- Keep the export name in this slice to reduce churn.
- Render `OperationCell` as rows with status icon, label text, muted metadata, and
  chevron only when detail exists.
- Remove outer border, panel background, badge shell, shadow, and card padding.
- Convert `conversation-work-cell-rail` to a stable 16px icon slot.
- Render expanded detail as indented transcript content.
- Bound command output to 5 lines per command in inline detail.
- Remove default diagnostics/action buttons that duplicate inline detail or result review.
- Render active-to-terminal changes on the same row. The row text may change from
  running copy to terminal copy, but the row id and expansion state remain stable.
- Coalesce read/list/search command groups into one exploration/context row unless a
  specific command is user-meaningful.

Acceptance:

- Main feed operation groups are visually borderless.
- Running rows update in place.
- Rows without detail do not show a chevron.
- Inline expanded detail is not a nested panel.
- No blank completed shell/code execution rows appear.

### CUI4. AgentActivitySpan Renderer

Type: React UI and model mapping.

Goal: make multi-agent work visible without a collaboration-card transcript.

Suggested files:

```text
apps/web/src/shared/conversation/ConversationWorkCell.tsx
apps/web/src/lib/collaboration-task-work-cell.ts
apps/web/src/styles/components.css
```

Work:

- Replace `BranchRows` copy and structure with `AgentActivitySpan`.
- Show one latest-action line per active agent.
- Fold old actions behind the agent row.
- Show completed agents as one result line unless expanded.
- Keep blocked/failed/waiting agents visible until coordinator resolution.
- Collapse more than three active agents into `另有 {n} 个队友处理中`.

Acceptance:

- Serial multi-agent work shows prior/current teammate rows without raw step spam.
- Parallel multi-agent work shows one latest-action line per active teammate.
- Semantic sub-agent process expands inline behind the agent row. Raw sub-agent transcript
  is raw/debug access only.
- Agent internal reasoning is never visible by default.

### CUI5. Coordinator Message And Final Result

Type: Web rendering and daemon-derived message handling.

Goal: ensure Ling Agent messages are useful narrative, not duplicate status.

Suggested files:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/lib/conversation-work-cell.ts
apps/web/src/lib/collaboration-task-work-cell.ts
```

Work:

- Show coordinator scope confirmation only when it carries planning, safety, delegation,
  clarification, or blocker context.
- Show one final coordinator result for terminal work.
- Move changed files, checks, and artifacts into an artifact strip or bounded evidence,
  not a report card.
- Remove default `Ling summary`, `Outcome`, `Changed`, `Validated`, `Blockers / risks`,
  and `Next action` report-card headings from the main feed unless the user opens detail.

Acceptance:

- Completed work has one final result surface.
- Coordinator final copy adds outcome information instead of repeating operation counts.
- Multi-agent completion includes teammates in one concise final line when useful.

### CUI6. Active Lifecycle And User Interruption

Type: Web state and composer actions.

Goal: make active work interruptible and steerable without hidden prompt injection.

Suggested files:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/shared/components/MessageComposer.tsx
apps/web/src/lib/use-run-control.ts
```

Work:

- Keep ordinary send, queued follow-up, and stop-and-redirect as distinct user actions.
- Show queued follow-up on the active OperationCell.
- Do not append stdout chunks as new rows.
- Do not let stale completion override cancelled/interrupted state.
- Preserve lineage for redirect operations.

Acceptance:

- User text during active work is never silently injected.
- Normal send is not an implicit interrupt.
- Queued follow-up is visible and editable/cancellable.
- Stop-and-redirect creates a linked continuation state.

### CUI6.5. SourceSummaryStrip Projection

Type: semantic evidence projection.

Goal: summarize user-meaningful context sources from structured events without adding a
new first-level card to the main conversation.

Design source:
[Conversation Memory Citations And Sources](conversation-memory-citations-and-sources.md).

Suggested files:

```text
apps/web/src/lib/conversation-turn-projector.ts
apps/web/src/lib/conversation-work-cell.ts
apps/web/src/lib/collaboration-task-work-cell.ts
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/shared/conversation/ConversationWorkCell.tsx
```

Work:

- Derive source refs from MCP/tool calls, web search/open page/find in page events,
  context sources, file refs, and artifacts.
- Keep memory citations separate: `UsedMemoryEvent + MemoryObject` projects into a
  message-level memory footer, while memory may also contribute only a compact source
  group count in the active source summary.
- Filter internal helpers: `node_repl`, daemon glue, projector helpers, setup/cleanup
  wrappers, raw shell wrappers, and hidden routing tools.
- Deduplicate by stable source key: tool/app id, normalized URL, memory id, file path, or
  artifact id.
- Attach source refs to the owning operation or agent span before rendering.
- Render compact source icons only in active popover, inline expanded evidence, or source
  metadata detail. Do not render a standalone main-feed Sources card.

Acceptance:

- A turn that uses MCP tools shows one icon per user-meaningful tool/app source.
- A turn that searches or opens web pages shows globe icons with URL tooltips/details.
- Internal tools never appear in the source strip.
- Source refs remain available after terminal commit and do not disappear with active
  status.
- Source metadata detail does not duplicate the final coordinator answer or operation
  transcript.
- Memory source detail does not duplicate the message-level memory citation footer.

### CUI7. Floating Run Popover Boundary

Type: Web UI boundary.

Goal: keep the right floating surface, but make it ambient active status only.

Suggested files:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/styles/components.css
```

Work:

- Keep the popover; do not remove it.
- Hide when no active work exists.
- Show during running, waiting approval, and blocked states.
- Hide after final coordinator summary and artifact strip commit.
- Show one actor, elapsed time, one latest-action phrase, optional compact source icons,
  and one primary action.
- Hide or compress when another non-conversation workspace utility is open.

Acceptance:

- Completed state does not linger as a second success message.
- Popover never shows command output, raw ids, workflow/run labels, or branch history.
- Popover source icons are compact evidence affordances, not progress rows.
- Opening any optional side utility does not create duplicate progress UI.

### CUI8. Conversation Detail Boundary

Type: Web conversation detail architecture.

Goal: keep completed-result review, files, links, source metadata, approvals, checks, and
artifacts inside the conversation reading path, not in a second transcript or a right
drawer.

Decision update:

- Active progress belongs to the floating popover, and durable progress belongs to the
  main transcript.
- Conversation-owned details have no `Files`, `Review`, or `Progress` drawer root page.
- Operation process detail belongs to inline `OperationCell` / `AgentActivitySpan`
  expansion in the main transcript.
- Source metadata, approval detail, raw/debug detail, file preview, diff review, and
  artifact preview remain explicit drill-down surfaces opened from the owning transcript
  row.

Suggested files:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/shared/conversation/ConversationEvidenceBundlePanel.tsx
apps/web/src/shared/conversation/FileChangeEvidencePanel.tsx
```

Work:

- Add result-review and file/artifact preview state opened from explicit artifact, file,
  approval, source, or raw/debug actions on the owning transcript row.
- Do not add an operation-process drawer page. Expanded OperationCell detail is inline.
- File/review previews should show changed files, generated artifacts, previews, diffs,
  checks, approval decisions, and review/audit metadata.
- Source metadata should show source label, type, target URL/file/app/tool
  metadata, related operation refs, and raw detail ref when available.
- Raw events and JSON are folded by default.
- Preserve the owning turn anchor when opening/closing preview or detail.

Acceptance:

- No right drawer owns conversation attachments, links, artifacts, checks, approvals,
  operation evidence, source lists, or result review.
- Operation process rows are still readable through inline expansion after completion.
- File/review previews can show full previews, diffs, checks, approvals, artifacts,
  source metadata, and raw/debug refs from the owning turn.
- Raw ids and JSON never appear in normal conversation detail.

### CUI9. Legacy Collaboration Surface Retirement

Type: Web cleanup.

Goal: retire the first-level collaboration card concept after AgentActivitySpan and
conversation detail are stable.

Suggested files:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/lib/collaboration-task-card.ts
apps/web/src/styles/components.css
```

Work:

- Keep `CollaborationTaskCardModel` as internal projection input if useful.
- Stop rendering `.collaboration-task-card` as a first-level user object in the main feed.
- Do not move legacy cards into a Progress drawer page. Retire them from first-level
  user surfaces; active status is already covered by the floating popover and durable
  history is covered by the transcript.
- Update tests that currently assert `.collaboration-task-card` to assert operation rows,
  agent spans, or result review/raw-debug detail.

Acceptance:

- No user-facing surface is labeled as a collaboration card.
- Main feed multi-agent work appears as AgentActivitySpan.
- No right-side utility exposes Progress as a conversation root page or duplicates work
  cards.

### CUI10. Artifact, File, Check, And Memory Rows

Type: Web detail and artifact strip.

Goal: show useful outputs without turning evidence into card stacks.

Design source:
[Conversation Memory Citations And Sources](conversation-memory-citations-and-sources.md).

Suggested files:

```text
apps/web/src/shared/conversation/ConversationEvidenceBundlePanel.tsx
apps/web/src/shared/conversation/FileChangeEvidencePanel.tsx
apps/web/src/shared/components/UsedMemorySummary.tsx
apps/web/src/lib/run-evidence.ts
apps/web/src/lib/file-change-evidence.ts
```

Work:

- Add a compact artifact strip under terminal coordinator summary when artifacts exist.
- Show file paths, changed file count, and check count.
- Show produced images/screenshots as stable inline thumbnails under the artifact/result
  area. Clicking a thumbnail opens a lightbox or preview overlay with filename and close
  action.
- Show message-level memory citation footer only when memory affected the answer. Do not
  render memory as an OperationCell row unless the memory event is run-only and has no
  owning assistant/coordinator message.
- Keep full file previews and diffs in in-turn preview/detail surfaces.

Acceptance:

- Artifact strip appears only when there are outputs.
- Image thumbnails fit inside the transcript column and do not cause text overlap or
  layout shift while loading.
- Lightbox preview does not duplicate operation progress or result-review content.
- Memory summary appears only when memory was used.
- File/detail previews show previews/diffs, not the same artifact strip repeated.

### CUI10.5. Active Shimmer Motion

Type: visual polish.

Goal: add a subtle active-work breathing state without turning completed transcript rows
into animated decoration.

Suggested files:

```text
apps/web/src/styles/components.css
apps/web/src/shared/conversation/ConversationWorkCell.tsx
apps/web/src/features/workspace/WorkspaceClientView.tsx
```

Work:

- Add one reusable shimmer/scanning-highlight token for active status text and active
  OperationCell/AgentActivitySpan rows.
- Use a `3000ms` cycle: about `800ms` left-to-right sweep and `2200ms` rest.
- Disable sweep under `prefers-reduced-motion: reduce`.
- Remove shimmer when the row reaches a terminal state.

Acceptance:

- Shimmer appears only while work is active or thinking/running.
- Completed rows, artifact rows, images, final summaries, and the full transcript do not
  animate.
- The effect stays subtle on Strict Daylight surfaces and does not look like a loading
  skeleton.

### CUI11. Regression Fixtures And Visual QA

Type: tests and screenshots.

Goal: lock the behavior so future implementation does not drift back to cards, raw event
spam, or self-referential copy.

Primary file:

```text
apps/web/e2e/channel.spec.ts
```

Required fixture matrix:

| Fixture | Must show | Must not show |
| --- | --- | --- |
| single-agent running | active operation row mutating in place | running modal or duplicate run row |
| single-agent completed | final coordinator result plus terminal operation rows | lingering floating success popover |
| serial multi-agent | coordinator handoff, current agent, folded prior agent | collaboration record card |
| parallel multi-agent | latest action per active teammate | full sub-agent transcripts as default feed |
| waiting approval | approval row and blocking affordance | vague `continue?` copy |
| blocked | human-readable blocker and next action | raw exception as default row |
| interrupted redirect | cancelled source plus linked continuation | hidden prompt injection |
| detail preview open | detail/raw sections only | copied main transcript |
| popover active | one-line active status | command output or branch history |
| artifact result | artifact strip and selected file/detail path | duplicate artifact list in a drawer root |

Copy regression assertions:

- Main feed does not contain `workflow`, `run`, `work-unit`, `packet`, `raw event`,
  `attempt`, or `selector`.
- Main feed does not contain `细节放在折叠证据里`.
- Main feed does not contain UI-mechanism copy such as `主会话会同步状态` or
  `查看右侧抽屉了解完整细节`.
- Conversation detail/preview does not repeat the coordinator final summary.
- Floating popover is hidden after terminal summary commits.

Verification commands:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- channel.spec.ts
```

Use browser screenshots for final visual acceptance:

```text
desktop: 1440 x 960
mobile/narrow: 390 x 844
```

Phase 1 screenshot evidence should be fixture-driven. Capture completed single-agent
expanded, serial multi-agent expanded, and parallel multi-agent active states from the
mock-daemon conversation transcript fixtures so old local history cannot mask a lifecycle
regression.

## Suggested Execution Order

Do not implement all phases in one unreviewable patch. Use these slices.

### Slice 1: Main Feed And Copy Canon

Phases: CUI1, CUI2, CUI3, part of CUI5.

Execution rule: Slice 1 must land before Slice 2 starts. Slice 1 owns the single-agent
and completed-work transcript treatment only. It must not remove or redesign the floating
run popover or unrelated workspace utilities. The later R5 cleanup removes any
conversation-detail dependency on a right drawer after the popover and transcript own
their respective progress surfaces.

Files likely touched:

```text
apps/web/src/lib/conversation-turn-projector.ts
apps/web/src/lib/conversation-work-cell.ts
apps/web/src/lib/collaboration-task-work-cell.ts
apps/web/src/shared/conversation/ConversationWorkCell.tsx
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/styles/components.css
apps/web/e2e/channel.spec.ts
```

Acceptance:

- Main feed is projected by user turn first: user message, coordinator start, operation,
  coordinator summary, and artifact strip belong to one `ConversationTurn`.
- Main feed is borderless transcript.
- First-person and UI-explainer copy removed.
- Completed work has one final result surface.
- Completed work keeps its folded semantic process rows; finishing work must not delete or
  replace the visible operation history.
- Auto-started workflow records, represented runs, workflow steps, and grouped coordinator
  messages do not appear as unrelated sibling feed items in the default conversation.
- Main feed default copy does not expose `attempt`, `workflow`, `run`, `work-unit`,
  `packet`, `selector`, `raw event`, provider metadata, token budgets, JSON, or drawer
  instructions.
- Main feed no longer renders the report-card headings `Ling summary`, `Outcome`,
  `Changed`, `Validated`, `Blockers / risks`, and `Next action`.
- Inline detail may still use semantic headings such as `Changed`, `Checked work`,
  `Evidence`, and `Attention`; those headings are detail evidence, not a second final
  answer.
- The details trigger describes available evidence or artifacts. It must not tell the
  user that details are "loaded on demand" or that they should open another UI surface.
- Existing core channel e2e still passes.

### Slice 2: AgentActivitySpan

Phases: CUI4 and CUI9 first half.

Execution rule: start Slice 2 only after Slice 1 compiles and its focused e2e assertions
are updated. Slice 2 owns multi-agent transcript rows in the main feed. It must not remove
the floating run popover or convert a side panel into a duplicate transcript.

Files likely touched:

```text
apps/web/src/lib/collaboration-task-card.ts
apps/web/src/lib/collaboration-task-work-cell.ts
apps/web/src/shared/conversation/ConversationWorkCell.tsx
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/e2e/channel.spec.ts
```

Acceptance:

- Multi-agent serial and parallel work render as agent spans.
- Legacy collaboration cards no longer appear in the main feed.
- The main feed does not use `Agent branches`, `{owner} branch`, `Expand branch`,
  `Collapse branch`, or `.conversation-work-cell-branch` as the user-facing model.
- Each visible agent span shows one latest action line by default. Prior actions remain
  behind that agent row, and raw sub-agent transcript stays in explicit raw/debug detail.
- Right progress panel cards may remain during this slice as compatibility UI; they are
  not first-level main-feed conversation cells and are cleaned up in later slices.
- Branch overflow and blocked/failed visibility rules are tested.

### Slice 3: SourceSummaryStrip

Phases: CUI6.5, plus CUI7/CUI8 source affordances.

Execution rule: start only after OperationCell and AgentActivitySpan projection have stable
operation ids. Source refs attach to existing operations/spans; they must not create a new
main-feed card family.

Files likely touched:

```text
apps/web/src/lib/conversation-turn-projector.ts
apps/web/src/lib/conversation-work-cell.ts
apps/web/src/lib/collaboration-task-work-cell.ts
apps/web/src/shared/conversation/ConversationWorkCell.tsx
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/e2e/channel.spec.ts
```

Acceptance:

- MCP/tool, web, memory, file, and artifact sources project into `sourceRefs`.
- Internal helpers such as `node_repl`, daemon glue, setup/cleanup wrappers, and projector
  internals are filtered.
- Source refs are deduped and keep stable ids across active-to-terminal mutation.
- Main feed has no standalone Sources card.
- Floating popover may show compact source icons while active.
- Source detail opens from the owning transcript row without duplicating the operation
  transcript.

### Slice 4: Floating Popover

Phase: CUI7.

Files likely touched:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/styles/components.css
apps/web/e2e/channel.spec.ts
```

Acceptance:

- Popover remains available during active work.
- Popover hides after terminal summary.
- Popover does not duplicate any other progress surface.
- Popover source icons are optional compact affordances, not additional progress rows.

### Slice 5: Result Review, Artifacts, Images, And Motion

Phases: CUI8, CUI10, and CUI10.5.

Files likely touched:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/shared/conversation/ConversationEvidenceBundlePanel.tsx
apps/web/src/shared/conversation/FileChangeEvidencePanel.tsx
apps/web/e2e/channel.spec.ts
```

Acceptance:

- No right drawer root page duplicates or owns main-feed conversation artifacts.
- Operation process detail remains inline and does not become a drawer page.
- Conversation result/detail preview has files, diffs/previews, checks, approvals,
  sources, artifacts, and folded raw/debug refs.
- Files/artifacts/memory follow the strip/detail boundary.
- Image thumbnails and lightbox preview work in the main transcript.
- Active shimmer appears only on active rows/popover text and stops on terminal rows.

### Slice 6: Legacy Cleanup And Fixture Matrix

Phases: CUI9 completion and CUI11.

Files likely touched:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/styles/components.css
apps/web/e2e/channel.spec.ts
docs/design/conversation-ui-framework-copy-implementation-plan.md
```

Acceptance:

- `.collaboration-task-card` is gone from first-level user surfaces or kept only as
  compatibility class during transition with no card visual treatment.
- Full fixture matrix passes.
- Final screenshots match Strict Daylight v3 + Strict Codex Transcript structure.

## Test Plan

### Model And Copy

Use focused browser/e2e tests first because the Web package does not currently have a
configured unit test runner.

Coverage:

- Operation projection from a single active run.
- Operation projection from a terminal run.
- Workflow + run dedupe into one operation model.
- Collaboration task maps to agent spans.
- Copy canon rejects UI-mechanism explanations, empty self-announcements, and raw labels.

### Main Feed

Coverage:

- Active operation mutates in place.
- Terminal operation does not create a second completion surface.
- Inline evidence expands without a card/panel container.
- Completed shell/code execution rows are not rendered when empty.

### Multi-Agent

Coverage:

- Serial workflow: prior completed agent folded, current agent visible.
- Parallel workflow: one latest-action line per active teammate.
- More than three agents: overflow line.
- Failed/blocked teammate remains visible.

### Floating Popover

Coverage:

- Hidden with no active work.
- Visible with running work.
- Visible with pending approval and focuses approval surface.
- Hidden after terminal summary.
- Hidden or reduced when a non-conversation workspace utility opens.

### Conversation Detail

Coverage:

- File preview, diff review, artifact preview, source metadata, approval detail, and
  raw/debug detail open from explicit actions on the owning conversation row.
- Operation process detail remains inline in the main transcript.
- Raw JSON is folded.
- Detail/preview summary does not repeat coordinator final summary.

### Visual QA

Coverage:

- Desktop screenshot of single-agent running/completed.
- Desktop screenshot of parallel multi-agent.
- Desktop screenshot of inline expanded OperationCell detail.
- Desktop screenshot of in-turn result review/file preview.
- Desktop screenshot of image thumbnail and lightbox preview.
- Narrow viewport screenshot of active work and composer.

## Failure Modes

| Failure mode | Prevention |
| --- | --- |
| Raw event spam returns to main feed | Copy regression tests and render contract checks. |
| Completed popover keeps showing after run is done | Popover state tests tied to terminal operation commit. |
| Side panel becomes a second transcript | Conversation detail ownership guard and fixture tests. |
| Multi-agent work becomes separate teammate chats | AgentActivitySpan projection owns default multi-agent display. |
| Existing e2e depends on legacy card selectors | Migrate selectors slice by slice; do not delete all legacy classes in Slice 1. |
| `WorkspaceClientView.tsx` diff becomes too large | Keep first slices behavior-focused; split components only after acceptance. |
| Copy formatters become over-abstracted | Keep formatter functions small and explicit; no generic prose generator. |
| Evidence becomes inaccessible after folding | Semantic evidence stays reachable inline; raw/debug refs stay reachable from explicit drill-down. |

Critical silent-failure guard:

- If an implementation hides semantic process evidence instead of folding it inline, stop
  and restore the OperationCell/AgentActivitySpan expansion before continuing.
- If an implementation hides a raw/debug path without replacing it with explicit raw/debug
  access, stop and restore audit access before continuing.

## Not In Scope

- No daemon schema migration in the first implementation wave.
- No new workflow engine.
- No new runner protocol.
- No migration from embedded Pi library mode.
- No full `WorkspaceClientView.tsx` modularization before behavior is correct.
- No terminal/TUI renderer clone.
- No removal of the floating run popover.
- No hidden mid-run prompt injection.
- No wholesale replacement of existing approval, evidence, or artifact APIs.

## Parallelization Strategy

Sequential core is required because the same model, renderer, and lifecycle rules are
being corrected. Do not parallelize UI work that can change the visible transcript until
R1-R3.1 pass.

| Workstream | Modules touched | Depends on |
| --- | --- | --- |
| Projection and copy canon | `apps/web/src/lib/` | CUI0 |
| OperationCell renderer | `apps/web/src/shared/conversation/`, `apps/web/src/styles/` | Projection and copy canon |
| AgentActivitySpan | `apps/web/src/lib/`, `apps/web/src/shared/conversation/` | OperationCell renderer |
| Floating popover | `apps/web/src/features/workspace/`, `apps/web/src/styles/` | Projection and active lifecycle fields |
| SourceSummaryStrip | `apps/web/src/lib/`, `apps/web/src/shared/conversation/`, `apps/web/src/features/workspace/` | Stable OperationCell and AgentActivitySpan ids |
| Conversation result/detail preview | `apps/web/src/shared/conversation/`, `apps/web/src/features/workspace/` | Projection model, artifacts, file/change evidence, source refs |
| Image/lightbox and shimmer | `apps/web/src/shared/conversation/`, `apps/web/src/styles/` | Artifact/result rows and active lifecycle fields |
| E2E fixtures | `apps/web/e2e/` | Each corresponding slice |

Execution:

```text
Phase 1 core message framework:
  R0 baseline
    -> R1 ConversationTurn projection
    -> R2 TranscriptBlock renderer
    -> R3/R3.1 OperationCell + AgentActivitySpan lifecycle
    -> R3.2 core tests and screenshots

Later surfaces:
  R4 Floating Popover
    -> R5 Conversation Detail
    -> R7 SourceSummaryStrip
    -> Slice 6 Legacy Cleanup
```

Conflict flags:

- Slice 3, Slice 4, and Slice 5 all touch `WorkspaceClientView.tsx`; keep them sequential
  unless ownership is split in a separate design note.
- Slice 1 and Slice 2 both touch `ConversationWorkCell.tsx`; do not parallelize.
- Do not start SourceSummaryStrip if operation/span ids still change during terminal
  commit; sources would attach to unstable rows and disappear or duplicate.
- Do not start later surface work if the same user task still renders as multiple Ling
  Agent replies or if completed operation rows disappear after terminal summary.

## Stop Signs

If any of these happen during implementation, stop and adjust the plan:

- A new default UI label introduces `workflow`, `run`, `work-unit`, `packet`, `raw event`,
  `attempt`, or `selector`.
- A coordinator message explains the UI mechanism instead of the task state.
- A detail panel or preview repeats the final coordinator answer verbatim.
- A running operation appends a new row for every stdout chunk.
- A running operation appends a new row just to express terminal state; terminal state
  must mutate the existing semantic row.
- Conversation structure depends on matching coordinator text such as `确认需求` or `完成`.
- A completed task creates more than one final result surface.
- The floating popover is deleted instead of constrained.
- A new daemon table is proposed before the Web projection proves the UI contract.

## Final Acceptance

The implementation is complete when:

- Main feed uses borderless transcript operation rows.
- Multi-agent work uses AgentActivitySpan by default.
- Ling Agent copy follows the copy canon.
- Active operation rows update in place.
- Inline evidence is bounded and expandable.
- Main conversation owns completed result review, file/artifact preview, source metadata,
  approvals, checks, attachments, links, and evidence through inline detail or in-turn
  preview.
- Floating popover owns active status only and hides after completion.
- Legacy collaboration cards no longer appear as first-level user concepts.
- Full fixture matrix passes.
- Desktop and narrow screenshots match the Strict Daylight v3 + Strict Codex Transcript
  direction.

Verification commands:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- channel.spec.ts
```
