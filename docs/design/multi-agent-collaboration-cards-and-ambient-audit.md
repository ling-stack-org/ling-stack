# Multi-Agent Collaboration Cards And Ambient Audit

Status: superseded for main-feed conversation UI; retained as historical context.

2026-06-15 update: main-feed collaboration cards are no longer the active product model.
Use [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md) and
[Conversation UI Design Conformance Recovery Plan](conversation-ui-design-conformance-recovery-plan.md)
for the channel conversation feed. This document may still explain the older
collaboration-card read model, but not a current Progress drawer surface.

Previous status: product design baseline.
Date: 2026-06-13

Related docs:

- [Multi-Agent Collaboration Cards Implementation Plan](multi-agent-collaboration-cards-implementation-plan.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [Channel Intent To Workflow Selector](channel-intent-workflow-selector.md)
- [Channel Context Processing Layer](channel-context-processing-layer.md)
- [Channel Message Streaming](channel-message-streaming.md)
- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)
- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
- [State Machines and Recovery](state-machine-recovery.md)

## Purpose

Ling needs durable, inspectable multi-agent coordination, but the default user experience
must feel intelligent rather than diagnostic.

This design defines the product layer above workflow steps, selector evidence, handoff
records, context packets, output packets, approvals, runs, artifacts, and logs.

```text
durable orchestration evidence
  -> operation cell collaboration projection
  -> active-task progress projection
  -> optional details
  -> advanced audit/debug only when requested
```

The user should see work being shaped, handed off, and completed. They should not have
to understand selector ids, context packet ids, route JSON, token budgets, or raw runtime
logs unless they explicitly open details.

Compatibility note: in the channel feed, collaboration cards should render through the
unified `OperationCell` contract from
[Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md). `Requirement Shaping
Card`, `Execution Task Card`, and `Step Handoff Card` are product read models and
sections inside that operation surface. They must not become extra first-level rows that
duplicate the Ling Agent summary, run summary, or evidence drawer.

## Product Principle

Audit is ambient.

Ling should record enough evidence to explain, recover, and debug work. The normal
conversation should show only the product meaning of that evidence:

- what Ling understood;
- which teammates are involved;
- what is running, waiting, blocked, or done;
- what changed;
- what the next decision is;
- where details can be opened.

## Visibility Layers

| Layer | User sees by default? | Contents | Examples |
| --- | --- | --- | --- |
| Product layer | Yes | Natural progress, collaboration cards, final summaries, permission prompts | `Ling is shaping the task`, `Engineer is implementing`, `QA is validating`. |
| Smart details layer | On demand | Teammate contributions, step summaries, handoff packets, evidence groups, files, approvals | Expanded card detail, right drawer, evidence disclosure. |
| Audit/debug layer | Advanced only | Raw ids, context section ids, dropped ids, token budgets, selector metadata, raw logs, route JSON | Developer diagnostics and explicit inspect routes. |

Default UI must not render audit/debug data as primary conversation content. The
information can exist, but it should stay behind details or developer/debug affordances.

## Card Types

### Requirement Shaping Card

Used before the task is confirmed or executable.

Purpose:

- let Ling Agent coordinate multiple viewpoints;
- collect scope, risks, acceptance criteria, and open questions;
- produce a confirmable execution task card only when scope is clear enough.

Default feed example:

```text
Ling is shaping the task
Product added scope notes
Architect added integration boundaries
Design added interaction guidance

Ling summary:
- Goal
- Proposed scope
- Open questions
- Suggested next action
```

Expanded details may show each teammate's contribution. Audit/debug details may show
selector decisions, source refs, and context view metadata.

Trigger when:

- the user asks to discuss, design, plan, compare, or decide;
- the request spans multiple roles but is not ready for execution;
- acceptance criteria or permission boundary is unclear;
- specialists need to surface risks before a task is created.

Do not trigger when:

- the user gives a narrow direct edit/fix request;
- the user explicitly says to implement now and scope is clear;
- a single Ling Agent reply is enough.

### Execution Task Card

Used after Ling Agent has enough scope to run work or request confirmation.

Purpose:

- make objective, acceptance criteria, participants, execution order, permissions, and
  next actions clear;
