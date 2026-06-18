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
- External work import/action/CI-triage coordination.
- Work item claim, heartbeat, release, complete, and fail behavior.
- Cross-domain assertions that verify channel, task, run, workflow, artifact, and
  approval references.
- Public facade methods that preserve the existing `RunStore` API.

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

## Candidate Slice A: External Work And Work Items

This is the preferred next slice if we continue modularizing storage.

### Target Modules

```text
packages/core/src/storage/sqlite/
  external-work-store.ts
  external-work-action-store.ts
  external-work-ci-triage-store.ts
  external-work-scheduler-store.ts
  work-item-store.ts
  external-work-coordinator.ts
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

`SqliteExternalWorkCoordinator` should own only flows that cross aggregates, for example:

- create or reuse the workflow for an external work item;
- create linked tasks and artifacts when importing external work or CI triage;
- route external work into a work item;
- coordinate approval-backed external action proposals.

### Required Ports

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

### Ownership Questions To Answer First

Before implementing this slice, decide:

- Does `RunSessionStore` own `transitionRunStatus`, or does `SqliteRunStore` keep all
  state-machine transitions?
- Does `RuntimeWorkUnitStore` own lease release side effects, or does a coordinator own
  them?
- Does stale recovery live in a runtime process manager, or remain in `SqliteRunStore`
  until runtime supervision is redesigned?
- Are run events and runtime events independent stores, or one execution-log boundary?

Until those questions are answered, this slice should not start.

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
