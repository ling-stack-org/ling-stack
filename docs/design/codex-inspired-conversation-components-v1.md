# Codex-Inspired Conversation Components v1

Status: design detail for implementation planning
Date: 2026-06-05
Scope: shared Web conversation components, channel/private/run thread surfaces, evidence
disclosure, and drawer behavior

## Summary

This document turns
[Codex-Inspired Conversation Experience v1](codex-inspired-conversation-v1.md) into
implementable UI detail.
[Codex-Inspired File And Text Display v1](codex-inspired-file-text-display-v1.md)
extends this component model for message body rendering, local file links, artifact
previews, and diff/file-change evidence.

The Codex-style pattern to borrow is not the terminal look. It is the information shape:

```text
main conversation
  -> compact assistant work summary
    -> expandable evidence
      -> exact runtime, files, memory, approvals, and lineage
```

For Ling Stack, this must support multiple AI teammates, channels, private teammate
threads, skill-aware runs, scoped memory, approvals, and hard delete placeholders.

## Current Web Anchors

Existing code already has partial pieces:

- `apps/web/src/shared/components/MessageComposer.tsx`
- `apps/web/src/shared/components/UsedMemorySummary.tsx`
- channel virtual feed in `apps/web/src/features/workspace/WorkspaceClientView.tsx`
- private message rows in `apps/web/src/features/teammates/TeammateWorkspace.tsx`
- run timeline rows in `apps/web/src/features/runs/RunTimeline.tsx`
- channel right drawer in `WorkspaceClientView.tsx`

The next implementation should extract common primitives instead of continuing to
duplicate page-specific rows and layout rules.

## Component Tree

Target shared component layout:

```text
ConversationShell
  ConversationHeader?          page-specific
  ConversationFeed
    ConversationDayDivider?
    MessageRow
    ConversationSummaryRow
      EvidenceDisclosure
    ConversationEmptyState
    ScrollToLatestButton
  MessageComposer

RightDrawer
  RightDrawerRootNav
  RightDrawerPage
  RightDrawerDrilldownStack
```

Recommended source layout:

```text
apps/web/src/shared/conversation/
  ConversationFeed.tsx
  ConversationVirtualFeed.tsx
  ConversationItem.tsx
  MessageRow.tsx
  MessageBodyRenderer.tsx
  ArtifactPreview.tsx
  FileChangeEvidencePanel.tsx
  ConversationSummaryRow.tsx
  ConversationEmptyState.tsx
  EvidenceDisclosure.tsx
  RightDrawer.tsx
  conversation-types.ts
```

`MessageComposer` can remain in `shared/components` until it gains enough
conversation-specific behavior to move.

## Codex-Inspired Cell Model

Codex's useful UI primitive is a transcript cell model:

```text
committed transcript cells
  + active mutable cell
  + overlay/detail surface
  + bottom input/status pane
```

Ling should implement the same shape with Web-native components:

| Cell role | Ling component | Behavior |
| --- | --- | --- |
| committed user message | `MessageRow` | durable row; right-aligned for local user |
| committed teammate message | `MessageRow` | durable row; left-aligned with teammate identity |
| active assistant reply | `MessageRow` with `streaming` status | same row mutates until terminal state |
| active run work | `ConversationSummaryRow` with `running` status | compact status; evidence grows behind disclosure |
| completed run work | `ConversationSummaryRow` with terminal status | stable summary plus evidence |
| raw runtime detail | `EvidenceDisclosure` or `RightDrawer` page | hidden until requested |
| composer/status pane | `MessageComposer` plus optional run status strip | input remains available during active work |

There should never be two visible assistant rows for one streamed reply. There should
never be both a raw run timeline and a compact run summary in the default feed for the
same event.

### Active Cell State Machine

The active mutable cell is the most important Codex detail to preserve.

```text
draft user input
-> committed user message
-> active teammate reply or active run summary
-> terminal committed row
-> evidence remains expandable
```

For private streaming replies:

| Event | UI behavior |
| --- | --- |
| send | commit the local user row immediately |
| ready | create one pending teammate row |
| delta | append text to the same teammate row |
| blocked | keep the same row and show blocked reason |
| error | keep the same row and show failed state |
| done | mark the same row ready |

