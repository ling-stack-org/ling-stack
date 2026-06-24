# Multi-Agent Orchestration P4-P7 Detailed Design

Status: initial implementation landed; workflow model-assisted selector remains a follow-up.
Ling Agent Session is the user-turn entry point. Channel `auto_route` and the workflow
intent selector are internal helpers behind the Ling Agent turn envelope boundary, with
P1-P6 implemented and model-assisted intent selection feature-gated.
Date: 2026-06-09

Source design:

- [Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Channel Intent To Workflow Selector](channel-intent-workflow-selector.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [P1 Workflow Graph](multi-agent-orchestration-p1-workflow-graph-implementation-plan.md)
- [P2 Packet Standardization](multi-agent-orchestration-p2-packets-implementation-plan.md)
- [P3 Live Progress](multi-agent-orchestration-p3-live-progress-implementation-plan.md)
- [Memory Health And Multi-Agent Memory Fan-In](memory-health-and-fanin.md)
- [Codex-Inspired Conversation Experience v1](codex-inspired-conversation-v1.md)
- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)
- [Channel Auto Reply Router](channel-auto-reply-router.md)

## Purpose

P0-P3 made multi-agent orchestration visible and durable without turning Ling into a
shared agent chatroom:

```text
WorkflowGraph
  -> ChannelWorkflow / ChannelWorkflowStep
  -> context/output packets
  -> existing run path
  -> compact live progress
  -> expandable evidence
```

P4-P7 add the next orchestration behaviors while preserving that boundary:

```text
P4 structured handoff intent
P5 selector coordinator decision
P6 graph-defined fan-out / fan-in and memory candidates
P7 workflow evidence detail and terminal audit polish
```

This document is an implementation design, not a runtime swap. Ling should borrow the
useful ideas from AutoGen, Microsoft Agent Framework, and Codex-style conversation UIs as
product and architecture patterns only. It should not import those runtimes or replace
the existing channel conversation model.

## Current Implementation Status

Initial P4-P7 implementation landed in the Ling-native stack:

- P4 structured handoff intent types, SQLite persistence, validation, accept route, and
  workflow evidence aggregation are implemented.
- P5 selector decision types, SQLite persistence, deterministic coordinator decisions,
  step metadata attachment, packet source refs, and evidence rendering are implemented.
  Model-assisted selection is intentionally deferred behind a future policy/feature flag.
- P6 fan-in policy metadata, fan-in summary artifacts, candidate-only memory output, and
  workflow evidence attribution are implemented. Memory candidates remain review-gated
  and are not injected into active recall.
- P7 workflow and workflow-step evidence APIs plus Web work-cell/right-drawer drilldown
  are implemented without replacing the existing Codex-inspired conversation surfaces.

The implementation is additive: Pi remains the default runner through `RunnerRegistry`,
`ChannelWorkflowStep` remains the executable unit, and default channel feed content stays
compact.

## Shared Guardrails

- Keep Pi as the default runner through `RunnerRegistry`.
- Keep `ChannelWorkflowStep` as the durable executable unit.
- Keep active progress visible while work runs.
- Keep raw selector prompts, handoff messages, packet JSON, run events, and tool logs out
  of the default channel feed.
- Keep evidence inspectable through the existing work cell, attention popover, right
  drawer, artifact, and approval surfaces.
- Do not create a shared long-context multi-agent group chat.
- Do not let model output grant tools, approvals, provider access, credentials, deploy
  authority, external-send authority, or memory authority.
- Do not let a model rewrite a running workflow graph.
- Do not inject hidden mid-run prompts into an already-running Pi session.
- Do not automatically activate memory from fan-in outputs.
- Do not refactor the Codex-inspired conversation UI solely to support P4-P7.

## Existing Anchors