- provide the durable bridge from conversation into workflow/run state;
- avoid visible agent-to-agent chatter in the main feed.

Default card fields:

```ts
interface CollaborationTaskCard {
  readonly id: string;
  readonly mode:
    | "shaping"
    | "ready_for_confirmation"
    | "queued"
    | "running"
    | "waiting_for_approval"
    | "blocked"
    | "summarizing"
    | "completed"
    | "failed"
    | "cancelled";
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly participants: readonly CollaborationParticipantSummary[];
  readonly steps: readonly CollaborationStepCard[];
  readonly executionMode: "serial" | "parallel" | "mixed";
  readonly permissionState: "none_needed" | "needs_confirmation" | "waiting_for_approval" | "approved" | "denied";
  readonly currentSummary: string;
  readonly nextAction?: CollaborationNextAction;
}
```

Default UI should show a compact task card in the channel feed and reuse the existing
operation cell/evidence disclosure in the channel feed. The right drawer is only for
deeper drilldown or cross-task work-board context, not for duplicating the same expanded
evidence.

## Card State Machine Boundary

Collaboration cards need state, but they should not become a second workflow engine.

The authoritative execution state remains in existing durable state machines:

```text
RequirementShapingCard state
  -> proposal / confirmation
  -> ChannelWorkflow
  -> ChannelWorkflowStep
  -> Run
  -> Approval
  -> ResourceLease
  -> OutputPacket / HandoffPacket
```

`CollaborationTaskCard.mode` is a product read-model state derived from those records.
It is safe to cache for UI performance, but legal transitions must still be enforced by
the workflow, step, run, approval, and lease state machines defined in
[State Machines and Recovery](state-machine-recovery.md).

### Requirement Shaping Card States

Before execution exists, the shaping card can own a light state machine:

| From | Event | To |
| --- | --- | --- |
| `collecting_context` | teammate_input_started | `collecting_teammate_input` |
| `collecting_teammate_input` | missing_scope_found | `needs_user_clarification` |
| `collecting_teammate_input` | summary_ready | `ready_for_confirmation` |
| `needs_user_clarification` | user_answered | `collecting_teammate_input` |
| `ready_for_confirmation` | user_confirmed | `converted_to_task` |
| non-terminal | user_dismissed | `dismissed` |

Once converted, the execution task card should derive from `ChannelWorkflow` and
`ChannelWorkflowStep` instead of continuing as an independent shaping object.

### Execution Task Card Derived States

| Card mode | Derived from |
| --- | --- |
| `ready_for_confirmation` | proposal exists and no workflow has started. |
| `queued` | workflow is ready and all eligible steps are queued or waiting for policy. |
| `running` | at least one step or linked run is running. |
| `waiting_for_approval` | active workflow/step/run has a pending approval requiring user action. |
| `blocked` | workflow or any required current step is blocked with a user-actionable reason. |
| `summarizing` | terminal runs exist but final Ling summary has not been posted or folded. |
| `completed` | workflow succeeded and final summary is available. |
| `failed` | workflow failed and no automatic retry is pending. |
| `cancelled` | workflow/card was explicitly cancelled. |

### Step State Projection

`CollaborationStepCard.state` should map directly from `ChannelWorkflowStep.status`:

| Step card state | Source status |
| --- | --- |
| `waiting` | `queued` or dependency not ready |
| `active` | `claimed`, `running`, or linked run running |
| `waiting_for_approval` | `waiting_for_approval` or linked approval pending |
| `blocked` | `blocked` |
| `done` | `succeeded` |
| `failed` | `failed` |
| `skipped` | `skipped` |
| `cancelled` | `cancelled` |

### Serial, Parallel, And Fan-In Rules

- Serial cards may have only one active execution step unless a step is a non-executing
  summary/fan-in node.
- Parallel cards may have multiple active steps only when the workflow graph, resource
  leases, provider semaphores, and approval policy all allow it.
- Fan-in can start only after required dependency branches reach terminal allowed states.
- A blocked required branch blocks the card unless the graph marks that branch optional.
- Cancelling a card must transition the underlying workflow/runs/approvals through legal
  cancellation paths; it must not just hide the card.
