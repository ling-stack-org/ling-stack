# Conversation Operation Bubble And Performance Store

Status: detailed design
Date: 2026-06-25
Scope: channel conversation feed, teammate private chat reuse, operation folding,
assistant-ui-inspired tool display, and Web conversation performance

Related docs:

- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
- [Conversation UI Framework And Copy Canon Implementation Plan](conversation-ui-framework-copy-implementation-plan.md)
- [Conversation Performance Deferral And Virtualization](conversation-performance-deferral-and-virtualization.md)
- [Conversation UI Framework Temporary Implementation Checklist](conversation-ui-framework-implementation-checklist.md)
- [Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md)
- [Ling Agent Session Control Plane](ling-agent-session.md)

## Purpose

Ling should borrow assistant-ui's polished tool display and high-performance UI-store
ideas without adopting assistant-ui as the runtime or state authority.

This design closes two gaps:

1. Operation display still reads too flat. Running work, tool calls, file reads, command
   output, approvals, checks, and artifacts need a sharper inline visual shape.
2. Long active conversations need scoped UI state and narrow subscriptions so a stdout
   chunk, hover state, or expanded row does not re-render the whole workspace surface.

The product object is called an `OperationBubble` in this document. It is the visual
presentation of Ling's existing `OperationCell` or `AgentActivitySpan`. It is not a new
daemon entity and it is not assistant-ui's `ToolFallback` component.

## Non-Goals

- Do not replace daemon/core projection with assistant-ui runtime/store.
- Do not make workflow branches behave like assistant-ui alternative answer branches.
- Do not hide Ling agent operations, approvals, diffs, checks, artifacts, or evidence in
  a generic tool bubble.
- Do not move conversation evidence into a right drawer.
- Do not create a new database table for view state.
- Do not persist hover, focus, expanded, copied, measured-height, or preview-open state.

## Source Of Truth Boundary

Ling has two layers:

```text
authoritative state
  daemon/core projection
  channel / workflow / run / approval / artifact / evidence records
  ConversationTurn / TranscriptBlock / OperationCell / AgentActivitySpan

view state
  Web conversation view store
  expanded ids, focused id, hover action target, copied ids, preview modal state,
  virtualizer measurements, local loading states
```

Only the first layer decides what happened. The Web view store decides how the current
user is looking at it.

Rules:

- A model message, assistant-ui pattern, or local view store state cannot create runtime
  authority.
- An `OperationBubble` renders from an existing transcript block id and revision.
- Any side-effecting action still routes through the existing approval/runtime path.
- If the daemon projection changes, the view store reconciles local UI state against the
  new block ids and revisions.

## Assistant-UI Borrowing Map

| Assistant-ui concept | Ling borrowing | Ling boundary |
| --- | --- | --- |
| `ToolFallback.Root` | `OperationBubbleRoot` visual shell | No new runtime tool entity |
| `ToolFallback.Trigger` | compact operation header with chevron | Trigger toggles local expansion only |
| `ToolFallback.Content` | inline semantic detail body | Detail belongs in the owning turn |
| `ToolFallback.Args` | `Input`, `Target`, or `Plan` section | Render bounded summaries, not raw JSON |
| `ToolFallback.Result` | `Result`, `Checks`, `Artifacts`, `Sources` sections | Link to existing evidence refs |
| `ToolFallback.Error` | `Error` or `Blocked` section | Failed/blocked stays expanded by default |
| `ToolFallback.Approval` | Ling inline approval section | Approval state remains daemon-owned |
| `ActionBar` | hover/focus action rail | Never creates transcript rows |
| Tool state spinner/shimmer | active header status motion | Disabled under reduced motion |
| External store adapters | scoped conversation view store | No assistant-ui runtime authority |

## Operation Bubble Visual Contract

`OperationBubble` is a compact inline work object. It may have richer visual treatment
than the earlier borderless `OperationCell`, but it must still feel like part of the
conversation transcript, not a detached dashboard card.

Header anatomy:

```text
[chevron] [kind icon] [actor] [operation label] [status chip] [summary] [actions]
```

| Field | Required | Notes |
| --- | --- | --- |
| Chevron | when expandable | right when collapsed, down when expanded |
| Kind icon | yes | stable lucide icon per operation kind |
| Actor | when ownership matters | `Engineer`, `QA`, `Product`, teammate display name, or runner label |
| Operation label | yes | short verb phrase such as `read_file`, `edit_file`, `run_command` |
| Status chip | yes | low-saturation status tone |
| Summary | when available | one-line target or latest meaningful result |
| Actions | on hover/focus | copy, open, download, retry, diagnostics, details |

