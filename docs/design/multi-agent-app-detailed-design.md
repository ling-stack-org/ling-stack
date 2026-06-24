# Multi-Agent App Detailed Design

Status: canonical design patch for the next multi-agent implementation slices.

Date: 2026-06-24

Related docs:

- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)
- [Orchestrator Advanced](orchestrator-advanced.md)
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md)
- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
- [Channel Context Processing Layer](channel-context-processing-layer.md)
- [Runtime Control Plane Detailed Design](runtime-control-plane-detailed-design.md)
- [Runner Adapters](runner-adapters.md)

## Purpose

This document is the single design source for Ling's multi-agent app behavior after the
initial orchestration slices.

It settles these design points:

- Ling's multi-agent model is coordinator-owned workflow orchestration, not free-form
  agent group chat.
- Requirement analysis can involve multiple teammates, but discussion is selective,
  summarized, and rendered through the existing conversation operation-cell model.
- Workflow packets live as typed contracts plus JSON artifacts; workflow-step metadata
  stores refs, not packet bodies.
- Safe parallel workflow is allowed only for explicitly safe side-effect classes by
  default.
- Parallel workspace writes require a future isolated worktree merge protocol.
- UI should extend `ConversationTurn -> OperationCell / ConversationWorkCell`, not add a
  second workflow page or a raw multi-agent transcript.
- Conversation UI is adaptive and block-driven, not a fixed template. Requirement
  shaping, planning, execution, approval, artifact review, and plain answers render only
  the blocks produced by the semantic projector for that turn.

## Product Rule

One user task gets one visible work object.

```text
User request
  -> Ling coordinator
  -> optional requirement shaping with specialists
  -> workflow proposal / template compile
  -> durable workflow steps
  -> one runner execution per step
  -> artifacts, approvals, audit, and final summary
  -> conversation operation-cell projection
```

The coordinator owns state transitions. Specialists contribute bounded judgments and
artifacts. Runners execute one step attempt. Approval policy owns authority for side
effects.

No specialist can:

- approve its own side effects;
- mutate workflow state directly;
- start another step by writing prose;
- bypass runner registry, leases, approval policy, artifact import, or audit;
- make private discussion part of channel context without an explicit source ref.

## Architecture

```text
Channel user turn
  |
  v
Ling coordinator
  |
  +--> Requirement shaping selector
  |      -> specialist context views
  |      -> contribution packets
  |      -> coordinator synthesis
  |
  +--> Workflow proposal / template selection
         -> WorkflowTemplate or WorkflowGraph
         -> ChannelWorkflow
         -> ChannelWorkflowStep[]
             |
             v
        MultiAgentOrchestrator tick
             |
             +--> safe parallel scheduler
             +--> approval gates
             +--> task/run coordinator
                    |
                    v
               RunnerRegistry
                    |
                    v
               Pi runner by default
                    |
                    v
        context/output packet artifacts
        approvals, leases, artifacts, audit events
                    |
                    v
        ConversationTurn projection
        OperationCell / ConversationWorkCell / inline evidence and in-turn previews
```

Ling still owns the runtime control plane. Pi remains the default effective runner.
`codex-app-server` and other external agent runtimes remain future runner adapters until
their approval, workspace, artifact, resume, and conformance gates pass.

## Execution Stages

| Stage | Owner | Durable output | Default UI |
| --- | --- | --- | --- |
| Requirement shaping | Ling coordinator | shaping packet, contribution refs, decision refs | one shaping operation cell |
| Workflow proposal | Ling coordinator | proposal, workflow graph/template refs | ready/start action inside same turn |
| Workflow compile | Orchestrator | `ChannelWorkflow`, `ChannelWorkflowStep` metadata | plan rows inside operation cell |
| Step execution | Task/run coordinator + runner | run, events, artifacts, approvals | agent spans / progress rows |
| Fan-in | Orchestrator | fan-in summary artifact and output packet refs | branch summary row |
| Terminal summary | Ling coordinator | final coordinator message and evidence refs | compact final operation cell |

The stage boundary matters because each stage has different authority. Requirement
shaping can decide what to do. Step execution can run tools only through normal run
policy. Fan-in can summarize branch artifacts but cannot hide conflicts.

## Adaptive Conversation Projection

