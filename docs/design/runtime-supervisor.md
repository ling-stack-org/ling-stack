# Runtime Supervisor

## Status

Active design for a durable runtime supervisor shared by Web, desktop, CLI, and future
clients. Core runtime supervision, discriminated initial approval-wait suspension, and
resumed-attempt atomic settlement are implemented and full Core/Daemon regression green;
the complete repository deterministic matrix is green, and a fresh packaged macOS
artifact passes integrity/startup/provider preflight. Real restart/reconnect lineage
acceptance remains active work.

This document extends:

- [Architecture](../architecture.md)
- [Platform Architecture](platform-architecture.md)
- [State Machines and Recovery](state-machine-recovery.md)
- [Multi-Channel Concurrency](multi-channel-concurrency.md)
- [Contracts and API Client](contracts-api-client.md)
- [Desktop Shell](desktop-shell.md)

## Problem

Ling Stack is moving from a single local web workflow toward a multi-client, multi-agent
workspace. Web and desktop can run side by side, but they must not create separate
runtime ownership. If each client owns active runs, leases, heartbeats, cancellation, or
runner state, the product can split into several partial truths:

```text
Web thinks the workspace is idle.
Desktop thinks a run is active.
SQLite still has an active lease.
The runner may be stalled or already gone.
```

That class of failure is worse than a normal provider error because the transport or UI
can look healthy while execution is not making progress. Ling Stack needs one durable
runtime owner that can answer:

- Which work is active?
- Which runner owns it?
- Which client requested it?
- Which resource leases does it hold?
- When did it last make progress?
- Can it be cancelled, retried, or reconciled?
- Is it safe for another agent to start?

The current task run path already has the first version of this model: persisted runs,
state transitions, resource leases, idempotency, cancellation, and late-success
protection. The missing piece is a general supervisor that applies the same guarantees to
every agent or provider execution path, including channel AI replies, teammate direct
messages, external work steps, and media jobs.

## Goals

- Keep one runtime owner per workspace.
- Let Web, desktop, and CLI use the same daemon runtime concurrently.
- Route every agent/provider execution through a durable work unit.
- Preserve compare-and-set state transitions and idempotency.
- Make resource leases renewable, attributable, and diagnosable.
- Detect stalled runners with heartbeat and event-age checks.
- Support cancellation, retry, and startup recovery without client-specific state.
- Prevent read/write, channel, workspace, provider, and external subject conflicts.
- Expose enough runtime diagnostics for support and local debugging.
- Keep SQLite as the v0.1 local-first store while leaving room for Postgres later.

## Non-Goals

- Distributed multi-node execution in v0.1.
- Cloud team presence or cross-device collaboration.
- Running separate runtime supervisors for Web and desktop.
- Replacing the Pi runner.
- Full external plugin sandboxing.
- Automatic recovery of arbitrary side effects after a crashed shell command.
- Bypassing existing approval policy, provider preflight, or resource lease checks.

## Core Position

The daemon is the only runtime owner. Clients are control surfaces.

```text
Web Client  --+
Desktop App --+--> shared api-client --> local daemon --> runtime supervisor
CLI         --+                         |
                                        +--> core state machines
                                        +--> storage
                                        +--> runner/provider/tool adapters
                                        +--> shared conversation transcript projector
```

The desktop app may start, stop, and monitor the daemon, but it must not become a second
runtime. The web app may run from Vite or be embedded inside the desktop shell, but it
must not call a runner directly. The CLI is also a client over the same daemon API unless
it is explicitly performing setup work before the daemon exists.

The same rule applies to conversation projection: clients may render transcript data, but
the daemon/core layer owns the semantic projection from channel messages, workflows, runs,
approvals, artifacts, and interventions into `ConversationTranscript`. Web, Desktop, and
CLI must not each invent their own lifecycle interpretation for active and completed work.

## Runtime Identity

Each workspace has one active daemon instance.

Suggested runtime identity file:

```text
.ling-stack/runtime.lock
```

Suggested payload:

```json
{
  "workspaceId": "workspace_local",
  "runtimeInstanceId": "runtime_...",
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 5187,
  "startedAt": "2026-06-04T00:00:00.000Z",
  "version": "0.1.0",
  "schemaVersion": 1
}
```

Startup rules:

1. A daemon checks the lock file before binding a runtime port.
2. If the lock points to a healthy daemon, the new process exits or returns the existing
   connection details.
3. If the lock points to a dead process or failed health probe, the new daemon can take
   ownership after writing a takeover event.
4. Clients must treat `runtimeInstanceId` changes as a reconnect boundary and reload
   durable state from the daemon.
5. Clients must never write this file directly.

The lock file is a local single-machine guard, not a distributed consensus mechanism.

Daemon process lifecycle state is separate from this runtime lock. `daemon start`,
`status`, `stop`, `restart`, `logs`, and the P0 doctor checks are specified in
[Daemon Lifecycle and Doctor P0](daemon-lifecycle-p0.md). Lifecycle commands may signal
the daemon process, but they must not directly edit work units, runs, approvals, leases,
or semaphore slots.

## Package Boundaries

### `packages/core`

Owns pure runtime domain logic:

- Work unit types.
- Work unit state machine.
- Lease and semaphore types.
- Runtime policy evaluation.
- Transition legality.
- Recovery decisions.
- Diagnostic DTO types.

It must not import Web, desktop, Node HTTP server code, or runner implementation code.

### `packages/storage` or current `packages/core/src/storage`

Owns durable persistence:

- Work units.
- Work unit attempts.
- Runtime events.
- Heartbeats.
- Leases and lease renewals.
- Provider semaphores.
- Artifacts and summaries.

Current SQLite storage can remain in `packages/core/src/storage` until the package split
is useful.

### `packages/daemon`

Owns runtime orchestration:

- Runtime lock acquisition.
- Supervisor lifecycle.
- HTTP API.
- SSE or future WebSocket event streams.
- Start, cancel, retry, reconcile, and diagnostics commands.
- Runner adapter invocation.
- Startup recovery.

The daemon may coordinate, but it must call core state machines for durable state changes.

### `packages/runner-pi`

Owns the Pi runner adapter:

