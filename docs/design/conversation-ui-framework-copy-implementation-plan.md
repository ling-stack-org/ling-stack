# Conversation UI Framework And Copy Canon Implementation Plan

Status: complete implementation plan
Date: 2026-06-14
Scope: channel conversation feed, semantic operation projection, Ling Agent copy,
multi-agent activity spans, floating run popover, right drawer detail, and regression
fixtures

Related docs:

- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
- [Codex-Inspired Conversation Experience v1](codex-inspired-conversation-v1.md)
- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)
- [Ling Agent Session Implementation Plan](ling-agent-session-implementation-plan.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Multi-Agent Collaboration Cards Implementation Plan](multi-agent-collaboration-cards-implementation-plan.md)

## Summary

This plan turns the conversation UI design into an implementation sequence. The goal is
not to add another runtime system. The goal is to insert a semantic Web UI layer between
existing daemon records and React surfaces.

Target pipeline:

```text
existing daemon/channel/runtime records
  -> Web semantic projection
  -> ConversationTurn / OperationCell / AgentActivitySpan view models
  -> Display / Expanded / Raw render modes
  -> main feed / floating popover / right drawer / blocking surfaces
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
- The right drawer owns deep detail, raw/debug data, files, context, and settings.
- Ling Agent copy describes task state and outcome, not the UI mechanism.

Hard copy rules:

- First-person wording is allowed when it is the most natural user-facing sentence.
- No empty self-announcement or UI-explainer copy: `细节放在折叠证据里`,
  `主会话会同步状态`, `查看右侧抽屉了解完整细节`.
- No default feed labels for `workflow`, `run`, `work-unit`, `packet`, `attempt`,
  `selector`, `raw event`, provider metadata, token budgets, or JSON.
- Coordinator messages are for confirmation, clarification, blockers, and final result.
- Operation rows use verb + object + state.

## Existing Anchors

| Concern | Current anchor | Reuse plan |
| --- | --- | --- |
| Web operation read model | `apps/web/src/lib/conversation-work-cell.ts` | Reuse as the first semantic projection, then tighten naming and fields. |
| Workflow progress model | `apps/web/src/lib/workflow-progress.ts` | Reuse as workflow input to OperationCell. |
| Collaboration projection | `apps/web/src/lib/collaboration-task-work-cell.ts` | Reuse, but remove card/report copy and map to AgentActivitySpan. |
| Legacy collaboration card read model | `apps/web/src/lib/collaboration-task-card.ts` | Keep as internal input; stop treating it as a first-level UI card. |
| Main operation renderer | `apps/web/src/shared/conversation/ConversationWorkCell.tsx` | Convert from work-cell/card rendering to borderless transcript rendering. |
| Right drawer shell | `apps/web/src/shared/conversation/RightDrawer.tsx` | Keep shell, add operation detail page contract in parent view. |
| Channel assembly | `apps/web/src/features/workspace/WorkspaceClientView.tsx` | Keep orchestration in place for first slices; avoid large file split until behavior is correct. |
| Floating progress popover | `apps/web/src/features/workspace/WorkspaceClientView.tsx`, `.channel-progress-popover` | Keep the popover, reduce content to active status. |
| Styling | `apps/web/src/styles/components.css` | Apply Strict Daylight v3 transcript rules and remove residual card treatments. |
| E2E regression | `apps/web/e2e/channel.spec.ts` | Extend existing mock-state tests instead of creating a new test system first. |

## Target Data Model

Do not create daemon storage in the first implementation wave. Build a Web projection
first. Add contracts only after the shape proves stable.

```ts
type ConversationCellKind =
  | "user_message"
  | "coordinator_message"
  | "operation"
  | "agent_activity"
  | "approval"
  | "artifact_strip";

interface ConversationCellRender {
  readonly display: readonly DisplayLine[];
  readonly expanded?: ExpandedDetail;
  readonly raw?: RawDetailRef;
}

interface OperationCellViewModel {
  readonly id: string;
  readonly turnId?: string;
  readonly sourceKind: "run_thread" | "workflow" | "collaboration_task";
  readonly status: "queued" | "running" | "waiting_for_approval" | "blocked" | "failed" | "cancelled" | "succeeded";
  readonly title: string;
  readonly summary: string;
  readonly activeOperation?: OperationRowViewModel;
  readonly operationRows: readonly OperationRowViewModel[];
  readonly agentSpans: readonly AgentActivitySpanViewModel[];
  readonly evidence: EvidenceSummaryViewModel;
  readonly artifacts: readonly ArtifactStripItemViewModel[];
  readonly rawDetailRef?: RawDetailRef;
}
```

Implementation note: keep `ConversationOperationCellViewModel` as a compatibility type
while call sites migrate. Do not rename every file in the first slice.

## Render Surfaces

```text
ConversationTurn
  UserMessageCell
  CoordinatorMessageCell?
  OperationCell?
    OperationDisplayLine[]
    AgentActivitySpan[]
    ExpandedDetail?
  CoordinatorSummaryCell?
  ArtifactStrip?