Default geometry:

| Token | Value | Rule |
| --- | --- | --- |
| header min-height | 32px | stable across hover, running, and terminal states |
| icon slot | 18px | no oversized badge container |
| status chip height | 20px | compact, text may truncate with tooltip |
| border radius | 7px | keep under the app's 8px card limit |
| header padding | 6px 8px | dense but touchable |
| body indent | 28px | aligns with label text after icon |
| body max inline width | parent conversation column | never stretch into side utilities |

Visual tone:

- Use a subtle surface fill only for the bubble header and expanded body.
- Avoid nested cards inside the expanded body.
- Use one hairline border or one left accent line, not both.
- Avoid large colored backgrounds. Status is expressed through chip tone, icon tone, and
  small accent line.
- Preserve existing transcript density. Do not turn every command into a tall card.

## Operation Kind Mapping

| Operation kind | Icon | Header label examples | Default detail |
| --- | --- | --- | --- |
| `read_file` | `FileSearch` | `read_file`, `读取文件` | Target, result summary, source refs |
| `search` | `Search` | `search`, `搜索代码` | Query, result count, top files |
| `list_files` | `FolderSearch` | `list_files`, `读取目录` | Target path, count, filters |
| `edit_file` | `PencilLine` | `edit_file`, `修改文件` | Changed files, diff preview, approval if needed |
| `run_command` | `Terminal` | `bash`, `运行命令` | Command, bounded output, exit status |
| `approval` | `ShieldCheck` | `approval_needed`, `等待审批` | Risk, payload summary, approve/deny controls |
| `verify` | `BadgeCheck` | `verify`, `检查` | Passed/failed checks first |
| `artifact` | `PackageOpen` | `artifact_ready`, `产物` | Artifact strip and lightbox action |
| `workflow_step` | `ListChecks` | `workflow_step`, `工作流步骤` | Step owner, dependencies, packet refs |
| `requirement_shaping` | `MessagesSquare` | `requirement_shaping`, `需求澄清` | Useful participant contributions only |
| `source_summary` | `Library` | `sources`, `来源` | Sources used, open source detail |
| `handoff` | `Users` | `handoff`, `交接` | From/to actor, reason, next action |

Implementation may keep current internal kind names, but the renderer should map them to
this visible vocabulary before display.

## Collapse And Expansion Policy

| State | Running display | Terminal display | Expansion default |
| --- | --- | --- | --- |
| `queued` | compact header | compact header | collapsed unless it explains waiting |
| `running` | header plus active latest detail | same block mutates when terminal | expanded |
| `waiting_for_approval` | header plus approval body | resolves into terminal state | expanded |
| `blocked` | header plus blocker body | remains visible until resolved | expanded |
| `failed` | header plus error/check body | remains visible until handled | expanded |
| `cancelled` | compact header | compact header with lineage if useful | collapsed unless user initiated |
| `succeeded` | active until terminal commit | compact header after coordinator summary | collapsed |

Rules:

- Running work is never initially hidden.
- Completed work may fold only after the terminal state is committed.
- If a final coordinator answer references the completed work, the completed bubble can
  fold to one line immediately after that answer appears.
- Approval, blocked, and failed states do not auto-fold.
- Expanding a completed bubble restores semantic operation rows, checks, approvals,
  artifacts, and bounded output in the same turn.
- Raw/debug detail is a secondary explicit action inside the expanded body.

## Expanded Body Sections

Expanded body order:

```text
Summary
Input / Target / Plan
Current progress
Result
Approvals
Checks
Files and diffs
Artifacts and previews
Sources
Agent activity
Raw/debug refs
```

Section rules:

- Omit empty sections. Do not render placeholder headings.
- Use semantic labels, not raw event names.
- Use bounded content by default. Long logs and large diffs have inline "Show more" or
  lightbox/detail actions.
- File previews, diff review, artifact preview, approval detail, and source metadata open
  inline or as lightbox/modal from the owning turn.
- Copy/open/download feedback is inline status text or button state, not a transcript row.

Default caps:

| Section | Cap | Overflow |
| --- | --- | --- |
| Summary | 2 lines | truncate with tooltip only if non-critical |
| Input/target | 4 rows | fold extra rows behind "Show input" |
| Command output | 5 lines or 8 KB | inline expand to bounded larger view, raw artifact for full output |
| Files | 6 files | count hidden files and link to diff detail |
| Checks | 5 checks | failed checks first |
| Artifacts | 4 artifacts | count hidden artifacts |
| Sources | 4 sources | count hidden sources |
| Agent history | latest 3 semantic actions per agent | older actions folded under span |

## AgentActivitySpan As Operation Bubble

`AgentActivitySpan` uses the same visual grammar but stays visually lighter than a full
operation. It is one latest-action line per participating agent.

Header anatomy:

```text
[agent avatar or icon] [agent name] [status chip] [latest action] [chevron]
```

Rules:

- Multiple active agents may render as a small stacked group under one parent operation
  bubble.
- Each agent span expands independently.
- Parallel agent spans keep stable order by first semantic appearance.
- Completed agent spans fold after the coordinator summary, but failed/blocked spans stay
  open until handled.
- Direct teammate private chat is not an `AgentActivitySpan`; it owns its conversation.

Example:

```text
Product    running   Clarifying acceptance criteria
Architect  done      Confirmed packet boundaries
QA         blocked   Needs preview URL
```

## Action Bar

Borrow assistant-ui's hover/focus action bar pattern. Actions stay out of the transcript
until the user interacts.

| Action | Visibility | Effect |
| --- | --- | --- |
| Copy summary | hover/focus and keyboard shortcut | copies visible summary |
| Copy output | expanded command output only | copies bounded or full source depending on section |
| Open file/source | when target has URL/path | opens existing local/file/source handler |
| Download artifact | artifact rows only | starts download and shows inline feedback |
| Retry | failed safe operation only | calls existing retry handler |
| Approve/Deny | approval body only | explicit buttons, never gesture-only |
| Diagnostics | advanced failures | opens existing diagnostics detail |
| Raw/debug | developer-mode or explicit detail | opens bounded raw ref, not default body |

Accessibility:

- Every icon action has an accessible name and tooltip.
- Keyboard focus reveals the same action bar as hover.
- Enter/Space toggles the bubble header when expandable.
- Escape closes local popovers/previews before moving focus.
- Copy/open/download success uses polite live announcement.

## Motion

Use motion to show activity, not decoration.

Allowed:

- running status spinner or subtle sweep on the status chip;
- 150-180 ms settle-in when a new bubble first appears;
- focus-locate pulse when the app scrolls to an owning turn;
- chevron rotation on expansion.

Not allowed:

- perpetual animation on terminal rows;
- background bokeh, orbs, or decorative gradients;
- layout-shifting animations that resize text rows;
- animation that hides an approval, blocker, or failure.

`prefers-reduced-motion: reduce` disables non-essential motion. State changes must remain
visible through text, icon, and status chip.

## Conversation Performance Store

The view store borrows assistant-ui's scoped subscription idea. It keeps high-frequency UI
state close to the component that needs it.

Suggested module boundary:

```text
apps/web/src/shared/conversation/view-store/
  conversation-view-store.ts
  conversation-view-selectors.ts
  conversation-view-provider.tsx
  use-conversation-action-view.ts
  use-conversation-block-view.ts
  use-conversation-span-view.ts
  use-conversation-view-reconciliation.ts
```

The store is Web-local until the API proves stable. It can later move into
`packages/conversation-ui-core` only if Desktop or another surface consumes it.

Store-owned state:

| State | Key | Persistence |
| --- | --- | --- |
| Expanded block ids | `blockId` | local only |
| Expanded span ids | `spanId` | local only |
| Focused block id | `blockId` | local only |
| Active action bar id | `blockId` or `spanId` | local only |
| Preview/lightbox request | preview request id | local only |
| Copy feedback | action id | local timeout only |
| Measured row heights | virtual item key | local only |
| Deferred render readiness | block id + revision | local only |

Daemon-owned state:

- transcript turns and block order;
- operation status and revisions;
- approval state;
- workflow packet summaries;
- artifact refs and preview metadata;
- source refs;
- run/work-unit lifecycle.

## Subscription Model

Components should subscribe at the smallest useful granularity.

