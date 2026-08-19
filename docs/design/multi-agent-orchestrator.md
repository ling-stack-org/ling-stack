# Multi-Agent Orchestrator

Status: active; evidence-aware finalization, Completion Gate, approval-wait suspension,
reconnect recovery, explicit participant preservation, participant authority/profile,
and typed provider preflight exist. Explicit Node 22 transaction ownership, its fault
matrix, and the pre-S3.5 source matrix are green. The Runtime fence, closed
delegated-outcome binding, required-participant coverage, and single-terminal-publication
amendments are implemented in the active WIP and focused regressions are green. The full
Daemon/source matrix must be regenerated before fresh packaged naked-ready,
approval-resume/fan-in, and reconnect acceptance.
Last verified: 2026-08-18

## Purpose

This document defines the first automatic multi-agent orchestration engine for Ling
Stack.

The orchestrator is a Ling-owned workflow layer. It does not replace Pi. It compiles a
multi-teammate workflow template into durable workflow steps, starts each step through
the normal task/run path, waits for terminal state, then advances or blocks the workflow
through existing state machines.

Target shape:

```text
WorkflowTemplate
  -> MultiAgentOrchestrator
    -> ChannelWorkflow
      -> ChannelWorkflowStep
        -> task/run
          -> RunnerRegistry
            -> PiRunnerAdapter
              -> pi-coding-agent session
```

The first implementation should make Ling Stack capable of running a simple
product/design/architecture/implementation/QA/release workflow without asking the user
to manually start every step.

Canonical follow-up design:
[Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md) is the current
source of truth for requirement shaping, workflow packet ownership, side-effect classes,
safe parallel defaults, isolated worktree merge protocol, and the OperationCell UI
projection. If this historical orchestrator document conflicts with that design, prefer
the detailed design.

Terminal user-facing synthesis is defined by
[Ling Agent TerminalReport Protocol](ling-agent-terminal-report-protocol.md). The
orchestrator owns terminal detection and evidence, but the final user result is not the
last step `resultSummary` or a workflow-card count rollup.

## Current Implementation Status

Implemented in the first backend slice:

- `packages/daemon/src/features/channels/workflow-templates.ts` compiles the built-in
  `autoplan-lite` template into durable `ChannelWorkflow` and `ChannelWorkflowStep`
  records.
- Workflow-step `metadata_json` stores template step id, dependencies, teammate template
  id, skill id, approval gate, runner id, and provider override data.
- `POST /channels/:channelId/workflows?cwd=...` accepts `templateId` and creates the
  compiled workflow in one call.
- `packages/daemon/src/features/channels/orchestrator.ts` performs a deterministic tick:
  it starts at most one eligible step, reuses `prepareWorkflowStepStart()`, and advances
  only after a linked run reaches terminal state. For manifest-backed Continuity v2
  workflows, the active amendment further requires the shared evidence finalizer before
  that step may advance.
- `POST /workflows/:workflowId/orchestrate?cwd=...` triggers the manual tick and detached
  step run bridge.
- Steps with `approvalGate` now create `workflow_step` approval records before the run
  starts; approval decisions move workflow and step state through
  `waiting_for_approval` -> `running` or fail the workflow.
- `GET /execution-actions` exposes workflow-step approvals with workflow and step target
  refs.
- Startup recovery repairs low-level non-terminal workflow/Run state: orphaned
  claimed/running steps become blocked for explicit retry and legacy workflows may use
  aggregate repair. Manifest-backed Continuity v2 workflows are the active hardening
  slice: terminal linked Runs must pass the shared daemon finalizer/reconciler, and Core
  startup must not infer semantic success from aggregate statuses.
- The daemon test suite covers `autoplan-lite` compilation and all 8 generated steps
  progressing through the runner, including implementation/QA/ship pre-step gates.
- The Web channel runtime drawer can create and immediately start the built-in
  `autoplan-lite` workflow, manually advance an existing workflow through
  `/workflows/:workflowId/orchestrate`, cancel non-terminal workflows through
  `/workflows/:workflowId/cancel`, retry blocked steps through
  `/workflow-steps/:workflowStepId/retry`, show workflow/step status, blockers, linked
  task/run ids, and template/skill/runner/provider metadata.
- The channel activity feed shows concise workflow cards with an `Advance` action, so a
  user can continue a workflow after approval or restart recovery without manually
  starting each step.
- Succeeded workflow activity cards include a deterministic final summary rollup with
  completed step count, linked run count, artifact count, and changed-file/artifact path
  refs.

Implemented follow-up slices:

- Parallel branch scheduling and custom auto-startable templates are implemented through
  workflow graph/template metadata and the existing runtime policy budget.
- P4-P7 orchestration evidence is implemented as structured handoff intents,
  deterministic selector decisions, fan-in summary artifacts, candidate-only memory
  output, workflow evidence APIs, and Web work-cell/right-drawer drilldown.
- Model-assisted selector decisions remain a future explicit policy/feature-flag slice;
  current selector decisions are deterministic routing evidence.
- The next hardening target is not "parallel everything." It is safe parallel scheduling
  based on explicit step side-effect class and parallel policy. By default, only
  `analysis_readonly` and verified `test_artifact_only` branches should auto-parallelize;
  `workspace_write`, `external_mutation`, and `release` remain serial until the isolated
  worktree merge protocol exists.

Advanced follow-up design:

- [Orchestrator Advanced](orchestrator-advanced.md) defines the parallel branch scheduler,
  custom auto-startable template schema, fan-in packet behavior, and additional tests.
- [Channel Context Processing Layer](channel-context-processing-layer.md) defines how
  channel context is collected, filtered, compacted, and rendered into per-agent Context
  Views before Ling Agent, specialists, selectors, or workflow steps consume it.
- [Multi-Agent Orchestration Experience](multi-agent-orchestration-experience.md) defines
  the user-facing visibility boundary: live progress is visible while work runs, terminal
  work folds into compact summaries, and raw selector, handoff, and runtime evidence stays
  expandable instead of becoming default chat content.
  splits the next orchestration work into structured handoff intent, selector decisions,
  graph-defined fan-out/fan-in with memory candidates, and workflow evidence detail.