For active runs:

| Event | UI behavior |
| --- | --- |
| run started | create or update one compact run summary row |
| tool/memory/approval event | update evidence bundle, not the default feed |
| approval needed | show waiting state in the summary row |
| blocked/failed | show reason in the summary row |
| succeeded/cancelled | terminal state on the same summary row |
| stale completion | record in evidence, do not flip visible terminal state incorrectly |

This prevents the common UI failure where streaming creates duplicate assistant bubbles or
runtime events create a noisy feed.

## ConversationShell

Purpose: keep channel, private chat, and run thread layout dimensions consistent.

Recommended shape:

```text
ConversationShell
  optional header
  feed viewport
  optional active status strip
  composer
  optional side rail or drawer slot
```

Rules:

- the global left drawer is never owned by `ConversationShell`,
- the feed and composer share the same horizontal max width,
- the status strip sits between feed and composer or inside the composer frame,
- channel and private chat should not use different composer widths,
- empty states are centered within the feed slot,
- page-level settings or skill tabs do not render inside a chat shell.

## ConversationStatusStrip

Purpose: one compact place for active work state, modeled after Codex's bottom task
indicator but adapted for Ling.

Content:

- active teammate,
- active run or reply state,
- requested/selected skill when relevant,
- approval/blocker state when relevant,
- queue follow-up action,
- stop and redirect action when supported.

Rules:

- show only one active strip per conversation surface,
- do not duplicate the same state inside every message row,
- if multiple runs are active, summarize the highest-priority item and link to the
  right drawer Progress page,
- normal Send remains a normal message action and is not an implicit run interrupt.

## Conversation Data Contract

The UI may derive this model from existing records before adding any new durable table.

```ts
type ConversationSurface = "channel" | "teammate_direct" | "run_thread";

type ConversationActorKind =
  | "local_user"
  | "ai_teammate"
  | "coordinator"
  | "system";

type ConversationItemKind =
  | "human_message"
  | "teammate_message"
  | "system_summary"
  | "run_summary"
  | "approval_summary"
  | "proposal"
  | "artifact_summary"
  | "deleted_reference";

type ConversationStatus =
  | "ready"
  | "streaming"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "failed"
  | "succeeded"
  | "cancelled"
  | "deleted";

interface ConversationItem {
  readonly id: string;
  readonly surface: ConversationSurface;
  readonly kind: ConversationItemKind;
  readonly actorKind: ConversationActorKind;
  readonly actorId?: string;
  readonly actorName?: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly threadId?: string;
  readonly title?: string;
  readonly body: string;
  readonly status: ConversationStatus;
  readonly createdAt: string;
  readonly attachments?: readonly ConversationAttachmentRef[];
  readonly actions?: readonly ConversationAction[];
  readonly evidence?: ConversationEvidenceBundle;
}
```

Rules:

- `actorId` is optional only for local user and deleted references.
- `teammateId` must be present for AI teammate messages and run summaries when a
  teammate owns the work.
- `status` must use the shared state vocabulary; do not invent page-local labels.
- `body` is user-facing summary text, not raw JSON payload or event log text.

## ConversationFeed

Purpose: one scrollable transcript component for channel chat, private chat, and run
thread views.

### Layout

```text
feed viewport
  loading row
  older loader row
  day divider
  item rows
  empty state
  scroll-to-latest button
```

Rules:

- the feed owns scroll, not the whole page,
- empty state is centered in the feed area,
- entering a conversation pins to the latest item,
- loading older items preserves visual scroll position,
- if the user scrolls away from the latest item, show a centered floating down-arrow,
- no visible scrollbar is preferred on desktop, but keyboard scrolling must still work,
- channel and private chat must use the same max text column and composer alignment.

### Props

```ts
interface ConversationFeedProps {
  readonly surface: ConversationSurface;
  readonly items: readonly ConversationItem[];
  readonly loading?: boolean;
  readonly loadingOlder?: boolean;
  readonly canLoadOlder?: boolean;
  readonly emptyLabel: string;
  readonly emptyIcon?: ReactNode;
  readonly onLoadOlder?: () => void | Promise<void>;
  readonly onOpenEvidence?: (item: ConversationItem) => void;
  readonly onAction?: (action: ConversationAction, item: ConversationItem) => void;
}
```