Multi-agent workflow state projects into a heterogeneous `TranscriptBlock[]`, not a
fixed card/report layout.

Projection rules:

- The projector owns block selection and order.
- The renderer registry owns presentation for each block kind.
- A turn may render only one answer block, or many blocks, depending on the actual task
  flow.
- Examples in design docs are fixtures, not fixed UI templates.
- Implementation must not infer UI structure from copy prefixes, markdown headings, or
  teammate message text.

Common block examples:

| Task condition | Blocks |
| --- | --- |
| direct answer | coordinator message |
| requirement analysis | requirement shaping, participant spans, decisions needed |
| implementation | operation, agent activity, approval, checks, artifacts |
| verification | agent activity, checks, source summary |
| blocked workflow | blocked operation, decision needed, approval/requested input |
| terminal result | final result, artifact strip, inline evidence |

## Requirement Shaping Protocol

Requirement shaping is a coordinator-owned pre-execution phase. It exists to turn an
ambiguous or risky user request into a clear execution proposal.

### Trigger Conditions

The coordinator may invite specialists when at least one condition is true:

- the user explicitly asks for teammate discussion or names a specialist;
- the request spans product, architecture, design, QA, security, release, or operations;
- the objective, acceptance criteria, target files, or permission boundary are unclear;
- a proposed workflow would include side effects, external mutation, release, or budget
  risk;
- two plausible plans conflict and the user must choose;
- a specialist can add acceptance checks or risk constraints that change the proposal.

The coordinator should not trigger shaping when:

- the user gives a narrow direct edit or local check request;
- one ordinary Ling Agent reply is enough;
- the user explicitly says to implement immediately and the scope is already safe;
- the only purpose would be to show agent activity.

### Participant Selection

Specialists are selected by reason, not by default roster expansion.

| Signal | Candidate specialists |
| --- | --- |
| product value, scope, prioritization | product strategist |
| state ownership, integration boundary, migration risk | architect |
| interaction model, visible UI behavior | designer |
| acceptance checks, regressions, runtime verification | QA |
| secrets, permission, unsafe tools, external mutation | security |
| deploy, release, rollback, post-ship checks | release |
| docs and discoverability | docs |

The selector writes evidence explaining why each teammate was included or skipped. That
evidence is inspectable, but the main feed shows only the result.

### Contribution Contract

Each invited teammate produces a contribution packet, not raw chat.

```ts
type RequirementContributionKind =
  | "scope"
  | "risk"
  | "acceptance_criteria"
  | "design_boundary"
  | "architecture_boundary"
  | "security_boundary"
  | "test_plan"
  | "release_boundary"
  | "open_question";

interface RequirementContributionPacket {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly teammateId: string;
  readonly roleKey: string;
  readonly kind: RequirementContributionKind;
  readonly summary: string;
  readonly recommendations: readonly string[];
  readonly risks: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly openQuestions: readonly string[];
  readonly sourceRefs: readonly WorkflowPacketSourceRef[];
  readonly generatedAt: string;
}
```

Rules:

- `summary` is user-facing and bounded.
- `recommendations` are proposals, not workflow authority.
- `openQuestions` can block execution only when the coordinator marks them decision
  required.
- The packet may reference artifacts, messages, summaries, and memory ids through
  `sourceRefs`.
- Chain-of-thought, raw private discussion, and raw prompts are not packet fields.

### Coordinator Synthesis

The coordinator merges contribution packets into a shaping packet.

```ts
interface RequirementShapingPacket {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly status:
    | "collecting"
    | "needs_user_decision"
    | "ready_for_workflow"
    | "converted_to_workflow"
    | "dismissed";
  readonly objective: string;
  readonly proposedScope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly risks: readonly string[];
  readonly decisionsNeeded: readonly RequirementDecisionNeed[];
  readonly proposedWorkflow?: RequirementWorkflowPreview;
  readonly contributionPacketArtifactIds: readonly string[];
  readonly sourceRefs: readonly WorkflowPacketSourceRef[];
  readonly generatedAt: string;
}

interface RequirementDecisionNeed {
  readonly id: string;
  readonly title: string;
  readonly options: readonly string[];
  readonly recommendedOption?: string;
  readonly blocksExecution: boolean;
}

interface RequirementWorkflowPreview {
  readonly templateId?: string;
  readonly graphId?: string;
  readonly stepCount: number;
  readonly participantLabels: readonly string[];
  readonly executionMode: "serial" | "safe_parallel" | "manual";
  readonly unsafeSteps: readonly string[];
}
```

