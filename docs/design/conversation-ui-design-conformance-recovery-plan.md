# Conversation UI Design Conformance Recovery Plan

Status: active Phase 1 correction plan
Date: 2026-06-15
Scope: Phase 1 core message framework for the channel main conversation. Floating run
popover, right drawer, and source summary work are later surfaces that consume this
framework.

Related docs:

- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
- [Conversation UI Framework And Copy Canon Implementation Plan](conversation-ui-framework-copy-implementation-plan.md)
- [Codex-Inspired Conversation Experience v1](codex-inspired-conversation-v1.md)
- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)
- [Multi-Agent Collaboration Cards Implementation Plan](multi-agent-collaboration-cards-implementation-plan.md)

## Why This Exists

The current Slice 1 and Slice 2 implementation passed too narrow a test gate. It verified
that a few `ConversationWorkCell` and `AgentActivitySpan` selectors existed, but it did
not verify the actual UI-layer contract from `Ling Agent Operation Cell UI`.

The visible failure is that the main conversation can expand into a diagnostic evidence
dump containing `Context Pack`, provider/model/token metadata, workflow ids, raw artifact
paths, JSON/log/file paths, and low-level runtime vocabulary. That is not the accepted
Codex-like transcript design.

This document supersedes the current Slice 1 and Slice 2 acceptance status until the
checks below pass. Slice 3 must not continue until this conformance recovery is complete.

## Source Of Truth

The product contract remains:

```text
raw runtime events
  -> normalizer
  -> semantic UI model
  -> cell render contract
  -> surface placement
```

The transcript model is heterogeneous. A user turn owns an ordered stream of semantic
blocks, not a fixed set of headings or required coordinator prefixes:

```text
UserMessageCell
LingAgentTranscript
  blocks: TranscriptBlock[]
```

The visual target remains:

- Stitch project: `Ling Stack Strict Daylight UX v3 - Channel Drawer v1.24`
- Stitch project id: `projects/3112180709682189824`
- Stitch screen reference: `频道会话 - Strict Codex Transcript v1`
- Main feed style: borderless transcript, not card stack or dashboard panel

If implementation conflicts with `Ling Agent Operation Cell UI`, the design contract wins
unless this document records a newer decision.

Cross-client target:

```text
daemon/core projection
  -> ConversationTranscript contract
  -> Web / Desktop / CLI renderers
```

This recovery pass may keep the first corrected projection in Web for speed, but any new
logic that decides turn ownership, active/terminal cell lifecycle, or raw/detail boundary
must be written so it can move into shared contracts/core. Do not add Web-only heuristics
that Desktop would later have to duplicate.

## Phase 1 Boundary

Phase 1 is the core message framework. It is not a popover, drawer, or source-summary
project.

The deliverable is:

```text
runtime/channel records
  -> ConversationTranscriptTurn
     blocks:
       coordinator_text*
       operation_cell*
       agent_activity_span*
       coordinator_text*
       artifact_strip?
```

Required behavior:

- One executable user task normally renders as one assistant transcript turn.
- The start text, operation cells, agent spans, terminal text, and artifact strip are
  ordered blocks inside the same turn.
- Active `OperationCell` blocks mutate in place while work runs.
- Terminal `OperationCell` blocks commit as folded transcript rows; they are not deleted
  and are not replaced by the final coordinator summary.
- `AgentActivitySpan` blocks keep each agent's semantic process folded under that agent
  after completion.
- The transcript structure comes from ids, statuses, ownership refs, and event types, not
  from generated phrases such as `确认需求` or `完成`.

Explicitly out of Phase 1:

- right floating popover polish;
- right drawer de-dup or detail pages;
- SourceSummaryStrip and source icons;
- Work History page density;
- shared daemon/core contract extraction, except writing code so the Web prototype can
  move there later.

Those later surfaces may not define the transcript model. They can only consume the
Phase 1 transcript model after it is stable.

## Current Root Cause

