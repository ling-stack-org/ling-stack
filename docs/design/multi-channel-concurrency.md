# Multi-Channel Concurrency

Ling Stack channels do not each own a separate business adapter or private state machine. A channel is a general multi-agent work scene with a runtime policy. All proposal, task, run, approval, media, and workflow state goes through core state machines and the daemon coordinator path.

## Shape

```text
Channel Source Adapter
-> Channel Coordinator
-> Core State Machines
-> Runner / Provider / Tool Runtime
```

- Adapter: normalizes events from Web, CLI, and future Slack, Feishu, GitHub, email, or custom sources.
- Channel Coordinator: validates channel status, provider readiness, idempotency, leases, and CAS task claims.
- Core State Machines: define legal transitions for task, run, approval, media job, workflow, and workflow step.
- Runner / Provider / Tool Runtime: executes work only after coordinator approval.

Web and CLI currently use the built-in `local` source. No external adapter is needed for v0.1.

## PI Session Boundary

Channels and AI teammates do not own permanent private PI processes. PI is the execution
runtime for a task run.

```text
Assignee agent identity + confirmed task + provider/tools
-> run id
-> scoped PI session
-> tool events, approvals, artifacts, terminal result
```

This means multiple channel conversations can happen without starting PI. When a user
confirms an execution proposal, the task is created and, for create-and-run proposals,
the assigned agent launches a run-scoped PI session immediately. Each run has its own
task snapshot, channel id, proposal linkage when available, provider snapshot, approval
records, artifacts, and status transitions.

The assignee agent is the execution source of truth. Its provider, tools, and approval
profile must be runnable before PI starts. If they are not runnable, the proposal/task is
blocked for repair instead of silently falling back to another provider.

Different agents can therefore use PI without sharing conversational state:

```text
Engineer on task A -> run_1 -> PI session 1
Reviewer on task B -> run_2 -> PI session 2
```

The daemon coordinator and resource leases decide whether those sessions may run at the
same time. Read-only runs can run in parallel when policy allows it. Write-capable runs
are blocked by the configured write lock scope.

## Channel Runtime Policy

Channels persist:

```ts
type ChannelStatus = "active" | "paused" | "archived";

interface ChannelRuntimePolicy {
  maxConcurrentRuns: number;
  executionMode: "serial" | "parallel";
  writeLockScope: "channel" | "boundPath" | "workspace";
  allowReadOnlyParallel: boolean;
  queueOnConflict: boolean;
}
```

Default:

```ts
{
  maxConcurrentRuns: 1,
  executionMode: "serial",
  writeLockScope: "boundPath",
  allowReadOnlyParallel: true,
  queueOnConflict: true
}
```

Status behavior:

- `active`: tasks and runs can be created.
- `paused`: tasks can be viewed and edited, but new runs are rejected.
- `archived`: read-only channel history; new tasks and runs are rejected.

Execution behavior:

- `serial`: one active run per channel because the coordinator locks `channel:<channelId>`.
- `parallel`: future mode; v0.1 still protects task and write scopes, but `maxConcurrentRuns` enforcement is a follow-up.
- `boundPath`: write/bash/edit runs lock the canonical repo path.
- `workspace`: write/bash/edit runs lock the whole local workspace.
- `channel`: write/bash/edit runs only conflict inside the same channel.

## Resource Leases

SQLite table:

```sql
CREATE TABLE resource_leases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT
);

CREATE UNIQUE INDEX idx_active_resource_lease
ON resource_leases(workspace_id, resource_type, resource_key)
WHERE status = 'active';
```

Run start leases:

- `task:<taskId>` for every task run.
- `channel:<channelId>` when channel execution mode is `serial`.
- `bound_path:<realpath>`, `channel:<channelId>`, or `workspace:<workspaceId>` when tools include `bash`, `edit`, or `write`.

Terminal runs release leases. Startup expires stale leases before new work is accepted.

## Idempotency

`POST /runs` and `POST /tasks/:id/run` accept `idempotencyKey`. For persisted tasks, the claim transition records the key with reason `run:<runId>`.

If the same request is retried:

- Ling returns the original run id.
- No second run session is created.
- No second task claim occurs.

This protects browser retry, SSE reconnect confusion, and network flaps.

## APIs

Channel CRUD:

```http
GET /channels
POST /channels
PATCH /channels/:id
```

Channel payload includes:

```json
{
  "status": "active",
  "runtimePolicy": {
    "maxConcurrentRuns": 1,
    "executionMode": "serial",
    "writeLockScope": "boundPath",
    "allowReadOnlyParallel": true,
    "queueOnConflict": true
  }
}
```

Task run:

```http
POST /tasks/:id/run
```

The current daemon reuses the SSE run stream path so Web can watch events. The durable semantics match the coordinator contract: status check, provider check, idempotency, leases, CAS claim, run creation, state transitions, and release on terminal state.

Diagnostics:

```http
GET /state-transitions?entityType=task&entityId=...
GET /runtime/leases?status=active
```

These are read-only APIs. UI and CLI must not write transitions directly.

## UI Signals

The Web workspace shows:

- Channel status and policy in the channel header.
- Status chips for active, paused, and archived channels.
- Active resource lease count in the workspace header and right context panel.
- Task cards with channel inactive or active lock hints.
- Run detail state-machine timeline.
- Run detail active leases for the selected run.

CLI shows:

- Channel status and policy in `channel list` and `channel show`.
- Runtime policy flags in `channel create` and `channel update`.
- Active lease count in `doctor`.

## Current v0.1 Boundaries

Implemented:

- Channel status and runtime policy persistence.
- Local source through Web and CLI.
- Task/run state-machine helpers.
- SQLite transition events for task/run transitions.
- SQLite resource leases.
- Paused/archived channel run rejection.
- Task/channel/bound-path/workspace lock conflicts.
- Idempotent task run retry returning the original run id.
- Cancel race protection.

Deferred:

- Distributed locks.
- Cross-machine runner recovery.
- Full queued attempt scheduling for `queueOnConflict=true`.
- `maxConcurrentRuns` semaphore enforcement for parallel channels.
- External source adapters.
- Workflow persistence for real multi-agent plans.