The coordinator may create a workflow only after all blocking `decisionsNeeded` are
resolved or explicitly deferred by the user.

## Workflow Packet Protocol

Workflow packets are the typed handoff language between coordinator, orchestrator,
specialists, runner steps, fan-in, UI, memory candidate generation, and audit.

### Ownership

Packet ownership is split deliberately:

| Layer | Owns |
| --- | --- |
| `packages/core` | domain packet types used by storage, orchestrator, and daemon |
| `packages/contracts` | API DTO packet types exported to Web/Desktop/CLI clients |
| artifact store | JSON packet bodies |
| `ChannelWorkflowStep.metadata` | stable packet refs, summary refs, version refs |
| Web projection | packet summaries and evidence links |

Do not create a `workflow_step_packets` SQLite table in this phase. Packet bodies are
evidence artifacts. Querying should go through workflow, step, run, and artifact refs
until real product queries require a table.

### Packet Ref

Step metadata should carry refs instead of packet bodies.

```ts
type WorkflowPacketKind =
  | "requirement_contribution"
  | "requirement_shaping"
  | "step_context"
  | "step_output"
  | "handoff"
  | "selector_decision"
  | "fan_in_summary";

interface WorkflowPacketRef {
  readonly kind: WorkflowPacketKind;
  readonly schemaVersion: number;
  readonly artifactId: string;
  readonly summary?: string;
  readonly sourceRefIds?: readonly string[];
  readonly createdAt: string;
}

interface WorkflowStepPacketRefs {
  readonly context?: WorkflowPacketRef;
  readonly output?: WorkflowPacketRef;
  readonly handoffs?: readonly WorkflowPacketRef[];
  readonly selectorDecisions?: readonly WorkflowPacketRef[];
  readonly fanInSummary?: WorkflowPacketRef;
}
```

Existing metadata fields such as `contextArtifactId`, `outputArtifactId`,
`selectorDecisionIds`, `handoffIntentIds`, and `fanInSummaryArtifactId` can remain for
backward compatibility. The target shape should add a grouped packet-ref helper so new
code stops spreading packet refs across unrelated metadata fields.

### Packet Envelope

Every JSON artifact should use a narrow envelope.

```ts
interface WorkflowPacketEnvelope<TBody> {
  readonly schemaVersion: 1;
  readonly kind: WorkflowPacketKind;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly channelId: string;
  readonly sourceMessageId?: string;
  readonly body: TBody;
  readonly sourceRefs: readonly WorkflowPacketSourceRef[];
  readonly createdAt: string;
}
```

Rules:

- packet readers fail closed on missing artifact, bad JSON, wrong kind, or wrong
  `schemaVersion`;
- packet writers are idempotent for a step/kind when a previous artifact ref exists;
- packet body artifacts are local-only under `.ling-stack/artifacts`;
- packet readers return diagnostics to evidence surfaces instead of crashing workflow UI;
- summaries may be stored in metadata, but full packet body stays in the artifact.

### Existing Step Packets

The current `ChannelWorkflowStepContextPacket` and `ChannelWorkflowStepOutputPacket`
remain valid packet bodies. They should be treated as `WorkflowPacketEnvelope.body`
values over time.

Context packet includes:

- workflow and step ids;
- graph node ids;
- teammate and skill ids;
- objective and step prompt;
- dependency output refs;
- source refs;
- selector and handoff ids;
- runner/provider/approval metadata;
- context-pack budget snapshot when available.

Output packet includes:

- workflow and step ids;
- run id;
- terminal status;
- result summary;
- artifact ids;
- blockers;
- changed paths;
- source refs;
- runner audit.

Fan-in and downstream steps consume output packets, not raw branch transcripts.

## Step Side-Effect Model

Parallel behavior must be based on declared side-effect class, not only dependency graph
shape.

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