| Concern | Current anchor |
| --- | --- |
| Handoff records | `ChannelHandoff` in `packages/core/src/workspace-types.ts` |
| Handoff-to-workflow path | `createChannelWorkflowFromHandoff` daemon/Web flow |
| Workflow graph contract | `packages/core/src/workflow-graph-types.ts` |
| Graph compiler | `packages/daemon/src/features/channels/workflow-graph.ts` |
| Workflow step metadata | `ChannelWorkflowStepMetadata.selectorDecisionIds` and `handoffIntentIds` |
| Packet artifacts | `packages/daemon/src/features/channels/workflow-step-packets.ts` |
| Live workflow cell | `apps/web/src/lib/workflow-progress.ts` |
| Conversation evidence model | `apps/web/src/lib/conversation-work-cell.ts` |
| Right drawer | `apps/web/src/features/workspace/WorkspaceClientView.tsx` |
| Memory fan-in boundary | `docs/design/memory-health-and-fanin.md` |

The existing code already anticipates P4/P5 by adding `selectorDecisionIds` and
`handoffIntentIds` to context/output packets and workflow-step metadata. P4-P7 should
populate those ids and render them as evidence, not create a parallel transcript system.

Ordinary channel replies are an internal Ling Agent answer outcome, not a separate
top-level entry point. They may reuse the structured decision and validation pattern, but
they should use [Channel Auto Reply Router](channel-auto-reply-router.md) only after Ling
Agent Session has built the full turn envelope and declined active-run handling,
executable intent, confirmation, and clarification. They create only normal `ai_reply`
messages and must not invoke workflow selector authority or advance a workflow.

When a user turn is likely to start coordinated work, Ling Agent Session should pass the
same turn envelope through
[Channel Intent To Workflow Selector](channel-intent-workflow-selector.md). That internal
classifier may produce a compact workflow proposal, a clarify question, or a validated
direct-workflow prefill. Its P1 adapter hands a confirmed or auto-start-eligible proposal
into this workflow graph/selector layer; it must not turn channel discussion into a shared
multi-agent transcript or bypass workflow state machines.

## Execution Stage Boundary

P4-P7 must preserve the product distinction between shaping and execution.

### Shaping Stage

Before work is clear enough to execute, teammates can appear in the channel if their
output changes the user's decision:

- requirement clarification;
- architecture/design/security/QA disagreement;
- blocker or risk that changes scope;
- explicit user mention of a teammate;
- explicit request for bounded visible opinions from several teammates, such as
  `所有队友都回复我一下`, when the user is asking for discussion rather than execution;
- execution proposal that needs user confirmation.

These are conversation-level events and may be visible as teammate replies.

`visible_multi_reply` belongs only to this shaping stage. It borrows the useful
AutoGen/SelectorGroupChat interaction idea that multiple named agents can visibly
contribute different perspectives, but Ling should keep it as a bounded one-round channel
discussion. It must not become an autonomous shared-context selector group chat, create
workflow steps, start tools, grant permissions, or feed hidden peer messages into a
running workflow. If the user asks the same teammates to implement, verify, publish,
merge, deploy, or otherwise execute work, Ling Agent Session should classify the turn as
`workflow_proposal` or `direct_workflow` through its internal intent selector instead.

### Collaboration Protocol Boundary

Ling's multi-agent coordination surface is a set of explicit work records, not a shared
long-context transcript. The durable protocol is:

```text
visible discussion
  -> ChannelContextSummary / ChannelDecision
  -> ChannelHandoff or WorkflowHandoffIntent
  -> ChannelWorkflowStep packet
  -> WorkflowPacketSourceRef evidence
  -> review-gated memory candidate
```

Responsibilities:

- `ChannelContextSummary` carries scoped working context, acceptance criteria, and open
  questions.
- `ChannelDecision` preserves decisions and alternatives.
- `ChannelHandoff` is the user-visible handoff card: from, to, reason, required input,
  expected output, and status.
- `WorkflowHandoffIntent` is the runtime proposal form for a step-to-step or
  participant-to-participant handoff; it must be validated before conversion.
- Workflow packets and source refs carry step outputs and evidence without copying raw
  conversation into every downstream prompt.
- Memory fan-in may create candidates only; active shared memory and teammate persona
  still require the normal review path.

Raw teammate discussion can be cited as source evidence, but it should not become hidden
peer context or implicit execution authority. If a later step needs discussion output, the
workflow should depend on a context summary, decision, handoff, packet, artifact, or
explicit source ref.

### Execution Stage

After the user starts a workflow or accepts an execution proposal, internal coordination
is no longer default channel speech.

Visible by default:

```text
Architect is defining implementation boundaries.
Engineer is running implementation.
QA is validating 2 checks.
Blocked: waiting for approval to write files.
Done: 3 steps completed, 1 artifact generated.
```

Hidden by default, expandable as evidence:

```text
Selector raw prompt
Selector alternatives and scoring payload
Agent handoff JSON
Workflow packet JSON
Run event timeline
Tool stdout/stderr
Raw ids
```

## P4 Structured Handoff Intent

### Goal

Allow an agent or workflow step to propose a handoff in a structured way, then let Ling
validate it before it becomes a durable handoff or workflow step.

Handoff intent is a proposal:

```text
agent output
  -> handoff intent
  -> validation
  -> durable ChannelHandoff or rejected evidence
  -> optional workflow step / workflow creation
```

It is not execution authority.

### Non-Goals

- No free-form handoff chat that silently becomes context.
- No automatic approval of side effects.
- No automatic teammate creation.
- No cross-channel handoff without explicit source/target validation.
- No direct workflow-step creation from unvalidated model text.
- No default main-feed spam for every proposed handoff.

### Contract

Add a core/contracts type:

```ts
export type WorkflowHandoffIntentStatus =
  | "proposed"
  | "validated"
  | "accepted"
  | "declined"
  | "converted"
  | "failed";

export interface WorkflowHandoffIntent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly workflowId?: string;
  readonly sourceWorkflowStepId?: string;
  readonly sourceRunId?: string;
  readonly sourceMessageId?: string;
  readonly fromParticipantId: string;
  readonly fromParticipantLabel: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel?: string;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly riskSummary?: string;
  readonly sourceRefs: readonly WorkflowPacketSourceRef[];
  readonly status: WorkflowHandoffIntentStatus;
  readonly validation?: WorkflowHandoffValidation;
  readonly createdBy: "local-user" | "ai-teammate" | "orchestrator";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowHandoffValidation {
  readonly targetTeammateExists: boolean;
  readonly targetTeammateActive: boolean;
  readonly skillExecutable: boolean;
  readonly providerRunnable: boolean;
  readonly approvalProfileCompatible: boolean;
  readonly resourceLeaseAvailable: boolean;
  readonly blockers: readonly string[];
}
```

Use stable ids in metadata:

```ts
interface ChannelWorkflowStepMetadata {
  readonly handoffIntentIds?: readonly string[];
}

interface ChannelWorkflowStepContextPacket {
  readonly handoffIntentIds?: readonly string[];
}

interface ChannelWorkflowStepOutputPacket {
  readonly handoffIntentIds?: readonly string[];
}
```

### Persistence Strategy

First implementation should add a small durable store surface instead of hiding intent
records only inside artifact JSON.

Recommended table:

```sql
CREATE TABLE IF NOT EXISTS workflow_handoff_intents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  workflow_id TEXT,
  source_workflow_step_id TEXT,
  source_run_id TEXT,
  source_message_id TEXT,
  from_participant_id TEXT NOT NULL,
  from_participant_label TEXT NOT NULL,
  to_participant_id TEXT NOT NULL,
  to_participant_label TEXT,
  reason TEXT NOT NULL,
  required_input TEXT NOT NULL,
  expected_output TEXT NOT NULL,
  risk_summary TEXT,
  source_refs_json TEXT NOT NULL,
  status TEXT NOT NULL,
  validation_json TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Why table first:

- handoff intents may be created before a run artifact exists;
- selector/evidence routes need to list them by workflow and step;
- status changes need audit and filtering;
- existing `ChannelHandoff` can remain the user-facing accepted handoff record.

`ChannelHandoff` should not be overloaded with rejected or failed model proposals. A
validated and accepted intent can create a normal `ChannelHandoff`; rejected intents stay
as workflow evidence.

### Daemon Flow

Add a helper module:

```text
packages/daemon/src/features/channels/workflow-handoffs.ts
```

Responsibilities:

1. Parse structured handoff intent from step output or an explicit route input.
2. Normalize participant ids and labels.
3. Validate target teammate, skill binding, provider readiness, approval profile, and
   resource-lease constraints.
4. Persist `WorkflowHandoffIntent`.
5. Attach `handoffIntentIds` to the source workflow step metadata.
6. If accepted, create or update a normal `ChannelHandoff`.
7. If converted, create the next workflow or workflow step only through existing
   workflow routes and approval gates.

The model can propose:

```text
handoff to QA because implementation changed files and needs validation
```

Ling decides whether that can become:

```text
ChannelHandoff(status=proposed)
```

or:

```text
workflow step queued for QA
```

### UI Behavior

Default feed:

- shaping stage: show user-relevant accepted handoffs or coordinator summaries;
- execution stage: show only live progress, blocker, approval, or terminal summary copy;
- never show raw handoff JSON.

Right drawer/evidence:

- show handoff intent summary;
- show validation result and blockers;
- link to source step/run/artifacts;
- show accepted `ChannelHandoff` if one was created;
- expose raw JSON only through artifact/detail view if an artifact exists.

Suggested visible labels:

```text
Handoff proposed: Engineer -> QA
Validation blocked: QA provider is not runnable
Handoff accepted: QA will validate changed files
```

### Implementation Slices

P4.1 core/contracts:

- add `WorkflowHandoffIntent` types;
- add store interface methods;
- add SQLite migration and parser tests.

P4.2 daemon:

- add intent create/validate helpers;
- add route or orchestrator hook for step-output handoff proposals;
- attach ids to step metadata and output packets.

P4.3 Web evidence:

- add handoff intent rows to workflow detail/evidence;
- keep default feed unchanged except accepted/blocked summary states.

P4.4 tests:

- valid intent creates durable intent;
- missing teammate fails validation without creating `ChannelHandoff`;
- accepted intent creates a normal handoff;
- converted intent starts only through existing workflow-step/workflow paths;
- raw handoff JSON is not displayed in the main feed.

## P5 Selector Coordinator

### Goal

Let Ling choose the next teammate, skill, or graph branch from structured context while
recording the decision as durable evidence.

Selector decision is routing evidence:

```text
workflow graph state + packets + teammate registry + policy
  -> selector decision
  -> validated selected target
  -> existing workflow step start / branch unlock
```

It is not graph mutation and not permission granting.

### Non-Goals

- No shared selector group chat; bounded visible multi-reply is handled before workflow
  execution by the channel intent selector.
- No model-owned graph rewrite.
- No hidden approval-policy change.
- No side effects during selector evaluation.
- No direct tool execution from selector output.
- No raw chain-of-thought or long reasoning payload in evidence.

### Contract

Add a core/contracts type:

```ts
export type WorkflowSelectorDecisionStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "blocked"
  | "superseded";

export type WorkflowSelectorTargetKind =
  | "workflow_step"
  | "graph_node"
  | "teammate"
  | "skill"
  | "handoff"
  | "wait";