The implementation reused `ConversationWorkCell` as a compatibility shell, but the
projection boundary is still leaky:

- `ConversationWorkCellDetails` renders all evidence groups as main-feed inline detail.
- The `context` group is treated like user-facing evidence instead of raw/detail evidence.
- Tests currently protect the wrong behavior by expecting internal labels such as
  `workflow_runtime_boundary` after inline expansion.
- Multi-agent rows were partially moved to `AgentActivitySpan`, but still sit inside a
  work-cell mental model rather than a strict transcript model.
- Surface work was mixed into the message-framework pass, which made the implementation
  optimize visible UI fragments before the transcript lifecycle was correct.

## Design Decisions Reconfirmed

### One User Task, One Default Work Object

The default visible conversation should be:

```text
user request
Ling Agent coordinator message when useful
OperationCell
  AgentActivitySpan rows when multi-agent work exists
  compact operation rows
terminal Ling Agent summary
artifact / file / check summary
```

It must not become:

```text
Ling Agent started
workflow row
run row
work-unit row
collaboration card
raw event log
right drawer duplicate
Ling Agent completion duplicate
```

### Display / Expanded / Raw

Every conversation cell has three logical render modes:

| Mode | Purpose | Allowed by default in main feed |
| --- | --- | --- |
| `display` | Short user-readable transcript line | yes |
| `expanded` | Bounded semantic evidence for normal audit | yes, only if bounded |
| `raw` | Developer/support detail | no, right drawer/detail only |

### No Fixed Coordinator Template

Coordinator text is natural assistant prose. Examples such as `确认需求：...` or
`完成：...` are examples only. The implementation must not infer turn phase by matching
those phrases, and it must not rewrite arbitrary assistant text into a rigid prefix.

Turn phase and cell ownership come from semantic projection fields:

- root user turn id;
- coordinator text segment role, when known;
- operation cell status and lifecycle;
- agent span status and owner;
- artifact/check/file evidence refs;
- terminal result marker, when the runtime has one.

If older data lacks a structural marker, the fallback should preserve the original
assistant text and still group known workflow/run/tool events under the root user turn.
It should not depend on generated Chinese wording.

Any temporary fallback that still uses body text must be isolated, tested as legacy-only,
and removed when structural metadata exists. New transcript lifecycle code should use ids,
statuses, ownership refs, and event types.

### Inline Expanded Detail Allow List

Inline expanded detail may show:

- changed files, up to 6 rows;
- checks, up to 5 rows, failed checks first;
- approvals, up to 3 recent decisions;
- artifacts, up to 4 rows;
- command names and bounded output only when the command is user-meaningful;
- blocker or failed-step excerpts when they change the user's next action.

Inline expanded detail must not show:

- `Context Pack`;
- provider/model metadata;
- token budgets or context-window values;
- workflow/run/work-unit ids;
- raw artifact storage paths;
- JSON/log file names as primary evidence;
- raw event ids;
- route/intent/target resolver diagnostics;
- `workflow`, `run`, `work-unit`, `packet`, `attempt`, `selector`, `raw event` as user
  labels.

### Later Surface Ownership

These boundaries are retained for later phases. They are not Phase 1 acceptance gates.

| Surface | Owns | Must not own |
| --- | --- | --- |
| Main feed | narrative, operation rows, agent spans, final result, artifact strip | raw logs, ids, duplicated drawer detail |
| Inline expansion | bounded semantic evidence | Context Pack, JSON dumps, provider metadata |
| Floating popover | active state only, optional compact source icons after source projection exists | history, logs, completed summaries |
| Right drawer root | Files, Settings | active progress, copied main transcript, raw context pages |
| Right drawer detail | commands, outputs, diffs, source detail, raw events | repeated coordinator summary |

`SourceSummaryStrip` is not part of the first visible recovery gate. It should be added
only after R1-R3.1 prove that operation ids, agent span ids, and terminal committed rows
are stable. Sources attach to those semantic blocks; they must not create another
first-level conversation card.

