# Runtime Control Plane Detailed Design

## Status

Implementation-level design for the Ling Runtime Control Plane. This document is the
join point between:

- [Runtime Supervisor](runtime-supervisor.md)
- [Runtime Control Plane Roadmap](runtime-control-plane-roadmap.md)
- [Runner Registry](runner-registry.md)
- [Pi Coding Agent Integration](../pi-coding-agent-integration.md)

The design is intentionally narrower than a new agent engine. Ling owns the runtime
control plane. Pi remains the default coding-agent kernel behind `runner-pi`.

The canonical Attempt-fence contract below is implemented in the active Continuity v2
WIP and its focused regressions are green. It is not release-cleared until the corrected
full Daemon aggregate, repository-wide source gates, and packaged restart/reconnect
matrix pass on the same post-hardening source.

Implementation sequencing is owned by the roadmap: first verify operator lifecycle and registry refresh, then
establish daemon-owned snapshots/events and client subscriptions, and only after concrete multi-client pressure
consider processor/transport decomposition. This document remains the object, API, event and ownership contract.

## Problem

A coding-agent kernel can run one task, but Ling needs product-grade control over that
task after it enters the workspace:

- which workspace, channel, task, teammate, and runner owns the work;
- whether the runner is alive, idle, stuck, cancelling, or stale;
- which approvals and artifacts belong to the run;
- which client can reconnect and see the same truth;
- which runner backend is allowed, blocked, or eligible for fallback.

Without a daemon-owned control plane, Web, CLI, desktop, and future workers would each
invent partial state. That would make cancellation, approval, retry, and audit depend on
the client that happened to be open.

## Boundary

```text
client surfaces
  Web, CLI, desktop
    |
    v
Ling daemon control plane
  work units, attempts, heartbeats, approvals, artifacts, audit,
  runner registry, snapshots, events, recovery
    |
    v
runner adapters
  pi, future codex-app-server, future openclaw-acp
    |
    v
agent kernel
  model turn loop, tool loop, session internals
```

Ling must not reimplement the bottom layer while Pi is sufficient. Ling must own the
middle layer because product safety, recovery, and audit are Ling responsibilities.

## Current Public Surface

| Surface | Current path | Role |
| --- | --- | --- |
| Work-unit types | `packages/core/src/runtime-supervisor-types.ts` | Durable runtime object model |
| Work-unit store facet | `packages/core/src/run-types.ts` | Store interface for work units, attempts, events, heartbeats, semaphores |
| SQLite runtime tables | `packages/core/src/storage/sqlite/runtime-work-unit-store.ts` | Durable local storage |
| Runtime supervisor | `packages/daemon/src/runtime/supervisor.ts` | Runtime lock, startup reconcile, diagnostics |
| Work-unit helpers | `packages/daemon/src/runtime/work-units.ts` | Start, cancel, terminal transition, stale marking |
| Runner registry | `packages/daemon/src/runtime/runners.ts` | Default, allowed, fallback, capability checks |
| Runtime settings | `packages/daemon/src/runtime/runner-settings.ts` | Workspace/user/built-in runner defaults |
| External runner gates | `packages/daemon/src/runtime/external-runners.ts` | Future Codex/OpenClaw runner enablement |
| Control-plane contracts | `packages/contracts/src/control-plane.ts` | Shared snapshot and event DTOs |
| Control-plane processors | `packages/daemon/src/features/control-plane/processors.ts` | Transport-neutral snapshot and event reads |
| Control-plane HTTP routes | `packages/daemon/src/features/control-plane/routes.ts` | `GET /control-plane/*` compatibility API |
| Control-plane RPC adapter | `packages/daemon/src/server/rpc.ts` | Optional transport over the same processors |

## Core Concepts

### Work Unit

A work unit is the user-visible execution envelope. It answers "what work is this?"

Examples:

- task run;
- channel AI reply;
- teammate direct reply;
- external work step;
- external work action;
- media job.

The work unit persists identity, owner, status, runner selection, provider preset,
idempotency key, timeout policy, linked run/message/media/external ids, last event time,
last heartbeat time, and terminal error fields.

### Attempt

An attempt is one runner execution under a work unit. It answers "which concrete runner
try is currently responsible?"

Retry creates another attempt without changing the work unit identity. This lets a user
see one piece of work while Ling keeps separate execution records.