- Runs one prompt/session for a work unit.
- Emits normalized runner events.
- Accepts `AbortSignal`.
- Emits heartbeats or progress callbacks when possible.
- Does not mutate durable Ling Stack state directly.

The current implementation uses `@earendil-works/pi-coding-agent` as an embedded
TypeScript library. If Ling Stack later uses the Pi CLI as the concrete execution engine,
the boundary stays the same: Pi remains behind `packages/runner-pi`, and the daemon still
supervises it through work units, attempts, heartbeats, cancellation, and artifacts.

### `packages/api-client`

Owns shared client access:

- Web, desktop, and CLI use this package.
- It hides HTTP/SSE details behind typed methods.
- It supports reconnect and event replay.
- It provides idempotency key helpers for client commands.

### `apps/web` and `apps/desktop`

Own control surfaces only:

- Render durable state.
- Send commands through the API client.
- Subscribe to events.
- Cache UI state locally, but never treat local state as runtime truth.
- Do not read or write the SQLite database directly.
- Do not invoke runners directly.

## Work Unit Model

A work unit is the durable execution envelope for anything that can call an agent,
provider, runner, shell hook, or media adapter.

```ts
type WorkUnitKind =
  | "task_run"
  | "channel_turn_dispatch"
  | "channel_ai_reply"
  | "teammate_direct_reply"
  | "external_work_step"
  | "external_work_action"
  | "media_job";

type WorkUnitStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting_for_approval"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stale";

interface WorkUnit {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: WorkUnitKind;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly teammateId?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly idempotencyKey: string;
  readonly status: WorkUnitStatus;
  readonly priority: number;
  readonly attemptCount: number;
  readonly activeAttemptId?: string;
  readonly createdByClientId?: string;
  readonly createdByActor: "user" | "system" | "scheduler";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly lastEventAt?: string;
  readonly lastHeartbeatAt?: string;
  readonly idleTimeoutMs: number;
  readonly hardTimeoutMs: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}
```

The existing `run_sessions` table can either remain as a task-run-specific projection or
be migrated into `work_units`. The safer path is:

1. Add `work_units`.
2. Keep `run_sessions` for compatibility.
3. Make every new run create a linked `work_unit`.
4. Migrate UI and APIs toward work units.
5. Retire or narrow `run_sessions` later.

## Work Unit Attempts

A work unit can have multiple attempts. Attempts separate user-visible work identity from
runner execution identity.

```ts
type WorkUnitAttemptStatus =
  | "created"
  | "started"
  | "waiting_for_approval"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

interface WorkUnitAttempt {
  readonly id: string;
  readonly workUnitId: string;
  readonly attemptNumber: number;
  readonly runtimeInstanceId: string;
  readonly runnerId: string;
  readonly providerPresetId?: string;
  readonly status: WorkUnitAttemptStatus;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly lastEventAt?: string;
  readonly lastHeartbeatAt?: string;
  readonly abortRequestedAt?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}
```

Retry creates a new attempt under the same work unit unless the retry should become a new
user-visible task.

## State Machine

Baseline work unit transitions:

| From | Event | To |
| --- | --- | --- |
| `queued` | `claim` | `claimed` |
| `claimed` | `runner_started` | `running` |
| `running` | `approval_requested` | `waiting_for_approval` |
| `waiting_for_approval` | `approval_approved` | `running` |
| `waiting_for_approval` | `approval_denied` | `failed` |
| `waiting_for_approval` | `approval_expired` | `failed` |
| `running` | `runner_succeeded` | `succeeded` |
| `running` | `runner_failed` | `failed` |
| `running` | `idle_timeout` | `cancelling` |
| `running` | `hard_timeout` | `cancelling` |
| `running` | `runner_lost` | `stale` |
| `cancelling` | `runner_cancelled` | `cancelled` |
| `cancelling` | `cancel_timeout` | `stale` |
| `stale` | `reconcile_failed` | `failed` |
| `stale` | `reconcile_cancelled` | `cancelled` |
| `failed` | `retry` | `queued` |
| non-terminal | `cancel` | `cancelling` |

Terminal states:

- `succeeded`
- `failed`
- `cancelled`

These are runtime/process states, not delegated-workflow completion states. In
particular, `runner_succeeded` proves only that the current attempt ended without a
runtime failure. For a manifest-backed workflow step it wakes the Channel semantic
reconciler, which must still validate the immutable delegated requirement, tool/action or
output-packet evidence, approvals, dependencies, participant manifest, and fan-in policy.
Only that reconciler may move the step or workflow to semantic success. A runner that
ends successfully with only ordinary assistant text therefore leaves the runtime attempt
`succeeded` while the delegated step becomes `blocked(delegated_outcome_missing)`.

```text
Runtime Supervisor                  Channel semantic reconciliation
------------------                  -------------------------------
attempt/lease/heartbeat             participant requirement
runner terminal status     ----->   action or output-packet evidence
lost/stale/cancel policy            graph, dependencies, fan-in
                                    workflow Completion Evaluation
```

This distinction is intentional: process diagnostics remain truthful without allowing a
healthy process exit to impersonate completed user work.

`stale` is non-terminal but blocked. It means Ling Stack cannot prove the runner still has
or no longer has execution authority. A stale work unit requires supervisor
reconciliation or an explicit user retry/cancel decision.

All transitions must be compare-and-set updates. A late runner success from a cancelled
or stale work unit must be recorded as a stale event, not applied as status truth.

## Supervisor Responsibilities

The runtime supervisor owns the live execution registry for one daemon instance.

```ts
interface RuntimeSupervisor {
  startWorkUnit(input: StartWorkUnitInput): Promise<WorkUnitView>;
  cancelWorkUnit(id: string, input: CancelWorkUnitInput): Promise<WorkUnitView>;
  retryWorkUnit(id: string, input: RetryWorkUnitInput): Promise<WorkUnitView>;
  reconcile(input?: ReconcileInput): Promise<ReconcileReport>;
  listActive(): Promise<readonly ActiveWorkUnitView[]>;
  getDiagnostics(input?: RuntimeDiagnosticsInput): Promise<RuntimeDiagnostics>;
}
```

Responsibilities:

- Claim queued work with idempotency.
- Acquire leases and provider semaphore slots.
- Create work unit attempts.
- Start runner/provider execution.
- Track active abort controllers.
- Append runtime events.
- Update last event and heartbeat timestamps.
- Detect idle and hard timeouts.
- Cancel or mark stale work.
- Release leases and semaphores on terminal state.
- Reconcile durable state on daemon startup.

The supervisor must not trust client connection state. A browser refresh or desktop
window close does not cancel active work.

## Scheduling and Queueing

The scheduler decides which queued work can start.

Inputs:

- Channel status.
- Channel runtime policy.
- Work kind.
- Required tools.
- Resource leases.
- Provider semaphore.
- Priority.
- Idempotency key.
- External subject state.

Queue rules:

- `queueOnConflict=false`: reject with conflict.
- `queueOnConflict=true`: persist queued work and return the queued work unit.
- Same idempotency key: return the existing work unit.
- Same external subject with a newer idempotency key: block, supersede, or queue according
  to source policy.
- Paused or archived channel: reject before queueing.

`maxConcurrentRuns` should be enforced through a channel semaphore, not only a channel
lease. Serial channels can continue to use a `channel:<channelId>` lease as the simple
case.

## Leases and Semaphores

Leases protect exclusive resources. Semaphores limit concurrent usage of counted
resources.

Suggested lease resource types:

```ts
type RuntimeLeaseResourceType =
  | "task"
  | "channel"
  | "bound_path"
  | "workspace"
  | "workflow_step"
  | "external_subject"
  | "external_workspace"
  | "approval_owner";
```

Suggested semaphore resource types:

```ts
type RuntimeSemaphoreResourceType =
  | "provider"
  | "channel_parallel"
  | "runner"
  | "media_provider";
```

Lease rules:

- Every active work unit owns leases by `work_unit_attempt`.
- Leases have `expiresAt`, `lastRenewedAt`, and `releaseReason`.
- Active attempts renew leases on heartbeat.
- Expired leases trigger reconciliation before new work can reuse the resource.
- A live owner prevents fail-open reuse.
- A lost owner can be marked `expired` or `stale_released` by supervisor recovery.

Semaphore rules:

- Provider slots protect API rate and local resource pressure.
- Channel parallel slots enforce `maxConcurrentRuns`.
- Runner slots prevent too many local agent sessions.
- Semaphore acquisition and release must be durable enough to survive daemon restart.

## Heartbeats and Watchdogs

Each active attempt needs two progress clocks:

- `lastHeartbeatAt`: the runtime process is still alive.
- `lastEventAt`: user-meaningful progress happened.

Timeouts:

- `heartbeatTimeoutMs`: no heartbeat from runner or wrapper.
- `idleTimeoutMs`: no meaningful event for too long.
- `hardTimeoutMs`: maximum wall-clock runtime.
- `cancelGraceMs`: time allowed after abort before marking stale.

Suggested default policy:

```ts
interface RuntimeTimeoutPolicy {
  readonly heartbeatIntervalMs: number;      // 10_000
  readonly heartbeatTimeoutMs: number;       // 45_000
  readonly idleTimeoutMs: number;            // 10 * 60_000
  readonly hardTimeoutMs: number;            // 60 * 60_000
  readonly cancelGraceMs: number;            // 15_000
}
```

Idle timeout should be configurable per work kind. A coding task can run longer than a
short channel AI reply. A channel discussion reply should not hold an HTTP request
forever.

## Runner Contract

Runner adapters should implement a supervised contract:

```ts
interface SupervisedRunnerAdapter {
  readonly runnerId: string;

  runWorkUnit(input: {
    readonly workUnit: WorkUnit;
    readonly attempt: WorkUnitAttempt;
    readonly cwd: string;
    readonly task: RunnerTask;
    readonly provider: RunnerProviderConfig;
    readonly tools: readonly string[];
    readonly signal: AbortSignal;
    readonly onEvent: (event: RuntimeEventInput) => void;
    readonly onHeartbeat: (heartbeat: RuntimeHeartbeatInput) => void;
    readonly onApprovalRequired: (request: RuntimeApprovalRequest) => Promise<RuntimeApprovalDecision>;
  }): Promise<RuntimeRunnerResult>;
}
```

Runner rules:

- Emit a start event.
- Respect `AbortSignal`.
- Emit heartbeats from the wrapper even if the provider stream is quiet.
- Translate provider/tool errors into normalized error codes.
- Never write final Ling Stack status directly.
- Dispose sessions and remove event listeners in `finally`.

If a third-party runner cannot emit heartbeats, the wrapper must emit wrapper-level
heartbeats while the runner promise is still pending.

## Pi Runner Modes

Pi is the first runner backend. The supervisor design supports two implementation modes:

| Mode | Description | Preferred use |
| --- | --- | --- |
| Embedded Pi library | `packages/runner-pi` calls `@earendil-works/pi-coding-agent` directly. | Current implementation, best event fidelity and approval integration. |
| Pi CLI subprocess | `packages/runner-pi` spawns a `pi` CLI command and translates process output into Ling runtime events. | Compatibility mode when the CLI is the stable public execution surface. |

Both modes must expose the same Ling Stack runner contract. No Web, desktop, or CLI
client should care which Pi mode is active.

Default decision: keep the embedded Pi library mode as the primary backend. Pi CLI should
remain an experimental, fallback, or isolation backend until it exposes enough structured
control for Ling's supervisor contract.

Pi CLI can become the default only after it satisfies these gates:

- Stable structured event output, preferably JSONL.
- Reliable cancellation that does not continue side effects after abort.
- A tool approval bridge before `bash`, `edit`, `write`, or any external mutation.
- Clear exit code, signal, timeout, and parse-failure semantics.
- Secret injection without argv exposure.
- Passing the shared runner conformance tests for start, events, approval, cancellation,
  timeout, late success, artifacts, and stale recovery.

### Embedded Pi Library Mode

Current behavior:

- Create a Pi agent session inside the daemon process.
- Use an in-memory Pi `SessionManager` scoped to the work unit.
- Subscribe to Pi session events and translate them into Ling runtime events.
- Use `AbortSignal` to call `session.abort()`.
- Dispose the session in `finally`.
- Keep Ling approvals, artifacts, provider policy, and state transitions outside Pi.

This mode gives Ling Stack the best control over tool approval hooks and event-level
progress.