## Old Design Document Handling

Do not delete historical design documents unless they block implementation. Mark them
explicitly instead.

| Document | Decision |
| --- | --- |
| `ling-agent-operation-cell-ui.md` | active product/UI contract |
| `conversation-ui-framework-copy-implementation-plan.md` | active execution plan, amended by this recovery plan |
| `codex-inspired-conversation-v1.md` | background design source, still valid |
| `codex-inspired-conversation-components-v1.md` | background component source, still valid |
| `multi-agent-collaboration-cards-implementation-plan.md` | superseded for main-feed UI; retained only as historical context |
| `multi-agent-collaboration-cards-and-ambient-audit.md` | superseded for main-feed UI; retained only as historical context |

The word "card" is no longer allowed as a first-level main conversation model for Ling
Agent work. Existing compatibility class names may remain during migration, but they must
not drive visual shape or product vocabulary.

## Phase 1 Core Slices

### R0. Baseline And Guardrail Audit

Type: read-only before edits.

Files:

```text
apps/web/src/lib/conversation-work-cell.ts
apps/web/src/lib/collaboration-task-work-cell.ts
apps/web/src/shared/conversation/ConversationWorkCell.tsx
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/e2e/channel.spec.ts
```

Work:

- Locate all main-feed render paths for `ConversationWorkCell`.
- Locate all builders that create `context`, `evidence`, `changed`, `checked`, and
  `attention` groups.
- Locate e2e assertions that currently expect raw/context/provider/token detail in the
  main feed.
- Capture a before screenshot of the broken completed-work expansion.

Acceptance:

- Every current raw/context leak has an owning builder or renderer.
- The wrong tests are identified before edits.
- No code behavior changes in this slice.

### R1. ConversationTurn Projection Boundary

Type: Web prototype projection, moving toward the shared daemon/core transcript
projection.

Files:

```text
apps/web/src/lib/conversation-turn-projector.ts
apps/web/src/lib/conversation-work-cell.ts
apps/web/src/lib/collaboration-task-work-cell.ts
apps/web/src/features/workspace/WorkspaceClientView.tsx
```

Problem corrected by this slice:

The current feed still renders `message`, `workflow`, and `run` activity records as
separate first-level items. That makes one user request appear as multiple Ling Agent
replies plus a separate work card, and it can make completed work look like the process
was deleted or replaced by a summary. Filtering evidence is not enough. The feed needs a
turn-level projection before React rendering.

R1 introduces `ConversationTurnProjector`:

```text
channel messages, proposals, workflows, steps, runs, approvals, artifacts, collaboration cards
  -> ConversationTurnViewModel[]
  -> user message + coordinator start + OperationCell + coordinator summary + artifact strip
```

The projector groups by the root user message first:

- root user message: `ChannelMessage` with `authorType=local-user`, `kind=message`, and no
  `threadId`;
- coordinator start and terminal messages: Ling Agent messages whose `threadId` equals the
  root user message id;
- workflow operation: workflow linked by an execution proposal, channel intent decision, or
  workflow metadata/source relation to the root user message;
- run operation: run linked by proposal or thread relation when no workflow operation owns
  it;
- collaboration projection: same operation cell, with `AgentActivitySpan` rows nested
  under the operation, never a first-level collaboration card.

Output contract:

```ts
interface ConversationTurnViewModel {
  readonly id: string;
  readonly sourceMessage: ChannelMessage;
  readonly coordinatorStartMessages: readonly ChannelMessage[];
  readonly coordinatorTerminalMessages: readonly ChannelMessage[];
  readonly operationCell?: ConversationOperationCellViewModel;
  readonly operationDetailsKey?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ConversationTurnProjection {
  readonly turns: readonly ConversationTurnViewModel[];
  readonly hiddenActivityIds: ReadonlySet<string>;
}
```

Default feed rules:

- Render a `ConversationTurnViewModel` as one visible work object.
- Hide the grouped root message, child coordinator messages, workflow item, workflow-step
  items, represented runs, and represented approvals from the default flat activity feed.