| Subscriber | Selects | Must not re-render for |
| --- | --- | --- |
| Conversation feed | visible turn ids, virtualizer measurements | copy feedback in one code block |
| Turn renderer | ordered block ids for one turn | hover state in another turn |
| Operation bubble header | status, revision, expanded state | preview body loading elsewhere |
| Operation bubble body | expanded state and section refs | collapsed sibling updates |
| Agent span row | span latest action and local expanded state | unrelated agent span changes |
| Code block | code content, streaming flag, copy feedback | operation status chip animation |
| Preview lightbox | active preview request and loaded preview | transcript hover state |

Implementation options:

- Use `useSyncExternalStore` or a small local store with selector equality.
- Keep the raw daemon projection in React state or domain hooks; derive indexed maps once
  per transcript revision.
- Store `blockId -> revision` and `spanId -> revision` so stale local expanded state can
  reconcile after projection changes.
- Use stable callbacks for action bars to avoid remounting every row.

## Rendering Pipeline

```text
daemon/core records
  -> conversation projector
  -> ConversationTranscript snapshot
  -> transcript index maps
  -> view store reconciliation
  -> virtualized visible turn range
  -> block renderer registry
  -> OperationBubble / AgentActivitySpan / message / artifact renderers
```

High-frequency updates:

1. Daemon emits or the Web layer polls a status/output update.
2. Projector updates only the owning block revision.
3. Transcript index replaces that block entry.
4. Store subscribers for that block re-render.
5. Virtualizer remeasures that row if height changed.

The rest of the transcript should not re-render for a stdout chunk.

## Virtualization And Anchors

Rules:

- Virtualize once the feed crosses 200 rendered blocks or 100 turns.
- Keep active running, waiting-for-approval, blocked, and failed bubbles mounted when
  possible, even if older completed content is windowed.
- Preserve anchors by stable turn id and block id, not array index.
- Scroll-to-owning-turn uses the virtualizer's item key and then focuses the bubble header.
- If a row expands above the viewport, preserve the user's visible anchor unless the user
  explicitly requested focus.
- Composer height changes must update viewport measurements without forcing scroll jumps.

## Heavy Content Deferral

Detailed rules for large code, diff, image, image-compare, command-output, raw/debug,
height measurement, and deep virtualization live in
[Conversation Performance Deferral And Virtualization](conversation-performance-deferral-and-virtualization.md).

This document only fixes the Operation Bubble boundary:

- `OperationBubble` provides the shell and inline expansion affordance.
- The view store owns local expansion and action state.
- Heavy bodies may defer, but no operation evidence may become inaccessible.
- Running, waiting-for-approval, blocked, and failed rows stay inspectable.

## Implementation Contract

These choices are fixed for the first implementation slice.

### Component Boundary

`OperationBubble` is a Web component family, not a daemon/core model.

Files should be introduced or split under `apps/web/src/shared/conversation/blocks/`:

```text
OperationBubble.tsx
OperationBubbleHeader.tsx
OperationBubbleBody.tsx
OperationBubbleSections.tsx
OperationBubbleActions.tsx
```

Rules:

- `ConversationWorkCell` remains the compatibility adapter from
  `ConversationOperationCellViewModel` to the visual `OperationBubble` props.
- `OperationCell`, `ConversationWorkCell`, and `AgentActivitySpan` remain the semantic
  names in projection and design language. `OperationBubble` is only the visual shell.
- Do not add a daemon/core `OperationBubble` type, database table, migration, or API.
- Do not move evidence into a drawer or global detail panel. Expanded detail renders
  inside the owning conversation turn.
- Do not fork operation rendering by copying the old row component. Extract row/section
  rendering so old evidence remains reachable through the new shell.

`OperationBubble` owns visual composition:

```text
OperationBubble
  OperationBubbleHeader
  OperationBubbleBody
    OperationBubbleSection[]
  OperationBubbleActions
```

`ConversationWorkCell` owns model adaptation:

```text
ConversationOperationCellViewModel
  -> OperationBubbleProps
  -> OperationBubble
```

`AgentActivitySpan` uses the same header/body grammar through a lighter span renderer.
It should not become a second independent visual system.

### View Store Choice

The first implementation uses a scoped external store built with `useSyncExternalStore`.
Do not use broad React state in `WorkspaceClientView` for expanded ids, hover action
state, copy feedback, preview state, or measured row heights.

Module boundary:

```text
apps/web/src/shared/conversation/view-store/
  conversation-view-store.ts
  conversation-view-selectors.ts
  conversation-view-provider.tsx
  use-conversation-block-view.ts
  use-conversation-span-view.ts
```

Contract:

- No new runtime dependency is required for slice 1. A small local store is enough.
- The provider is scoped to one conversation surface, not the whole workspace app.
  Channel and teammate private chat surfaces each get their own provider instance.
- Shared conversation components must keep a local fallback when no provider is present.
  Channel surfaces use the scoped store for performance and reconciliation; private chat
  or isolated previews may render without provider wiring.
- Store keys include `surfaceId`, `turnId`, `blockId` or `spanId`, and `revision` where
  stale state needs reconciliation.
- Selectors subscribe to the smallest needed state. A copy feedback tick in one code
  block must not re-render the full channel page.
- Reconciliation removes local state for blocks/spans no longer present in the latest
  transcript snapshot.
- Local view state is never serialized to daemon/core and is never sent to model prompts.

Suggested first-store shape:

```ts
interface ConversationDisclosureState {
  readonly expanded: boolean;
  readonly revisionKey: string;
  readonly touched: boolean;
}

interface ConversationCopyFeedbackState {
  readonly copiedAt: number;
}

interface ConversationViewState {
  readonly blockDisclosureById: ReadonlyMap<string, ConversationDisclosureState>;
  readonly spanDisclosureById: ReadonlyMap<string, ConversationDisclosureState>;
  readonly activeActionId: string | undefined;
  readonly previewRequest?: ConversationPreviewRequest;
  readonly copyFeedbackByActionId: ReadonlyMap<string, ConversationCopyFeedbackState>;
  readonly measuredHeightsByItemKey: ReadonlyMap<string, number>;
  readonly readyDeferredBlockKeys: ReadonlySet<string>;
}
```

Slice 1 implementation currently covers `blockDisclosureById`, `spanDisclosureById`,
`activeActionId`, `copyFeedbackByActionId`, and feed-scoped reconciliation for operation,
generic transcript block, and agent-span keys. Preview, measured heights, and deferred
block readiness are reserved for the virtualization/deferral slice. The concrete
implementation may use mutable internals for performance, but selectors must expose
immutable snapshots or stable derived values.

### Expansion State Defaults

Expansion defaults are owned by the renderer, then captured in the view store after user
interaction.

Rules:

- Running, waiting-for-approval, blocked, and failed bubbles default expanded.
- Completed succeeded bubbles default collapsed only after their terminal coordinator
  summary is visible.
- User toggles win over automatic defaults until the block id or revision changes.
- A revision change can auto-open a block only when the new status is
  `running`, `waiting_for_approval`, `blocked`, or `failed`.
- No state transition may hide approval controls, blockers, failures, or new artifacts.

### Action Contract

Action bar controls call existing handlers. They do not create transcript rows by
themselves.

Allowed local-only actions:

- copy visible summary;
- copy bounded output;
- open existing file/source link;
- open preview/lightbox;
- download existing artifact;
- toggle expansion;
- focus owning turn.

Daemon-backed actions still route through existing command paths:

- approve or deny;
- retry;
- cancel;
- diagnostics fetch;
- raw/debug detail fetch.

Each icon action must have an accessible label and keyboard focus style. Hover-only
actions are invalid.

### Compatibility Contract

The first visual slice must preserve current behavior while changing presentation.

Required compatibility:

- Existing `ConversationWorkCell` props keep working.
- Existing artifact preview, approval controls, diagnostics, evidence loading, and
  `onOpenRun` handlers keep their current semantics.
- Existing screenshots may change visually, but no operation row, approval, check,
  artifact, or source ref may disappear.
- Main coordinator answers and final results must never be irreversibly truncated. If a
  preview is shortened, the same turn must provide inline expansion or an existing
  artifact/raw ref for the full content.

### Implementation Order

Build in this order:

1. Extract `OperationBubble` components with no behavior change.
2. Add the scoped view store and move expansion/copy/preview state behind selectors.
3. Add visual polish: status chip, icon mapping, action bar, section labels.
4. Add caps and explicit "Show more" controls for heavy sections.
5. Add the dedicated performance deferral and deep virtualization slice.

Do not start virtualization before the component boundary and view-store boundary exist.
Otherwise scroll anchoring and expansion state will be tied to the wrong owner.

## Implementation Slices