### Pi CLI Subprocess Mode

If Pi CLI becomes the bottom execution layer, the adapter should treat it as an
untrusted long-running child process that is supervised by Ling, not as the runtime owner.

Process rules:

- Spawn one Pi CLI process per work unit attempt.
- Run the child in an isolated working directory such as
  `.ling-stack/pi/work-units/<workUnitId>/<attemptId>/`.
- Pass secrets through environment variables or restricted temp config files, not through
  argv where they can appear in process listings.
- Put the process in its own process group when the platform supports it.
- On cancel, send graceful termination first, then force kill after `cancelGraceMs`.
- Capture stdout and stderr as redacted artifacts with bounded size.
- Map exit code, signal, timeout, and parse failures into normalized runner error codes.

Event rules:

- Prefer a structured JSONL or machine-readable Pi CLI event stream.
- Translate Pi events into `runtime_events` with stable `seq` allocation owned by Ling
  storage.
- If the CLI has only plain text output, emit coarse events: `started`, `stdout_delta`,
  `stderr_delta`, `progress`, `succeeded`, `failed`, and attach the full transcript as an
  artifact.
- The wrapper emits heartbeats while the child process is alive even if the CLI is quiet.
- `lastEventAt` updates only on meaningful output or parsed progress, not on wrapper-only
  heartbeats.

Recovery rules:

- A Pi CLI child from an old daemon instance is not assumed resumable.
- On daemon restart, previous CLI attempts become `lost` unless Pi exposes a durable
  resume token and Ling has implemented that resume path.
- Ling must not reuse the work unit's leases until the stale attempt is reconciled.

Approval rules:

- If Pi CLI cannot surface tool approval requests before executing side effects, Ling must
  either run it with side-effect tools disabled or use preflight policy that blocks those
  requests before CLI start.
- Side-effect-capable Pi CLI mode should be enabled only when the CLI exposes a tool-call
  approval protocol that the adapter can bridge into Ling approvals.

The key design constraint is that Pi CLI may execute the work, but it does not own Ling's
runtime truth. The daemon supervisor owns identity, state, leases, cancellation,
heartbeats, retries, and diagnostics.

Human course correction for active runs is a separate follow-up design:
[Run Interruption And Continuation](run-interruption-continuation.md). It builds on the
supervisor and does not inject prompt text into an already-active runner call.

## Unified Execution Paths

All of these must become work units:

| Current path | Work unit kind | Notes |
| --- | --- | --- |
| `POST /runs` | `task_run` | Existing run session path becomes supervised. |
| `POST /tasks/:id/run` | `task_run` | Keeps task lease and task state transitions. |
| Channel AI reply | `channel_ai_reply` | Creates a pending message, updates it on terminal state. |
| Teammate direct reply | `teammate_direct_reply` | Creates a pending private message, updates it on terminal state. |
| External workflow step | `external_work_step` | Owns source and workspace leases. |
| External action execution | `external_work_action` | Approval-gated and stale-target checked. |
| Media generation | `media_job` | Uses media provider semaphore and cost approvals. |

The important migration is channel and direct AI replies. They currently feel like chat
messages, but they are still provider executions. They need durable pending state,
cancellation, timeout, and diagnostics.

## Storage Draft

Suggested SQLite tables:

```sql
CREATE TABLE work_units (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  channel_id TEXT,
  task_id TEXT,
  teammate_id TEXT,
  provider_preset_id TEXT,
  runner_id TEXT,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  active_attempt_id TEXT,
  created_by_client_id TEXT,
  created_by_actor TEXT NOT NULL,
  request_json TEXT NOT NULL,
  timeout_policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  last_event_at TEXT,
  last_heartbeat_at TEXT,
  error_code TEXT,
  error_message TEXT
);

CREATE UNIQUE INDEX idx_work_unit_idempotency
ON work_units(workspace_id, kind, owner_type, owner_id, idempotency_key);

CREATE INDEX idx_work_unit_status
ON work_units(workspace_id, status, priority, created_at);
```

```sql
CREATE TABLE work_unit_attempts (
  id TEXT PRIMARY KEY,
  work_unit_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  runtime_instance_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  provider_preset_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  last_event_at TEXT,
  last_heartbeat_at TEXT,
  abort_requested_at TEXT,
  error_code TEXT,
  error_message TEXT,
  FOREIGN KEY(work_unit_id) REFERENCES work_units(id)
);

CREATE UNIQUE INDEX idx_work_unit_attempt_number
ON work_unit_attempts(work_unit_id, attempt_number);
```

```sql
CREATE TABLE runtime_events (
  id TEXT PRIMARY KEY,
  work_unit_id TEXT NOT NULL,
  attempt_id TEXT,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  data_json TEXT NOT NULL,
  FOREIGN KEY(work_unit_id) REFERENCES work_units(id)
);

CREATE UNIQUE INDEX idx_runtime_event_seq
ON runtime_events(work_unit_id, seq);
```

```sql
CREATE TABLE runtime_heartbeats (
  id TEXT PRIMARY KEY,
  work_unit_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  runtime_instance_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  source TEXT NOT NULL,
  detail_json TEXT,
  FOREIGN KEY(work_unit_id) REFERENCES work_units(id),
  FOREIGN KEY(attempt_id) REFERENCES work_unit_attempts(id)
);

CREATE INDEX idx_runtime_heartbeat_attempt
ON runtime_heartbeats(attempt_id, ts);
```

Extend `resource_leases`:

```sql
ALTER TABLE resource_leases ADD COLUMN last_renewed_at TEXT;
ALTER TABLE resource_leases ADD COLUMN release_reason TEXT;
ALTER TABLE resource_leases ADD COLUMN work_unit_id TEXT;
ALTER TABLE resource_leases ADD COLUMN attempt_id TEXT;
```

Suggested semaphore table:

```sql
CREATE TABLE runtime_semaphore_slots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  work_unit_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  last_renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT
);

CREATE INDEX idx_runtime_semaphore_active
ON runtime_semaphore_slots(workspace_id, resource_type, resource_key, status);
```

The semaphore limit is enforced in code through a transaction:

1. Count active slots for the resource.
2. Compare with configured limit.
3. Insert a new slot if below limit.
4. Commit.