- Keep the active operation as the same cell while it mutates; after completion it remains
  as a committed cell with folded semantic rows.
- Do not delete process rows on completion; completion changes state and folding, not
  ownership.
- In audit/filter mode, flat activity fallback may still show legacy records because the
  user explicitly asked for debugging/filtering.

Evidence boundary still applies inside the projected operation:

- Keep `ConversationOperationCellViewModel` as the compatibility type.
- Split main-feed evidence into display fields, inline-safe expanded groups, and raw/detail
  refs for future drawer detail.
- Keep raw/context/provider/token artifacts in data, but do not pass them to main-feed
  inline detail.
- Convert generic runtime summaries such as `Run succeeded.` into user-facing task state.

Acceptance:

- One root user message with an auto-started workflow renders as one `ConversationTurn`
  sequence, not as separate default feed items.
- Completed workflow cells keep their compact operation/evidence rows in the turn.
- The start coordinator message, operation cell, and terminal coordinator message no
  longer appear as unrelated sibling replies in the default feed.
- Main-feed operation `groups` never include raw/context-only sections.
- `Context Pack`, provider/model metadata, token budgets, workflow ids, and raw artifact
  paths do not reach the default or expanded main-feed rendering.
- Audit access is not destroyed: hidden raw/detail items remain reachable through existing
  evidence objects, audit filters, or a future `RawDetailRef` drawer path.

### R2. Main Conversation Transcript Renderer

Type: React and CSS.

Files:

```text
apps/web/src/shared/conversation/ConversationWorkCell.tsx
apps/web/src/styles/components.css
```

Work:

- Treat `ConversationWorkCell` as an `OperationCell` renderer, even if the export name
  remains for compatibility.
- Delete or rewrite obsolete card/work-cell styles instead of layering transcript CSS on
  top of conflicting panel styles.
- Remove card-like visual treatment from the main feed:
  - no outer border;
  - no card background;
  - no shadow;
  - no large badge rail;
  - no chip-heavy evidence layout.
- Change the rail into a stable 16px status icon slot.
- Keep evidence trigger as one compact transcript line with a chevron.
- Render expanded detail as indented transcript content, not a nested panel.
- Rows without safe semantic detail must not show a disclosure affordance.
- Expanded detail loads automatically when opened. Do not show a second "load evidence"
  button or copy that explains the UI mechanics.
- A diagnostics/raw-detail action is allowed only when no inline semantic evidence is
  available; it must not sit beside an evidence disclosure for the same operation.

Acceptance:

- The main feed visually reads as transcript rows.
- The expanded area is text/rows with indentation, not a dashboard evidence panel.
- No default diagnostics button appears when inline evidence already exists.
- Completed work has one operation result surface plus optional artifact strip.
- CSS has one effective transcript contract for `.conversation-work-cell`; old panel/card
  rules are removed or neutralized at their source.

### R3. AgentActivitySpan Correction

Type: Web model and React.

Files:

```text
apps/web/src/lib/collaboration-task-work-cell.ts
apps/web/src/shared/conversation/ConversationWorkCell.tsx
apps/web/src/styles/components.css
apps/web/e2e/channel.spec.ts
```

Work:

- Keep `agentSpans` as the canonical main-feed field.
- Show one latest-action line per visible agent by default.
- Fold prior actions behind the agent row.
- Collapse more than three active/interesting agents into an overflow row.
- Do not show `Agent branches`, `{owner} branch`, raw branch ids, or collaboration-card
  labels in the main feed.
- Do not show raw sub-agent transcript in the main feed.
- Treat `ConversationAgentActivitySpan` as its own view model, not as a renamed branch
  row. `agentBranches` may remain only as a compatibility alias during migration.
- Build each default span head from:
  - visible agent name;
  - one latest semantic action;
  - optional semantic result/blocker/step-summary text;
  - compact state only when it clarifies running/waiting/failed/done state.
