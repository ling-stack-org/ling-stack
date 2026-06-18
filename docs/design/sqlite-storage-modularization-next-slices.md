# SQLite Storage Modularization Next Slices

## Purpose

The first storage modularization pass split `packages/core/src/storage` into focused
SQLite domain stores, mappers, helpers, migrations, and select-SQL modules while keeping
`SqliteRunStore` as the stable `RunStore` facade.

This document defines the boundary for any follow-up split. The next work should not be
a mechanical file extraction. The remaining large areas in `sqlite-run-store.ts` are
cross-domain orchestration paths where ownership of transactions, state transitions,
leases, recovery, artifacts, and workflow links must be explicit before code moves.

## Current Boundary

Implemented shape:

```text
packages/core/src/storage/
  sqlite-run-store.ts          public RunStore facade and orchestration root
  sqlite/
    *-store.ts                 focused domain storage delegates
    *-mappers.ts               row-to-domain mapping and JSON parsing
    helpers.ts                 shared SQLite read/write helpers
    migrations.ts              schema setup and migration application
    select-sql.ts              shared SELECT projections
    store-context.ts           SQLite context passed to delegates
```

`SqliteRunStore` still owns:

- Ling thread, turn, run, and run-event orchestration.
- Runtime work units, attempts, heartbeats, semaphores, and stale-run recovery.
- External work import/action/CI-triage coordination that crosses tasks, artifacts,
  approvals, workflows, and scheduler state.
- Cross-domain assertions that verify channel, task, run, workflow, artifact, and
  approval references.
- Public facade methods that preserve the existing `RunStore` API.

The external-work/work-item aggregate stores are already extracted. `SqliteRunStore`
remains the facade and currently keeps `createOrReuseExternalWorkWorkflow` as a
coordinator-like method.

Existing extracted stores should remain narrow delegates. They should receive:

- a `SqliteStoreContext` containing the SQLite database;
- explicit `Ports` for cross-domain calls they cannot own.

They should not receive the whole `SqliteRunStore`.

## Why The Next Split Needs Design

The next candidates are not simple CRUD areas. They combine storage with workflow
coordination:

- `external-work + work-item` joins external records, scheduler state, actions, CI
  triage, work items, tasks, artifacts, approvals, and workflows.
- `run + runtime/work-unit` joins run sessions, events, work units, attempts,
  heartbeats, semaphore slots, resource leases, state transitions, and stale recovery.

Moving these methods without a design would likely reduce file length while hiding
coupling behind too many callbacks. The split is only useful if ownership becomes clearer.

## Recommended Pattern

Use the existing local pattern, not a new framework:

```text
SqliteRunStore
  -> public RunStore facade
  -> composition root for storage delegates
  -> owns high-level cross-domain orchestration unless a coordinator is introduced

SqliteXxxStore
  -> aggregate-local persistence
  -> idempotency lookups and simple updates inside one domain
  -> no dependency on the full facade

SqliteXxxCoordinator
  -> optional process manager for cross-domain flows
  -> coordinates multiple stores through narrow ports
  -> owns recovery or workflow progression only when explicitly designed
```

This is closest to a small hexagonal architecture:

- SQLite modules are adapters.
- aggregate stores own local persistence.
- ports name cross-domain dependencies.
- coordinators/process managers own multi-step orchestration.

## Completed Slice A: External Work And Work Items

This slice has been implemented for aggregate-local persistence. The optional
`SqliteExternalWorkCoordinator` remains a later extraction if the cross-aggregate import
and action flows grow further.

### Modules

```text
packages/core/src/storage/sqlite/
  external-work-store.ts
  external-work-action-store.ts
  external-work-ci-triage-store.ts
  external-work-scheduler-store.ts
  work-item-store.ts
```

### Store Ownership

`SqliteExternalWorkStore` should own:

- external work record create/get/list/update behavior;
- idempotency lookups by source kind and idempotency key;
- artifact id list persistence for an external work record.