- Restart recovery rebuilds card state from durable workflow/step/run/approval records.

This gives Ling Agent a simple control surface:

```text
read active CollaborationTaskCard
-> check card mode
-> find current actionable step or user action
-> delegate legal transitions to workflow/run/approval state machines
-> update compact progress projection
```

### Step Handoff Card

Used when one teammate finishes or blocks a step and another teammate may continue.

Purpose:

- turn terminal step output into a clear handoff;
- keep downstream agents reading structured output packets instead of raw branch chat;
- let users understand why the next teammate is involved.

Default summary:

```text
Engineer completed implementation
- Changed 3 files
- Added 2 tests
- Handoff to QA: validate channel streaming and final folding
```

Contract:

```ts
interface StepHandoffCard {
  readonly stepId: string;
  readonly fromTeammateId: string;
  readonly toTeammateIds: readonly string[];
  readonly status: "ready" | "accepted" | "blocked" | "skipped";
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly blockers: readonly string[];
  readonly artifactIds: readonly string[];
  readonly changedPaths: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly nextInputs: readonly string[];
}
```

Smart details can show output packet content and evidence groups. Audit/debug can show
raw packet ids and route metadata.

## Stream Folding

Streaming is a presentation mode, not permanent transcript spam.

### Serial workflow

Default behavior:

```text
Ling publishes task card
Engineer accepts step
Engineer streams concise progress while active
Engineer finishes
Engineer stream folds into a step summary and handoff card
QA accepts next step
QA streams concise progress while active
QA finishes
Ling posts final result
```

The completed stream should collapse automatically into a summary row. The user can open
details to see the full runtime stream, logs, artifacts, and packet evidence.

### Parallel workflow

Default behavior:

```text
Ling publishes task card
Engineer / Docs / QA start in parallel
Default feed shows compact branch state
Each branch stream is folded by default
User can expand one branch or open the task card details
Fan-in summarizes terminal branch packets
Ling posts merged result, conflicts, and next action
```

Parallel branch raw streams should not all print into the channel feed at once. The feed
shows top-level progress and blockers; details show branch-level streams.

## Suggested Runtime Mapping

| Product object | Existing lower-level source |
| --- | --- |
| Requirement Shaping Card | visible multi-reply, proposal draft, selector evidence, context summaries |
| Execution Task Card | `ChannelWorkflow`, proposal evidence, `WorkflowGraph`, approvals |
| Step row | `ChannelWorkflowStep`, linked run, approval, resource lease |
| Step Handoff Card | `WorkflowHandoffIntent`, step output packet, fan-in summary |
| Stream detail | run SSE events, workflow progress model, artifacts |
| Smart details | output/context packets, source refs, approvals, changed files |
| Audit/debug | raw route metadata, context pack ids, token budget, raw logs |

The product cards are read models over existing durable records first. Add new storage
only if derived views become too expensive or need user edits.

## UI Rules

- The default feed shows one operation cell per active shaping/execution thread.
- Collaboration-card content lives inside that operation cell as sections, rows, or
  folded evidence.
- Running cards are mutable: update status in place rather than appending process spam.
- Terminal cards fold into a compact final summary.
- The right floating Progress surface is not a completed-work history list. It is a
  projection of the current or most recently actionable task.
- A newly started task takes over the Progress surface. Older completed work moves to
  final summaries, evidence, or history/detail surfaces instead of staying expanded in
  the Progress list.
- Expand actions are explicit: `Details`, `Evidence`, `View steps`, or right drawer.
  Do not show both an inline evidence expansion and a drawer button for the same evidence
  bundle in the default card chrome.
- Permission prompts stay visible because they require user action.
- Blockers stay visible because they change the next action.
- Raw audit/debug data is never the first thing shown.
- Mobile defaults to the compact card; branch details open full-height.

## Compact Progress Projection

The channel right-side floating panel should not be a full workflow inspector by
default. It should be a compact projection of the active `CollaborationTaskCard`, similar
to a concise task progress checklist.

It should also not behave like an append-only list of completed workflow steps. The
projection is recalculated from current workflow/card state:

```text
new task starts
  -> Progress shows that task's checklist
task runs
  -> rows update in place: done / active / waiting / blocked
task completes
  -> Progress folds it into one completion summary row
next task starts
  -> new task takes over Progress; completed work remains available in details/history
```

It answers only:

```text
What is the current task?
Where are we in the flow?
Is anything waiting for me?
```

Default fields:

```ts
interface CollaborationProgressProjection {
  readonly taskTitle: string;
  readonly status:
    | "shaping"
    | "ready_for_confirmation"
    | "running"
    | "waiting_for_approval"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled";
  readonly currentOwnerLabel?: string;
  readonly progressItems: readonly CollaborationProgressItem[];
  readonly blocker?: string;
  readonly nextAction?: CollaborationNextAction;
  readonly detailTarget?: "task_card" | "workflow_detail" | "evidence";
}

interface CollaborationProgressItem {
  readonly id: string;
  readonly label: string;
  readonly state: "done" | "active" | "waiting" | "blocked" | "skipped";
  readonly ownerLabel?: string;
}
```

Display rules:

- show 3-6 progress items by default;
- show active, waiting, blocked, or failed work before completed work;
- completed work should normally occupy one summary row per task, not one row per
  completed step;
- step-level completed rows are visible only while they provide useful orientation for
  the current active task, and otherwise belong in details;
- if there is a current active task, older completed task summaries must not crowd out
  that task's active/waiting/blocker rows;
- prefer human-readable step summaries over teammate ids or workflow ids;
- show a single active item when possible;
- show only one blocker or next action;
- show a detail affordance rather than all evidence;
- hide context packet ids, selector ids, token budgets, and raw logs;
- collapse completed serial steps into checkmarked rows only inside the active task's
  short checklist;
- summarize parallel branches as one row per branch or branch group.

Example:

```text
Progress
✓ Ling published task card
✓ Architect confirmed state-machine boundary
● Engineer is implementing compact progress projection
○ QA is waiting to validate
```

This projection can appear in the right floating panel, attention popover, or compact
mobile sheet. Opening it should navigate to the smart details layer, not immediately to
raw audit/debug data.

## Evidence Rules

Record these durably:

- selected participants and reason;
- source message;
- context view kind and source-ref counts;
- workflow graph/step ids;
- handoff packet ids;
- output packet ids;
- linked run/artifact ids;
- approval ids and outcomes;
- stream terminal summary.

Do not show these by default:

- raw prompt text;
- selector JSON;
- confidence scores;
- context section ids;
- token budget numbers;
- raw logs;
- private teammate memory;
- provider secrets or credential-adjacent values.

## Acceptance Criteria

- A shaping-stage multi-agent discussion appears as one compact requirement shaping card,
  not a flood of teammate messages.
- A confirmed workflow appears as one operation cell with execution-task sections and
  step progress.
- The right-side floating panel shows a compact progress projection, not a full workflow
  inspector.
- Serial step streams fold into summaries and handoff cards after completion.
- Parallel branch streams are compact by default and expandable per branch.
- Final Ling Agent report summarizes outcome, changed files/artifacts, blockers, and next
  action.
- Details expose evidence and handoff packets on demand.
- Audit/debug details remain available without becoming default conversation content.
- Permission prompts and blockers remain visible when user action is required.

## Implementation Slices

| Slice | Scope |
| --- | --- |
| CC1 | Add derived `CollaborationTaskCard` and `StepHandoffCard` view models over existing workflow/proposal/packet records. |
| CC2 | Render shaping-stage `RequirementShapingCard` from visible multi-reply/proposal evidence without creating executable work. |
| CC3 | Render execution `CollaborationTaskCard` in the existing `ConversationWorkCell` surface. |
| CC4 | Add stream folding state: active stream rows collapse into step summaries after terminal state. |
| CC5 | Add parallel branch summary rows and per-branch expansion. |
| CC6 | Add smart details grouping for step output packets, handoffs, artifacts, approvals, and changed files. |
| CC7 | Add compact progress projection for the right floating panel and attention popover. |
| CC8 | Keep audit/debug metadata in explicit inspect surfaces only. |

First implementation slice:
[Multi-Agent Collaboration Cards Implementation Plan](multi-agent-collaboration-cards-implementation-plan.md).
