# Channel Workspace v1.2 Design and Implementation Plan

## Status

Implemented v1.2 slice after the channel workspace MVP and v1.1 protocol records.

This document is scoped to handoff-driven workflows. The broader channel source of
truth remains [Channel Workspace Design](channel-workspace.md).

## Summary

v1.1 made collaboration protocol state visible: Channel Brief, decisions, handoffs, and
context summaries. v1.2 turns a handoff into the smallest durable workflow execution
unit without building a fully automatic multi-agent runtime.

The product rule is:

```text
v1.2 lets a user start and track a handoff workflow.
It does not automatically chain agents, ingest file/webpage bodies, or self-approve work.
```

All execution remains local-first and must use the existing task/run coordinator,
provider preflight, approval policy, runtime leases, and state transition events.

## Product Goals

- Let a handoff become an executable workflow when the user explicitly starts it.
- Show who owns each next step, what context is being used, and where execution is
  blocked.
- Preserve task/run/approval boundaries instead of making workflow steps a hidden side
  channel.
- Keep workflow state auditable through `workflow` and `workflow_step` transition
  events.
- Keep v1.1 records readable even when a workflow is cancelled, blocked, or failed.

## Non-Goals

- No automatic multi-agent loop or background scheduler for the next step.
- No custom workflow builder.
- No attachment, Office, PDF, image, or webpage body ingestion into AI context.
- No notification persistence.
- No cross-channel workflows.
- No bypass of approval, provider readiness, runtime locks, or task/run state machines.

## User Workflows

### 1. Start Workflow From Handoff

```text
open channel
-> inspect Handoffs
-> click Start workflow on a handoff
-> daemon creates workflow + first queued step
-> Runtime inspector shows the workflow queue
```

Starting a workflow does not start a run. It only creates durable workflow records and
prepares the first step for explicit user action.

### 2. Start Step As Task

```text
open workflow step
-> inspect context packet
-> click Start step
-> choose create_task
-> task is created with workflow/step source metadata
-> step links to the task
```

This path is for planning, review, QA, or documentation handoffs where the user wants to
inspect or edit the created task before running it.

### 3. Start Step And Run

```text
open workflow step
-> inspect context packet
-> click Start step
-> choose create_and_run_task
-> daemon creates task
-> daemon starts run through the existing coordinator
-> step links to task and run
```

If provider readiness, channel status, approval policy, or runtime locks block execution,
the step becomes `blocked` and exposes a user-visible blocker. The workflow record
stays available for recovery.

### 4. Block, Resume, Skip, Or Cancel

```text
step blocked
-> user fixes provider/runtime/input issue
-> user retries or resumes step
```

Skipping or cancelling a step only changes workflow state. It must not mutate a linked
task/run into a terminal state.

## Public Interfaces

Add shared contract/core types:

- `ChannelWorkflow`
- `ChannelWorkflowStep`
- `CreateChannelWorkflowRequest`
- `UpdateChannelWorkflowRequest`
- `CreateChannelWorkflowStepRequest`
- `UpdateChannelWorkflowStepRequest`
- `StartChannelWorkflowStepRequest`
- list/mutation response types for workflows and workflow steps

Use existing state-machine status names:

- Workflow: `draft`, `ready`, `running`, `waiting_for_approval`, `blocked`, `succeeded`,
  `failed`, `cancelled`
- Workflow step: `queued`, `claimed`, `running`, `waiting_for_approval`, `blocked`,
  `succeeded`, `failed`, `skipped`, `cancelled`

Add daemon routes:

```http
GET /channels/:id/workflows?cwd=&status=&limit=
POST /channels/:id/workflows?cwd=
GET /workflows/:id?cwd=
PATCH /workflows/:id?cwd=
POST /handoffs/:id/workflow?cwd=
GET /workflows/:id/steps?cwd=
POST /workflows/:id/steps?cwd=
PATCH /workflow-steps/:id?cwd=
POST /workflow-steps/:id/start?cwd=
```

`POST /workflow-steps/:id/start` supports:

- `create_task`: create a task from the step context and link it to the step.
- `create_and_run_task`: create the task, then start a run through the existing
  coordinator.

## Data Model

### Channel Workflow