#### Canonical attempt fencing

Attempt fencing is part of the Runtime Control Plane contract and is enforced by Core,
not inferred by the Channel orchestrator. The logical Work Unit/Run stores one nullable
`activeAttemptId`; a partial uniqueness constraint and compare-and-set claim guarantee
that at most one Attempt is active for that logical execution. Every Attempt stores:

```ts
interface RuntimeAttemptFenceV1 {
  readonly attemptId: string;
  readonly workUnitId: string;
  readonly runId?: string;
  readonly runtimeInstanceId: string;
  readonly fencingToken: string;
}
```

`runtimeInstanceId` identifies one daemon process lifetime. `fencingToken` is an opaque
decimal string at the contract boundary and a monotonically increasing generation per
Work Unit in SQLite, so JavaScript never loses 64-bit integer precision. It is minted by
the claim transaction and never reused. A claim atomically verifies the Work Unit/Run
revision, loses any prior active Attempt, inserts the replacement Attempt, and advances
`activeAttemptId` to the new id/token. The same tuple is persisted in runtime audit rows
so startup recovery can prove which process owned each transition. The shared Runtime
snapshot schema increments from 22 to 23; this pre-release clean break does not decode or
silently default a snapshot that lacks the token.

Every mutating runtime operation must include the fence tuple in its CAS predicate:
heartbeats, status transitions, lease/semaphore release, approval consumption,
`tool_start`/`tool_end`, evidence/action writes, and terminal callbacks. A callback that
does not match the current `activeAttemptId` and `fencingToken` is stale. It may append a
bounded diagnostic event, but it cannot append canonical evidence, consume approval,
change a Work Unit/Run/step, release the current Attempt's resources, or publish a
control-plane invalidation. This rule applies equally to online callbacks and startup
repair.

Terminal audit is the one post-transition exception, and it is not a relaxation of the
fence. The owner that successfully performs a terminal Work Unit/Attempt transition may
append the closed terminal-audit event with the same complete fence tuple. The store must
verify that ownership explicitly, or compose the transition and audit in one transaction;
`allowTerminalAttemptAudit` is not a general-purpose escape hatch. A stale callback,
an attempt-id-only callback, or a caller that merely observes a terminal row remains
diagnostic-only. If the owner cannot append the required audit, the owner-controlled
transaction must roll back the terminal transition. Terminal audit never writes action
evidence, consumes approval, changes Completion Gate/TerminalReport state, or publishes a
client invalidation.

#### Fence API split and resource ownership

The fence is a type boundary, not a convention documented only at call sites. Runtime
store ports expose three different classes of operation:

```text
canonical mutation
  RuntimeAttemptFenceV1 (all fields required)
  -> one CAS predicate over WorkUnit + Attempt + resource row

diagnostic observation
  StaleAttemptDiagnosticInput
  -> bounded runtime diagnostic only; never canonical evidence or invalidation

read / projection
  attemptId or workUnitId may be sufficient
  -> no state mutation and no lease renewal
```

The following inputs must not keep optional `runtimeInstanceId` or `fencingToken`
fields: heartbeat, runtime event/evidence append, tool start/end, approval consume,
Work Unit/Run/step transition, Attempt transition, lease renew/release, semaphore
renew/release, startup repair, and terminal audit ownership. A missing fence is an
invalid caller contract, not a legacy callback that may be allowed through. If a late
runner callback has only an attempt id, it must call the diagnostic API explicitly.

Resource rows carry the owning Attempt fence at acquisition. Renew and release compare
`attemptId + runtimeInstanceId + fencingToken` in the same SQL update that changes the
resource row. They are idempotent for the same owner tuple and return `stale_attempt`
without touching a replacement Attempt's lease or semaphore slot. The owner-level release
API is a separate, narrow capability for `workflow_step` and `system` resources only. It
is not legal for Run or `work_unit_attempt` resources, and the SQLite boundary rejects
both a new unfenced runtime lease and an owner-level release attempted with `run`.

`allowTerminalAttemptAudit` is not a public capability. The terminal transition returns a
short-lived `TerminalAuditCapabilityV1` bound to the exact fence, transition id, and
closed event kind. The owner must present that capability to append the audit, or use the
same transaction helper that appends transition and audit together. A boolean supplied
by an arbitrary callback is rejected by the Core port. This makes the audit exception
provable and prevents an old callback from turning an observed terminal row into an
apparently owned transition.