### States

| State | Display |
| --- | --- |
| Loading first page | centered spinner + label |
| No messages | centered empty state |
| No filtered matches | centered search/filter empty state |
| Has older messages | compact loader row at top |
| User scrolled up | floating jump-to-latest action |
| SSE streaming | same row updates in place; no duplicate assistant row |
| Deleted teammate reference | neutral row with `Deleted teammate` label |

### Virtual Feed Variant

Long channel transcripts should use a virtualized wrapper while preserving the same row
contract.

`ConversationVirtualFeed` owns DOM layout for the scroll viewport, virtualizer spacer,
empty state, loading row, and scroll-to-latest button. The parent can still own data
loading, `useVirtualizer`, and scroll preservation until the data model is normalized.

```ts
interface ConversationVirtualFeedProps<TItem> {
  readonly scrollRef: RefObject<HTMLDivElement>;
  readonly className?: string;
  readonly viewportClassName?: string;
  readonly feedClassName?: string;
  readonly loading?: boolean;
  readonly empty?: boolean;
  readonly emptyIcon?: ReactNode;
  readonly emptyLabel: string;
  readonly totalSize: number;
  readonly virtualRows: readonly VirtualItem[];
  readonly items: readonly TItem[];
  readonly renderItem: (item: TItem, index: number) => ReactNode;
  readonly renderLoader?: () => ReactNode;
  readonly measureElement?: (element: Element | null) => void;
  readonly onScroll?: UIEventHandler<HTMLDivElement>;
  readonly scrollToLatest?: ReactNode;
}
```

Rules:

- keep existing channel virtualization math in the parent until a later cleanup,
- keep `.message-feed-wrap`, `.message-feed`, `.message-feed-virtualizer`, and
  `.message-feed-virtual-row` class compatibility during migration,
- do not let virtualization affect message row width, text alignment, or drawer
  compression,
- loading older rows must preserve scroll position,
- empty state must stay centered in the viewport, not at the top of the virtual spacer.

## MessageRow

Purpose: one row component for ordinary human and teammate messages.

### Anatomy

```text
avatar / spacer
message column
  header: actor name, AI badge, status badge
  body
  attachment strip
  used-memory compact strip
  error/blocked note
  footer actions: copy, reply/thread, create task, timestamp
```

### Visual Rules

- Local user messages align right.
- Local user rows do not need repeated author name by default.
- AI teammate messages align left and show teammate identity.
- Timestamps are footer or hover detail, not dominant header copy.
- Copy/reply/create-task actions are hover/focus visible.
- Streaming row uses the same final row; only status and text change.
- Failed/blocked messages stay in the feed and show the reason inline.
- Attachments display as compact chips, not full cards.

### Author Rules

| Actor | Avatar | Header | Notes |
| --- | --- | --- | --- |
| Local user | optional spacer or local initial | hidden or `You` in compact footer | quiet right-aligned |
| AI teammate | teammate avatar | teammate display name + AI badge | must preserve deleted placeholder |
| Coordinator | coordinator mark | coordinator name | used for multi-agent summary |
| System | neutral icon | system label | only for compact summaries |

### Footer Actions

Message footer actions should be quiet, but discoverable.

| Action | Default visibility | Notes |
| --- | --- | --- |
| Copy message | hover/focus | icon button with tooltip |
| Reply/thread | hover/focus where supported | channel/thread only |
| Create task | hover/focus where supported | creates proposal evidence; may auto-start only when Ling Agent Session policy allows it |
| Open evidence | always visible when evidence exists | badge or disclosure button |
| Timestamp | compact footer text | not a dominant column |

Icon-only controls require `aria-label` and `title`. Avoid text buttons for routine row
tools when a familiar icon exists.

### Attachment Strip

Attachments render as compact chips under the body:

- file icon,
- display name when allowed by scope,
- size or type when useful,
- open/download action,
- remove action only when the current user owns the attachment or the surface allows it.