SQLite is sufficient for single-daemon local v0.1.

## API Draft

Runtime identity:

```http
GET /runtime
```

Returns:

```json
{
  "runtimeInstanceId": "runtime_...",
  "workspaceId": "workspace_local",
  "status": "healthy",
  "startedAt": "...",
  "schemaVersion": 1
}
```

Work units:

```http
GET /work-units
GET /work-units/:id
POST /work-units
POST /work-units/:id/cancel
POST /work-units/:id/retry
POST /work-units/:id/reconcile
GET /work-units/:id/events?afterSeq=...
```

Diagnostics:

```http
GET /runtime/supervisor
GET /runtime/active
GET /runtime/stuck
GET /runtime/leases
GET /runtime/semaphores
POST /runtime/reconcile
```

Compatibility:

- `POST /runs` can continue to return SSE and `runId`.
- Internally it creates a `task_run` work unit.
- Run views include `workUnitId`.
- Future clients should prefer work unit APIs.

## Event Stream and Reconnect

Clients subscribe to runtime events through SSE first and WebSocket later if needed.

Requirements:

- Every event has `workUnitId`, `seq`, `type`, and `ts`.
- Clients reconnect with `afterSeq` or `Last-Event-ID`.
- Reconnect never creates a second runner.
- Missing events are replayed from storage.
- If replay is too old or compacted, the client reloads the work unit snapshot.
- Initial replay is bounded and gap-aware. The server registers live delivery first,
  captures a replay upper bound and retention floor, and queries the selected workspace/
  domains through that bound with one extra row. Numeric sequence gaps from other
  workspaces or filtered domains are legal. Ahead cursors, retained-history gaps, and
  overflow close the provisional subscription and return typed
  `control_plane_snapshot_required`; complete ranges return an explicit replay-ready
  window. The client performs a buffered snapshot handoff and never stream-truncates an
  unknown gap or advances its applied cursor before canonical refresh succeeds.
- UI local state is a cache only.

Suggested event families:

```text
work_unit.created
work_unit.queued
work_unit.claimed
work_unit.started
work_unit.heartbeat
work_unit.progress
work_unit.approval_requested
work_unit.cancelling
work_unit.succeeded
work_unit.failed
work_unit.cancelled
work_unit.stale
lease.acquired
lease.renewed
lease.released
semaphore.acquired
semaphore.released
artifact.created
diagnostic.stuck_detected
```

## Client Responsibilities

### Web

- Uses `@ling-stack/api-client`.
- Subscribes to runtime events.
- Sends idempotent commands.
- Renders pending channel replies as pending messages.
- Shows stuck and cancellable work units in the channel runtime panel.
- Does not call runners or read SQLite.

### Desktop

- Discovers or starts the daemon.
- Uses the same API client as Web.
- Shows daemon health, runtime identity, and background status.
- Renders the same shared conversation transcript snapshot/delta contract as Web.
- Can expose tray controls for stop/restart after confirmation.
- Does not own active runs or direct runner state.
- Does not create a second daemon for the same workspace.
- Does not own conversation projection or parse message body phrases as state.

### CLI

- Uses the daemon API for normal commands.
- Can run setup commands before daemon startup.
- Sends idempotency keys for start/cancel/retry/approve.
- Can print diagnostic views for active, stuck, leases, and semaphores.
- Can render the shared transcript as plain text or TUI cells, but does not own the
  transcript projector.

## Shutdown Intent And Recoverable Suspension

Daemon shutdown and user cancellation are different control-plane operations. An
explicit cancel endpoint may terminalize a Run and cancel its pending approvals. A
daemon lifecycle stop may only stop process-owned attempts. It must not call the same
`cancelAll()` path and then infer that the user cancelled every active task.

The active registry therefore exposes typed operations:

```text
cancel(runId, actor, reason)
  -> durable business cancellation first
  -> abort the current process attempt

suspendAll(runtimeInstanceId, shutdownCause)
  -> close new claims
  -> classify recoverable Run/approval/checkpoint lineage
  -> abort process attempts with runtime_suspend reason
  -> completion path atomically preserves logical state, marks Attempt lost,
     releases leases/slots, and appends invalidations before shutdown completes

fail(runId, timeoutOrCrashCode)
  -> durable typed failure
  -> abort the current process attempt
```

`AbortSignal` remains the runner transport, but its reason is not the state-machine
decision. The Run orchestrator reloads canonical Run/work-unit state plus the typed stop
intent before committing a terminal effect. A user-cancelled Run stays cancelled; a hard
timeout fails; a runtime suspension leaves a recoverable checkpoint pending.

Graceful daemon shutdown is ordered:

1. stop accepting new HTTP/RPC work and close dispatcher claims;
2. let callbacks that already crossed a durable terminal/handoff boundary finish;
3. for approval-backed attempts, commit one discriminated suspension transaction; for
   other attempts, use the runtime-recovery owner rather than coordinator-local writes;
4. retain pending `ApprovalRequest` and `LingApprovalCheckpoint` rows;
5. release attempt-owned leases and semaphore slots;
6. close streams and SQLite only after the durable suspension fence is visible.

A waiting approval is the first supported resumable boundary. The same logical
`RunSession`, workflow step, required-participant manifest, and evidence remain. Startup
may attach a new `WorkUnitAttempt` only after validating the checkpoint basis and current
`activeAttemptId`. Generic mid-tool recovery stays conservative: without a durable
checkpoint it fails or blocks visibly and never becomes cancellation.

## Startup Recovery

On daemon startup:

1. Acquire runtime lock or connect to existing daemon.
2. Open storage and apply migrations.
3. Create a new `runtimeInstanceId`.
4. Scan non-terminal work units.
5. Scan active leases and semaphore slots.
6. Mark attempts from old runtime instances as `lost` unless they are provably resumable.
7. Move affected work units to `stale`, `failed`, or `queued` according to recovery policy.
8. Release or mark stale leases owned by lost attempts.
9. Expire old approvals.
10. Emit a startup reconcile report.

Startup then crosses three explicit recovery barriers. They are ordered and idempotent;
no phase may duplicate the next phase's authority:

```text
Phase A: runtime repair
  leases + attempts + WorkUnits + lost/stale Runs
              |
              v
Phase B: Channel semantic repair
  current linked Runs -> delegated outcomes -> steps -> Completion Evaluation
              |
              v
Phase C: publication repair
  TerminalReport -> final Item + source Turn event + durable invalidation
              |
              v
clients reconnect and reproject canonical state
```

Phase A may requeue safe preprocessing or repair low-level state-machine rows. It must
not infer manifest-backed step/workflow success. Phase B always reloads the source intent
decision, immutable participant manifest/graph, current step-Run links, approvals, and
evidence; callbacks and cached gate snapshots are hints only. Phase C revalidates the
same Completion Evaluation read-set inside its atomic publication transaction. Client
reconnect happens after these durable barriers and never causes any of them to run again.

Default recovery policy:

| Durable state | Recovery action |
| --- | --- |
| `queued` work unit | Keep queued. |
| queued/claimed `channel_turn_dispatch` | Claim or requeue, then resume from committed context/intent/reply/workflow refs. |
| `claimed` with no active attempt | Return to queued or mark failed after claim timeout. |
| `running` from previous runtime without a safe checkpoint | Mark attempt `lost`; fail/block with `runtime_interrupted_no_checkpoint`, never cancel. |
| `waiting_for_approval` with pending or approved-but-unclaimed checkpoint | Commit `approval_wait` suspension: preserve Run/work unit/checkpoint, mark old Attempt `lost`, release Run leases/Attempt slots, append invalidations, and register resume; create a new Attempt only after the decision is durable. |
| `running` with `resume_pending` checkpoint | Classify the bound replacement Attempt from canonical tool events; retry only before `tool_start`, finalize existing `tool_end`, otherwise block effect-unknown. |
| `waiting_for_approval` without a valid checkpoint | Preserve audit rows and block with `approval_resume_checkpoint_missing`; do not cancel or guess. |
| `cancelling` from previous runtime | Mark `stale` or `cancelled` if runner is known gone. |
| Active lease from previous runtime | Mark `stale_released` after owner work unit is stale. |
| Active semaphore from previous runtime | Mark `stale_released`. |

No client connection state participates in recovery.

Approval resume adds a phase between low-level repair and Channel semantic repair:

```text
Phase A: runtime repair
  old attempt lost + leases released
              |
              v
Phase A2: approval resume registration
  validate checkpoint + preserve decision + fence old attempt
              |
              v
new attempt under same Run, or typed resume blocker
              |
              v
Phase B: delegated outcome + workflow Completion Evaluation
```

The resume coordinator may use a verified runner-native handle. Otherwise it uses Ling
continuation context and a one-time exact approval grant. Because the current Pi adapter
uses `SessionManager.inMemory`, Pi is in the second category. A resume mismatch or
unsupported action becomes a visible blocker; startup cannot downgrade it to
`cancelled` or recreate the required participant from prose.

### `resume_pending` crash recovery

The resume claim and the local side effect cannot be one SQLite transaction. The protocol
therefore makes every boundary explicit and recovers from canonical facts:

```text
approved checkpoint
  -> CAS resume_pending + bind replacementAttemptId
  -> create/activate replacement Attempt
  -> acquire ordinary Run resource leases
  -> acquire replacement-Attempt semaphore slots
  -> append durable tool_start(attemptId, toolCallId, sideEffectFingerprint)
  -> execute exact approved side effect
  -> append durable tool_end(attemptId, toolCallId, result)
  -> atomically terminalize Attempt/Run/checkpoint and release capacity
  -> post-commit Channel semantic reconciliation
```

The claim/create/activate lines before capacity acquisition are one Core SQLite
transaction. It revision-CASes the checkpoint, inserts the replacement Attempt,
transitions/fences the Run and work unit, appends runtime audit, and appends the durable
control-plane invalidation. A new writer cannot leave a committed `resume_pending` row
without its bound Attempt or `activeAttemptId`. Startup support for that partial shape is
repair for older development/abnormal state, not a normal protocol branch.

Capacity acquisition is intentionally after claim and before `tool_start`. It reuses the
ordinary concurrency path; approval does not grant a lease or bypass a semaphore. If the
process dies in this interval, startup fences the claimed Attempt and releases its active
capacity before another Attempt may retry. If capacity acquisition fails normally, the
coordinator emits a typed pre-dispatch failure/suspension and no side effect starts.

On startup, the resume coordinator scans `approved` and `resume_pending`. It validates the
immutable resume basis first, then applies the following deterministic classification:

| Evidence for bound replacement Attempt | Safe action |
| --- | --- |
| Attempt missing | create the bound Attempt once if Run/work unit still wait on the same checkpoint |
| Attempt exists but has no `tool_start` | mark it lost, revision-CAS one newer bound Attempt, and continue |
| matching `tool_end` exists | rebuild the action/result and finish canonical reconciliation without execution |
| matching `tool_start` exists but no `tool_end` | mark resume failed with `approval_resume_effect_unknown`; do not retry |
| Run/checkpoint already terminal | reconcile only; do not create an Attempt |

The `tool_start` append is a write-ahead dispatch fence. Absence proves the coordinator
did not call the executor. Presence without `tool_end` does not prove whether the child
process completed before the daemon died. The local shell does not provide an idempotency
lookup, so exactly-once execution is impossible in that interval; fail-closed behavior is
required.

A second `runtime_suspend` uses the same classification. The resumed executor reads the
typed stop intent from the active-run registry or abort reason. It never maps a daemon
stop to `approval_resume_interrupted` failure. Before dispatch it preserves
`resume_pending`; after terminal evidence it lets startup finalize; in the unknown window
it records the typed blocker. A real idle/hard timeout remains `runtime_failure` and
terminalizes the Run as failed.

Runner registry metadata owns resume capability:

```ts
interface RunnerResumeCapabilitiesV1 {
  readonly nativeResume: boolean;
  readonly hostApprovalContinuation: readonly ApprovalActionType[];
}
```

The coordinator selects a strategy only from that metadata plus the checkpoint payload.
Pi declares `nativeResume=false` and currently permits host continuation for `bash` only.
No code path infers support from `runnerId`, a stored handle shape, or provider prose.
Advertising `native_resume` is insufficient by itself: the adapter must expose the typed
resume operation, return a verified handle bound to the same lineage/fingerprints, and
pass runner-conformance coverage. Until then, any existing decorative external-runner
capability string is non-authoritative and cannot activate resume.

