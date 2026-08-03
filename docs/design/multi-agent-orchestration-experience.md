# Multi-Agent Orchestration Experience

## Status

Design baseline for the next multi-agent orchestration slices.

Related docs:

- [Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md)
- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation Surface Contract Implementation Plan](conversation-surface-contract-implementation-plan.md)
- [Channel Context Processing Layer](channel-context-processing-layer.md)
- [Channel Intent To Workflow Selector](channel-intent-workflow-selector.md)
- [Channel Message Streaming](channel-message-streaming.md)
- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)

P0-P3 implementation status as of 2026-06-09:

- P1 `WorkflowGraph` is additive and compiles into existing `ChannelWorkflow` /
  `ChannelWorkflowStep` rows.
- P2 workflow step context/output packets carry graph, teammate, skill, source-ref,
  blocker, and changed-path fields as evidence artifacts.
- P3 Web live progress reuses `ConversationWorkCell`, attention progress rows, inline
  evidence, and runtime surfaces instead of introducing a separate multi-agent transcript
  UI.

P4-P7 implementation status as of 2026-06-09:

- P4-P7 are split as structured handoff intent, selector coordinator, graph-defined
  fan-out/fan-in with memory candidates, and workflow evidence detail.
- Initial backend/Web implementation keeps the existing Codex-inspired conversation
  surfaces as the compatibility boundary: default feed stays compact, active progress
  stays visible, and coordination evidence stays expandable.
- Structured handoff intents, deterministic selector decisions, fan-in summary artifacts,
  candidate-only memory output, workflow evidence APIs, and work-cell inline drilldown
  are implemented.
- Model-assisted selector decisions remain a follow-up behind an explicit policy/feature
  flag; the current selector records deterministic routing evidence and alternatives.
- Ordinary channel messages use a separate intent entry before they can propose or start
  workflow-shaped collaboration. The staged plan is documented as P1-P6 in
  [Channel Intent To Workflow Selector](channel-intent-workflow-selector.md): proposal
  to WorkflowGraph adapter, proposal edit, clarify, independent intent evidence,
  confirmed direct-workflow prefill, and model-assisted intent selection.
- Detailed design:
  [Multi-Agent Orchestrator](./multi-agent-orchestrator.md).

This document connects the implemented channel conversation work with the existing
durable orchestrator. It should guide future implementation without turning the
Codex-inspired conversation model into a rewrite.

For implementation conflicts, prefer
[Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md). This document
explains the user-facing experience; the detailed design owns packet placement,
safe-parallel policy, requirement-shaping packets, and isolated worktree merge
boundaries.

## Summary

Ling Stack is not a multi-agent chatroom. It is:

```text
channel collaboration space
-> smart collaboration cards
-> visible live work progress
-> Ling-owned multi-agent orchestration
-> ambient audit evidence
```

The user should feel that work is happening while an orchestration is running, then see
the completed work collapse into a compact result summary. Raw agent chatter, tool
events, selector traces, and handoff evidence remain inspectable, but they are not default
conversation content.

Product rule:

```text
Live progress is visible.
Internal chatter is not default content.
Evidence is ambient and inspectable.
Completed work collapses into summaries.
Conversation layout follows task flow, not a fixed template.
```

The product surface follows [Conversation Surface Contract](conversation-surface-contract.md)
and [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md): requirement shaping,
executable work, and step handoffs are semantic presentations inside one operation cell.
Audit and debug details stay behind explicit expansion.

For the default channel feed, those cards are projections inside the unified operation
cell model in [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md). They should
not render as a second first-level surface next to a run summary or Ling Agent completion
message.

Current UI framing should be read as a semantic block framework, not literal fixed cards:
each turn renders the `TranscriptBlock[]` produced by the projector. A task that only
answers a question should not receive empty progress, artifact, or teammate sections; a
task with approvals or artifacts should render those blocks inline because they actually
occurred.

## Existing Boundaries

Current Ling behavior already has the important production shape:

- `Channel` is the user's collaboration space.
- `Task` and `ChannelWorkflowStep` are executable work units.
- Each executable step runs one scoped `AiTeammate` through the normal task/run path.
- [Channel Context Processing Layer](channel-context-processing-layer.md) owns what each
  teammate or selector sees for a turn; the orchestration UI should not imply all agents
  share one raw transcript.
- Pi remains the default single-run coding-agent kernel.
- Ling owns workflow state, approval policy, resource leases, state machines, artifacts,
  memory candidates, and audit evidence.
- The Web channel surface already borrows Codex-style active mutable cells, compact run
  summaries, folded evidence, attention/progress popovers, and inline evidence drilldown.

Future multi-agent work must extend this shape. It must not replace it with shared group
chat, a new runtime, or a broad conversation UI refactor.

## Visibility Model

### 1. Shaping Stage

Before work is clear enough to execute, multiple teammates may be visible in the channel
when their output changes the user's decision.

Visible specialist participation is appropriate when:

- the user explicitly mentions a teammate,
- the coordinator needs requirements clarification,
- product, architecture, design, security, or QA judgment changes scope,
- specialists disagree and the user must arbitrate,
- a blocker or risk changes the proposed execution boundary.

Routine agent-to-agent process should not become visible channel speech. The coordinator
may show a collapsed collaboration record such as:

```text
Collaboration: Product clarified scope, Architect flagged integration risk,
QA added acceptance criteria.
```

When shaping requires more than one teammate, the default UI should prefer a
`Requirement Shaping` operation cell over a sequence of visible teammate chat messages.
The cell can show compact contribution state and a Ling Agent summary, with detailed
teammate contributions available on expansion.

Canonical shape:

```text
ConversationTurn
  UserMessageCell
  OperationCell(presentation=requirement_shaping)
    coordinator summary
    participant contribution spans
    decision-needed block
    proposed workflow preview
    actions: approve workflow / edit scope / ask follow-up / start workflow
```

The shaping cell is not executable workflow state by itself. It becomes executable only
when the coordinator converts the resolved shaping packet into a proposal or
`ChannelWorkflow`. Raw specialist discussion remains evidence, not default transcript
content.

### 2. Live Execution Stage

After Ling Agent auto-starts a clear bounded task, the user confirms an execution
proposal, or the user starts a workflow, the channel should show live progress without
streaming raw internal chatter into the main feed.

Good default progress rows:

```text
Architect is defining the implementation boundary.
Engineer is running the implementation step.
QA is validating 2 checks.
Blocked: waiting for approval to write files.
Done: 3 steps completed, 1 artifact generated.
```

Bad default content:

```text
Engineer: I am about to read files.
QA: OK, I will wait.
Engineer: I finished reading.
QA: I will start checking now.
```

The live surface should reuse the existing Codex-inspired conversation model:

- one active mutable `OperationCell` for the active workflow or shaping thread,
- collaboration task fields rendered inside that operation cell rather than as a
  duplicate first-level card,
- the channel progress or attention popover for compact operational state,
- folded inline evidence for runtime, memory, tools, files, lineage, approvals, and raw
  events,
- in-turn previews/lightboxes for larger file, diff, artifact, source, and approval
  detail.

Step streams should fold when a step reaches terminal state. Serial workflows may show
the current step stream in the card; parallel workflows should show branch summaries by
default and expose per-branch stream details only when expanded.

### 3. Terminal Stage

When a workflow finishes, fails, or blocks, the live cell becomes a stable summary row.

The default feed should show:

- terminal outcome,
- completed/blocked step count,
- active assignee or last responsible teammate,
- artifacts or changed files when relevant,
- next action when one exists.

The expanded evidence should show:

- selector decisions,
- handoff intents and accepted handoffs,
- step prompts and output packets,
- tool calls and approvals,
- linked runs and artifacts,
- raw event detail.