Private attachment chips must not imply the AI has read the file. Ling Agent may receive
attachment metadata through the turn envelope; body content requires a separate preview,
extraction, or tool-read state. When body content is materialized, the row must show a
separate audited evidence item such as "included in context".

### Status Treatment

| Status | Row treatment |
| --- | --- |
| `ready` | normal |
| `streaming` | subtle live indicator; same row text updates |
| `running` | summary row with spinner or progress mark |
| `waiting_for_approval` | visible warning/status chip and primary approve path |
| `blocked` | visible blocked reason in row body or summary |
| `failed` | visible error summary; evidence links to command/result |
| `succeeded` | quiet success status only when useful |
| `cancelled` | neutral stopped state with lineage when applicable |
| `deleted` | neutral placeholder; no private content |

## ConversationSummaryRow

Purpose: show work as a compact conversation object, not raw activity spam.

Kinds:

- run summary,
- approval summary,
- proposal,
- artifact summary,
- memory summary,
- deleted reference.

### Run Summary

Collapsed copy should answer:

```text
Who worked?
What happened?
What state is it in?
What user action is needed?
```

Example:

```text
Ada ran Designer Review for Model Workbench
Status: waiting for approval
Needs approval: file edit
Evidence: 2 memories, 1 skill, 3 tool calls, 4 files
```

Rules:

- no raw run id in visible default copy,
- no full event timeline in the main feed,
- approval-needed, blocked, failed, and cancelled states are visible without expanding,
- selected skill and blocked reasons appear in collapsed summary when relevant.

### Proposal

Proposal cards stay attached to the source message.

Required content:

- proposed action,
- assignee teammate,
- requested skill if present,
- provider/tool readiness,
- approval impact,
- primary confirm action,
- secondary dismiss/edit action.

Do not let a proposal silently create or run uncontrolled side effects. Clear executable
work may auto-start only through Ling Agent Session policy after durable proposal
evidence is created and required tools are not denied. High-risk, external, destructive,
deploy/release/publish, Git push/merge, or credential/provider/policy-changing side
effects are gated by runtime approval policy; ambiguous or policy-blocked work still
requires clarification, confirmation, or a blocked proposal before run creation.

### Approval Summary

Collapsed content:

- action type,
- risk level,
- target object,
- requesting teammate/run,
- approve/deny actions when safe in context.

Expanded evidence can show structured payload preview. Raw payload should not dominate
the collapsed row.

### Summary Copy Rules

Summary rows must answer these questions in one scan:

```text
Who did it?
What did they do?
What is the current state?
What should the user do next, if anything?
```

Good:

```text
Ada completed Model Workbench review
Evidence: Designer skill, 2 memories, 3 files
```

Bad:

```text
run_01J... transitioned to terminal state
workflow_event: provider_call_complete
```

Visible copy should use names and actions. Raw ids belong in expanded evidence.

## EvidenceDisclosure

Purpose: make work auditable without making the feed noisy.

### Collapsed Row

Collapsed evidence always shows a short summary:

```text
Evidence: 2 memories, 1 skill, 3 tool calls, 4 files
```

Authority-critical state must be visible before expansion:

- waiting for approval,
- blocked,
- failed,
- permission denied,
- missing provider,
- missing tool,
- memory recall disabled,
- deleted teammate.

### Sections

```ts
interface ConversationEvidenceBundle {
  readonly memory?: EvidenceMemorySection;
  readonly skill?: EvidenceSkillSection;
  readonly tools?: EvidenceToolSection;
  readonly approvals?: EvidenceApprovalSection;
  readonly files?: EvidenceFileSection;
  readonly artifacts?: EvidenceArtifactSection;
  readonly runtime?: EvidenceRuntimeSection;
  readonly lineage?: EvidenceLineageSection;
}
```

| Section | Collapsed label | Expanded detail |
| --- | --- | --- |
| Memory | `2 memories` | titles, scopes, recall reason, used-memory event ids |
| Skill | `Designer Review` | requested skill, selected skill, executable state, blocked reasons |
| Tools | `3 tool calls` | tool names, approval status, result summary |
| Approvals | `1 approval` | action type, risk, status, target, structured preview |
| Files | `4 files` | changed files, attachment refs, artifact refs |
| Runtime | `Pi / gpt-...` | runner, provider, model, timestamps, state transitions |
| Lineage | `continued from prior run` | source run, intervention mode, continuation reason |