interface WorkflowStepExecutionSafety {
  readonly sideEffectClass: WorkflowStepSideEffectClass;
  readonly parallelPolicy?: WorkflowStepParallelPolicy;
}
```

Target storage:

- add these fields to `WorkflowStepTemplate`, `WorkflowGraphNode`, custom template step,
  and `ChannelWorkflowStep.metadata`;
- infer conservative defaults for old templates;
- keep run/tool approval policy separate from side-effect class.

Default side-effect classification:

| Class | Meaning | Default auto-parallel |
| --- | --- | --- |
| `analysis_readonly` | reads existing context/artifacts, produces analysis packet only | yes |
| `test_artifact_only` | may run checks but writes only artifacts/evidence, not workspace files | yes, if artifact-only verified |
| `workspace_write` | may edit workspace files or apply patches | no |
| `external_mutation` | may mutate external systems, tickets, PRs, services, inboxes | no |
| `release` | deploy, ship, merge, publish, or rollback | no |

No model output may upgrade a step to a safer side-effect class. Template validation or
deterministic skill metadata must choose the class.

## Safe Parallel Scheduler

The scheduler may start multiple siblings in one tick only when all gates pass.

```text
dependencies are satisfied
+ step status is queued or approved waiting_for_approval
+ metadata.autoStart is not false
+ parallelPolicy.autoParallel is true
+ sideEffectClass is analysis_readonly or test_artifact_only
+ no pending pre-step or post-step approval blocks this step
+ artifact-only constraint is satisfied for test_artifact_only
+ resourceKeys do not conflict with active siblings
+ active sibling count is below maxParallelSiblings
+ channel runtimePolicy.executionMode is parallel
+ runtimePolicy.maxConcurrentRuns and runner/provider semaphores have budget
+ workflow is not blocked, failed, cancelled, or waiting on a global decision
=> start step through normal task/run coordinator
```

Existing leases and semaphores remain mandatory. The scheduler is only a candidate
selector. `prepareWorkflowStepStart()` and the run coordinator remain the authority that
creates tasks, runs, approvals, and resource leases.

### Default Autoplan Mapping

`autoplan-lite` should compile to this target safety model:

| Step | Side-effect class | Auto parallel | Reason |
| --- | --- | --- | --- |
| `product-discovery` | `analysis_readonly` | no | entry step, establishes objective |
| `product-review` | `analysis_readonly` | no | depends on discovery and gates branch quality |
| `design-review` | `analysis_readonly` | yes | independent review after product review |
| `engineering-review` | `analysis_readonly` | yes | independent review after product review |
| `implementation` | `workspace_write` | no | may edit workspace and requires approval gate |
| `code-review` | `analysis_readonly` | yes | can review implementation output |
| `qa` | `test_artifact_only` | yes only when artifact-only | may run checks; cannot write workspace files by default |
| `ship` | `release` | no | strict release approval |

First default parallel group:

```text
product-review succeeded
  -> design-review
  -> engineering-review
```

Controlled parallel group:

```text
implementation succeeded
  -> code-review
  -> qa
```

`qa` may join this group only when the run request is artifact-only. If QA needs to write
fixtures, snapshots, generated files, or external state, it becomes `workspace_write` or
`external_mutation` and must run serially or through future isolated worktrees.

### What "Foundation Complete" Means

Build the full metadata and scheduler gates now:

- side-effect class;
- parallel policy;
- resource keys;
- branch/join metadata;
- fan-in packet reading;
- evidence projection;
- tests for safe and unsafe classes.

But default product behavior should expose only safe parallel branches. "One step" should
not mean "auto-parallel all branches"; it should mean "no schema rewrite later, but safe
defaults now."

## Isolated Worktree Merge Protocol

Parallel workspace writes are not safe until Ling owns a merge protocol.

This protocol is future P2/P3 scope. The current scheduler should reserve interfaces for
it but keep `workspace_write`, `external_mutation`, and `release` serial by default.

### Goal

Allow multiple writing agents to work in isolated branches without corrupting the user's
workspace or silently resolving conflicts.

```text
integration base
  -> isolated worktree A / branch A / writing step A
  -> isolated worktree B / branch B / writing step B
  -> validation artifacts per branch
  -> merge coordinator
  -> rebase or cherry-pick into integration branch
  -> conflict report / approval
  -> final verification
  -> user-visible merge result