- Do not use full workflow step prompt, context packet, output packet, branch id, or raw
  sub-agent transcript as a default span summary.
- If a workflow step prompt was generated by the proposal workflow template, only the
  structured `Step summary` section may be projected as semantic copy.
- Do not show UI-mechanics copy such as `previous actions` in the default feed or as the
  first expanded detail line.
- Overflow spans may show the hidden teammate names in the default line; their expanded
  rows show one semantic latest action per hidden teammate.

Acceptance:

- Serial and parallel multi-agent work render as AgentActivitySpan rows.
- Each visible agent row shows current/latest semantic action only.
- Failed, blocked, waiting, or approval-needed agents remain visible.
- Raw sub-agent transcript is not visible by default.
- Agent span expansion shows folded historical semantic actions only; it does not start
  with a generic history label.
- More than three visible agent groups collapse to one overflow AgentActivitySpan.

### R3.1. AgentActivitySpan Lifecycle And Copy

Type: Web projection, coordinator message projection, tests.

Files:

```text
apps/web/src/lib/collaboration-task-card.ts
apps/web/src/lib/collaboration-task-work-cell.ts
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/e2e/channel.spec.ts
```

Work:

- Treat running and completed agent activity as the same semantic span. Completion must
  fold prior actions; it must not discard them.
- The default span head shows only the agent name, one latest semantic action, and a
  compact state. The detail area shows the folded semantic process for that agent.
- Completed multi-agent work keeps each agent's process available behind the span toggle.
  The toggle is hidden only when there is no additional semantic action to reveal.
- Generic internal action words such as `Consult`, `Review`, `Coordinate`, `Coordinated`,
  `Reviewed`, and `flagged_risk` are not valid default span copy. Prefer, in order:
  `resultSummary`, `blocker`, structured `Step summary`, then a cleaned step title.
- Coordinator start and terminal messages in a conversation turn are display-projected.
  They must not repeat generated workflow request text, `Smoke ID`, internal routing
  vocabulary, branch ids, proposal template sections, or UI-mechanics explanations.
- Coordinator start and terminal copy render inside one Ling Agent transcript row for
  the user turn. The UI must not show them as two separate assistant replies.
- The raw message can remain in audit/detail surfaces; the default conversation uses the
  semantic display body.

Acceptance:

- While active, each agent span mutates in place to the latest semantic action.
- After completion, default feed still shows compact agent rows; expanding a row reveals
  that agent's semantic process.
- Agent span expansion is available whenever at least one semantic process row exists;
  it is not hidden just because the agent has only one completed workflow step.
- Explicit branch metadata is not required for a non-coordinator teammate span. A single
  assigned teammate still renders as an `AgentActivitySpan` when the workflow has a
  semantic process row; coordinator-only work remains a plain `OperationCell`.
- Completed agent history is not lost when workflow status becomes `succeeded`.
- The default transcript has one Ling Agent assistant transcript per executable user
  turn; the transcript contains coordinator text segments, operation cells, agent spans,
  and terminal text as ordered blocks.
- Default feed does not contain `Consult`, `Review`, `Coordinate`, `Smoke ID`,
  `Confirmed proposal`, `Acceptance criteria`, or raw branch ids for R3.1 fixtures.
- Coordinator text is natural prose and is not forced into `确认需求` or `完成` prefixes.
- Start/terminal ownership is asserted through projection metadata, not string matching.
- Completed teammate process rows remain folded under the relevant `AgentActivitySpan`
  and are not replaced by a one-line coordinator summary.

### R3.2. Core Message Framework Regression And Visual QA

Type: e2e plus browser screenshot for Phase 1 only.

Files:

```text
apps/web/e2e/channel.spec.ts
apps/web/e2e/support/mock-daemon.ts
docs/design/conversation-ui-framework-copy-implementation-plan.md
```

Work:

- Replace positive assertions for raw/context/provider/token/id visibility in the main
  feed with negative guards.