### Evidence Bundle Summary

`ConversationEvidenceBundlePanel` should be the structured wrapper around collapsed
evidence. It should not simply dump arbitrary JSX from each page.

Recommended bundle shape:

```ts
interface ConversationEvidenceBundle {
  readonly id: string;
  readonly summary: string;
  readonly severity?: "info" | "attention" | "blocked" | "failed";
  readonly sections: readonly ConversationEvidenceSection[];
}

interface ConversationEvidenceSection {
  readonly id: string;
  readonly label: string;
  readonly summary?: string;
  readonly kind:
    | "memory"
    | "skill"
    | "tools"
    | "approvals"
    | "files"
    | "artifacts"
    | "runtime"
    | "lineage"
    | "policy";
  readonly items?: readonly ConversationEvidenceItem[];
  readonly content?: ReactNode;
}
```

Collapsed summary priority:

1. authority-critical state: approval needed, blocked, failed, permission denied,
2. selected teammate and selected/requested skill,
3. used memory count and scope,
4. tool/file/artifact counts,
5. runtime/provider detail,
6. lineage detail.

Examples:

| Situation | Collapsed evidence summary |
| --- | --- |
| normal memory-assisted reply | `Used 2 memories` |
| skill-aware run | `Designer Review, 2 memories, 3 files` |
| blocked run | `Blocked: missing provider capability` |
| approval needed | `Approval needed: edit 2 files` |
| continuation | `Continued from interrupted run, 1 partial artifact` |

Rules:

- the collapsed summary is short text, not a table,
- sections are ordered by user consequence, not event timestamp,
- raw ids are hidden unless the user opens a raw/detail subview,
- a missing optional vector provider appears as `Vector retrieval: not installed`, not as
  an error.

### Redaction

Default collapsed labels must not reveal:

- secret-adjacent memory body,
- full prompts,
- private attachment filenames from another scope,
- raw approval payloads,
- raw tool output,
- persona content,
- deleted teammate private data.

Expanded detail can show allowed source metadata, but must respect the same scope rules
as the source surface.

### Evidence Section Detail

Memory section:

- memory title or redacted label,
- scope: workspace, channel, teammate, task, run,
- recall reason,
- used-memory event id,
- policy decision when recall was blocked.

Skill section:

- requested skill,
- selected/effective skill,
- executable state,
- blocked reasons,
- approval profile,
- required provider capabilities.

Tools section:

- tool name,
- status,
- approval requirement,
- result summary,
- no raw output by default.

Runtime section:

- runner adapter,
- provider preset,
- model name when safe to show,
- started/ended timestamps,
- status transitions,
- stale completion handling when relevant.

Lineage section:

- source thread/run,
- queue-follow-up or interrupt-redirect mode,
- continuation reason,
- partial artifact summary.

## RightDrawer

Purpose: stable detail navigation for channel and run/thread evidence.

### Root Pages

Channel root pages:

- Progress,
- Files,
- Context,
- Settings.

Run/thread root pages:

- Evidence,
- Files,
- Approvals,
- Runtime.

Private chat does not need a persistent right drawer in the first implementation. Its
light context rail can later become a drawer on narrower screens.

### Drill-Down Stack

Use a stack model instead of page-specific booleans:

```ts
type RightDrawerPage =
  | { readonly kind: "root"; readonly page: RightDrawerRootPage }
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "approval"; readonly approvalId: string }
  | { readonly kind: "runEvidence"; readonly runId: string }
  | { readonly kind: "artifact"; readonly artifactId: string };
```

Rules:

- root nav icons switch root pages,
- drill-down pages show a back action,
- the channel header owns close/open on desktop,
- do not render a second close button inside the drawer body when header close exists,
- refresh stays in drawer header actions,
- drawer width is 380px on desktop unless a page explicitly needs a wider detail mode.

### Responsive

| Viewport | Behavior |
| --- | --- |
| Desktop | drawer compresses center conversation |
| Tablet | drawer may overlay after user action |
| Mobile | drawer becomes full-screen sheet; feed/composer keep state |