The default terminal row should read like a result report, not an audit report. Step ids,
context packet ids, selector metadata, token budgets, and raw logs remain in details.

## Borrowed Designs

Ling should borrow patterns from Microsoft Agent Framework and historical AutoGen only as
design references. It should not import those runtimes.

### Workflow Graph

The current durable step engine already supports ordered steps, dependency metadata,
branch groups, join groups, dependency modes, gates, retry, and serial orchestration.
Future graph work should make those concepts explicit as a versioned workflow graph:

```ts
interface WorkflowGraph {
  readonly schemaVersion: 1;
  readonly entryNodeId: string;
  readonly nodes: readonly WorkflowGraphNode[];
  readonly edges: readonly WorkflowGraphEdge[];
  readonly termination: WorkflowTerminationPolicy;
}

interface WorkflowGraphNode {
  readonly id: string;
  readonly kind: "step" | "selector" | "handoff" | "join" | "wait";
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly prompt?: string;
  readonly policy?: WorkflowStepPolicy;
}

interface WorkflowGraphEdge {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly condition?: WorkflowEdgeCondition;
}
```

This graph should compile into durable `ChannelWorkflowStep` rows. The graph is a planning
and scheduling shape, not a model-owned mutable object.

### Checkpoint And Resume

Each graph node should have a durable checkpoint boundary:

- queued,
- running,
- waiting for input,
- waiting for approval,
- blocked,
- succeeded,
- failed,
- skipped,
- cancelled.

Daemon restart, model interruption, approval wait, user pause, and continuation must resume
from durable state. Do not inject a new hidden prompt into an already-running Pi session.

### Structured Handoff Intent

An agent may propose a handoff, but a handoff is not execution authority.

```ts
interface HandoffIntent {
  readonly toTeammateId: string;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly riskSummary?: string;
  readonly sourceStepId?: string;
}
```

Ling validates teammate availability, provider readiness, skill binding, approval policy,
and resource leases before creating the next durable handoff or workflow step.

### Selector Coordinator

A selector coordinator may choose the next teammate or graph branch from:

- current objective,
- channel brief and decisions,
- workflow graph state,
- available teammate registry,
- step output packets,
- blockers and approvals,
- user mentions or explicit commands.

The selector result must be structured and auditable:

```ts
interface SelectorDecision {
  readonly selectedTeammateId: string;
  readonly selectedSkillId?: string;
  readonly reason: string;
  readonly alternativesConsidered: readonly string[];
  readonly confidence: "low" | "medium" | "high";
  readonly requiresUserConfirmation: boolean;
}
```

The selector should never silently grant tools, change approval policy, rewrite the graph,
or start side effects.

### Output And Context Packets

Workflow steps should pass structured packets, not hidden free-form group-chat state.
Those packets should be rendered from per-agent Context Views. The coordinator view can
see broader channel state, while specialist views receive only role/task-relevant
context, source refs, and evidence summaries.

```ts
interface StepOutputPacket {
  readonly workflowStepId: string;
  readonly runId?: string;
  readonly status: "succeeded" | "failed" | "blocked" | "cancelled";
  readonly resultSummary: string;
  readonly artifactIds: readonly string[];
  readonly changedPaths: readonly string[];
  readonly decisions: readonly string[];
  readonly blockers: readonly string[];
}

interface StepContextPacket {
  readonly objective: string;
  readonly channelBriefId?: string;
  readonly dependencyOutputs: readonly StepOutputPacket[];
  readonly sourceRefs: readonly string[];
}
```

Fan-in and memory-candidate flows should consume these packets. They should not silently
rewrite active memory, teammate persona, approval policy, or the workflow graph.

### Per-Agent Context Views

Multi-agent orchestration should not share a single giant prompt history across every
participant.

Default views:

| View | Used by | Default contents |
| --- | --- | --- |
| Ling Agent coordinator | ordinary coordination, proposal, final summary | current turn, channel protocol, active work, recent visible context, relevant summaries, selected evidence, scoped memory |
| Specialist task | Engineer, Docs, QA, Design, Release | objective, acceptance criteria, role-specific source refs, dependency output packets, relevant channel decisions |
| Selector | intent/participant routing | current turn, lightweight channel metadata, teammate capability summaries, short recent context |
| Fan-in | branch merge/synthesis | terminal step output packets, artifact refs, blockers, changed paths |
| Evidence inspect | user-opened detail | safe metadata, source refs, selected raw snippets where allowed |

This keeps visible collaboration coherent without leaking private memory, full logs, or
unrelated channel history to every agent.

### Termination Policy

Every workflow template or graph must define termination behavior:

- success criteria,
- maximum turns or maximum orchestrator ticks,
- failed-step behavior,
- blocked-step behavior,
- approval-denied behavior,
- optional branch behavior,
- user-input wait behavior.

Multi-agent workflows without termination policy are not shippable.

### Teammate Registry Schema

Selectors and handoffs need more than display names. Each teammate should expose a
registry-facing capability profile:

```ts
interface TeammateCapabilityProfile {
  readonly teammateId: string;
  readonly roleKey: string;
  readonly capabilitySummary: string;
  readonly workflowPhases: readonly string[];
  readonly canAcceptHandoffsFrom: readonly string[];
  readonly canHandoffTo: readonly string[];
  readonly forbiddenScopes: readonly string[];
  readonly requiredTools: readonly string[];
  readonly providerRequirements: readonly string[];
  readonly approvalProfileId: string;
}
```

This profile is metadata for routing and explanation. It does not grant permission by
itself.

### Fan-Out And Fan-In

Parallel reviewers, researchers, QA steps, or design checks can run concurrently only when:

- the workflow graph allows it,
- channel runtime policy allows it,
- resource leases and runner semaphores allow it,
- side-effectful actions remain approval-gated,
- fan-in reads durable output packets from terminal dependency steps.

The fan-in step may summarize branch outputs, but the raw branch evidence remains
expandable.

## Experience Surfaces

### Main Feed

Allowed by default:

- user messages,
- coordinator or mentioned-teammate replies,
- execution proposals,
- active mutable operation cells,
- terminal operation summaries,
- compact branch rows for visible specialist work,
- blocked and approval-needed summaries.

Not allowed by default:

- raw selector prompts,
- raw handoff messages,
- raw run event timelines,
- tool-call logs,
- repeated agent process chatter,
- JSON payloads or raw ids.

### Progress Popover

The progress section should be the glanceable operational surface for active multi-agent
work. It should use the compact operation projection from
[Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md), not a full workflow
inspector. It can show:

- current task title;
- current state;
- 3-6 progress rows;
- current owner;
- one blocker or pending approval;
- one next action.

It should not show workflow ids, context packet ids, selector metadata, token budgets, or
raw logs. It should not become a second workflow detail surface.

### Conversation Evidence And Detail

The main conversation remains the smart detail surface. Inline expansion, agent-span
disclosure, and in-turn previews should expose:

- workflow graph/step list,
- active step detail,
- output packet,
- selector and handoff evidence,
- linked runs and artifacts,
- approvals,
- raw runtime evidence when opened.

Raw audit/debug data should stay one level deeper than the default inline detail. If
inline evidence on the operation cell already exposes the same smart detail, the main
feed should not also show a separate button whose only purpose is to open a duplicate
side-panel view.

## Implementation Slices

### P0: Documentation And Existing Contract Alignment

- Keep this document linked from the channel and Codex-style conversation design baselines.
- Treat existing Codex-style conversation components as the UI compatibility boundary.
- Document that active progress is visible during execution and folds only after terminal
  state.

### P1: Workflow Graph Schema

- Add a versioned graph schema that compiles into existing durable workflow steps.
- Keep deterministic compilation.
- Keep model-generated graph rewrites out of scope.
- Add graph termination and failure policy.
- Implementation plan:
  [Multi-Agent Orchestrator](./multi-agent-orchestrator.md).

