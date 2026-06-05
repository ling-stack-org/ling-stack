# Multi-Agent Orchestrator

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
  only after a linked run reaches terminal state.
- `POST /workflows/:workflowId/orchestrate?cwd=...` triggers the manual tick and detached
  step run bridge.
- Steps with `approvalGate` now create `workflow_step` approval records before the run
  starts; approval decisions move workflow and step state through
  `waiting_for_approval` -> `running` or fail the workflow.
- `GET /execution-actions` exposes workflow-step approvals with workflow and step target
  refs.
- Startup recovery now reconciles non-terminal workflows from durable linked run state:
  terminal linked runs complete/fail their steps, orphaned claimed/running steps become
  blocked for explicit retry, and safe aggregate workflow state is repaired on store
  startup.
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

Still pending:

- Parallel branches and custom auto-startable templates.

Advanced follow-up design:

- [Orchestrator Advanced](orchestrator-advanced.md) defines the parallel branch scheduler,
  custom auto-startable template schema, fan-in packet behavior, and additional tests.

Implemented hardening:

- [Execution And Orchestration Hardening](execution-orchestration-hardening.md) defines
  the follow-up orchestrator hardening slice. Deterministic step context packets, step
  output packets, durable failure/block policy, and post-step gates are now implemented
  for the serial workflow engine.

## Original Baseline

Ling Stack already has most of the lower-level pieces:

- Built-in teammate templates for product, architect, engineer, designer, QA, security,
  release, and docs.
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
- No runner bypass. Steps still execute through `RunnerRegistry`.
- No automatic approval of `bash`, `edit`, `write`, release, external-send, or deploy
  actions.