```ts
interface ChannelWorkflow {
  id: string;
  workspaceId: string;
  channelId: string;
  sourceHandoffId?: string;
  title: string;
  objective: string;
  status: WorkflowStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

### Channel Workflow Step

```ts
interface ChannelWorkflowStep {
  id: string;
  workspaceId: string;
  channelId: string;
  workflowId: string;
  sourceHandoffId?: string;
  contextSummaryId?: string;
  taskId?: string;
  runId?: string;
  position: number;
  title: string;
  prompt: string;
  toParticipantId: string;
  toParticipantLabel: string;
  status: WorkflowStepStatus;
  blocker?: string;
  resultSummary?: string;
  createdAt: string;
  updatedAt: string;
}
```

Rules:

- `sourceHandoffId`, `contextSummaryId`, `taskId`, and `runId` must belong to the same
  channel when present.
- Step position is monotonically assigned within a workflow.
- Workflow and step mutations must use legal state-machine transitions.
- Step start must acquire a `workflow_step` lease and release it on terminal state or
  start failure.

## Context Packet

The Web UI should show the context packet before a step starts:

- Channel Brief fields.
- Active decisions.
- Source handoff.
- Linked context summary.
- Selected message ids or summary source message ids.
- Attachment and link preview metadata only.

The packet is visible product state, not hidden prompt memory. v1.2 does not read file
contents or webpage bodies.

## Web UX Plan

- Runtime inspector adds a Workflow queue section.
- Handoff cards add `Start workflow`.
- Workflow detail shows status, source handoff, and step list.
- Step cards show participant, status, blocker, linked task/run, and context packet.
- Step actions: `Start step`, `Skip`, `Cancel`; blocked steps can be retried after user
  fixes the blocker.
- Activity synthesizes workflow and step events alongside messages, decisions, handoffs,
  and context summaries. Tasks, runs, approvals, and artifacts remain available through
  the existing task/run surfaces.
- Task detail shows source workflow/step when present.

Keep existing channel selectors stable, including `.channel-options`,
`article.task-detail`, and `Task inspector`.

## Implementation Plan

### Phase 1: Contracts And Store

- Add workflow/step contract and core types.
- Add SQLite tables, indexes, and old-database self-healing.
- Add store CRUD and transition helpers for workflow and workflow step status changes.
- Validate same-channel source references.
- Add `workflow_step` lease handling for step start.

### Phase 2: Daemon API

- Add workflow and workflow-step route parsing and handlers.
- Implement `POST /handoffs/:id/workflow` to create workflow + initial queued step.
- Implement step start for `create_task` and `create_and_run_task` through existing
  task/run coordinator paths.
- Return displayable blockers for provider/runtime/preflight failures.
- Ensure skip/cancel only affect workflow state and do not mutate linked task/run
  terminal states.

### Phase 3: API Client And Web Data Flow

- Add API client methods and tests for routes, query params, and bodies.
- Load workflows and steps by selected channel.
- Refresh workflow data after handoff start, step start, skip, cancel, and task/run
  mutations.
- Keep existing messages, files, tasks, and v1.1 protocol loaders unchanged.

### Phase 4: Web UI

- Add Runtime workflow queue.
- Add Start workflow action to Handoff UI.
- Add workflow detail and step controls inside the channel workbench.
- Add context packet rendering.
- Add Activity and Task detail integration.

### Phase 5: Docs And Tracker

Implemented notes:

- SQLite persists `channel_workflows` and `channel_workflow_steps` with migration
  self-healing for older workspaces.
- `POST /handoffs/:id/workflow` creates a draft workflow and first queued step.
- `POST /workflow-steps/:id/start` supports `create_task` with JSON response and
  `create_and_run_task` through the existing SSE run coordinator.
- Runtime inspector renders the workflow queue, context packet metadata, blockers,
  linked task/run ids, and step controls.
- Task detail displays the source workflow/step when a task was created by a workflow
  step.
- v1.2 keeps attachment/link content out of AI context; only visible metadata appears
  in the context packet.

- [x] Update `docs/daemon-api.md`.
- [x] Update `docs/design/web-ui-v0.1.md` for user-visible Web behavior.
- [x] Update `docs/design/channel-workspace.md` tracker.

## Test Plan

Core/store:

- Workflow and step round-trip.
- Handoff creates workflow + first queued step.
- Legal state transitions persist transition events.
- Illegal/stale transitions are rejected.
- Same-channel source validation rejects cross-channel references.
- Old SQLite databases self-heal workflow tables.
- `workflow_step` lease blocks duplicate step start.

Daemon:

- New workflow/step CRUD endpoints.
- `POST /handoffs/:id/workflow`.
- `POST /workflow-steps/:id/start` for `create_task` and `create_and_run_task`.
- Provider/runtime failure blocks the step with a visible blocker.
- Step skip/cancel does not mutate linked task/run terminal status.
- Cross-channel source references are rejected.

API client:

- Route, query, and body mapping for every new endpoint.

Web:

- Start workflow from handoff.
- Runtime inspector shows workflow queue.
- Step start creates a task.
- Step start + run routes through existing task/run UI.
- Blocked step shows blocker.
- Activity shows workflow/step timeline items.
- Task detail shows source workflow/step.

Regression:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web exec playwright test
corepack pnpm typecheck
git diff --check
```