FloatingRunPopover
  Active actor + elapsed + latest action + stop/approval action

RightDrawer
  Root: Progress | Files | Context | Settings
  Detail: Operation detail | File detail | Approval detail | Raw detail
```

Surface ownership:

| Surface | Owns | Must not own |
| --- | --- | --- |
| Main feed | user text, coordinator narrative, operation rows, agent spans, final result, artifact strip | raw logs, ids, duplicate drawer copy |
| Inline expansion | bounded semantic evidence | unbounded stdout, JSON, provider metadata |
| Floating popover | current active status and one action | transcript, branch history, completed summaries |
| Right drawer root pages | progress attention, files, context, settings | copied main transcript |
| Right drawer detail pages | exact commands, outputs, diffs, raw events | default conversation summary |
| Modal/blocking surface | approval, destructive confirmation, missing input | passive status |

## Implementation Phases

### CUI0. Baseline Inventory

Type: read-only.

Goal: capture the current broken surfaces before changing behavior.

Work:

- Identify current main-feed work cell states: active, completed, blocked, approval,
  multi-agent serial, multi-agent parallel.
- Identify current duplicate surfaces: main feed card, right progress card, drawer detail,
  floating popover, raw run bubble.
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
- Keep technical labels available only for drawer raw/detail pages.

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
- Remove default diagnostics/action buttons that duplicate drawer detail.

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
- Raw sub-agent transcript opens only in drawer detail.
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
- Show one actor, elapsed time, one latest-action phrase, and one primary action.
- Hide or compress when the right drawer is open.

Acceptance:

- Completed state does not linger as a second success message.
- Popover never shows command output, raw ids, workflow/run labels, or branch history.
- Opening the right drawer does not create duplicate progress UI.

### CUI8. Right Drawer Detail Boundary

Type: Web drawer architecture.

Goal: keep the right drawer as detail/workspace, not a second transcript.

Suggested files:

```text
apps/web/src/shared/conversation/RightDrawer.tsx
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/shared/conversation/ConversationEvidenceBundlePanel.tsx
apps/web/src/shared/conversation/FileChangeEvidencePanel.tsx
```

Work:

- Keep root pages: `Progress`, `Files`, `Context`, `Settings`.
- Add operation detail page state opened from explicit drill-down actions.
- Drawer `Summary` should show operation status and owner, not repeated final answer.
- Drawer `Timeline` should show timestamped semantic events, not copied main rows.
- Raw events and JSON are folded by default.
- Preserve main feed scroll position when opening/closing drawer.

Acceptance:

- Drawer root pages do not duplicate the main conversation.
- Operation detail pages can show exact commands, cwd, exit code, duration, output,
  changed files, checks, approvals, artifacts, and raw events.
- Raw ids and JSON never appear in drawer root pages.

### CUI9. Legacy Collaboration Surface Retirement

Type: Web cleanup.

Goal: retire the first-level collaboration card concept after AgentActivitySpan and drawer
detail are stable.

Suggested files:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/lib/collaboration-task-card.ts
apps/web/src/styles/components.css
```

Work:

- Keep `CollaborationTaskCardModel` as internal projection input if useful.
- Stop rendering `.collaboration-task-card` as a first-level user object in the main feed.
- In right Progress, replace legacy cards with compact progress rows or operation detail
  entry points.
- Update tests that currently assert `.collaboration-task-card` to assert operation rows,
  agent spans, or drawer detail.

Acceptance:

- No user-facing surface is labeled as a collaboration card.
- Main feed multi-agent work appears as AgentActivitySpan.
- Right Progress shows attention and drill-down entry points, not a duplicate work card.

### CUI10. Artifact, File, Check, And Memory Rows

Type: Web detail and artifact strip.

Goal: show useful outputs without turning evidence into card stacks.

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
- Show memory rows only when memory affected the answer.
- Keep full file previews and diffs in drawer detail.

Acceptance:

- Artifact strip appears only when there are outputs.
- Memory summary appears only when memory was used.
- Drawer Files shows previews/diffs, not the same artifact strip repeated.

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
| parallel multi-agent | latest action per active teammate | full sub-agent transcripts |
| waiting approval | approval row and blocking affordance | vague `continue?` copy |
| blocked | human-readable blocker and next action | raw exception as default row |
| interrupted redirect | cancelled source plus linked continuation | hidden prompt injection |
| drawer open | detail/raw sections only | copied main transcript |
| popover active | one-line active status | command output or branch history |
| artifact result | artifact strip and file detail path | duplicate artifact list in drawer root |

Copy regression assertions:

- Main feed does not contain `workflow`, `run`, `work-unit`, `packet`, `raw event`,
  `attempt`, or `selector`.
- Main feed does not contain `细节放在折叠证据里`.
- Main feed does not contain UI-mechanism copy such as `主会话会同步状态` or
  `查看右侧抽屉了解完整细节`.