### Drawer Page Detail

Progress page:

- active runs,
- queued follow-ups,
- pending approvals,
- blocked work,
- recent completed summaries.

Files page:

- channel files,
- run artifacts,
- private attachments only when the drawer belongs to a private surface,
- changed-file summaries,
- file evidence drill-down.

Context page:

- channel brief,
- memory recall policy,
- selected teammate context,
- skill/provider readiness summary,
- no raw prompt or secret-adjacent text.

Settings page:

- channel notification and member settings,
- default teammate and permission hints,
- links to Workspace Skill Library or single-agent settings when relevant.

The drawer is the place to inspect and drill down. It is not a second main page inside
the channel.

## Channel Surface Detail

### Default Feed

Show:

- human messages,
- AI teammate replies,
- execution proposals,
- compact run summaries,
- compact approval/blocked summaries,
- compact collaboration summaries.

Hide by default:

- raw task events,
- raw run events,
- workflow step spam,
- state-transition cards,
- CI triage details,
- broad activity filters.

### Activity Tools Naming

The current `Activity filters` label is too abstract for the user. Preferred labels:

- menu item: `Filter channel events`,
- panel title: `Channel event filters`,
- saved views: `Saved event views`,
- empty state: `No channel events match these filters`.

The product meaning is: power-user filtering of channel events, not a separate main
dashboard.

### Composer And Active Work

Channel composer remains available while work runs. If the user types during active work,
the UI must make the routing explicit:

| User intent | Control | Behavior |
| --- | --- | --- |
| add normal message | Send | posts a normal channel message |
| ask active run to continue later | Queue follow-up | stores linked follow-up after terminal state |
| stop and redirect work | Stop and redirect | cancels active run and creates continuation |
| create new task from message | Create task | creates proposal evidence; auto-starts only when Ling Agent Session policy allows it, otherwise opens confirmation |

Do not silently route a new message into an active run.

### Processed Summary Pattern

Codex-style processed rows should become Ling run summaries:

```text
Processed model workbench review
Ada used Designer Review
Waiting for approval: edit 2 files
Evidence: memory, tools, files, lineage
```

This row belongs in the feed only when it is tied to the current channel context. Raw
run event rows stay in evidence or right drawer.

## Private Chat Surface Detail

### Default Page

Clicking an AI teammate opens private chat only:

```text
teammate header
private message feed
message composer
light context rail
settings icon
```

Do not show:

- settings tabs,
- skill lists,
- memory management panels,
- model controls,
- danger zone controls.

### Private Message Row

Private chat uses the same `MessageRow`:

- user right-aligned,
- teammate left-aligned,
- attachments as chips,
- Used Memory as compact evidence,
- streamed reply updates same row,
- blocked provider response stays in row with reason.

### Context Rail

The context rail is a summary surface, not configuration.

Allowed sections:

- short conversation summary,
- private attachments count/list,
- recent Used Memory,
- current provider status.

Do not imply attachment bodies were read just because chips are visible. The Ling Agent
turn envelope should include metadata and preview/extraction status. Body content enters
model context only through an auditable preview, extraction, or tool-read event.

### Single-Agent Settings Entry

Private chat header should expose one compact settings action:

- icon-only button,
- tooltip such as `Open teammate settings`,
- opens the single-agent settings page,
- does not replace or resize the global left drawer.

The settings page owns profile, model, permissions, channels, skills, memory, MCP, and
danger controls. The chat page owns conversation only.

## Run Thread Surface Detail

Run history should converge toward a thread view:

```text
Thread objective
conversation-like run summaries
manual resume composer
right drawer evidence
raw event timeline inside evidence
```

Rules:

- show linked runs as summaries,
- show continuation/interruption lineage inline,
- keep raw runtime timeline one level down,
- approvals remain actionable,
- memory/skill/tool evidence is visible from each run summary.

## Interruption Controls

Active work uses two explicit controls:

| Mode | Label | Behavior |
| --- | --- | --- |
| Queue follow-up | `Queue follow-up` | active run continues; next linked run starts later |
| Interrupt redirect | `Stop and redirect` | active run is cancelled/interrupted; continuation starts from durable context |