Migration 121 is a pre-release clean break. It never derives a fencing token from an old
Attempt number and never keeps an unfenced Run alive. Unfenced development Attempts and
their events, heartbeats, semaphore slots, and runtime leases are deleted; a Work Unit
that pointed at one becomes `stale`, while Thread/Turn/Item user content is untouched.
The migration postcondition rejects any remaining active runtime lease without a complete
current fence. No v1 alias, optional-field dual read, owner-level Run release, or
fabricated token is permitted after the migration boundary.

#### Restart and reconnect state ownership

Restart recovery is a durable state machine, not a process-local retry loop:

```text
old Attempt active
  -> classify SQLite checkpoint/tool evidence
       safe checkpoint, no tool_start   -> old Attempt lost -> one new Attempt, same Run
       no checkpoint                    -> old Attempt lost -> typed blocker, no retry
       tool_start without tool_end      -> old Attempt lost -> effect-unknown blocker
       tool_end present                 -> old Attempt lost -> reconstruct evidence/finalize
       terminal source already present  -> reconcile publication only
```

The classifier runs before any new Attempt is created and is idempotent on
`(runId, checkpointId, recoveryGeneration)`. It never calls the generic user-cancel path,
reselects a participant, recompiles a graph, or creates a second Run. `resume_pending` is
scanned on startup alongside `pending` and `approved`; a crash after the checkpoint CAS
cannot strand the logical Run.

SSE/RPC reconnect is an observer protocol. The client sends its last applied control-plane
sequence and view generation. The daemon either replays from that cursor or returns a
fresh canonical snapshot when the replay floor has moved. The client advances its cursor
only after the snapshot/replay is applied successfully. Reconnect never posts a Turn and
never creates a Run, Attempt, approval, evidence, outcome, or terminal publication. The
UI treats a ready acknowledgement as `accepted/pending`; only a committed
`finalResultItemId` plus source-Turn terminal transition may render the final result.

Daemon restart is therefore a same-Run Attempt replacement, not a workflow retry. The
restart path uses `runtime_suspend` and the checkpoint policy below; it never enters the
generic `stale -> queued` retry path, recompiles a graph, or creates a new Run. Generic
stale recovery remains available for an actual runner timeout/crash and may create a new
Attempt only after its own typed retry policy permits it.

### Heartbeat

A heartbeat is liveness evidence. It is not user progress.

Ling tracks two clocks:

- `lastHeartbeatAt`: wrapper, runner, or provider is still alive;
- `lastEventAt`: user-meaningful progress happened.

Both are needed. A quiet but alive runner is different from a disconnected runner. A
busy wrapper with no user progress can still become idle-stuck.

### Runtime Event

A runtime event is the work-unit local event log. It carries runner progress, approval
requests, terminal transitions, stale markers, lease/semaphore events, and artifact refs.

It is not a raw transcript dump. Token deltas and large tool output belong in run events
or artifacts.

### Control-Plane Event

A control-plane event is a workspace-level invalidation and audit record. It lets
clients refresh one domain without reading every detail endpoint.

Examples:

- `run.created`
- `work_unit.transitioned`
- `approval.created`
- `artifact.created`
- `runner.settings_updated`

Payloads must be summaries. Raw prompts, command bodies, file paths, secret refs, tool
output, and artifact bytes stay out of control-plane event data.

### Artifact

An artifact is durable evidence or output. It may be linked to a run, media job, or
external work item.

The control plane exposes artifact summaries and content URLs, not local filesystem
paths or bytes.

### Runner Registry

The runner registry decides which backend can execute the work. It normalizes legacy ids,
checks workspace `allowedRunnerIds`, checks provider/tool compatibility, and applies
fallback policy.

Current default:

```text
defaultRunnerId = "pi"
```

Future external runners such as `codex-app-server` stay disabled until feature flag,
endpoint, readiness, and conformance gates all pass.

## State Machines

### Work Unit Status

```text
queued
  -> claimed
  -> running
  -> waiting_for_approval
  -> running
  -> succeeded

running
  -> failed
  -> cancelling
  -> stale

cancelling
  -> cancelled
  -> stale

stale
  -> queued      retry
  -> failed      reconcile failure
  -> cancelled   reconcile cancellation
```

Rules:

- All status updates are compare-and-set transitions.
- Terminal states are `succeeded`, `failed`, and `cancelled`.
- `stale` is blocked but non-terminal.
- `runtime_suspend/daemon_restart` is recorded as a typed suspension cause and does not
  use `stale -> queued`; checkpoint recovery owns the same-Run replacement decision.
- Late runner success after cancellation must be audited, not applied as truth.
- Retry creates or starts a new attempt under the same work unit.

### Attempt Status

```text
created -> started -> waiting_for_approval -> started -> succeeded
started -> failed
started -> cancelling -> cancelled
started -> lost
```

`lost` means Ling cannot prove the runner still has execution authority. Startup
reconcile and stale recovery should release durable resources only through explicit
supervisor logic.

## Data Ownership

| Data | Owner | Storage |
| --- | --- | --- |
| Work unit identity and status | Core store via daemon | `work_units` |
| Attempt identity and runner execution state | Core store via daemon | `work_unit_attempts` |
| Active-attempt pointer and fence revision | Core store via daemon | `work_units.active_attempt_id` plus the immutable Attempt fence tuple |
| Work-unit event log | Core store via daemon | `runtime_events` |
| Heartbeats | Core store via daemon | `runtime_heartbeats` |
| Runtime semaphores | Core store via daemon | `runtime_semaphore_slots` |
| Resource leases | Core store via daemon | `resource_leases` |
| Workspace-level invalidations | Core store via daemon | `control_plane_events` |
| Runner defaults | Workspace/user runtime settings | `.ling-stack/runtime-settings.json`, user config |
| Runner implementation internals | Runner adapter | adapter-owned session state |

Clients never write these tables or files directly.

## Control-Plane APIs

Current compatibility routes:

```text
GET /control-plane/snapshot?cwd=<cwd>&domains=runs,work_units,...
GET /control-plane/events?cwd=<cwd>&afterSeq=0&limit=100&domains=runs
GET /control-plane/stream?cwd=<cwd>&afterSeq=0&domains=providers
```

Rules:

- `snapshot` returns redacted domain read models.
- `events` returns redacted, bounded workspace-level events.
- `stream` replays recent events then emits SSE events and heartbeats.
- Domain failures are isolated in `domains[domain].ok = false`.
- The API does not expose secret refs, local artifact paths, raw memory bodies, prompts,
  tool outputs, or artifact bytes.

Future RPC and WebSocket adapters must call the same processors. They must not create a
second approval path, secret resolver, or runtime state model.

### Replay and subscription recovery

Control-plane transports share one bounded replay-window evaluator over the per-workspace
`control_plane_replay_state` row:

```text
requestedAfterSeq + domains + safe limit
  -> replayFloorSeq + captured upperBoundSeq
  -> events in (requestedAfterSeq, upperBoundSeq], limit + 1
       complete           -> events + nextAfterSeq=upperBoundSeq
       cursor unavailable -> snapshot_required
       retention gap      -> snapshot_required
       window exceeded    -> snapshot_required
```

Filtered domains and other workspaces may create numeric sequence gaps; they do not make
the window incomplete. The durable floor/latest watermark survives an empty event table.
Every append advances latest in the event transaction. Future deletion or compaction must
advance the floor in the same transaction as deletion.

SSE/RPC subscription setup is live-first but provisional:

```text
register provisional subscriber, no flush
  -> read bounded replay window
     -> snapshot_required: send/return disposition, close and unregister
     -> complete: replay <= bound, signal ready, drain buffered > bound, activate
     -> error: close and unregister before propagating
```

For RPC, activation occurs only after the subscribe response has been sent, so replay or
live notifications cannot race ahead of the returned `subscriptionId`. A snapshot-required
response is normal control flow and retains no subscription. Clients advance their
reconnect cursor only after the canonical refresh triggered by an event succeeds; receipt
alone is not acknowledgement.

Approval-resume lifecycle uses the same observer rule. Resume claim, replacement-Attempt
start, runtime suspension, terminal evidence, and structured resume blocker append
content-free invalidations in the same SQLite transaction as their visible state change,
in the existing `runs`, `work_units`, and `approvals` domains.
Their idempotency keys bind checkpoint id, revision, Attempt id, and transition kind.
Neither the event payload nor its delivery may consume an approval, start an Attempt, or
advance fan-in. Live delivery, replay, and snapshot-required all reload the canonical
projection before the client advances its applied cursor.