- Add focused fixtures for:
  - single-agent active operation mutating in place;
  - single-agent completed operation with folded committed rows;
  - serial multi-agent work with folded completed agent process;
  - parallel multi-agent work with one latest action per agent;
  - terminal coordinator text in the same assistant transcript turn.
- Capture screenshots for:
  - completed single-agent operation expanded;
  - serial multi-agent completed operation expanded;
  - parallel multi-agent active operation.

Acceptance:

- `corepack pnpm --filter @ling-stack/web typecheck` passes.
- Focused `channel.spec.ts` tests for Phase 1 pass.
- Browser smoke for the main conversation has no console errors/warnings.
- Screenshots show one assistant transcript turn per executable user task.
- No Phase 1 test depends on the right floating popover, right drawer, or source icons.

R3.2 gate evidence:

- `channel.spec.ts` includes fixtures for active single-agent mutation, completed
  single-agent committed rows, completed serial multi-agent expansion, completed
  single-step agent expansion without branch metadata, and active parallel multi-agent
  latest-action rows.
- The negative guards assert that Phase 1 main feed fixtures do not leak raw proposal,
  provider, token, context-file, smoke-id, branch-id, or UI-explainer copy.
- Visual QA screenshots are generated from the same mock-daemon fixture shape, not from
  stale local conversation history.
- Multi-agent fixtures assert that `AgentActivitySpan` rows preserve first semantic
  appearance order. Status and severity affect tone only; they do not reorder the
  transcript or coordinator teammate list.
- 2026-06-17 local verification:
  - `corepack pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g "phase 1 active single-agent transcript|phase 1 completed main-agent transcript|phase 1 parallel multi-agent active transcript|completed multi-agent transcript keeps folded agent process"`
  - `corepack pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g "completed single-step agent span|progress surfaces fold completed workflow steps|workflow context inspect details stay out|workflow action details stay in folded evidence|thread action details"`
  - `LING_R32_SCREENSHOTS_DIR=/tmp/ling-r32-screens corepack pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g "phase 1 completed main-agent transcript|phase 1 parallel multi-agent active transcript|completed multi-agent transcript keeps folded agent process"`
  - screenshot artifacts generated outside the repo:
    `/tmp/ling-r32-screens/completed-single-agent-expanded-{desktop,mobile}.png`,
    `/tmp/ling-r32-screens/parallel-multi-agent-active-{desktop,mobile}.png`,
    `/tmp/ling-r32-screens/serial-multi-agent-expanded-{desktop,mobile}.png`.

## Later Surface Slices

The slices below are valid work, but they must start only after R1-R3.2 pass.

### R4. Floating Popover Boundary

Type: Workspace UI.

Files:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/styles/components.css
apps/web/e2e/channel.spec.ts
```

Work:

- Preserve the right floating popover.
- Restrict it to active-work state only:
  - running;
  - waiting for approval;
  - blocked while unresolved.
- Hide after terminal main-feed summary/artifact strip commits.
- Hide or reduce when the right drawer is open.
- Show one actor, elapsed time, one latest-action phrase, and the relevant small action.

Acceptance:

- The popover is visible during active work.
- The popover is hidden after succeeded/cancelled terminal summary.
- The popover never shows raw ids, command output, workflow/run labels, branch history, or
  completed summaries.
- Opening the drawer does not create duplicate progress UI.

R4 gate evidence:

- `ProgressPopover` renders active progress rows only; provider, permission mode, and
  other run settings are no longer part of the floating popover.
- `buildCollaborationProgressProjection(..., scope: "active")` is the popover workflow
  source, so terminal collaboration summaries stay in the committed transcript instead
  of the floating surface.
- 2026-06-17 local verification:
  - `corepack pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g "channel drawers match the accepted HTML layout|wide channel progress popover keeps the accepted HTML spacing|progress popover owns workflow status|progress surfaces fold completed workflow steps|progress popover prefers daemon collaboration card payload|progress popover falls back to local collaboration card derivation|channel activity does not auto-render the progress popover"`

### R5. Right Drawer De-Dup Boundary

Type: Workspace UI, not full drawer detail rebuild.

Files:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/shared/conversation/RightDrawer.tsx
apps/web/e2e/channel.spec.ts
```