### P2: Output And Context Packet Standardization

- Make step output and dependency context packet shapes explicit across backend and UI.
- Ensure fan-in and memory-candidate flows read packets instead of free-form hidden
  transcript summaries.
- Expose packet evidence through inline operation-cell evidence and in-turn previews.
- Implementation plan:
  [Multi-Agent Orchestrator](./multi-agent-orchestrator.md).

### P3: Live Multi-Agent Progress Presentation

- Extend existing active run/work summary presentation into operation cells for
  multi-step workflows.
- Show current teammate, current phase, completed step count, blockers, and artifacts.
- Reuse the existing conversation row, attention/progress popover, and inline detail
  patterns.
- Do not rebuild the conversation feed or replace the Codex-inspired component model.
- Implementation plan:
  Multi-Agent Orchestration Experience.

### P4: Structured Handoff Intent

- Add an agent output contract for handoff proposals.
- Validate handoff intent before creating durable handoff/workflow-step records.
- Show accepted handoffs as live progress or collapsed evidence depending on execution
  state.
- Implementation detail:
  [Multi-Agent Orchestrator](./multi-agent-orchestrator.md).

### P5: Selector Coordinator

- Add a structured selector decision contract.
- Persist selector decisions for audit.
- Show only user-relevant selector outcomes in live progress.
- Keep raw selector reasoning inside evidence.
- Implementation detail:
  [Multi-Agent Orchestrator](./multi-agent-orchestrator.md).

### P6: Fan-Out And Fan-In

- Allow graph-defined parallel branches only within runtime policy and lease constraints.
- Add join/fan-in summaries backed by dependency output packets.
- Keep branch evidence expandable.
- Fan-in may create reviewable memory candidates, but must not activate memory or inject
  unreviewed candidates into later steps.
- Apply safe-parallel side-effect policy: `analysis_readonly` and verified
  `test_artifact_only` may auto-parallelize; `workspace_write`, `external_mutation`, and
  `release` stay serial until isolated worktree merge exists.
- Implementation detail:
  [Multi-Agent Orchestrator](./multi-agent-orchestrator.md).
- Canonical safe-parallel rule:
  [Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md#safe-parallel-scheduler).

### P7: Timeline And Audit Polish

- Make terminal workflow summaries expandable into selector, handoff, packet, run, approval,
  artifact, and raw-event evidence.
- Keep summaries concise in the main feed.
- Add browser checks for active progress visibility and terminal folding.
- Implementation detail:
  [Multi-Agent Orchestrator](./multi-agent-orchestrator.md).

### P8: Collaboration Projections And Ambient Audit

- Add product-level requirement shaping cards before scope is executable.
- Render confirmed workflows as operation cells whose collaboration-task fields are
  derived from existing workflow/proposal records.
- Fold serial step streams into summaries and handoff cards after terminal state.
- Keep parallel branch streams compact by default, with per-branch expansion.
- Keep audit/debug details out of the default feed.
- Design baseline: [Conversation Surface Contract](conversation-surface-contract.md) and
  [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md).
- Implementation source:
  [Conversation Surface Contract Implementation Plan](conversation-surface-contract-implementation-plan.md).

## Non-Goals

- No AutoGen runtime.
- No Microsoft Agent Framework runtime.
- No shared long-context group chat as the execution model.
- No hidden model-generated workflow graph rewrite.
- No hidden mid-run prompt injection.
- No bypass of approval policy, resource leases, state machines, or runner registry.
- No conversation feed refactor solely to support orchestration.
- No default display of raw agent-to-agent chatter.

## Validation

Documentation-only validation:

```bash
git diff --check
```

Implementation slices should add targeted backend tests for graph compilation, handoff
intent validation, selector decision persistence, output packet fan-in, and restart
recovery. UI slices should add browser checks that active progress remains visible while
running and terminal work folds into compact summaries with expandable evidence.