- Right drawer detail does not repeat the coordinator final summary.
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

## Suggested Execution Order

Do not implement all phases in one unreviewable patch. Use these slices.

### Slice 1: Main Feed And Copy Canon

Phases: CUI1, CUI2, CUI3, part of CUI5.

Files likely touched:

```text
apps/web/src/lib/conversation-work-cell.ts
apps/web/src/lib/collaboration-task-work-cell.ts
apps/web/src/shared/conversation/ConversationWorkCell.tsx
apps/web/src/styles/components.css
apps/web/e2e/channel.spec.ts
```

Acceptance:

- Main feed is borderless transcript.
- First-person and UI-explainer copy removed.
- Completed work has one final result surface.
- Existing core channel e2e still passes.

### Slice 2: AgentActivitySpan

Phases: CUI4 and CUI9 first half.

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
- Branch overflow and blocked/failed visibility rules are tested.

### Slice 3: Floating Popover

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
- Popover does not duplicate drawer progress.

### Slice 4: Right Drawer Detail

Phases: CUI8 and CUI10.

Files likely touched:

```text
apps/web/src/shared/conversation/RightDrawer.tsx
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/shared/conversation/ConversationEvidenceBundlePanel.tsx
apps/web/src/shared/conversation/FileChangeEvidencePanel.tsx
apps/web/e2e/channel.spec.ts
```

Acceptance:

- Drawer root pages do not duplicate main feed.
- Operation detail page has Summary, Timeline, Commands, Files, Checks, Approvals,
  Artifacts, and folded Raw events.
- Files/artifacts/memory follow the strip/detail boundary.

### Slice 5: Legacy Cleanup And Fixture Matrix

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
- Hidden or reduced when drawer opens.

### Right Drawer

Coverage:

- Root pages render `Progress`, `Files`, `Context`, `Settings`.
- Operation detail opens from explicit action.
- Raw JSON is folded.
- Drawer summary does not repeat coordinator final summary.

### Visual QA

Coverage:

- Desktop screenshot of single-agent running/completed.
- Desktop screenshot of parallel multi-agent.
- Desktop screenshot of drawer-open detail.
- Narrow viewport screenshot of active work and composer.

## Failure Modes

| Failure mode | Prevention |
| --- | --- |
| Raw event spam returns to main feed | Copy regression tests and render contract checks. |
| Completed popover keeps showing after run is done | Popover state tests tied to terminal operation commit. |
| Right drawer becomes a second transcript | Drawer duplication guard and fixture tests. |
| Multi-agent work becomes separate teammate chats | AgentActivitySpan projection owns default multi-agent display. |
| Existing e2e depends on legacy card selectors | Migrate selectors slice by slice; do not delete all legacy classes in Slice 1. |
| `WorkspaceClientView.tsx` diff becomes too large | Keep first slices behavior-focused; split components only after acceptance. |
| Copy formatters become over-abstracted | Keep formatter functions small and explicit; no generic prose generator. |
| Evidence becomes inaccessible after folding | RawDetailRef and drawer detail stay reachable from explicit drill-down. |

Critical silent-failure guard:

- If an implementation hides a raw/detail path without replacing it in drawer detail,
  stop and restore audit access before continuing.

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

Sequential core is safer for the first two slices because they touch the same model and
renderer.

| Workstream | Modules touched | Depends on |
| --- | --- | --- |
| Projection and copy canon | `apps/web/src/lib/` | CUI0 |
| OperationCell renderer | `apps/web/src/shared/conversation/`, `apps/web/src/styles/` | Projection and copy canon |
| AgentActivitySpan | `apps/web/src/lib/`, `apps/web/src/shared/conversation/` | OperationCell renderer |
| Floating popover | `apps/web/src/features/workspace/`, `apps/web/src/styles/` | Projection and active lifecycle fields |
| Right drawer detail | `apps/web/src/shared/conversation/`, `apps/web/src/features/workspace/` | Projection model and evidence fields |
| E2E fixtures | `apps/web/e2e/` | Each corresponding slice |

Execution:

```text
Slice 1 sequential
  -> Slice 2 sequential
  -> Slice 3 and Slice 4 can run in parallel after Slice 2
  -> Slice 5 after both merge
```

Conflict flags:

- Slice 3 and Slice 4 both touch `WorkspaceClientView.tsx`; parallel work needs tight
  ownership of separate regions or should be sequential.
- Slice 1 and Slice 2 both touch `ConversationWorkCell.tsx`; do not parallelize.

## Stop Signs

If any of these happen during implementation, stop and adjust the plan:

- A new default UI label introduces `workflow`, `run`, `work-unit`, `packet`, `raw event`,
  `attempt`, or `selector`.
- A coordinator message explains the UI mechanism instead of the task state.
- A detail drawer repeats the final coordinator answer verbatim.
- A running operation appends a new row for every stdout chunk.
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
- Right drawer owns deep/raw/detail only.
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