Work:

- Remove the right drawer `Progress` root page. The floating progress popover owns
  active progress status.
- Stop rendering a copied main conversation transcript in the drawer root.
- Keep drawer root pages limited to ordinary workspace/detail surfaces: `Files` and
  `Settings`. Context/source detail opens only from explicit source or developer-detail
  affordances.
- Keep task and approval drawer views as explicit deep-detail surfaces opened from
  task/approval affordances.
- Deep raw/detail remains future Slice 4 unless it is already available through existing
  detail surfaces.

Acceptance:

- Drawer root pages do not duplicate the main feed operation cell or coordinator summary.
- Opening drawer does not show the same completed task summary already visible in the
  main feed.
- The drawer nav does not expose a `Progress` page.
- Clicking the progress toolbar opens the floating popover when active progress exists;
  with no active progress it does not open a drawer.
- Any removed raw/detail access has an explicit replacement path or is deferred with a
  tracked follow-up before merge.

R5 gate evidence:

- `channelSidePanelRootViews` is limited to `files` and `settings`; `context`, `task`,
  and `approval` remain deep-detail views opened only from explicit source/task/approval
  affordances.
- The task deep-detail run strip no longer renders `Task complete`, `Latest run`, or
  `View result`; it keeps only the linked-run evidence entry and `Open run` action.
- 2026-06-17 local verification:
  - `corepack pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g "progress popover owns workflow status|channel activity triage actions"`

### R6. Full Surface Regression And Visual QA

Type: e2e plus browser screenshot.

Files:

```text
apps/web/e2e/channel.spec.ts
docs/design/conversation-ui-framework-copy-implementation-plan.md
```

Work:

- Replace wrong positive raw/context assertions with negative guards.
- Add focused tests for:
  - completed single-agent work;
  - expanded inline evidence without raw/context leakage;
  - serial multi-agent AgentActivitySpan;
  - parallel multi-agent AgentActivitySpan with overflow;
  - floating popover active/terminal states;
  - drawer root de-dup.
- Capture desktop screenshot of:
  - completed single-agent operation expanded;
  - parallel multi-agent operation;
  - active run popover.

Acceptance:

- `corepack pnpm --filter @ling-stack/web typecheck` passes.
- Focused `channel.spec.ts` tests pass.
- Browser smoke has no console errors/warnings.
- Screenshot matches Strict Daylight v3 + Strict Codex Transcript direction.

### R7. SourceSummaryStrip Follow-Up

Type: semantic evidence projection after conformance recovery.

Files:

```text
apps/web/src/lib/conversation-turn-projector.ts
apps/web/src/lib/conversation-work-cell.ts
apps/web/src/lib/collaboration-task-work-cell.ts
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/shared/conversation/ConversationWorkCell.tsx
```

Work:

- Derive source refs from structured MCP/tool, web, memory, file, and artifact records.
- Attach source refs to the owning `OperationCell` or `AgentActivitySpan`.
- Filter internal helpers such as `node_repl`, daemon glue, projector helpers, raw shell
  wrappers, setup/cleanup glue, and hidden model routing tools.
- Deduplicate by stable semantic key: tool/app id, normalized URL, memory id, workspace
  file path, or artifact id.
- Render source affordances only in active popover, inline expanded evidence when useful,
  or right drawer source detail.

Acceptance:

- Main feed has no standalone Sources card.
- Source refs survive active-to-terminal commit and remain attached to committed rows.
- Internal helper sources are absent from default transcript surfaces.
- Right drawer source detail does not duplicate the operation transcript or coordinator
  final summary.

### R7.1 Context Capability Migration

Type: move context processing from UI-specific inspection into a semantic source
projection, while keeping raw context artifacts as developer/debug evidence.