```

### Lifecycle

1. Capture integration base commit and dirty-worktree policy.
2. Create one isolated worktree per writing step.
3. Bind each step's runner to only that worktree.
4. Persist branch name, base commit, step id, run id, patch artifact id, and test artifact
   ids.
5. On branch terminal state, collect changed paths, patch, test results, and output
   packet.
6. Merge coordinator computes merge order and conflict risk.
7. Rebase/cherry-pick/apply into an integration branch, never directly into the user's
   dirty workspace.
8. Run required verification.
9. If clean, ask for approval before updating the main workspace branch when policy
   requires it.
10. If conflicted, block with conflict artifacts and user choices.

### Merge Result Packet

```ts
interface IsolatedWorktreeMergePacket {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly mergeCoordinatorStepId: string;
  readonly integrationBaseCommit: string;
  readonly integrationBranch: string;
  readonly branchResults: readonly IsolatedBranchResult[];
  readonly mergeStatus: "clean" | "conflicted" | "failed" | "approved" | "applied";
  readonly conflictArtifactIds: readonly string[];
  readonly verificationArtifactIds: readonly string[];
  readonly sourceRefs: readonly WorkflowPacketSourceRef[];
  readonly generatedAt: string;
}
```

Until this protocol is implemented, any attempt to auto-parallelize `workspace_write`
should be rejected or downgraded to serial with a visible reason.

## UI Projection

The UI model remains:

```text
ConversationTurn
  UserMessageCell
  LingAgentTranscript
    coordinator text, if useful
    OperationCell / ConversationWorkCell
      requirement shaping rows
      agent activity spans
      progress rows
      approval rows
      artifact strip
      folded evidence
    terminal coordinator text, if useful
```

No new top-level workflow page is required for the main channel experience. Existing
detail surfaces may still link to workflow evidence.

### Requirement Shaping Operation Cell

Requirement shaping is rendered as an operation cell, not as agent chat spam.

Default feed shape:

```text
Ling is shaping the request with 3 teammates

Product clarified the user goal.
Architect flagged a state-boundary risk.
QA added acceptance checks.

Decision needed: choose the safe parallel policy for QA.
Actions: Approve workflow / Edit scope / Ask follow-up / Start workflow
```

View model target:

```ts
interface RequirementShapingCellModel {
  readonly id: string;
  readonly sourceMessageId: string;
  readonly status:
    | "collecting"
    | "needs_user_decision"
    | "ready_for_workflow"
    | "converted_to_workflow"
    | "dismissed";
  readonly title: string;
  readonly coordinatorSummary: string;
  readonly participants: readonly RequirementShapingParticipantSummary[];
  readonly decisionsNeeded: readonly RequirementDecisionNeed[];
  readonly workflowPreview?: RequirementWorkflowPreview;
  readonly evidenceRefs: readonly string[];
  readonly updatedAt: string;
}

interface RequirementShapingParticipantSummary {
  readonly teammateId: string;
  readonly label: string;
  readonly roleKey: string;
  readonly contributionKind: RequirementContributionKind;
  readonly summary: string;
  readonly state: "invited" | "contributing" | "done" | "blocked" | "skipped";
  readonly packetArtifactId?: string;
}
```

Projection rules:

- show at most 3-5 participant summaries by default;
- collapse raw teammate output behind details;
- show conflicts and decision needs in the main cell because they change user action;
- show packet ids, selector ids, token budgets, and raw prompts only in advanced evidence;
- converting to workflow mutates or links the same turn instead of adding an unrelated
  card.

### Execution Operation Cell

Confirmed workflows render through the existing `ConversationWorkCell` projection:

- serial work shows the active step and folded completed rows;
- safe parallel work shows one agent span or branch row per active branch;
- approval-required work shows an approval cell and next action;
- terminal work folds into a final summary with artifacts and changed paths.

Existing per-agent operation evidence must be preserved. If the current UI shows `Docs`
with an approved file edit, generated diff artifact, check result, and evidence rows, or
`QA` with an approved shell command and bounded command output, the multi-agent
projection must keep those rows attached to the owning agent span or operation cell.
They may collapse after terminal state, but they must remain recoverable through inline
expansion in the same conversation turn. They must not be deleted, anonymized, or moved
so that any side panel is the only way to inspect them.

Runtime visibility rule:

```text
running / waiting_for_approval / blocked
  -> active agent spans stay expanded enough to show current operation evidence

succeeded / failed / cancelled
  -> agent spans may fold to summary
  -> inline expansion restores command/file/check/approval/artifact rows