export interface WorkflowSelectorDecision {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly workflowId: string;
  readonly sourceWorkflowStepId?: string;
  readonly selectorNodeId?: string;
  readonly targetKind: WorkflowSelectorTargetKind;
  readonly selectedWorkflowStepId?: string;
  readonly selectedGraphNodeId?: string;
  readonly selectedTeammateId?: string;
  readonly selectedSkillId?: string;
  readonly selectedHandoffIntentId?: string;
  readonly reason: string;
  readonly alternativesConsidered: readonly WorkflowSelectorAlternative[];
  readonly confidence: "low" | "medium" | "high";
  readonly requiresUserConfirmation: boolean;
  readonly status: WorkflowSelectorDecisionStatus;
  readonly sourceRefs: readonly WorkflowPacketSourceRef[];
  readonly createdBy: "deterministic" | "model" | "local-user";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowSelectorAlternative {
  readonly targetKind: WorkflowSelectorTargetKind;
  readonly targetId: string;
  readonly label: string;
  readonly reason: string;
}
```

Keep `reason` concise and policy-safe. Do not store hidden reasoning. If provider output
includes unsupported reasoning fields, redact or discard them before persistence.

### Selector Inputs

The selector may read:

- workflow objective;
- workflow graph state;
- current step status;
- terminal dependency output packets;
- handoff intents;
- channel brief, decisions, and context summaries;
- teammate capability profile;
- skill bindings;
- provider readiness;
- runtime policy and resource-lease state;
- pending approvals and blockers;
- explicit user mentions or commands.

The selector must not read:

- private teammate memory outside scoped policy;
- raw unredacted tool output by default;
- secret-adjacent artifact content;
- unreviewed memory candidates as normal recall;
- hidden chain-of-thought from prior model calls.

### Persistence Strategy

Recommended table:

```sql
CREATE TABLE IF NOT EXISTS workflow_selector_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  source_workflow_step_id TEXT,
  selector_node_id TEXT,
  target_kind TEXT NOT NULL,
  selected_workflow_step_id TEXT,
  selected_graph_node_id TEXT,
  selected_teammate_id TEXT,
  selected_skill_id TEXT,
  selected_handoff_intent_id TEXT,
  reason TEXT NOT NULL,
  alternatives_json TEXT NOT NULL,
  confidence TEXT NOT NULL,
  requires_user_confirmation INTEGER NOT NULL,
  status TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Attach accepted decision ids to `ChannelWorkflowStepMetadata.selectorDecisionIds` and
packet `selectorDecisionIds`.

### Selector Modes

First implementation should support deterministic selector only. Model-assisted selector
is a later feature-flagged mode after deterministic filtering, validation, UI evidence,
and user-confirmation behavior are stable.

| Mode | Use case | Behavior |
| --- | --- | --- |
| Deterministic selector | graph has one eligible next step | produce decision with `createdBy: "deterministic"` |
| Model selector | future: graph has multiple valid next branches or teammate candidates | call model for structured JSON, then validate output behind feature flag |

The deterministic selector should be the default and should cover the existing serial
workflow path. If several policy-valid options remain after deterministic filtering in
the first phase, require user confirmation or block with alternatives instead of calling a
model.

### Daemon Flow

Add:

```text
packages/daemon/src/features/channels/workflow-selector.ts
```

Tick integration:

1. Reconcile running/waiting/blocked steps.
2. Build eligible candidate set from graph and step state.
3. If zero candidates, succeed/block/fail according to termination policy.
4. If one candidate, persist deterministic selector decision.
5. If multiple candidates remain, require user confirmation or block with alternatives.
   A future feature flag may invoke a structured model selector here, but the selected
   target must still pass deterministic validation.
6. Validate selected target is still eligible.
7. Attach decision id to selected step metadata.
8. Start the selected step only through the existing workflow-step start path.

Race rule:

```text
selector decision is accepted only if workflow state version still matches the state used
to build candidates
```

The first implementation can use `updatedAt` and terminal status checks. A later slice can
add explicit workflow version columns if needed.

### UI Behavior

Default feed:

- do not show selector decision rows by default;
- show only user-relevant outcomes, such as "QA selected next because implementation
  changed files" when it changes expectation;
- show blockers or confirmation needs at Level 1.

Evidence:

- show selected target;
- show concise reason;
- show alternatives count and labels;
- show confidence;
- show source refs;
- show whether the choice was deterministic or model-assisted.

Suggested collapsed evidence:

```text
Routing: QA selected, 2 alternatives considered
```

### Implementation Slices

P5.1 core/contracts:

- add selector decision types;
- add store interface methods and SQLite migration;
- add parser validation for alternatives and status.

P5.2 daemon deterministic selector:

- create selector decisions when one eligible step exists;
- attach decision ids to step metadata and packets;
- preserve existing serial behavior.

P5.3 daemon model selector:

- add structured model call behind feature flag;
- validate target eligibility after model output;
- require confirmation when confidence is low or target changes side-effect boundary.

P5.4 Web evidence:

- show selector evidence in workflow detail/evidence;
- keep default feed compact.

P5.5 tests:

- one eligible candidate creates deterministic decision;
- multiple candidates require selector policy;
- invalid selected target is rejected and workflow blocks safely;
- selector cannot change graph, approvals, tools, or provider settings;
- decision evidence appears in drawer, not as raw feed spam.

## P6 Fan-Out, Fan-In, And Memory Candidates

### Goal

Allow graph-defined parallel branches and joins while using output packets as the fan-in
input. Fan-in may produce summary artifacts and reviewable memory candidates. It must not
automatically activate memory or inject unreviewed candidates into later prompts.

```text
parallel branch steps
  -> terminal output packets
  -> join/fan-in step
  -> summary artifact
  -> optional memory candidates
  -> review before active recall
```

### Non-Goals

- No uncontrolled parallel execution.
- No parallel side-effectful writes through the default scheduler.
- No raw branch transcript merge into hidden context.
- No automatic memory authority changes.
- No cross-scope memory promotion.
- No branch output overriding workflow graph or approval policy.

### Runtime Rules

Parallel execution is allowed only when all of the following are true:

- graph dependencies allow multiple eligible steps;
- channel runtime policy permits the concurrency;
- runner registry and semaphores permit the concurrency;
- resource leases do not conflict;
- side-effect class is `analysis_readonly`, or `test_artifact_only` with verified
  artifact-only behavior;
- `workspace_write`, `external_mutation`, and `release` steps remain serial unless a
  future isolated worktree merge protocol explicitly owns the branch merge;
- side-effectful steps remain approval-gated even when serial;
- each branch has a terminal output packet or a blocked/failure policy outcome.

The scheduler should fail closed:

```text
if unsure whether branches conflict, run serially or block for user
```

### Contract Extensions

P1 already added `branchGroupId`, `joinGroupId`, `dependencyMode`, and
`maxParallelSiblings` to step metadata. The next hardening slice should add side-effect
and parallel policy metadata:

```ts
type WorkflowStepSideEffectClass =
  | "analysis_readonly"
  | "test_artifact_only"
  | "workspace_write"
  | "external_mutation"
  | "release";

interface WorkflowStepParallelPolicy {
  readonly autoParallel: boolean;
  readonly maxParallelSiblings?: number;
  readonly resourceKeys?: readonly string[];
  readonly requiresArtifactOnly?: boolean;
  readonly cancelSiblingsOnFailure?: boolean;
}
```

P6 should also add explicit fan-in metadata:

```ts
export type WorkflowFanInMode =
  | "summarize_outputs"
  | "compare_outputs"
  | "collect_checks"
  | "memory_candidates";

export interface WorkflowFanInPolicy {
  readonly mode: WorkflowFanInMode;
  readonly requireAllBranchesTerminal: boolean;
  readonly includeFailedBranches: boolean;
  readonly createSummaryArtifact: boolean;
  readonly createMemoryCandidates: boolean;
  readonly memoryCandidateScope: "run" | "task" | "channel";
  readonly maxInputArtifacts: number;
}

interface WorkflowStepPolicy {
  readonly fanIn?: WorkflowFanInPolicy;
}
```

If adding this directly to `WorkflowStepPolicy` is too broad, keep it in
`ChannelWorkflowStepMetadata.fanInPolicy` for the first slice.

### Fan-In Input

Fan-in consumes only durable evidence:

- terminal dependency output packets;
- linked artifact ids and summaries;
- blockers and changed paths;
- selector decision ids;
- handoff intent ids;
- explicit source refs.

Fan-in does not consume:

- raw hidden group chat;
- raw model reasoning;
- unscoped private memory;
- unreviewed memory candidates;
- provider/tool credentials;
- raw artifact content beyond configured size/type policy.

### Memory Candidate Boundary

Fan-in memory output must enter the existing memory review pipeline as candidates.

Rules:

- candidate source refs must include workflow id, step ids, packet artifact ids, and run
  ids where available;
- candidates default to the narrowest scope that is useful;
- workflow fan-in experiment default is manual approval;
- candidates are not normal run recall input until approved or policy-activated by the
  existing memory review policy;
- cross-scope promotion, workspace shared memory, persona/profile changes, secret-adjacent
  memory, and authority-like claims require manual review;
- memory cannot grant tools, approvals, providers, credentials, deploy access, or
  external-send authority.

### Scheduler Flow

Update orchestrator tick:

1. Reconcile terminal linked runs and packet artifacts.
2. Find all eligible queued steps.
3. Group eligible steps by `branchGroupId`.
4. Apply channel runtime policy and resource leases.
5. Start up to the allowed number of safe parallel steps.
6. For join/fan-in steps, require dependency output packets according to dependency mode.
7. If fan-in policy creates summary artifact, write it as workflow evidence.
8. If fan-in policy creates memory candidates, call memory consolidation candidate path
   with source refs and manual-review defaults.

Do not start another step solely because a model branch output asked for it. The graph,
selector, scheduler, state machines, and approval gates decide the next step.

### UI Behavior

Live progress:

```text
Research and Design Review are running in parallel.
Fan-in waiting for 2 branch outputs.
QA is validating merged branch results.
```

Default feed:

- one workflow progress cell;
- no duplicate per-branch run spam;
- terminal summary includes branch count and artifact count.

Evidence:

- branch group;
- branch step statuses;
- output packet summaries;
- fan-in summary artifact;
- memory candidate count and review-required count;
- links to memory review surface filtered by workflow/source refs.

### Implementation Slices

P6.1 scheduler:

- start multiple eligible safe steps within channel runtime limits;
- respect resource leases and approval gates;
- filter auto-parallel candidates by `sideEffectClass` and `parallelPolicy`;
- keep write, external mutation, and release steps serial by default;
- add tests for serial fallback on conflict.

P6.2 fan-in packet reader:

- collect dependency output packets;
- handle missing/bad packet evidence without crashing;
- create diagnostic blocker when required packet evidence is missing.

P6.3 summary artifact:

- create fan-in summary artifact from packet summaries and artifact refs;
- avoid raw transcript merge.

P6.4 memory candidates:

- call existing memory candidate/consolidation path;
- force manual-review default for fan-in experiment;
- add source refs and health metadata.

P6.5 Web:

- show branch progress and fan-in evidence through existing work cell/drawer;
- deep-link memory candidate review.

P6.6 tests:

- two read-only branches run in parallel when policy permits;
- write-conflicting branches do not run together;
- write branches without isolated worktree merge stay serial even with
  `maxParallelSiblings > 1`;
- QA artifact-only branches can run with code review, but QA branches that write
  workspace files cannot;
- join waits for required terminal dependencies;
- missing output packet blocks fan-in with evidence;
- fan-in creates candidates but no active memory;
- default feed still shows one workflow cell.

## P7 Workflow Evidence Detail

### Goal

Make workflow evidence complete enough that the default feed can stay compact without
hiding auditability.

P7 is UI/API polish around the evidence model:

```text
workflow progress cell
  -> right drawer workflow detail
  -> step detail
  -> selector / handoff / packets / runs / approvals / artifacts
  -> raw artifact detail only on request
```

### Non-Goals

- No new default transcript layout.
- No raw JSON in the main feed.
- No drawer rewrite.
- No duplicate workflow dashboard separate from the channel context.
- No broad visual redesign.

### Evidence API

P2 deferred a dedicated workflow-step evidence route. P7 should add a route shaped for
drawer drilldown:

```http
GET /workflows/:workflowId/evidence?cwd=/path
GET /workflow-steps/:workflowStepId/evidence?cwd=/path
```

Suggested response:

```ts
export interface WorkflowEvidenceResponse {
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly WorkflowEvidenceStep[];
  readonly selectorDecisions: readonly WorkflowSelectorDecision[];
  readonly handoffIntents: readonly WorkflowHandoffIntent[];
  readonly handoffs: readonly ChannelHandoff[];
  readonly approvals: readonly ApprovalRequest[];
  readonly artifacts: readonly RunArtifact[];
  readonly memoryCandidates: readonly WorkflowMemoryCandidateSummary[];
}

export interface WorkflowEvidenceStep {
  readonly step: ChannelWorkflowStep;
  readonly contextPacket?: ChannelWorkflowStepContextPacket;
  readonly outputPacket?: ChannelWorkflowStepOutputPacket;
  readonly linkedRun?: RunSession;
  readonly packetArtifacts: readonly RunArtifact[];
  readonly linkedArtifacts: readonly RunArtifact[];
  readonly diagnostics: readonly WorkflowEvidenceDiagnostic[];
}
```

Rules:

- list packet summaries, not raw packet JSON, unless artifact detail is explicitly opened;
- omit or redact scoped/private content the caller cannot see;
- include diagnostics for missing artifacts, bad packet schema, deleted teammates, missing
  approvals, or stale linked runs;
- route must be read-only.

### Drawer Information Architecture

Reuse the existing right drawer stack.

Workflow root:

- objective and status;
- current/terminal summary;
- step list with teammate, status, and blocker;
- top approval or next action;
- artifacts and changed paths count;
- selector/handoff counts;
- memory candidate count.

Step detail:

- prompt summary, not full prompt by default;
- context packet summary;
- output packet summary;
- linked run and artifacts;
- approvals;
- selector decisions and handoff intents tied to the step;
- diagnostics.

Raw detail:

- artifact preview/download;
- raw packet JSON only through artifact route;
- raw run event timeline only through existing runtime evidence route.

### Terminal Folding

When workflow reaches terminal state, the default feed shows one compact summary:

```text
Done: 8 steps completed, 4 artifacts captured, 2 memory candidates need review.
```

or:

```text
Blocked: QA cannot run because provider is not configured.
```

The expanded evidence should answer:

- which teammate did what;
- why selector chose the next target;
- whether handoffs were proposed/accepted/rejected;
- what packets were passed to downstream steps;
- what approvals were requested and decided;
- what artifacts or changed paths were produced;
- what memory candidates were created and whether they need review.

### Accessibility And Copy Rules

- Use buttons with `aria-expanded` for evidence disclosure.
- Use stable labels, not raw ids.
- Use status copy that names the user consequence: `Waiting for approval`, `Blocked`,
  `Failed`, `Done`.
- Keep raw ids available through copy/detail controls, not visible body copy.
- Completed evidence should be reachable by keyboard after the row folds.

### Implementation Slices

P7.1 evidence API:

- add workflow and step evidence read routes;
- aggregate packets, runs, artifacts, approvals, selector decisions, handoff intents, and
  memory candidate summaries;
- add read-only diagnostics.

P7.2 Web evidence model:

- map API response to `ConversationEvidenceBundle`;
- add workflow-specific evidence sections: routing, handoff, packets, branches, memory
  candidates.

P7.3 drawer drilldown:

- wire workflow progress cell to drawer evidence page;
- add step detail pages without changing the feed layout.

P7.4 terminal folding:

- ensure terminal workflow row stays compact;
- show evidence summary counts;
- preserve keyboard and right-drawer access to detail.

P7.5 tests:

- drawer loads workflow evidence on demand;
- raw JSON is not in default feed;
- missing packet creates diagnostic row;
- terminal workflow collapses into one summary row;
- active workflow remains visible while running;
- represented step/run noise remains deduped.

## Cross-Slice Acceptance Criteria

P4-P7 are complete only when these are true:

- a handoff proposal can be persisted, validated, accepted, rejected, and audited;
- a selector decision can be persisted and tied to the step it selected;
- fan-out respects graph, runtime policy, resource leases, and approvals;
- fan-in reads output packets and creates summary evidence;
- fan-in memory output creates candidates only;
- default channel feed still shows compact live/terminal workflow cells;
- right drawer can show selector, handoff, packet, run, approval, artifact, branch, and
  memory-candidate evidence;
- raw JSON and runtime event streams are never default feed content;
- tests cover failure, restart/reconcile, missing evidence, and permission boundaries.

## Recommended Implementation Order

Keep each PR behavior-preserving until the final UI/evidence slice:

1. P4.1-P4.2: handoff intent types, store, validation, daemon tests.
2. P4.3: handoff evidence UI.
3. P5.1-P5.2: selector decision types, store, deterministic selector.
4. P5.3-P5.4: model selector behind feature flag and evidence UI.
5. P6.1-P6.3: scheduler fan-out and fan-in summary artifacts.
6. P6.4-P6.5: memory candidates and Web candidate summary.
7. P7.1-P7.3: evidence API and drawer drilldown.
8. P7.4-P7.5: terminal folding polish and browser/E2E coverage.

Do not combine P6 parallel scheduling with P7 drawer work in the same PR. The scheduler
has state-machine risk; the drawer has presentation risk. Keeping them separate makes
regression triage simpler.

## Validation Plan

Documentation-only validation:

```bash
git diff --check
```

Implementation validation should add targeted checks:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
```

Add browser/E2E checks only when P7 changes rendered evidence behavior.
