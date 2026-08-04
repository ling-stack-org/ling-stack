# State Machines and Recovery

Ling Stack must treat task, run, approval, media job, and multi-teammate workflow state as durable product state, not as UI labels or transient runner memory.

This matters before multi-agent orchestration. Once several AI teammates, channels, providers, and approval gates can operate at the same time, plain status fields are not enough. The system needs explicit state machines so it can survive network drops, browser refreshes, daemon restarts, duplicate requests, and interrupted approval waits.

Related docs:

- [Conversation Surface Contract](conversation-surface-contract.md)
- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
- [Multi-Agent Orchestrator](multi-agent-orchestrator.md)

Operation-cell collaboration projections are product read models over these state machines. They may
derive compact states such as `shaping`, `running`, `waiting_for_approval`, or
`completed`, but they must not bypass workflow, step, run, approval, or lease transition
rules.

## Goals

- Prevent two agents from claiming or completing the same work item inconsistently.
- Make run, task, approval, media job, and workflow transitions legal by construction.
- Keep every state transition auditable through persisted events.
- Recover safely after daemon restart, network disconnect, browser refresh, or runner failure.
- Support future gstack-style and custom multi-role protocols without hard-coding one workflow.

## Current State

The current code now has the first durable transition layer:

- `TaskStatus`: `todo`, `claimed`, `running`, `blocked`, `review`, `done`, `failed`, `cancelled`.
- `RunStatus`: `queued`, `running`, `waiting_for_approval`, `succeeded`, `failed`, `cancelled`.
- `ApprovalStatus`: `pending`, `approved`, `denied`, `expired`, `cancelled`.
- `MediaJobStatus`: `queued`, `running`, `waiting_for_approval`, `succeeded`, `failed`, `cancelled`.
- `packages/core/src/state-machines.ts` centralizes legal transitions for task, run, approval, media job, workflow, and workflow step.
- SQLite persists `state_transition_events` for task and run transitions used by the daemon runner path.
- SQLite persists `resource_leases` for task, channel, bound path, workspace, provider, and workflow-step locks.
- `GET /state-transitions` and `GET /runtime/leases` expose read-only debugging timelines.

The remaining migration work is to route every approval and media-job status write through the same transition event table. The runner path already uses compare-and-set for task/run state, and cancellation releases active leases so late runner success cannot overwrite a cancelled run.

The orchestration hardening baseline is also implemented:

- stale runner completion is audited and cannot overwrite a newer terminal state;
- requested/effective runner and explicit fallback policy are persisted and inspectable;
- approval previews and tool result artifacts remain linked by stable run/tool-call identity;
- resume preview and execution share one deterministic context builder;
- workflow context/output packets are durable run artifacts referenced by step metadata;
- failure policy and post-step gates pause or continue downstream work through existing durable approvals.

These are state-machine guarantees, not a second workflow engine. Future changes must preserve compare-and-set,
idempotency, recovery, and approval ownership.

## Required State Machines

### Task

Tasks represent user-visible work items.

Allowed baseline transitions:

| From | Event | To |
| --- | --- | --- |
| `todo` | `claim` | `claimed` |
| `claimed` | `start_run` | `running` |
| `running` | `run_succeeded` | `done` |
| `running` | `run_failed` | `failed` |
| `running` | `run_waiting_for_human` | `blocked` |
| `blocked` | `human_resolved` | `claimed` |
| `failed` | `retry` | `claimed` |
| `review` | `accept` | `done` |
| non-terminal | `cancel` | `cancelled` |

Terminal states are `done` and `cancelled`. Failed tasks can be retried only by an explicit retry event.

### Run

Runs represent one execution attempt by one AI teammate or runner.

Allowed baseline transitions:

| From | Event | To |
| --- | --- | --- |
| `queued` | `runner_started` | `running` |
| `running` | `approval_requested` | `waiting_for_approval` |
| `waiting_for_approval` | `approval_approved` | `running` |
| `waiting_for_approval` | `approval_denied` | `failed` |
| `waiting_for_approval` | `approval_expired` | `failed` |
| `running` | `runner_succeeded` | `succeeded` |
| `running` | `runner_failed` | `failed` |
| non-terminal | `cancel` | `cancelled` |