Codex reference:

```text
context fragments / turn context / injected response items
  -> core history and compaction
  -> HistoryCell semantic render
  -> display / raw / transcript modes
```

Ling target:

```text
daemon context pack / inspect payload / source refs
  -> shared semantic source projection
  -> OperationCell / AgentActivitySpan source summary
  -> optional developer/raw detail
```

Rules:

- Do not render `Context Pack`, provider/model/token budgets, section ids, protocol
  metadata, workflow ids, raw JSON paths, or raw prompt/log safety flags in the default
  transcript or default operation expansion.
- Do not expose a normal root drawer page named Context or Protocol for ordinary users.
- Keep raw context artifacts and inspect payloads available for developer/debug surfaces,
  but gate them behind explicit diagnostic affordances.
- Map context source refs into user-facing source groups such as messages, files,
  artifacts, memories, web pages, runs, tasks, or teammates.
- If a source ref has no user-facing label, show only the type/count. Raw ids appear only
  in developer/raw detail.
- Web and Desktop must eventually share the same semantic source projection. Until daemon
  exposes it directly, Web may own a temporary projector helper, but React components
  must not parse Context Pack fields inline.

First migration slice:

- Replace per-component Context Pack rendering with a `ConversationContextSourceSummary`
  helper.
- Remove unused Context Pack row projectors from the main workflow progress model.
- Rename visible context affordances from "Inspect context" to source/audit wording.
- Leave developer diagnostics collapsed and out of the default reading path.

## Regression Guard Phrases

Main feed default and inline expanded detail must not contain these strings unless the
test explicitly opens a raw/detail surface:

```text
Context Pack
workflow_runtime_boundary
workflow_objective
workflow_current_step
workflow_approval_gates
provider_
model_known
tokens
token budget
workflow_
wfstep_
run_
packet
selector
attempt
raw event
context.json
output.json
preview.json
.log
```

Allowed exceptions:

- A user-provided filename may contain `.log` or `.json`.
- A command line may contain a literal filename only inside bounded command detail.
- A right drawer raw/detail page may show raw ids and JSON when explicitly opened.

## Tonight's First Visible Version

The first acceptable Phase 1 visible version is smaller than the full architecture:

1. Main conversation no longer looks like a card/work-cell panel.
2. Completed work expansion no longer dumps Context Pack or provider/token/raw paths.
3. One user task normally appears as one assistant transcript turn.
4. Active operation rows mutate in place and terminal rows remain folded.
5. AgentActivitySpan rows keep completed teammate process behind the agent row.
6. Tests protect the transcript lifecycle before any surface work continues.

Floating popover, right drawer, and sources are intentionally not in this first visible
gate. They are follow-up surfaces after the transcript lifecycle is correct.

## Stop Signs

Stop and update this plan before continuing if any of these happen:

- A main-feed test asserts raw/context/provider/token/id visibility.
- A renderer receives raw workflow/run records directly instead of a semantic view model.
- A change deletes raw/detail audit access without a replacement.
- The floating popover is removed instead of constrained.
- The drawer becomes a second transcript.
- A visual fix only changes CSS while the projection still leaks raw data.

## Implementation Order

```text
R0 baseline
  -> R1 projection boundary
  -> R2 transcript renderer
  -> R3 AgentActivitySpan correction
  -> R3.1 AgentActivitySpan lifecycle and copy
  -> R3.2 core tests + screenshots
later:
  -> R4 floating popover boundary
  -> R5 drawer de-dup boundary
  -> R6 full surface tests + screenshots
  -> R7 SourceSummaryStrip follow-up
```

R1 and R2 must be completed before any claim that Slice 1 is accepted. R3 must be
completed before any claim that Slice 2 is accepted. Phase 1 is not accepted until R3.2
passes. R4, R5, and R7 can follow only after the main-feed transcript lifecycle is clean.
R7 starts only after committed `OperationCell` and `AgentActivitySpan` ids are stable.