Do not inject new user text into an active runner prompt.

UI summary after user action:

```text
Follow-up queued
or
Stopped and redirected
Continuation will re-check provider, skill, tools, approvals, memory, and leases
```

## Accessibility And I18n

- Icon-only actions require `aria-label` and `title`.
- Hover-only actions must also appear on keyboard focus.
- Evidence disclosure uses a real button with `aria-expanded`.
- Drawer drill-down back action has a clear label.
- Streaming updates should use polite live region behavior only for status changes, not
  every token.
- Chinese labels must avoid vague product jargon. Prefer concrete labels such as
  `筛选频道事件`, `使用的记忆`, `运行证据`, `等待审批`.

## Visual Acceptance

- Channel and private chat composer widths match.
- Channel and private feed max text columns match.
- Empty message states are centered.
- Left drawer does not change width or row treatment when switching surfaces.
- Right drawer compresses center feed on desktop.
- Evidence is collapsed by default.
- Blocked/approval/failed states are visible while collapsed.
- No raw ids appear in default conversation copy unless the user opens evidence.

## Implementation Acceptance Matrix

Use this matrix during each UI slice so the Codex-inspired model does not drift back
into page-specific layouts.

| Surface | Shared primitives required | Must validate |
| --- | --- | --- |
| Channel chat | `ConversationVirtualFeed`, `MessageRow`, `ConversationSummaryRow`, `ConversationStatusStrip`, `RightDrawer` | left drawer unchanged, no raw event spam, evidence collapsed |
| Private chat | `ConversationFeed`, `MessageRow`, shared `MessageComposer`, attachment strip | composer width matches channel, empty state centered, streaming row mutates in place |
| Single-agent settings | center settings shell, effective skill rows | private chat does not show settings tabs, persona cannot grant permissions |
| Workspace Skill Library | global settings shell, import draft rows, skill definition rows | definitions are global, bindings are per teammate, blocked reasons remain visible |
| Run thread | `ConversationSummaryRow`, evidence bundle, resume composer | linked runs read as summaries, raw timeline is one level down |
| Model Workbench | shared status badges, icon actions, detail drawer/row expansion | no primary `API`, `Check`, or `Next step` duplicate columns |

## Regression Checks

Targeted browser checks after implementation should assert:

- selecting private chat does not replace or resize the left drawer,
- switching between channel and private chat keeps composer geometry stable,
- empty private chat state is vertically centered,
- stream send creates one user row and one mutable teammate row,
- channel feed has message footer actions without visible text clutter,
- run detail has at least one collapsed evidence toggle,
- expanding evidence reveals named sections rather than raw JSON first,
- Model Workbench primary rows do not include API/check/next-step duplicates,
- icon-only actions expose `title` or tooltip text.

## Implementation Slices

### Slice A: Component Extraction

- Add `ConversationFeed`.
- Add `MessageRow`.
- Move private chat rows onto `MessageRow`.
- Keep channel virtualizer behavior but route item rendering through `ConversationFeed`.

### Slice B: Evidence Disclosure

- Add `EvidenceDisclosure`.
- Render Used Memory through an evidence section while keeping compact chips.
- Fold run timeline, approvals, artifacts, and file refs behind disclosure.

### Slice C: Channel vNext

- Rename `Activity filters` UI copy.
- Render compact run/approval summaries in feed.
- Keep raw events behind channel event filters and evidence.

### Slice D: Private Chat vNext

- Align private chat feed and composer dimensions with channel.
- Keep context rail summary-only.
- Add message footer actions and consistent empty state.

### Slice E: Run Thread vNext

- Render LingThread as a conversation-like thread.
- Show run summaries plus right drawer evidence.
- Show queue follow-up and stop-and-redirect controls when implemented.

## Verification Plan

Design-only:

```bash
git diff --check
```

Implementation:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
```

Targeted browser checks:

- channel feed initial state and scroll-to-latest,
- private chat empty state and streamed reply,
- evidence collapsed/expanded state,
- channel right drawer root/drill-down stack,
- left drawer geometry across channel, private chat, settings, runs, and model workbench.