Terminal states are `succeeded`, `failed`, and `cancelled`. A terminal run must never return to `running`.

### Approval

Approvals are human decision points. They must be idempotent because the UI, CLI, or daemon can retry decision requests.

Allowed baseline transitions:

| From | Event | To |
| --- | --- | --- |
| `pending` | `approve` | `approved` |
| `pending` | `deny` | `denied` |
| `pending` | `expire` | `expired` |
| `pending` | `cancel_owner` | `cancelled` |

All resolved approval states are terminal.

### Media Job

Media jobs are async work items. The approval transitions below are legacy compatibility
states for older `media_cost` records; new media runs execute after generation runtime
readiness checks without creating media approvals.

Allowed baseline transitions:

| From | Event | To |
| --- | --- | --- |
| `queued` | `cost_approval_required` | `waiting_for_approval` |
| `waiting_for_approval` | `approval_approved` | `queued` |
| `waiting_for_approval` | `approval_denied` | `failed` |
| `waiting_for_approval` | `approval_expired` | `failed` |
| `queued` | `adapter_started` | `running` |
| `running` | `adapter_succeeded` | `succeeded` |
| `running` | `adapter_failed` | `failed` |
| non-terminal | `cancel` | `cancelled` |

Terminal states are `succeeded`, `failed`, and `cancelled`.

### Workflow

Workflows coordinate multiple AI teammates and protocols.

Suggested baseline status:

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

Workflow steps should reference an AI teammate, a prompt template, provider defaults, allowed tools, approval gates, and dependency rules. A gstack-style protocol and a user-defined protocol should both compile into this structure.

## Concurrency Rules

State transitions must be compare-and-set operations:

```ts
transitionRun({
  id: runId,
  expectedStatus: "running",
  event: "runner_succeeded",
});
```

The store should reject stale transitions when the current state no longer matches the expected state. This protects against races such as:

- a cancelled run later reporting success,
- two agents claiming the same task,
- an approval being approved twice,
- retry and cancellation arriving in the wrong order.

For SQLite, this means updates should use predicates:

```sql
UPDATE runs
SET status = ?, updated_at = ?
WHERE id = ? AND status = ?;
```

If `changes === 0`, the caller must reload the row and decide whether the event is duplicate, stale, or invalid.

## Resource Leases

The channel coordinator must acquire leases before it creates or starts a run.

Current lease types:

```ts
type ResourceType =
  | "channel"
  | "bound_path"
  | "workspace"
  | "provider"
  | "task"
  | "workflow_step";
```

Rules:

- Starting a task run always locks `task:<taskId>`.
- A serial channel locks `channel:<channelId>`.
- A run with `bash`, `edit`, or `write` locks the channel policy scope:
  - `boundPath`: canonical real path for the bound repo.
  - `channel`: current channel only.
  - `workspace`: whole local workspace.
- Terminal run states release active leases.
- Daemon startup expires stale active leases before accepting new work.

The `resource_leases` table has a unique active lease index:

```sql
CREATE UNIQUE INDEX idx_active_resource_lease
ON resource_leases(workspace_id, resource_type, resource_key)
WHERE status = 'active';
```

This is local SQLite coordination, not a distributed lock. v0.1 is single-user and single-daemon.

## Idempotency

Every external command that can be retried needs an idempotency key.

Examples:

- `run_request_id`
- `approval_decision_id`
- `workflow_step_attempt_id`
- `media_execution_id`

The state machine should treat duplicate events with the same idempotency key as safe no-ops when the previous result is already persisted.

## Recovery Model

After daemon restart, Ling Stack should rebuild active state from durable records:

| Durable state | Recovery action |
| --- | --- |
| `run.running` with no active runner | mark `failed` or `cancelled` with `runner_lost` reason, unless resumable runner support exists |
| `run.waiting_for_approval` | keep waiting, expire when `expiresAt` passes |
| `task.running` pointing to terminal run | reconcile task to `done`, `failed`, or `cancelled` |
| `approval.pending` past expiry | transition to `expired` and append decision event |
| `media_job.running` with no active adapter | mark `failed` with `adapter_lost` unless provider polling can recover |
| `workflow.running` with blocked step | move workflow to `blocked` or resume the step according to protocol |
| `resource_lease.active` past expiry | mark `expired` and reconcile the owning run/task |