Each resume claim/start/suspend/finalize/block transition appends one deterministic
control-plane invalidation inside the same SQLite transaction as its user-visible state
change. The in-memory hub publishes after commit; event delivery does not participate in
fencing. Reconnect replay or snapshot reloads Run/work-unit/approval state and may safely
coalesce duplicate invalidations.

The storage boundary is three focused compare-and-set transactions, not a generic
"update resume state" helper:

```text
commitApprovalResumeClaim
  checkpoint + old/new Attempts + Run + WorkUnit + runtime audit + invalidations

commitApprovalResumeSuspension
  approval_wait:
    checkpoint(pending|approved) + Run/WorkUnit(waiting_for_approval)
    + active Attempt(lost) + lease/slot release + audit + invalidations
  resume_pre_dispatch:
    checkpoint(resume_pending) + Run/WorkUnit(running)
    + active Attempt(lost) + lease/slot release + audit + invalidations

commitApprovalResumeTerminal
  checkpoint(resumed|resume_failed) + Run + WorkUnit + Attempt + Task
  + terminal runtime audit + lease/slot release + invalidations

commitApprovalResumeTerminal(checkpoint_quarantine)
  checkpoint(resume_failed) + diagnostic audit + approval invalidation
  (only when Run/WorkUnit/Attempt lineage cannot be proven; no guessed terminal writes)
```

Each method validates checkpoint revision, Run/work-unit state, `activeAttemptId`, and
Attempt ownership inside `BEGIN IMMEDIATE`. A stale result returns a typed conflict and
has no post-commit event to publish. The daemon must not follow a failed transaction with
best-effort writes that recreate part of the intended transition.

Suspension validates the lifecycle as a discriminated shape. It rejects
`pending + running`, `resume_pending + waiting_for_approval`, and every other arbitrary
cross-product before writing. Normal graceful shutdown and resume coordination use this
store boundary. Startup runtime repair may handle older abnormal rows, but the approval
resume coordinator cannot independently call `updateWorkUnitAttemptStatus()` or release
slots as a second writer.

The checkpoint-quarantine input is a discriminated terminal variant, not a general
escape hatch. It requires the expected checkpoint revision and a typed lineage-integrity
reason, and it is forbidden from accepting Run/work-unit/Attempt target states. Valid
lineage always uses the full terminal transaction.

Channel semantics remain post-commit. A committed terminal Run wakes the existing
delegated finalizer and Completion Gate. If that wake-up is lost, startup reconciliation
performs the same work. This keeps the Core transaction bounded while ensuring that a
process crash cannot repeat the local side effect or promote a required participant from
Run status alone.

### Channel turn dispatcher ownership

`channel_turn_dispatch` is a daemon-internal WorkUnit executed by one
`ChannelTurnDispatchWorkerRegistry`, not by the HTTP router. The registry is woken after a
store opens and after an acceptance transaction commits. It keeps one coalesced drain
loop per workspace, scans queued units oldest-first, and relies on the WorkUnit CAS claim
as the cross-wake/cross-process ownership fence.

The immutable request contains only source Turn/Item, Channel/Thread, explicit surface,
requested provider/teammate, and typed reply-disposition metadata. Current stage is
discovered from the canonical context assignment, intent/route decision, reply
Item/WorkUnit/Run, and workflow records. Runtime events describe attempts; they are not a
second checkpoint authority.

Startup reconciliation runs before the drain:

1. old active attempts are marked `lost` and their units `stale`;
2. stale Channel dispatch units are returned to `queued` with their previous attempt
   retained as audit evidence;
3. the workspace drain is woken once and claims the oldest eligible unit;
4. a durable child reply Run/workflow is reused; a terminal result is replayed; only a
   missing non-side-effectful preprocessing result may be recomputed;
5. visible reply and blocker identities are source-turn-derived, so recovery cannot
   append a duplicate result.

Graceful shutdown first closes the dispatcher to new claims and waits for active dispatch
callbacks to reach a durable handoff/terminal boundary. SQLite is closed only after that
wait. An abnormal process exit is handled by the lost/stale/queued path above.

## Failure Matrix

| Failure | Required behavior |
| --- | --- |
| Browser refresh | Reconnect and replay events. Work continues. |
| Desktop window close | Work continues if daemon is still running. |
| Web and desktop both click run | Same idempotency key returns duplicate; different key obeys queue/conflict policy. |
| Provider stream stalls | Heartbeat remains alive; idle timeout produces typed runtime failure rather than user cancellation. |
| Runner ignores abort | Cancel grace timeout marks work stale and blocks resource reuse until reconcile. |
| Daemon exits mid-run without a checkpoint | Startup marks the old attempt lost and work visibly stale/failed/blocked; it never records user cancellation. |
| Daemon exits while approval checkpoint is pending | Preserve Run/approval/checkpoint, mark old attempt lost, and register same-Run resume before Channel reconciliation. |
| Daemon exits after `resume_pending` claim but before replacement `tool_start` | Reuse/create one fenced replacement Attempt from the checkpoint CAS; do not duplicate execution. |
| Daemon exits after replacement `tool_start` but before `tool_end` | Record `approval_resume_effect_unknown`, fail closed, and never rerun the local side effect. |
| Daemon exits after replacement `tool_end` but before Run finalization | Finalize from durable action evidence; do not execute again. |
| Old attempt completes after a replacement attempt starts | Fence by runtime/active-attempt identity; persist diagnostic only. |
| Resumed side effect differs from checkpoint fingerprint | Require a new approval or block; never consume the old approval decision. |
| Late runner success after cancel | Record stale event, do not move cancelled work to succeeded. |
| Approval expires | Approval and owning work unit transition through state machine. |
| Lease expires while owner active | Supervisor renews or marks suspect; new work cannot fail-open over live owner. |
| External subject changes | Mark stale target before mutation. |
| SQLite write fails | Stop runner if possible, mark work failed if storage can recover, report diagnostic. |
| Client SSE disconnects | Stop streaming to that client only. Persist events. |
| Client disconnects after a Channel turn is accepted | Continue the durable `channel_turn_dispatch`; reconnect reads its committed result. |