- [Channel Context Budget Manager](channel-context-budget-manager.md) defines the bounded
  Context Pack layer that should eventually assemble workflow-step prompt input under
  provider-compatible budgets.

Implemented hardening:

- [Execution And Orchestration Hardening](execution-orchestration-hardening.md) defines
  the follow-up orchestrator hardening slice. Deterministic step context packets, step
  output packets, durable failure/block policy, and post-step gates are now implemented
  for the serial workflow engine.
- [Memory Health And Multi-Agent Memory Fan-In](memory-health-and-fanin.md) defines how
  terminal workflow step outputs can become Ling memory candidates without silently
  changing active memory, teammate persona, workflow state, or approval policy.

## Original Baseline

Ling Stack already has most of the lower-level pieces:

- Built-in teammate templates for product, architect, engineer, designer, QA, security,
  release, and docs.
- Future AI Council grouping for these built-in specialists is defined in
  [AI Councils](ai-councils.md). The orchestrator should treat councils as roster and slot
  resolution evidence, not as a replacement for workflow state machines.
- Built-in skill definitions and the `gstack-default` skill pack.
- A built-in `autoplan-lite` `WorkflowTemplate`.
- Durable `ChannelWorkflow` and `ChannelWorkflowStep` records.
- Pure workflow and workflow-step state machines.
- `workflow_step` resource leases.
- Task/run execution through Pi and Ling approval policy.
- Runtime supervisor concepts for stale work, leases, cancellation, and recovery.

Before this slice, the missing piece was the automatic coordinator that takes a workflow
template and advances its steps without turning the workflow into a hidden prompt loop.

Existing channel workflow behavior is explicit and manual:

```text
handoff -> workflow -> user starts step -> task/run
```

The orchestrator adds a controlled automatic path:

```text
workflow template -> planned steps -> orchestrator starts eligible step -> task/run
```

## Goals

- Run a durable multi-teammate workflow where every step is visible and auditable.
- Reuse existing `ChannelWorkflow` and `ChannelWorkflowStep` records.
- Reuse the existing task/run coordinator for actual agent execution.
- Keep Pi as the default runner for each step.
- Make each step's teammate, skill, prompt, tools, provider, approvals, and dependencies
  explicit before execution.
- Pause at approval gates and unsafe transitions.
- Resume or reconcile safely after daemon restart.
- Keep side effects governed by existing approval policy and resource leases.
- Support the built-in `autoplan-lite` workflow before custom workflow builders.

## Non-Goals

- No free-form agent-to-agent loop.
- No hidden context transfer between teammates.
- No shared all-agent prompt history. Each teammate receives a bounded Context View for
  its role, task, and permissions.
- No runner bypass. Steps still execute through `RunnerRegistry`.
- No automatic approval of `bash`, `edit`, `write`, release, external-send, or deploy
  actions.
- No OpenClaw/ACP delegation in the first orchestrator slice.
- No Codex app-server dependency. Codex can become a runner backend later.
- No distributed workflow engine.
- No dynamic graph rewriting by the model in the first slice.
- No unsafe parallel step execution. Independent dependencies are not enough; auto
  parallel requires explicit side-effect class, parallel policy, resource, approval, and
  runtime-budget gates.

## Product Rule

The orchestrator owns sequencing, state, and audit. Runners own one execution attempt.

```text
Orchestrator decides what should run next.
Runner executes exactly one step.
State machines decide whether the transition is legal.
Approval policy decides whether risky work may proceed.
```

This boundary prevents a teammate's final message from secretly starting another agent,
changing workflow state, or approving its own side effects.

## Core Concepts

| Concept | Meaning |
| --- | --- |
| Workflow template | Static multi-step protocol from a skill pack, such as `autoplan-lite`. |
| Workflow run | A durable `ChannelWorkflow` created from a template for one channel/task/objective. |
| Workflow step | A durable `ChannelWorkflowStep` compiled from a template step. |
| Step attempt | A task/run created for one workflow step. |
| Step output | The terminal summary, artifacts, linked task/run, and selected handoff context from a step. |
| Orchestrator tick | A deterministic reconciliation pass that starts or blocks eligible next steps. |
| Gate | A point where user approval or explicit confirmation is required before continuing. |

## Workflow Template Compilation

The first compiler should accept existing `WorkflowTemplate` metadata:

```ts
interface WorkflowTemplate {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly steps: readonly WorkflowStepTemplate[];
}

interface WorkflowStepTemplate {
  readonly id: string;
  readonly name: string;
  readonly phase: SkillWorkflowPhase;
  readonly teammateTemplateId: string; // legacy fallback
  readonly councilSlotKey?: string;
  readonly skillId: string;
  readonly dependsOn?: readonly string[];
  readonly approvalGate?: SkillApprovalProfile;
}
```

When a workflow is started from an AI Council, the compiler should resolve
`councilSlotKey` through the selected council's enabled members and persist the resolved
`teammateId` into step metadata before any run starts. Missing required council slots block
workflow creation instead of falling back to a hidden model choice.

Compilation creates:

- one `ChannelWorkflow`,
- one `ChannelWorkflowStep` per template step,
- dependency metadata for each step,
- a context packet seed shared by all steps.

The existing `ChannelWorkflowStep` type is enough for the manual v1.2 flow, but automatic
orchestration needs additional durable metadata:

```ts
interface ChannelWorkflowStep {
  readonly templateStepId?: string;
  readonly dependsOnStepIds?: readonly string[];
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly autoStart?: boolean;
  readonly approvalGate?: SkillApprovalProfile;
  readonly outputArtifactIds?: readonly string[];
}
```

These fields can be added as nullable columns or as a versioned JSON metadata column.
For the first implementation, a `metadata_json` column is acceptable if typed read/write
helpers keep the rest of the code from doing ad hoc JSON parsing.

## Default Workflow: `autoplan-lite`

The first automatic workflow should use the built-in `autoplan-lite` template:

```text
product-discovery
-> product-review
-> design-review
-> engineering-review
-> implementation
-> code-review
-> qa
-> ship
```

The template already encodes dependencies:

- `product-review` depends on `product-discovery`,
- `design-review` and `engineering-review` depend on `product-review`,
- `implementation` depends on both design and engineering review,
- `code-review` and `qa` depend on implementation,
- `ship` depends on code review and QA.

The original orchestrator slice ran this serially in a deterministic order:

```text
product-discovery
product-review
design-review
engineering-review
implementation
code-review
qa
ship
```

The current target behavior keeps that order as the conservative fallback, but allows
safe parallel branches when smart scheduling proves the branches are read-only,
independent, and inside the channel runtime budget:

```text
product-discovery
-> product-review
-> design-review + engineering-review       # analysis_readonly, safe parallel
-> implementation                           # workspace_write, serial approval gate
-> code-review + qa                         # qa only when artifact-only
-> ship                                     # release, strict serial gate
```

Parallel execution must follow the side-effect and packet rules in
[Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md#safe-parallel-scheduler).
Dependency graph shape alone is not enough to auto-parallelize a step.

## Step Execution Model

Each step becomes a normal task/run.

Step start:

1. Acquire a `workflow_step` lease.
2. Transition step `queued -> claimed -> running`.
3. Resolve the exact `toParticipantId` against the canonical teammate store. Revalidate
   current availability and the operation-derived required-tool subset. For a
   manifest-backed step, reject any caller assignee override instead of reselecting.
4. Bind the teammate's `systemPrompt`, `appendSystemPrompt`, and `approvalProfile` into
   the workflow Run request. Keep tools limited to the workflow-required subset and keep
   provider/runner selection graph-owned.
5. Build a task from step prompt, context packet, previous step outputs, teammate, and
   skill.
6. Start a run through the existing run coordinator.
7. Link `taskId`, `runId`, and `workUnitId` back to the workflow step; the run request
   and run session also persist `workflowStepId` so run/thread evidence remains
   queryable by workflow-step owner. The persisted request snapshot freezes the actual
   participant prompt fragments, approval profile, tools, provider, runner, and delegated
   requirement for restart and Attempt replacement.
8. Watch the run terminal state.
9. Treat terminal Run state as a reconciliation trigger, not the step outcome:
   - a succeeded execution/verification Run must first produce verified
     `ExecutionAction` refs covering its required operation subset;
   - a succeeded synthesis/review Run must first produce a validated output packet bound
     to the same workflow, step, participant, and dependency refs;
   - a Run that ends with ordinary assistant text only becomes
     `blocked(delegated_outcome_missing)` for delegated work;
   - a failed or cancelled Run records a typed negative delegated outcome and follows the
     existing retry/failure policy.
10. Persist the typed delegated outcome and only then transition the step to its compatible
   terminal state. Step `succeeded` means its delegated requirement is satisfied, not
   merely that the runner process exited successfully.

The orchestrator must not call `PiRunnerAdapter` directly. It should always go through
the same task/run coordinator used by user-started runs.

Delegated completion follows one host-owned pipeline:

```text
terminal Run candidate
  -> reload immutable DelegatedStepRequirement
  -> verify outcome-specific durable evidence
       execution/verification -> successful ExecutionAction refs
       synthesis/review       -> sealed sourced output packet
       discussion             -> attributed committed assistant Item
       cannot continue        -> structured blocked/failed/cancelled outcome
  -> atomically commit DelegatedOutcome + compatible step transition
  -> evaluate RequiredParticipantManifest + immutable graph + fanInPolicy
  -> atomically commit WorkflowCompletionEvaluation + compatible workflow transition
```

Assistant text such as “I will execute” or delivery status `ready` is never an input to
this pipeline. An execution-backed participant must produce the required action evidence
or an explicit structured negative outcome. A no-tool synthesis participant is legal only
when it produces the sealed packet required by its immutable requirement. This is how
Ling matches the useful Codex/Claude boundary: model narration and tool/result records are
different item classes, while the host validates completion.

Fan-in reads the accepted required-participant manifest and graph, not the set of rows or
callbacks currently present. Restart may replace an Attempt under the same Run, but it
cannot remove a participant, shrink a join, or convert approval/Run success into delegated
evidence. Success is legal only after every required participant has a compatible typed
outcome and every required operation/dependency/fan-in rule verifies against canonical
rows.

### Participant identity preservation

The orchestrator consumes participant ids fixed by the accepted intent decision. It does
not select a different teammate from a role, capability, default-agent, or roster lookup
while compiling the proposal or graph. Those lookups are allowed only before the decision
manifest is committed and only when the user did not explicitly name a teammate.

```text
accepted canonical mention ids
  == decision manifest required ids
  == proposal collaboration participant ids
  == workflow metadata required ids
  == graph node participant ids
  == delegated Run participant ids
```

Equality is by canonical id, not role. Two same-role mentions remain two requirements.
An explicitly requested participant that is unavailable or lacks tools produces a typed
blocked decision/step and remains visible in the lineage; the orchestrator never repairs
that shape by substituting a peer. If more than one explicit participant is present, the
single-step compiler is ineligible. The multi-participant compiler must map all ids and
operations or fail before any Run starts.

Participant and operation ownership are immutable together. One shared daemon function
maps each accepted operation to a resolved participant and derives that participant's
required tools. The selector uses it for the decision manifest and blocker checks; the
proposal/workflow compiler consumes the same mapping. It must not maintain a second
role-based distribution algorithm.

An existing proposal is an idempotency boundary. Retry/recovery returns its original
accepted decision and manifest instead of resolving the current roster again. A proposal
whose decision/manifest lineage is missing or inconsistent produces the structured
`existing_proposal_participant_lineage_invalid` blocker and no Run. Raw exceptions and
silent participant repair are both forbidden because either can leave an accepted source
Turn without a recoverable terminal result.

The graph step also carries the immutable `WorkflowParticipantAuthorityV1` defined in
[Channel Conversation Continuity v2](channel-conversation-continuity-v2.md#participant-authority-hardening-normative).
Authority kind is explicit: `channel_selection` requires current effective Channel
membership/council validation, while `workflow_definition` requires only an active,
visible exact teammate. The compiler writes authority, participant id, graph, manifest
fingerprints, and source refs atomically. Missing/late provenance, authority/participant
mismatch, or a caller PATCH that changes the assignee is a typed blocker, never a signal
to infer authority from `sourceProposalId` absence.

### Participant execution-profile propagation

Identity preservation is necessary but not sufficient. The workflow adapter must also
carry the selected teammate's execution profile into the concrete Run. This binding is
owned by `prepareWorkflowStepStart()` rather than by the generic Run orchestrator:

```text
workflow step participant id
  -> canonical teammate lookup
  -> availability + membership + required-tool validation
  -> WorkflowStepRunRequest
       systemPrompt
       appendSystemPrompt
       approvalProfile
       exact required tools
  -> workflow approval-gate merge
  -> generic Run orchestrator
       selected Skill prompt/profile merge
       workspace + Channel permission policy
  -> immutable Run request snapshot
```

The generic Run orchestrator must not auto-hydrate every Run that happens to carry a
`teammateId`. Selector, summarizer, and report Runs use explicit internal system roles;
global hydration would mix participant persona into those control-plane prompts. The
workflow adapter is the one place shared by manual step start, automatic orchestration,
and step retry, so fixing it covers all new workflow Runs without creating another prompt
authority.

The assigned teammate's full `allowedTools` list is an authorization ceiling, not the
Run tool list. The Run receives only `step.metadata.requiredTools`, with an absent value
normalized to `[]`. The adapter validates that subset against the current teammate and
the authority-aware workflow/Channel allowances; a missing capability blocks the assigned
participant and never widens tools or substitutes another Agent.
The teammate approval profile is the base profile. One shared run-policy adapter merges
the workflow step gate, selected Skill, and session policy for manual start, automatic
orchestration, retry, approval resume, and direct step start. Merges may only keep or
increase restriction, so start-path differences cannot bypass a step gate.

The first Run creation is the profile freeze point. Same-Run approval resume and daemon
restart reuse the stored request snapshot. A user-visible retry that creates a new Run
may resolve a newer canonical teammate profile, but it records a new immutable snapshot.
Participant profile data is not copied into `RequiredParticipantManifestV1` and does not
enter `WorkflowCompletionGateV1`: the manifest owns required identity/outcome, the Run
snapshot owns actual execution configuration, and evidence owns completion.

### Participant provider binding and preflight

Provider selection is part of the execution profile, but it has its own durable owner.
The orchestrator reuses the canonical resolution contract in
[Conversation Model Binding And Creation Validation](conversation-model-binding-and-creation-validation.md#workflow-participant-model-preflight)
instead of treating an absent `providerPresetId` as an invitation to guess:

```text
exact workflow participant
  -> teammate binding mode
     -> fixed                    -> teammate provider
     -> workspace_default
        -> Ling Agent in Channel -> Channel Ling Agent model
        -> every other built-in  -> workspace default
  -> typed readiness/capability preflight
  -> graph/step effective binding snapshot
  -> immutable Run request snapshot
```

The Channel's selected Ling Agent model cannot satisfy an unconfigured Engineer or QA.
The workspace default cannot replace a broken fixed teammate binding. An ordinary Channel
message cannot supply a per-message provider override. These fail-closed rules keep model
ownership stable across private chat, Channels, retry, and restart.

Proposal confirmation preflights all required participants as one set. If any provider
binding is unresolved or unavailable, the daemon creates no workflow, Task, Run, approval,
or tool action. It preserves the accepted decision, manifest, and proposal and returns a
structured `workflow_participant_provider_unavailable` blocker that identifies the
participant, binding source, reason, and repair surface. The UI renders that blocker on
the proposal and exposes the corresponding Model Workbench, Channel Settings, or teammate
settings action.

Step start repeats readiness validation against the frozen provider id to catch deletion,
disablement, secret loss, health-check failure, or capability drift after confirmation.
It does not silently re-resolve to another scope. A repaired explicit retry may compile a
new effective binding snapshot; a same-Run daemon restart or approval resume must reuse
the original snapshot. A provider-blocked required participant remains required, so the
Completion Gate cannot call partial fan-in success.

### Single-participant normalization

An `execute` decision with one required participant is still an orchestrated workflow.
The compiler emits one manifest-backed step, and the started Run persists that step's
`workflowStepId`. It does not invoke a parallel “direct teammate completion” path.

```text
single required Agent
  -> one-entry RequiredParticipantManifestV1
  -> one-node workflow graph
  -> one linked Run
  -> shared delegated-step finalizer
  -> Completion Gate
  -> TerminalReport publication
```

A normal ready acknowledgement may be published before the Run finishes so the user sees
progress. It is not a graph output and cannot satisfy the participant requirement. The
source Turn remains non-terminal until the report publication barrier commits. A brief
post-Run reconciliation interval is allowed; terminal callback and startup recovery must
both converge it without requiring SSE reconnect or another user turn.

## Prompt Assembly

The orchestrator should construct a step packet and pass it through existing skill-aware
run fields. As the Context Budget Manager lands, this packet becomes the
`workflow_packet` Context Pack rendered into those same run fields; the state machine and
task/run coordinator should not be replaced.
The packet should be produced from the Context Processing Layer's `workflow_step_view`
instead of bespoke prompt assembly inside the orchestrator.

Step prompt inputs:

- workflow objective,
- channel id/name and bound path metadata,
- current step title and phase,
- teammate id and role,
- skill id and prompt fragments,
- acceptance criteria,
- previous terminal step summaries,
- relevant artifacts by title/path/reference only,
- active channel decisions,
- explicit user notes,
- current gate instructions.

Prompt rules:

- Previous outputs are summarized and referenced. They are not blindly pasted in full.
- Provider/model budget enforcement belongs to the Context Budget Manager. Unknown custom
  providers should receive conservative packets instead of raw long transcripts.
- Private teammate chat is not included unless the user explicitly promotes it.
- Attachment or webpage bodies are not included unless a future ingestion slice creates
  explicit artifacts.
- The model may propose next actions, but only the orchestrator can advance state.
- Terminal step outputs may create reviewable memory candidates through the memory fan-in
  pipeline, but those candidates are not injected into later steps unless normal scoped
  recall policy allows active memory use.

## State Machine

Use existing workflow statuses:

```ts
type WorkflowStatus =
  | "draft"
  | "ready"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled";
```

Use existing workflow-step statuses:

```ts
type WorkflowStepStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";
```

New orchestrator events can be represented as runtime events plus existing
state-machine transitions:

| Situation | Workflow event | Step event |
| --- | --- | --- |
| Template compiled | `prepare` | none |
| User starts workflow | `start` | none |
| Step selected | none | `claim` |
| Step run started | none | `start` |
| Step needs approval | `approval_requested` | `approval_requested` |
| Approval granted | `approval_approved` | `approval_approved` |
| Terminal Run evidence verified | none | `succeed` |
| Terminal Run lacks required delegated outcome | `step_blocked` | `blocked` |
| Step blocked | `step_blocked` | `blocked` |
| Step failed | `step_failed` | `fail` |
| Completion gate atomically verified | `all_steps_succeeded` | none |
| User cancels workflow | `cancel` | `cancel` for active/queued steps |

Do not add new statuses unless a real UI or recovery distinction requires them.

## Orchestrator Tick

The orchestrator should be tick-driven, not recursive.

```ts
interface MultiAgentOrchestrator {
  startWorkflow(input: StartWorkflowInput): Promise<ChannelWorkflow>;
  tickWorkflow(input: TickWorkflowInput): Promise<OrchestratorTickResult>;
  reconcileWorkspace(cwd: string): Promise<OrchestratorReconcileResult>;
}
```

Tick algorithm:

1. Load workflow and steps.
2. If workflow is terminal, stop.
3. Reconcile running steps with linked run/work-unit state.
4. If the workflow is using serial runtime policy, stop when any step is `blocked`,
   `failed`, `waiting_for_approval`, or `running`.
5. If the workflow is using parallel runtime policy, compute eligible queued siblings and
   filter them through side-effect class, parallel policy, approval, resource, and budget
   gates.
6. Find the first serial step or the bounded set of safe parallel siblings whose
   dependencies are satisfied.
7. Before accepting a linked Run's success, validate the step's required operation subset
   against durable `ExecutionAction` evidence and persist the evidence action ids.
   For synthesis/review steps with no required operation, persist and validate a
   `ChannelWorkflowStepOutputPacket` artifact bound to the workflow, step, participant,
   and source refs; runner prose or `resultSummary` alone is not completion evidence.
8. Validate the workflow's immutable required-participant manifest against the graph.
   Every required participant must have mapped steps and a typed delegated outcome; a
   participant cannot disappear because another Agent produced a smaller proposal.
9. Evaluate every join's declared branch set and `fanInPolicy`, including
   `requireAllBranchesTerminal`. Incoming edges in the immutable workflow graph are the
   branch authority. Materialized `dependsOnStepIds` and the set of rows currently present
   must match that graph and cannot shrink it.
10. Evaluate `WorkflowCompletionGateV1` over participant coverage, required operation
   evidence, dependencies, fan-in policy, and termination policy whenever canonical state
   changes. Commit its basis-bound snapshot plus the compatible pending, succeeded,
   blocked, failed, or cancelled workflow effect in one SQLite transaction. The expected
   read-set covers the source decision/plan, graph/termination, step/outcome bases, Run
   rows/event watermarks, approvals, artifacts, and the derived action projection
   fingerprint. A cached snapshot or only step timestamps are never sufficient.
11. If a candidate step has a pre-step approval gate, create/attach approval and set
   `waiting_for_approval`.
12. Otherwise start the step through task/run coordinator.

Run-terminal callbacks, post-step approvals, startup recovery, duplicate callbacks, and
TerminalReport pre-publication checks all invoke the same canonical-state reconciliation
kernel. None may carry a local `Run succeeded -> Step succeeded` or `all existing steps
succeeded -> Workflow succeeded` shortcut. This keeps online execution and restart
recovery behavior identical.

Serial fallback still starts one step per tick. Safe parallel policy may start multiple
siblings in one tick only when every candidate is safe and the runtime budget permits it.

## Approval Gates

There are three gate types:

| Gate | Example | Behavior |
| --- | --- | --- |
| Pre-step gate | implementation, release | Workflow waits before starting the step. |
| Tool gate | `bash`, `edit`, `write` | Existing Pi/Ling approval hook blocks before side effect. |
| Post-step gate | accept plan before build | Workflow waits after a step succeeds before next step. |

The first implementation should support:

- pre-step gates from `WorkflowStepTemplate.approvalGate`,
- post-step gates from explicit workflow step metadata,
- existing tool gates during runs.

## Failure And Blocking Rules

| Failure | Required behavior |
| --- | --- |
| Missing teammate | Step becomes `blocked`; workflow becomes `blocked`. |
| Manifest-backed assignee override | Reject with `workflow_participant_override_forbidden`; do not create Task or Run. |
| Assigned teammate profile is missing or unavailable at Run start | Commit one typed pre-Run participant blocker; do not silently fall back to a same-role Agent. |
| Required workflow tool is no longer allowed by the assigned teammate | Commit `workflow_participant_required_tools_unavailable`; do not widen tools or substitute. |
| Missing skill binding | Step becomes `blocked` with `skill_not_bound`. |
| Provider not runnable | Step becomes `blocked`; no run starts. |
| Required tool not allowed | Step becomes `blocked`; no run starts. |
| Pre-step approval denied | Step becomes `failed`; workflow becomes `failed`. |
| Run fails | Persist typed `failed`; step/workflow follow failure policy unless retry remains legal. |
| Run succeeds but required operation evidence is missing | Step becomes `blocked`; workflow cannot succeed. |
| Required command action exits non-zero, times out, or is cancelled | Step becomes `failed` or remains retryable according to existing policy. |
| Fan-in predecessor is terminal without verified required operations | Join remains blocked; downstream work does not start. |
| Required participant has no mapped graph step | Workflow is blocked with `required_participant_missing`; no partial graph may report success. |
| Delegated participant returns ordinary `ready` text only | Step remains non-terminal or becomes explicitly blocked; prose does not satisfy the participant outcome. |
| Synthesis/review participant returns a sourced durable output packet without tools | Validate packet ownership and refs; it may satisfy synthesis without fabricating an execution action. |
| Synthesis/review participant returns text but no output packet | Step remains blocked with missing delegated evidence. |
| Fan-in context is stale, private, or rejected | Manifest-backed step commits typed `blocked` through the shared finalizer; direct context blocking is legacy-only. |
| `requireAllBranchesTerminal` has an active or absent declared branch | Join remains pending/blocked and workflow success is illegal. |
| Run waits for human | Step and workflow become `waiting_for_approval` or `blocked`. |
| Daemon restarts while a participant waits for approval | Preserve the approval/checkpoint, keep the participant pending, attach a new attempt to the same Run after resolution, then reconcile evidence. |
| Daemon restarts without a safe runner checkpoint | Mark the old attempt lost and surface a typed resume blocker; do not convert infrastructure loss to user cancellation. |
| User cancels workflow | Active run is cancelled; queued steps become `cancelled`. |

The first slice should not auto-retry failed implementation or release steps. Retry should
be a user action so side effects remain understandable.

## Recovery Model

On daemon startup or explicit reconcile:

1. Expire stale workflow-step leases using existing lease recovery.
2. Recover runtime attempts before workflow semantics:
   - an explicit user/workflow cancellation remains terminal;
   - a daemon-lifecycle suspension marks only the old `WorkUnitAttempt` lost;
   - a pending `LingApprovalCheckpoint` preserves the same Run, workflow step, approval,
     participant manifest, and evidence;
   - approval resolution starts a fenced replacement attempt under that same Run through
     verified native resume or Ling continuation;
   - no safe resume produces `blocked(approval_resume_unsupported)`, never `cancelled`.
3. For each non-terminal workflow:
   - reload active steps,
   - inspect linked task/run/work-unit state,
   - revalidate operation evidence before repairing stale `running` steps whose run is
     terminal,
   - mark runner-lost steps `blocked` or `failed` according to recovery policy,
   - start no new steps unless auto-resume is enabled for the workflow.
4. Recompute participant, operation, output-packet, dependency, and fan-in completion
   from the source decision, immutable graph, current steps, actions, and approvals.
   Persisted `completionGate` metadata is an audit cache; recovery never trusts its status
   without recomputation.
5. For workflows with a committed and published TerminalReport, reconcile the persisted
   source `LingTurn` through the idempotent source-turn settlement path.
6. Append runtime events for every repair action.

Low-level Core startup recovery owns stale leases, lost Runs, and legal row transitions.
It does not complete a manifest-backed workflow from step statuses alone. After those
repairs, daemon startup invokes the same evidence-aware reconciliation kernel used by an
online terminal callback. Post-step approvals enter that same kernel after approval state
is durable, so an approval cannot stand in for execution evidence.

The kernel is split by responsibility:

- `workflow-step-finalizer.ts` reloads a step's current linked Run and immutable delegated
  requirement, verifies the outcome-specific evidence, and atomically commits the typed
  outcome plus compatible step transition against a deterministic evidence basis;
- for synthesis/review, the finalizer creates or reuses a deterministic output packet
  keyed by workflow, step, current Run terminal watermark, requirement fingerprint, and
  canonical dependency/source refs before it commits success. Restart and duplicate
  callbacks therefore reuse one packet rather than duplicating artifacts;
- `workflow-reconciliation.ts` calls that finalizer for terminal candidates, reloads the
  workflow, evaluates the graph-derived Completion Gate, and atomically persists the gate
  plus its compatible pending, succeeded, blocked, failed, or cancelled workflow effect;
- TerminalReport publication consumes the reconciler result and remains idempotent, but
  is not imported by the semantic kernel.

The Completion Gate evaluation returns both the gate and a typed expected read-set.
`ExecutionAction` stays a derived read model over Run events, approvals, artifacts, and
Run snapshots; the SQLite CAS validates those complete backing rows instead of importing
daemon projection code or adding a duplicate action table. Synthesis/review output packets
are content-addressed artifacts whose canonical JSON and SHA-256 digest are sealed in
SQLite and checked by finalization, gate evaluation, and pre-publication validation.
Negative workflow completion is not a side channel: approval denial, absent participants,
blocked evidence, failure, and cancellation pass through this same evaluation and CAS.

Callback Run ids and statuses are wake-up hints. The finalizer always follows the current
step linkage, so a callback from an old retry cannot complete a newer attempt. A stale
step/evidence basis causes reconciliation retry. It never leaves outcome metadata and
step status half-committed.

Attempt replacement caused by daemon restart is not a workflow retry. The workflow step
keeps the same `runId` and immutable delegated requirement while `activeAttemptId`
changes. Existing successful participant and operation evidence remains valid; only the
unresolved participant continues. `requireAllBranchesTerminal` therefore remains pending
through the interruption and can pass only after the resumed participant produces its
typed outcome. If resume blocks or fails, the same Completion Gate publishes the
negative/partial result; no restart-specific fan-in rule exists.

The fence is a Runtime Control Plane contract, not an orchestrator convention. Every
mutable callback carries `activeAttemptId`, `runtimeInstanceId`, and the claim-issued
`fencingToken`; Core compare-and-set rejects any tuple that is not current. Rejected
callbacks cannot append actions/evidence, consume approvals, release current leases, or
emit terminal invalidations. Daemon restart uses the typed `runtime_suspend/daemon_restart`
path and never enters generic `stale -> queued` workflow retry.

`resume_pending` is also not participant completion. If the daemon dies again, startup
classifies the bound replacement Attempt before the step finalizer runs:

- no durable `tool_start`: one newer fenced Attempt may continue the same exact approval;
- durable `tool_end`: the existing action enters normal delegated finalization;
- `tool_start` without `tool_end`: the participant becomes
  `blocked(approval_resume_effect_unknown)` and the workflow cannot verify;
- already terminal Run/outcome: only idempotent workflow/publication reconciliation runs.

Prior Engineer evidence remains valid in every case. QA does not become satisfied merely
because a replacement Attempt existed or because an approval was already granted. The
Completion Gate still requires QA's typed outcome and operation evidence, so a second
restart cannot shrink the required participant set or bypass fan-in.

Default recovery policy should be conservative:

- resume planning/review/doc steps automatically only if no side-effect tools were
  involved,
- do not auto-resume implementation, release, or external mutation steps,
- a still-pending approval continues to wait; a durable approved grant may resume only the
  same fingerprinted side effect before `tool_start`, without asking twice;
- after `tool_start` without `tool_end`, block effect-unknown and require explicit user
  resolution rather than retrying or silently issuing a new approval.

This policy has a deliberate guarantee boundary. A safe durable approval checkpoint can
resume the same Run with one replacement Attempt. A stop without such a checkpoint does
not promise automatic continuation; the work-kind policy emits
`runtime_interrupted_no_checkpoint` as a typed block/failure. A `tool_start` without a
matching `tool_end` is always effect-unknown and is never retried. These are recovery
states, not a smaller fan-in quorum and not permission to create a new Run.

## API Surface

Add orchestration endpoints after the backend contract is stable:

```http
POST /channels/:id/workflows/from-template?cwd=
POST /workflows/:id/start?cwd=
POST /workflows/:id/tick?cwd=
POST /workflows/:id/cancel?cwd=
POST /workflows/:id/retry-step?cwd=
```

Suggested request bodies:

```ts
interface CreateWorkflowFromTemplateRequest {
  readonly templateId: string;
  readonly title: string;
  readonly objective: string;
  readonly sourceTaskId?: string;
  readonly sourceMessageId?: string;
  readonly providerPresetId?: string;
  readonly idempotencyKey?: string;
  readonly autoStart?: boolean;
}

interface StartWorkflowRequest {
  readonly idempotencyKey?: string;
  readonly autoAdvance?: boolean;
}

interface TickWorkflowRequest {
  readonly reason?: "manual" | "run_terminal" | "approval_decision" | "reconcile";
}
```

The first UI can start workflows manually and use daemon-side ticks after step terminal
events. Background ticking can be added later.

## UI Surface

The UI should show orchestration as a collapsed progress record, not as every teammate
posting into chat by default.

Required surfaces:

- workflow header with objective, status, template, current step, and blocker,
- step list with teammate, skill, status, linked task/run, approval state, and summary,
- current step detail with context packet and start/cancel/retry actions,
- approval panel integration for pre-step and tool approvals,
- activity feed events for workflow start, step start, step terminal, blocked, retry,
  cancel, and success,
- final summary card with links to artifacts, tasks, runs, and changed files.

The channel chat should show a concise operation-cell projection for the workflow. It
should not become a group chat transcript unless the user expands the workflow detail.

## Data Ownership

| Data | Owner |
| --- | --- |
| Workflow template definitions | `packages/core` skill pack metadata |
| Workflow and steps | SQLite store through core workflow APIs |
| Active runtime and leases | Runtime supervisor |
| Step execution | Existing task/run coordinator |
| Runner selection | RunnerRegistry |
| Model/tool approvals | Approval policy and approval records |
| Output artifacts | Existing artifact store |
| UI summaries | Web client derived from durable records |

## Implementation Plan

### Slice 1: Template Compiler

Status: implemented for built-in `autoplan-lite`.

- Add a compiler from `WorkflowTemplate` to `ChannelWorkflow` and
  `ChannelWorkflowStep` rows.
- Add metadata for template step id, dependencies, teammate id, skill id, and gates.
- Support only built-in `autoplan-lite`.
- Do not auto-start steps yet.

### Slice 2: Manual Tick

Status: implemented as `POST /workflows/:workflowId/orchestrate?cwd=...`; each tick starts
at most one eligible step.

- Add `tickWorkflow()` that reconciles state and starts at most one eligible step.
- Route step start through existing task/run coordinator.
- Block on missing teammate, missing skill, provider readiness, or runtime conflict.
- Persist blockers and transition events.

### Slice 3: Terminal Step Reconciliation

Status: evidence-aware delegated finalization, five-state Completion Evaluation, full
canonical read-set CAS, fan-in validation, and removal of direct Run-success shortcuts are
focused green in the active Continuity v2 amendment. The full deterministic suite is
green; packaged macOS verification remains pending.

- After a linked run reaches terminal state, tick the workflow.
- Persist the immutable delegated requirement on the graph step and Run request snapshot.
- Backfill non-terminal manifest-backed steps through strict migration 115; require source
  decision, manifest, graph, dependency, and operation ownership agreement, repair a
  recorded-but-incomplete migration, and never guess terminal historical requirements.
- Extract the shared step finalizer and workflow reconciler with the one-way dependency
  direction described above.
- Store result summaries as audit/context only; store validated actions/output packets as
  completion evidence.
- Give synthesis output packets deterministic attempt-bound ids and fingerprints so the
  online, restart, and duplicate-callback paths converge on one artifact.
- Persist one compatible typed delegated outcome or visible structured blocker.
- Commit the typed outcome and step terminal transition atomically against the current
  linked Run and evidence basis; retry reconciliation after stale compare-and-set.
- Advance to the next eligible step only after the current step's delegated requirement
  is satisfied.

### Slice 4: Approval Gates

Status: implemented for backend pre-step approval gates, post-step approval gates, and
existing run/tool approval hooks.

- Add pre-step approval records for gated steps.
- Keep existing tool approval hooks inside the run.
- Show workflow/step approval state in API responses and Web workflow cards.

### Slice 5: Startup Recovery

Status: low-level backend recovery and the shared daemon semantic reconciliation kernel
are deterministic-suite green. Restart equivalence remains a required packaged macOS
acceptance gate.

- Reconcile non-terminal workflows on daemon startup.
- Repair stale active steps from linked work-unit/run state.
- Recompute typed outcomes, graph fan-in, and completion basis from canonical state; never
  trust cached gates or aggregate step statuses alone.
- Do not auto-start side-effectful steps after restart without user confirmation.

### Slice 6: Web Progress Card

Status: implemented for the first Web control surface.

- Add workflow template start entry point.
- Add collapsed workflow progress card in channel.
- Add workflow detail with steps, blockers, approvals, linked tasks/runs, and artifacts.

Current coverage:

- `Start autoplan` creates `autoplan-lite` from the selected channel and starts the first
  orchestrator tick.
- `Advance` on a workflow card calls the orchestrator tick for approval/recovery/manual
  continuation cases.
- Workflow detail lists steps, status, blocker, linked task/run ids, approval id, template
  step id, skill id, provider preset id, and requested runner id.
- Workflow cards and the channel activity feed expose explicit cancel actions for
  non-terminal workflows.
- Blocked workflow steps expose explicit retry actions that restart through the normal
  task/run coordinator.
- Succeeded workflow activity cards show a deterministic final summary with linked runs,
  artifacts, step summaries, and changed-file/artifact path refs.
- Workflow step cards show context/output packet artifact chips plus policy and gate
  detail rows.

## Test Plan

Core:

- `autoplan-lite` compiles into expected workflow steps.
- Missing template/step references fail with clear errors.
- Dependency metadata round-trips.
- Workflow and step transitions reject stale updates.

Daemon:

- Create workflow from template.
- Manual tick starts one eligible step.
- Tick does not start a dependent step before prerequisites succeed.
- Gated steps create `workflow_step` approvals and do not start until approved.
- Denied or expired pre-step approvals fail the step/workflow before any runner starts.
- Denied pre/post approvals follow durable `onApprovalDenied` policy.
- Provider/preflight failures block the step without creating a run.
- Terminal successful run advances only after the delegated requirement and evidence
  class validate on the next tick.
- Failed run fails or blocks the workflow according to policy.
- Run cancellation blocks or fails according to policy; workflow cancellation cancels
  active run, queued steps, and pending approvals.
- `skip_if_optional` marks the failed step skipped and allows a later orchestrator tick to
  start downstream steps.
- Startup reconcile repairs stale running steps.
- Daemon shutdown at a pending tool approval marks only the old attempt lost; the Run,
  approval checkpoint, workflow step, manifest, and prior participant evidence persist.
- Approval resolution after restart creates one fenced replacement attempt under the
  same Run and feeds its evidence through the same delegated finalizer and Completion
  Gate.
- Startup recovers `resume_pending` before Attempt creation and before `tool_start`
  without duplicating the approved side effect.
- Startup with `tool_start` but no `tool_end` blocks the required participant as
  `approval_resume_effect_unknown`; it never retries or verifies fan-in.
- Startup with a durable `tool_end` completes delegated finalization and fan-in without
  executing the action again.
- A second daemon suspension preserves pre-dispatch resume state; a real timeout fails
  the participant and never becomes cancellation.
- Explicit user/workflow cancellation still cancels the Run and approval; timeout and
  runtime shutdown cannot produce a false `local-user` cancellation.
- Online callback, post-step approval, startup recovery, duplicate callback, and
  pre-publication validation produce the same step/workflow result from the same rows.
- A terminal no-tool promise reply produces one structured blocker, never step success.

Runner integration:

- Step Run receives the exact selected teammate's base/append prompts and base approval
  profile before selected Skill and session-policy merging.
- The persisted Run request snapshot records teammate id, workflow step id, delegated
  requirement, prompt fragments, approval profile, exact required tools, provider, and
  runner; same-Run restart/resume reuses those values.
- Step Run uses only workflow-required tools even when the teammate allows more tools.
- Manual start, automatic orchestration, and retry all pass through the same participant
  profile resolver; internal selector/report Runs are unaffected.
- Side-effect tools still require existing approval hooks.
- Runner final events cannot advance workflow without legal state transitions.
- Runner `succeeded` cannot advance a step without verified required operation evidence.
- Engineer-write -> QA-command fan-in does not advance when either action is missing,
  failed, timed out, cancelled, targets the wrong file, or violates dependency order.

Web:

- Start template workflow from channel.
- See current step and blocked state.
- Approve pre-step or tool gate.
- Continue after approval or recovery by pressing `Advance`.
- Retry a blocked step through existing blocked-step start behavior.
- Cancel workflow.
- Expand final summary and linked run/artifacts.

Regression:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm typecheck
git diff --check
```

## Relationship To Existing Designs

- [AI Teammates and Skills](ai-teammates-and-skills.md) defines teammate, skill, and
  workflow template metadata.
- [Conversation Surface Contract](./conversation-surface-contract.md) defines manual workflow and
  workflow-step records that this orchestrator reuses.
- [State Machines and Recovery](state-machine-recovery.md) defines legal workflow,
  workflow-step, task, run, approval, and work-unit transitions.
- [Runtime Supervisor](runtime-supervisor.md) owns leases, heartbeat, stale detection,
  and startup recovery.
- [Runner Registry](runner-registry.md) owns runner backend resolution for each step.
- [Pi Coding Agent Integration](../pi-coding-agent-integration.md) remains the default
  single-step execution backend.

## Resolved Questions And Future Optimizations

Resolved by the detailed design:

- Built-in `autoplan-lite` remains the default first auto-startable workflow shape.
- Failed planning/review steps block for user decision by default; implementation,
  external mutation, and release failures do not auto-retry without user action.
- `design-review` and `engineering-review` may auto-parallelize as `analysis_readonly`
  steps when runtime policy permits.
- Post-step gates should be explicit template or graph metadata.
- Workflow summaries start deterministic and source-linked; model-generated summaries are
  allowed only as evidence-backed additions.

Non-blocking future optimizations:

- Grouped workflow packet refs may move to a dedicated type file when that reduces an
  actually measured module-boundary cost; the current ownership contract is already fixed.
- Requirement-shaping packet search gets a SQLite index only after query-plan or packaged
  latency evidence shows the current access path is material.