### Slice 1: Visual Operation Bubble

Files:

```text
apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx
apps/web/src/shared/conversation/blocks/TranscriptBlockView.tsx
apps/web/src/shared/conversation/blocks/OperationBubble*.tsx
apps/web/src/styles/components.css
apps/web/e2e/channel.spec.ts
```

Work:

- Add `OperationBubbleHeader` and `OperationBubbleBody` components around the existing
  `ConversationWorkCell` model.
- Add status chip, kind icon, chevron, and hover/focus action bar.
- Preserve existing row evidence and expansion.
- Add running, completed, approval, blocked, failed, and parallel-agent fixtures.

Acceptance:

- Running bubbles are expanded enough to inspect current action.
- Completed bubbles fold to one line and expand inline.
- Approval, blocked, and failed bubbles are visible without opening a drawer.
- Existing agent operation evidence remains reachable.

### Slice 2: Tool-Like Section Renderers

Files:

```text
apps/web/src/shared/conversation/blocks/
apps/web/src/shared/conversation/preview/
apps/web/src/styles/components.css
```

Work:

- Normalize detail sections into `Input`, `Result`, `Checks`, `Files`, `Artifacts`,
  `Sources`, `Error`, and `Raw/debug refs`.
- Add section caps and "Show more" controls.
- Add icon and tone mapping for common operation kinds.

Acceptance:

- Tool-like operations no longer read as raw logs.
- Long output stays bounded.
- No semantic evidence is removed.

### Slice 3: Conversation View Store

Files:

```text
apps/web/src/shared/conversation/view-store/
apps/web/src/shared/conversation/blocks/ConversationVirtualFeed.tsx
apps/web/src/features/workspace/WorkspaceClientView.tsx
```

Work:

- Add local view store with scoped selectors.
- Move expanded/focused/copy/preview transient state out of broad workspace state where
  practical.
- Reconcile local view state against transcript block ids and revisions.
- Use `use-conversation-action-view.ts` for Operation Bubble copy feedback and active
  action state. Generic code/artifact copy buttons can migrate later only if needed.
- Use `use-conversation-view-reconciliation.ts` from the owning feed to prune operation
  details, generic transcript block disclosure, agent span disclosure, active action,
  and copy feedback keys that are no longer present in the visible conversation surface.

Acceptance:

- Toggling one bubble does not re-render unrelated turns.
- Copy feedback in one block does not re-render the full feed.
- Running output updates only the owning block/span.

### Slice 4: Performance Deferral And Deep Virtualization

Detailed contract:
[Conversation Performance Deferral And Virtualization](conversation-performance-deferral-and-virtualization.md)

Files:

```text
apps/web/src/shared/conversation/blocks/ConversationVirtualFeed.tsx
apps/web/src/shared/conversation/blocks/CodeBlock.tsx
apps/web/src/shared/conversation/blocks/DiffCodeBlock.tsx
apps/web/src/shared/conversation/preview/ImageCompareViewer.tsx
apps/web/e2e/channel.spec.ts
```

Work:

- Preserve active-row anchors during virtualization.
- Defer heavy code/diff/image/raw rendering under the dedicated shell-first contract.
- Add performance fixtures for long transcripts and active output.

Acceptance:

- A long transcript remains responsive.
- Active rows stay visible and stable.
- Reduced-motion and long-label checks still pass.

## Testing Matrix

| Case | Required proof |
| --- | --- |
| Running read_file bubble | expanded header/body, live status, no duplicate rows |
| Completed read_file bubble | folded summary plus inline expansion |
| Approval bubble | visible controls, no gesture approval |
| Blocked/failed bubble | expanded by default |
| Parallel agent spans | one latest-action row per active agent |
| Long command output | bounded by default, copy available |
| Large code block | plain while streaming, highlighted after commit or deferred |
| Image compare | opens explicit lightbox, operation evidence remains visible |
| Long transcript | virtualized with stable focus and scroll anchors |
| Reduced motion | no shimmer/sweep, state still visible |
| Mobile composer | no accidental approve/cancel/delete gesture |

## Open Decisions

No unresolved product or engineering decisions block implementation.

The first implementation uses:

- a new Web-only `OperationBubble` component family adapted from the existing
  `ConversationWorkCell` model;
- a scoped conversation view store backed by `useSyncExternalStore`;
- daemon/core projection as the only source of truth for transcript and operation data.