Event persistence exposes two non-interchangeable capabilities:

- standalone append always owns `BEGIN IMMEDIATE`, commit, and best-effort rollback;
- `appendControlPlaneEventWithinTransaction()` joins a caller-owned aggregate and never
  begins, commits, or rolls back.

The composition root binds aggregate stores only to the joined capability. Transaction
ownership is never inferred from `DatabaseSync.isTransaction`; the owner knows it issued
`BEGIN IMMEDIATE` and attempts rollback on every exceptional exit while preserving the
original error. In-memory SSE/RPC publication remains post-commit only. This keeps event
and replay-watermark rows atomic with approval resume, workflow completion, and
TerminalReport publication without allowing a nested writer to close the caller's
transaction.

## Snapshot Domains

| Domain | Snapshot purpose |
| --- | --- |
| `runs` | active/recent run summaries and stuck work links |
| `work_units` | active, queued, and stale work-unit summaries |
| `memory` | memory review policy and recent candidate summaries |
| `skills` | effective skill registry summary and generation |
| `teammates` | teammate status and binding counts |
| `approvals` | policy summary and pending approvals |
| `providers` | provider readiness without secret values |
| `mcp` | MCP status and missing secret counts |
| `runners` | default/allowed runners, capability and readiness summary |
| `artifacts` | recent artifact summaries and content links |

## Event Payload Rules

Every control-plane event payload should pass these checks:

- useful for invalidation or audit;
- smaller than the source object;
- redacted before leaving the daemon;
- no raw prompt, transcript, command body, diff body, secret ref, local path, stdout,
  stderr, or artifact bytes;
- includes a ref id when richer detail exists elsewhere.

## Implementation Slices

This branch implements the P0 contract-tightening slice and the control-plane portions
of P1/P2. P3 remains a future runner-adapter conformance project, not part of this
slice.

### P0: Contract Tightening

- Keep existing HTTP/SSE routes.
- Type every control-plane domain snapshot in `packages/contracts`.
- Keep artifact snapshots summary-only with content URLs, not local paths.
- Keep processors transport-neutral.
- Make `activeAttemptId`, `runtimeInstanceId`, and the immutable `fencingToken` part of
  the shared Runtime contract. Every state/evidence/approval callback must use the same
  CAS fence; old callbacks are diagnostic-only and cannot mutate canonical state.
- Give `runtime_suspend/daemon_restart` an explicit recovery reason and route it through
  checkpoint policy, never through generic `stale -> queued` retry.

### P1: Work-Unit Detail Consistency

- Ensure every task run has a linked work unit.
- Keep work-unit cancel/retry/reconcile APIs aligned with run state.
- Audit ignored late runner completions.
- Keep runtime diagnostics shared across Web, CLI, and future desktop clients.

### P2: Approval and Artifact Bridging

- Keep approval requests linked to owner run/work unit/action.
- Store previews and outputs as artifacts.
- Surface only artifact ids and content URLs through control-plane snapshots/events.
- Ensure approval resolution writes audit/control-plane events.

### P3: Runner Conformance

- Keep `pi` as default until another backend passes gates.
- Require external runners to prove capability negotiation, approval bridge, abort
  propagation, event streaming, artifact import, stale recovery, and redaction.
- Expose disabled external runners as unavailable, never as selectable defaults.

## Verification

Minimum checks for this layer:

- Claim two Attempts for one Work Unit concurrently and prove only one fence wins;
  replay an old callback after replacement and prove it cannot append evidence, consume
  approval, release the new lease, or advance terminal state. Exercise restart before
  checkpoint, at a safe checkpoint, before `tool_start`, between `tool_start` and
  `tool_end`, and after `tool_end`.

```bash
corepack pnpm --filter @ling-stack/contracts build
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/daemon test -- control-plane
corepack pnpm --filter @ling-stack/core test -- channel-runtime-store
```

Broader checks before shipping runtime changes:

```bash
corepack pnpm typecheck
corepack pnpm test
```

## Open Decisions

No direction-level decisions are open for this slice.

Still implementation-dependent:

- whether work-unit detail gets a dedicated contracts file or stays in runtime
  contracts;
- when Codex app-server conformance becomes worth implementing;
- whether future multi-client pressure justifies WebSocket/RPC as public transport.