```

Conversation-owned smart detail can expose:

- contribution summaries;
- workflow graph and step list;
- context/output packet summaries;
- branch/fan-in summaries;
- approvals and checkpoints;
- artifacts, changed files, and linked runs.

This detail lives inside the owning conversation turn through inline expansion,
operation/agent-span disclosure, selected artifact/file/diff preview, lightbox, or
explicit raw/debug detail. The right drawer is not a conversation evidence surface and is
not:

- a duplicate transcript;
- a raw log viewer by default;
- a place where hidden chain-of-thought is exposed;
- a second workflow state machine;
- a list of conversation attachments, links, agent operations, artifacts, checks, source
  summaries, or workflow/packet summaries.

## Evidence And Audit

Record enough evidence to debug and recover, but expose it by disclosure level.

Default feed:

- user-facing coordinator summary;
- participant summaries;
- current step/branch state;
- blockers and approvals;
- changed files and artifacts when useful.

Smart details:

- contribution packets;
- selector decisions;
- handoff intents;
- context/output packet summaries;
- branch/fan-in summaries;
- approval checkpoints;
- linked runs and artifacts.

Advanced audit:

- raw packet JSON;
- raw route metadata;
- raw run events;
- context budget section ids and dropped ids;
- packet parse diagnostics;
- provider/runner audit.

Never expose:

- chain-of-thought;
- raw private teammate memory;
- secrets, token values, credential-adjacent values;
- unredacted full logs in ordinary prompt context.

## Human-In-The-Loop Rules

Human decision is required when:

- the coordinator cannot define objective or acceptance criteria;
- specialists disagree on a scope or architecture decision that changes implementation;
- a step needs `workspace_write`, `external_mutation`, or `release`;
- QA cannot remain artifact-only;
- parallel resource conflict would change execution order or skip a branch;
- budget is exceeded or cost class changes;
- an approval is requested, denied, expired, or stale;
- an isolated worktree merge has conflicts;
- ship/deploy/external-send action is proposed.

User approval may be skipped only for deterministic, read-only, already-policy-allowed
actions. Existing approval policy still applies inside runner tool calls.

## Failure And Recovery

Failure policy must be explicit per stage.

| Failure | Required behavior |
| --- | --- |
| Missing specialist | shaping packet records skipped participant; coordinator decides whether blocked |
| Bad contribution packet | shaping blocks or proceeds without that contribution, with diagnostic evidence |
| Missing context packet | step blocks before run starts |
| Missing output packet | fan-in blocks with `missing_output_packet` diagnostic |
| Safe branch fails | apply step failure policy; fan-in cannot pretend success |
| QA writes workspace unexpectedly | block and reclassify as `workspace_write`; do not continue as artifact-only |
| Approval denied | apply `onApprovalDenied`; default block for user |
| Daemon restart | reconcile from workflow, step, run, approval, lease, and artifact state |
| Parallel sibling cancelled | cancel or block siblings according to `cancelSiblingsOnFailure` and workflow policy |
| Packet artifact unreadable | show diagnostic row; do not crash UI |

Recovery must never create a new side-effectful run after restart unless a durable policy
or explicit user action authorizes it.

## Cost And Budget

Safe parallel improves latency but can increase cost. The scheduler should account for:

- active sibling count;
- provider and runner semaphores;
- per-workflow max parallel;
- channel runtime policy;
- user or workspace budget limits;
- cost class of model/provider where available.

If budget is tight, scheduler preference order is:

1. continue already-running branches;
2. start required `analysis_readonly` blockers;
3. defer optional verification branches;
4. ask user before expensive parallel expansion.

Do not expose raw token math in the main feed. Show budget only when it changes a user
decision.

## Implementation Ownership

Target ownership:

| Area | Files / packages |
| --- | --- |
| Packet domain types | `packages/core/src/workflow-packet-types.ts` |
| API packet DTOs | `packages/contracts/src/workflow-packets.ts` |
| Packet artifact helpers | daemon channel workflow packet helpers |
| Side-effect and parallel policy metadata | core workflow/template/graph types and contracts |
| Scheduler gates | daemon `MultiAgentOrchestrator` |
| Autoplan defaults | core built-in skill pack workflow template metadata |
| Requirement shaping records | core/contracts shaping packet types, artifact helpers, Web projection |
| UI projection | Web conversation turn / work-cell projection libraries |
| Conversation evidence/detail | Web workflow evidence API, operation-cell expansion, and in-turn preview model |

Backward compatibility:

- keep existing `contextArtifactId` and `outputArtifactId` fields readable;
- support existing `ChannelWorkflowStepContextPacket` and
  `ChannelWorkflowStepOutputPacket`;
- re-export packet types from existing workflow type barrels while implementation code
  migrates to the dedicated packet files;
- add new metadata fields as optional;
- old workflows without side-effect class default to conservative serial execution unless
  the template is known safe.

Requirement shaping indexing:

- first phase does not add a requirement-shaping SQLite table or packet index;
- shaping and contribution packet bodies are JSON artifacts;
- source message, proposal, workflow, and workflow-step metadata carry artifact refs;
- the UI follows the current turn/proposal/workflow refs to load packet detail;
- add a projection index only after product requirements need cross-channel search,
  reporting, filtering by risk/decision type, or aggregate teammate contribution views.

Participant selector ownership:

- first phase uses deterministic participant selection from user intent, role signals,
  workflow graph, teammate registry, and policy metadata;
- deterministic selector output is persisted as evidence when it affects the workflow or
  shaping cell;
- model-assisted participant selection is future feature-flagged behavior only;
- model-assisted selection can suggest participants and reasons, but cannot start
  workflow steps, approve side effects, or bypass deterministic validation.

## Implementation Order

1. Add packet ref and side-effect policy contracts in core/contracts.
2. Update built-in `autoplan-lite` step metadata with side-effect class and parallel
   policy defaults.
3. Update custom workflow/template validation to require or infer conservative
   side-effect class.
4. Update orchestrator parallel gate to allow only `analysis_readonly` and verified
   `test_artifact_only` by default.
5. Add scheduler tests for safe branches, unsafe write branches, resource conflict,
   approval gate, and budget exhaustion.
6. Add requirement shaping packet helpers and projection model.
7. Render shaping discussion inside `ConversationTurn` operation cell.
8. Add inline evidence groups for shaping contributions and packet refs.
9. Add fan-in diagnostics for missing/bad packets.
10. Reserve isolated worktree merge protocol fields without enabling write parallel.

## Acceptance Criteria

- A multi-specialist requirement discussion appears as one shaping operation cell, not
  as a raw group chat.
- The user can see which specialists contributed and what decision is needed without
  seeing internal prompts.
- Existing per-agent operation rows, approvals, checks, artifacts, and bounded command
  output remain visible inline during running/waiting/blocked states and expandable inline
  after terminal states.
- Workflow packet bodies are JSON artifacts; step metadata stores refs and summaries.
- No new packet table exists in this phase.
- `design-review` and `engineering-review` can auto-run in parallel when runtime policy
  permits.
- `implementation`, external mutation, and release steps stay serial by default.
- `qa` can auto-parallelize only when artifact-only policy is satisfied.
- Fan-in reads output packets and reports missing/bad packet diagnostics.
- The main conversation exposes packet/evidence detail on demand through inline expansion
  and in-turn previews without becoming a raw transcript.
- Restart recovery does not duplicate branch starts or auto-start side-effectful work.
- Future isolated worktree merge can be added without changing packet refs, side-effect
  class, or scheduler policy shape.

## Resolved Decisions

- Use coordinator-owned selective discussion, not default all-agent chat.
- Put workflow packet types in core/contracts and packet bodies in artifacts.
- Split packet type definitions into dedicated files:
  `packages/core/src/workflow-packet-types.ts` and
  `packages/contracts/src/workflow-packets.ts`.
- Do not create a packet DB table yet.
- Do not create a requirement-shaping packet index in the first phase.
- Use deterministic participant selection in the first phase.
- Keep model-assisted participant selection behind a future feature flag.
- Build full parallel metadata now, but default auto-parallel only safe classes.
- Keep write/external/release steps serial until isolated worktree merge exists.
- Render multi-agent discussion through existing operation-cell UI.
- Keep raw audit deeper than the default conversation detail.

## Open Decisions

- Exact API route shape for requirement-shaping packet detail once Web needs direct
  loading outside the source turn/workflow context.
- The future criteria for adding a requirement-shaping projection index after cross-channel
  search or reporting becomes a real product requirement.