- No OpenClaw/ACP delegation in the first orchestrator slice.
- No Codex app-server dependency. Codex can become a runner backend later.
- No distributed workflow engine.
- No dynamic graph rewriting by the model in the first slice.
- No parallel step execution in the first slice, even if the template has independent
  dependencies.

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
  readonly teammateTemplateId: string;
  readonly skillId: string;
  readonly dependsOn?: readonly string[];
  readonly approvalGate?: SkillApprovalProfile;
}
```

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

The first orchestrator slice should still run this serially in a deterministic order:

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

Parallel execution can come later after the scheduler, artifact merge, and approval UX
are proven.

## Step Execution Model

Each step becomes a normal task/run.

Step start:

1. Acquire a `workflow_step` lease.
2. Transition step `queued -> claimed -> running`.
3. Build a task from step prompt, context packet, previous step outputs, teammate, and
   skill.
4. Start a run through the existing run coordinator.
5. Link `taskId`, `runId`, and `workUnitId` back to the workflow step; the run request
   and run session also persist `workflowStepId` so run/thread evidence remains
   queryable by workflow-step owner.
6. Watch the run terminal state.
7. Transition the step:
   - `succeeded` if the run succeeded,
   - `failed` if the run failed,
   - `blocked` if the run is waiting on a human or preflight blocker,
   - `cancelled` if the workflow or step was cancelled.

The orchestrator must not call `PiRunnerAdapter` directly. It should always go through
the same task/run coordinator used by user-started runs.

## Prompt Assembly

The orchestrator should construct a step packet and pass it through existing skill-aware
run fields.

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
- Private teammate chat is not included unless the user explicitly promotes it.
- Attachment or webpage bodies are not included unless a future ingestion slice creates
  explicit artifacts.
- The model may propose next actions, but only the orchestrator can advance state.

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
| Step blocked | `step_blocked` | `blocked` |
| Step failed | `step_failed` | `fail` |
| All required steps done | `all_steps_succeeded` | none |
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
4. If any step is `blocked`, `failed`, `waiting_for_approval`, or `running`, stop.
5. Find the first queued step whose dependencies are all terminal-success states.
6. If no queued steps remain, transition workflow to `succeeded`.
7. If the next step has a pre-step approval gate, create/attach approval and set
   `waiting_for_approval`.
8. Otherwise start the step through task/run coordinator.

The first slice should run one step per tick. After a step reaches terminal state, a new
tick can start the next step.

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
| Missing skill binding | Step becomes `blocked` with `skill_not_bound`. |
| Provider not runnable | Step becomes `blocked`; no run starts. |
| Required tool not allowed | Step becomes `blocked`; no run starts. |
| Pre-step approval denied | Step becomes `failed`; workflow becomes `failed`. |
| Run fails | Step becomes `failed`; workflow becomes `failed` unless retry policy allows retry. |
| Run waits for human | Step and workflow become `waiting_for_approval` or `blocked`. |
| Daemon restarts mid-step | Reconcile linked work unit/run and resume from durable state. |
| User cancels workflow | Active run is cancelled; queued steps become `cancelled`. |

The first slice should not auto-retry failed implementation or release steps. Retry should
be a user action so side effects remain understandable.

## Recovery Model

On daemon startup or explicit reconcile:

1. Expire stale workflow-step leases using existing lease recovery.
2. For each non-terminal workflow:
   - reload active steps,
   - inspect linked task/run/work-unit state,
   - repair stale `running` steps whose run is terminal,
   - mark runner-lost steps `blocked` or `failed` according to recovery policy,
   - start no new steps unless auto-resume is enabled for the workflow.
3. Append runtime events for every repair action.

Default recovery policy should be conservative:

- resume planning/review/doc steps automatically only if no side-effect tools were
  involved,
- do not auto-resume implementation, release, or external mutation steps,
- require user confirmation for any step that previously reached approval or side-effect
  execution.

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

The channel chat should show a concise workflow card. It should not become a group chat
transcript unless the user expands the workflow detail.

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

Status: implemented for successful and failed linked runs; successful terminal runs
continue the next eligible step.

- After a linked run reaches terminal state, tick the workflow.
- Store result summaries and artifact references on the step.
- Advance to next eligible step only when the current step succeeded.

### Slice 4: Approval Gates

Status: implemented for backend pre-step approval gates, post-step approval gates, and
existing run/tool approval hooks.

- Add pre-step approval records for gated steps.
- Keep existing tool approval hooks inside the run.
- Show workflow/step approval state in API responses and Web workflow cards.

### Slice 5: Startup Recovery

Status: implemented for backend store startup recovery.

- Reconcile non-terminal workflows on daemon startup.
- Repair stale active steps from linked work-unit/run state.
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
- Terminal successful run advances the workflow on next tick.
- Failed run fails or blocks the workflow according to policy.
- Run cancellation blocks or fails according to policy; workflow cancellation cancels
  active run, queued steps, and pending approvals.
- `skip_if_optional` marks the failed step skipped and allows a later orchestrator tick to
  start downstream steps.
- Startup reconcile repairs stale running steps.

Runner integration:

- Step run uses selected teammate, skill prompt fragments, required tools, approval
  profile, memory recall, provider preset, and runner id.
- Side-effect tools still require existing approval hooks.
- Runner final events cannot advance workflow without legal state transitions.

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
- [Channel Workspace v1.2](channel-workspace-v1.2.md) defines manual workflow and
  workflow-step records that this orchestrator reuses.
- [State Machines and Recovery](state-machine-recovery.md) defines legal workflow,
  workflow-step, task, run, approval, and work-unit transitions.
- [Runtime Supervisor](runtime-supervisor.md) owns leases, heartbeat, stale detection,
  and startup recovery.
- [Runner Registry](runner-registry.md) owns runner backend resolution for each step.
- [Pi Coding Agent Integration](../pi-coding-agent-integration.md) remains the default
  single-step execution backend.

## Open Questions

- Should `autoplan-lite` be the only auto-startable template at first, or should users
  be able to mark custom templates as auto-startable after review?
- Should failed planning/review steps block for user decision instead of failing the
  whole workflow?
- Should design review and engineering review become parallel once the serial version is
  stable?
- Should post-step gates be template metadata or derived from skill state effects?
- Should workflow summaries be model-generated, deterministic, or both with approval?

Recommended defaults:

- Only `autoplan-lite` is auto-startable in the first slice.
- Failed planning/review steps block, while failed implementation/release steps fail the
  workflow unless the user retries.
- Keep all execution serial until recovery and UI are proven.
- Use explicit post-step gate metadata.
- Start with deterministic summaries plus links to run artifacts.