`SqliteExternalWorkActionStore` should own:

- action create/get/list/update behavior;
- idempotency lookups for proposed external mutations;
- approval evidence fields that are local to action records.

`SqliteExternalWorkCiTriageStore` should own:

- CI triage record create/get/list/update behavior;
- failure-key lookup behavior;
- persisted task and artifact ids tied to a CI triage record.

`SqliteExternalWorkSchedulerStore` should own:

- scheduler-state upsert/get/list/update behavior;
- retry, next-poll, claim, and reconciliation metadata that is local to scheduler state.

`SqliteWorkItemStore` should own:

- work item upsert/get/list behavior;
- source-key lookup;
- dependency persistence;
- claim, heartbeat, release, complete, and fail updates when they only affect work-item
  rows.

If introduced later, `SqliteExternalWorkCoordinator` should own only flows that cross
aggregates, for example:

- create or reuse the workflow for an external work item;
- create linked tasks and artifacts when importing external work or CI triage;
- route external work into a work item;
- coordinate approval-backed external action proposals.

### Coordinator Ports

The coordinator may use ports such as:

- `createTask(input, now)`;
- `updateTask(id, input, now)`;
- `createArtifact(input)`;
- `createChannelWorkflow(input, now)`;
- `createChannelWorkflowStep(input, now)`;
- `createApprovalRequest(input, now)`;
- `recordStateTransitionEvent(input)`;
- `getChannel(id)`;
- `getTask(id)`;
- `getRun(id)`.

Do not expose generic `runStore` or `database` ports to the coordinator unless the module
is explicitly a storage adapter.

### Invariants

The split must preserve:

- external work idempotency by source kind and idempotency key;
- work item claim CAS behavior;
- dependency blocker semantics;
- retry budget and stale claim handling;
- artifact/task links on external work and CI triage records;
- approval requirement for external mutations;
- recovery after duplicate poll or webhook delivery.

## Candidate Slice B: Run And Runtime Work Units

This is higher risk than Candidate A and should be a separate later slice.

### Target Modules

```text
packages/core/src/storage/sqlite/
  run-session-store.ts
  run-event-store.ts
  run-intervention-store.ts
  runtime-work-unit-store.ts
  runtime-semaphore-store.ts
  runtime-recovery-coordinator.ts
```

### Ownership Decisions

The state-machine definitions stay in `packages/core/src/state-machines.ts`. SQLite
stores own applying those transitions to durable rows through compare-and-set updates,
idempotency checks, and transition-event persistence.

`SqliteRunSessionStore` should own:

- run session create/get/list behavior;
- `transitionRunStatus`, including current-status reads, idempotency lookup, the
  `transitionRun` call, compare-and-set update, and state-transition event recording;
- legacy `markRunStarted`, `markRunWaitingForApproval`, `markRunRunning`,
  `markRunSucceeded`, `markRunFailed`, and `markRunCancelled` wrappers as compatibility
  methods only;
- run-to-work-unit linking when it updates both `run_sessions` and `work_units`.

`SqliteRunSessionStore` must use narrow ports for:

- `recordStateTransitionEvent(input)`;
- `findStateTransitionByIdempotency(entityType, entityId, idempotencyKey)`;
- `reconcileLingTurnStatusForRun(runId, now)`;
- `tryRebuildLingThreadMetadata(threadId, now)`;
- `updateLinkedWorkUnitRunId(workUnitId, runId, now)`.

`SqliteRunEventStore` should own:

- run event append/list/count behavior;
- run event sequence assignment;
- terminal event detection for recovery;
- event-log file append for persisted run events.

Run events remain the authoritative run execution log. Runtime events are a separate
diagnostic/progress log for work units and attempts. Do not merge them into one
execution-log store.

`SqliteRunInterventionStore` should own:

- intervention create/get/list/update/cancel behavior;
- continuation run/work-unit links that are local to intervention rows.

`SqliteRuntimeWorkUnitStore` should own:

- work unit create/get/list and idempotency lookup behavior;
- `transitionWorkUnitStatus`, including current-status reads, idempotency lookup, the
  `transitionWorkUnit` call, compare-and-set update, and state-transition event
  recording;
- work unit attempt create/get/list/update behavior;
- runtime event append/list behavior and runtime event sequence assignment;
- runtime heartbeat insertion and the work-unit/attempt heartbeat timestamp updates.

`SqliteRuntimeWorkUnitStore` must not own broad lease cleanup. Heartbeat renewal may use
ports to renew active resource leases and runtime semaphore slots for an attempt, but
terminal release, stale release, and cancellation cleanup belong to process managers or
the recovery coordinator.

`SqliteRuntimeSemaphoreStore` should own:

- semaphore slot acquire/list/release behavior;
- active-slot counting and limit enforcement inside the acquire transaction;
- attempt-based renewal for active semaphore slots.

`SqliteRuntimeRecoveryCoordinator` should own startup recovery flows:

- expire resource leases before stale-run recovery;
- find queued, running, and waiting-for-approval runs left behind by daemon shutdown;
- append a terminal run error if the run has no terminal event;
- fail stale runs and reconcile linked Ling thread state;
- reconcile recoverable channel workflows and workflow steps from linked terminal runs,
  missing runs, claimed steps, and approval outcomes;
- aggregate workflow status repair after step recovery.

The recovery coordinator is not a table store. It coordinates `RunSessionStore`,
`RunEventStore`, `ResourceLeaseStore`, `ApprovalRequestStore`, `ChannelWorkflowStore`,
Ling thread ports, and state-transition ports. The daemon remains the runtime process
owner and continues to trigger recovery during store initialization.

### Implementation Order

Use this order to keep each slice coherent and reversible:

1. Extract `runtime-semaphore-store.ts`.
2. Extract `runtime-work-unit-store.ts`, using ports for transition events and heartbeat
   lease/semaphore renewal.
3. Extract `run-event-store.ts`.
4. Extract `run-intervention-store.ts`.
5. Extract `run-session-store.ts`, including `transitionRunStatus` and legacy wrappers.
6. Extract `runtime-recovery-coordinator.ts` after the underlying stores exist.

Do not start by moving stale recovery. It is the cross-domain process manager for this
slice and should move after the storage adapters it coordinates are in place.

### Invariants

The split must preserve:

- run status transition validation;
- run event sequence monotonicity;
- terminal event detection;
- stale run recovery;
- work unit CAS transition behavior;
- attempt lifecycle behavior;
- heartbeat lease renewal;
- semaphore limits and release semantics;
- resource lease release on terminal states.

## Non-Goals

- No `RunStore` public API change.
- No schema change as part of a pure modularization slice.
- No ORM introduction.
- No dependency injection container.
- No repository-per-table rewrite.
- No migration away from `node:sqlite`.
- No broad cleanup of unrelated docs, UI, runtime files, local state, or generated files.

## Validation Gate

Every follow-up slice must pass:

```bash
corepack pnpm --filter @ling-stack/core typecheck
corepack pnpm --filter @ling-stack/core test
git diff --check
```

For Candidate A, verify the tests covering:

- external work import and workflow reuse;
- external work action propose/cancel/approval behavior;
- GitHub/Linear poll deduplication;
- CI triage task and artifact creation;
- work item CRUD, route, claim, heartbeat, release, complete, and fail.

For Candidate B, verify the tests covering:

- run session and event persistence;
- run interventions;
- runtime supervisor migration self-healing;
- work unit CAS transitions;
- heartbeat and semaphore behavior;
- stale run and workflow recovery.

## Stop Rule

Stop a slice when either condition is true:

- the moved methods form a coherent aggregate or coordinator with narrow ports and no
  behavior changes;
- the remaining methods require a new ownership decision that is not already documented.

Do not continue extracting just because `sqlite-run-store.ts` still has many lines. The
goal is clearer ownership, not a smaller file at any cost.
