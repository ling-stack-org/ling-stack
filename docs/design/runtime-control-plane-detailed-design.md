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