Browser refresh and SSE disconnect must not imply cancellation. The client should reconnect and query durable state. Explicit cancellation must use a cancel API.

### Daemon Lifecycle Boundary

The P0 daemon lifecycle commands in [Daemon Lifecycle and Doctor P0](daemon-lifecycle-p0.md)
are process controls, not recovery engines:

- `ling-stack daemon stop` signals a Ling-managed daemon process and refuses to stop
  active work by default.
- `ling-stack daemon stop --force` and `ling-stack daemon restart --force` are explicit
  operator actions. They may cause active runner attempts to be lost, but they still do
  not rewrite durable task, run, approval, lease, or semaphore rows directly.
- Durable recovery after restart remains owned by the runtime supervisor and these state
  machines. Startup recovery reconciles lost attempts, stale leases, pending approvals,
  and terminal task/run mismatches from persisted records.
- Doctor is read-only. It may report stale pid files, stale listeners, active leases,
  stuck work, and recovery risks, but it must not expire leases, cancel runs, or repair
  SQLite state.

This split keeps lifecycle commands scriptable without creating a second state mutation
path beside compare-and-set transitions.

## Event Log Contract

Every accepted transition should emit a durable event:

```ts
interface StateTransitionEvent {
  id: string;
  entityType: "task" | "run" | "approval" | "media_job" | "workflow" | "workflow_step";
  entityId: string;
  from: string;
  to: string;
  event: string;
  reason?: string;
  actor: "system" | "local-user" | "ai-teammate" | "runner" | "provider";
  idempotencyKey?: string;
  createdAt: string;
}
```

The UI should render these transitions as timeline facts. The daemon should use them to diagnose hangs, stale waits, and recovery decisions.

## Integration With AI Teammate Protocols

AI teammate protocols should not bypass the state machines.

The protocol layer decides:

- which teammate should run next,
- which skill should frame the work,
- which prompt template to use,
- which tools are allowed,
- which approval gates apply,
- whether the workflow should continue automatically or ask the user.

The state machine decides:

- whether the next transition is legal,
- whether the state is terminal,
- whether a retry is safe,
- whether the event is stale or duplicated.

This split lets Ling Stack support:

- built-in engineering teammates,
- gstack-style role packs,
- skill packs such as `gstack-default`,
- AGENTS.md semi-automated protocols,
- custom user-defined workflows,
- future external agent connectors.

Skills are workflow templates. They can request tools, provider capabilities, approval profiles, and state effects, but they must never mutate state directly. A workflow step can only advance when the workflow state machine accepts the transition.

## Implemented Slice

- `packages/core/src/state-machines.ts` defines pure transition functions for task, run, approval, media job, workflow, and workflow step.
- SQLite has `state_transition_events` and `resource_leases`.
- Task/run status transitions in daemon task execution use compare-and-set helpers.
- Duplicate task run idempotency keys return the original run id instead of starting a second run.
- `POST /tasks/:id/run` is routed through the same coordinator-style preparation path as `POST /runs`.
- `GET /state-transitions` and `GET /runtime/leases` are read-only diagnostic APIs.
- Web shows channel runtime policy, active leases, and state transition timelines.
- CLI channel create/update can set status and runtime policy; `doctor` shows active lease count.

## Next Implementation Work

1. Move approval and media-job status writes to transition-event CAS helpers.
2. Add queued attempt rows for `queueOnConflict=true`; current v0.1 behavior is conflict visibility and no duplicate execution.
3. Enforce `maxConcurrentRuns` for parallel channels with a count/semaphore lease model.
4. Add workflow and workflow-step persistence before real multi-teammate orchestration.
5. Route gstack-style and custom AI teammate protocols through workflow steps.

## Non-Goals

- Do not build a distributed workflow engine in v0.1.
- Do not make browser or SSE connection state the source of truth.
- Do not let a runner's final message override terminal state without a legal transition.
- Do not allow hidden auto-retry for side-effectful actions without idempotency and approval policy.