## Diagnostics UI

The runtime diagnostics surface should answer:

- Active work units.
- Stuck work units.
- Last event age.
- Last heartbeat age.
- Current runner and provider.
- Held leases.
- Held semaphore slots.
- Owning channel/task/teammate.
- Cancellation and retry availability.
- Runtime instance id.
- Startup reconcile report.

Channel UI should show runtime blockers inline:

- Channel locked by work unit.
- Bound path locked by work unit.
- Provider concurrency limit reached.
- AI reply pending or stuck.
- Approval waiting.

Desktop can add OS-level notifications for:

- Work succeeded.
- Work failed.
- Approval needed.
- Work stuck.
- Runtime restarted.

## Security and Policy

The supervisor must preserve existing security boundaries:

- Provider secrets are resolved only inside the daemon.
- Secret values are redacted before events and artifacts are persisted.
- Tool access is checked before work is queued.
- Approval policy is evaluated before side effects.
- External actions re-read remote state before mutation.
- Clients cannot spoof runner completion events.
- Runtime lock takeover records an audit event.
- Diagnostics must not expose raw provider keys or secret-bearing command output.

## Migration Plan

### Phase 1: Supervisor Foundation

- Add `work_units`, `work_unit_attempts`, `runtime_events`, and heartbeat storage.
- Add runtime identity and daemon lock file.
- Wrap current `POST /runs` and `POST /tasks/:id/run` in supervisor work units.
- Preserve existing run APIs.
- Add idle and hard timeout policies.
- Add active and stuck diagnostics.
- Add tests for timeout, cancel, late success, reconnect, and startup recovery.

### Phase 2: Channel and Teammate Reply Unification

- Convert channel AI replies to `channel_ai_reply` work units.
- Convert teammate direct replies to `teammate_direct_reply` work units.
- Persist pending messages before runner start.
- Update messages on terminal state.
- Add cancel/retry actions for pending replies.
- Add UI runtime indicators in channel and teammate threads.

### Phase 3: Queue and Semaphore Enforcement

- Durable queued work units are persisted for `queueOnConflict=true`; the compatible
  run record remains `queued` and the runner is not started until the work is retried or
  scheduled.
- `queueOnConflict=false` preserves the explicit conflict response.
- `maxConcurrentRuns` is enforced with channel semaphore slots.
- Provider preset and runner concurrency use runtime semaphore slots.
- UI diagnostics expose queue state, held leases, semaphores, and blocker reason.

### Phase 4: External Work and Media Integration

- Move external work steps and external actions under work units.
- Move media jobs under work units or create a strict projection.
- Keep stale-target checks before mutation.
- Add background scheduler integration with supervisor diagnostics.

### Phase 5: Desktop Integration

- Desktop discovers or starts the daemon.
- Desktop shows runtime identity and health.
- Desktop uses shared API client.
- Desktop never owns active runtime state.
- Desktop consumes shared conversation transcript snapshot/delta state.
- Add tests for Web plus desktop-style client connecting to one daemon.

## Test Plan

Core tests:

- Work unit legal transitions.
- Stale transition rejection.
- Duplicate idempotency key returns existing work.
- Retry creates a new attempt.
- Terminal work cannot return to running.

Storage tests:

- Migration idempotency.
- Event sequence allocation.
- Heartbeat persistence.
- Lease renewal and release reason.
- Semaphore limit transaction.
- Startup recovery for lost attempts.
- Initial `approval_wait` suspension commits checkpoint/Run/work-unit preservation,
  Attempt loss, Run-lease/Attempt-slot release, runtime audit, and invalidations atomically.
- Every injected failure in initial-wait and resumed-pre-dispatch suspension rolls back the
  complete old snapshot.
- Illegal suspension lifecycle cross-products fail before the first write.

Daemon tests:

- `POST /runs` creates linked work unit.
- Same idempotency key does not start duplicate runner.
- Channel AI reply creates pending message and terminal update.
- Direct teammate reply creates pending message and terminal update.
- Runner idle timeout cancels or marks stale.
- Runner hard timeout cancels or marks stale.
- Late success after cancel does not overwrite cancelled.
- SSE reconnect replays stored events.
- Runtime lock prevents second daemon owner.
- Graceful shutdown at a pending approval does not cancel the Run or approval and does not
  leave active leases/semaphore slots.
- Replacement approval Attempt reacquires normal runtime capacity before `tool_start` and
  releases it on second suspension, terminal result, and startup repair.
- Startup registration contains no independent approval-coordinator Attempt/slot writer.
- `tool_start` without `tool_end` blocks effect-unknown; durable `tool_end` finalizes
  without executing the side effect again.

Client tests:

- Web and desktop-style clients see the same work unit state.
- Client reconnect after runtime instance change reloads durable state.
- UI renders stuck, queued, cancelling, and stale states without inventing local truth.
- SSE/RPC reconnect after approval claim/suspension/terminal/quarantine reloads canonical
  Run/work-unit/approval state before advancing the applied cursor and never resubmits work.

## Open Questions

- Should `run_sessions` become a projection of `work_units`, or should task runs keep a
  separate table permanently?
- What are the default timeout values for coding runs versus chat replies?
- Beyond the locked approval-resume rule, should other stale work with side-effect tools
  support a future idempotent executor? Current behavior is resolved: the same durable
  approved fingerprint may retry only before `tool_start`; effect-unknown never retries.
- How much event history should be retained before compaction?
- Should provider semaphore limits be configured per provider preset, provider type, or
  API key?
- Should desktop own daemon auto-update before or after runtime supervisor lands?

## Decision Summary

The complete design is a single daemon-owned runtime supervisor. Web and desktop can run
at the same time because both are clients over one runtime. Every execution path becomes
a durable work unit with state transitions, idempotency, leases, semaphores, heartbeat,
timeout, cancellation, retry, and recovery. This keeps Ling Stack from growing separate
runtime paths for task runs, channel chat, direct teammate chat, external work, and media.

For the Pi backend, Ling Stack should keep `@earendil-works/pi-coding-agent` embedded
library mode as the default. Pi CLI remains a supervised adapter option, not the default
runtime path, until it meets the structured event, approval, cancellation, and runner
conformance gates.
