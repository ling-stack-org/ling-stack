# SQLite Storage Ling And Domain Slices

## Purpose

This document defines the next SQLite storage modularization boundary after the
runtime/run extraction. It answers whether the remaining Ling thread/turn, channel
workflow, and teammate/memory areas need design before more code moves.

The answer is yes. These areas are not simple table delegates. They either maintain
derived state, coordinate multiple aggregates, or seed protected defaults across
tables. The next split should make ownership clearer instead of only reducing
`sqlite-run-store.ts` line count.

## Current State

Completed and already merged:

- external work and work item aggregate stores;
- runtime semaphore, work unit, run event, run intervention, and run session stores;
- runtime recovery coordinator.

Current shape remains:

```text
SqliteRunStore
  -> public RunStore facade
  -> SQLite composition root
  -> owner of remaining cross-domain orchestration
```

`SqliteRunStore` is still intentionally public and stable. The next slices must keep:

- `SqliteRunStore`;
- `createSqliteRunStore`;
- `RunStore`.

Observed remaining high-risk regions:

- Ling thread/turn creation, search, run linking, status reconciliation, and metadata
  rebuilds;
- channel workflow residual orchestration around external-work workflow creation and
  channel-scoped reference validation;
- teammate/memory bootstrap and backfill flows for protected system teammates,
  template skill bindings, channel memberships, and default memory scopes.

## Candidate Slice C: Ling Thread And Turn

This should be the next implementation slice.

### Target Modules

```text
packages/core/src/storage/sqlite/
  ling-thread-store.ts
  ling-turn-store.ts
  ling-thread-metadata-coordinator.ts
```

If search remains large after extraction, add:

```text
packages/core/src/storage/sqlite/
  ling-thread-search-store.ts
```

Do not start with search. First separate durable thread/turn ownership from metadata
coordination, then decide whether search needs its own store.

### Ownership

`SqliteLingThreadStore` should own aggregate-local thread persistence:

- `createLingThread`;
- `getLingThread`;
- `findLingThreadByOwner`;
- `listLingThreads`;
- `updateLingThread`.

It may keep `searchLingThreads` only if the implementation stays small and only depends
on thread, turn, and run read models through explicit ports. If search keeps direct SQL
over multiple tables, move it into `SqliteLingThreadSearchStore`.

`SqliteLingTurnStore` should own turn persistence and turn-run links:

- `createLingTurn`;
- `getLingTurn`;
- `listLingTurns`;
- `linkRunToLingTurn`;
- `getLingTurnForRun`;
- `listLingTurnRuns`;
- `reconcileLingTurnStatus`.

`SqliteLingThreadMetadataCoordinator` should own derived thread metadata:

- `rebuildLingThreadMetadata`;
- `rebuildLingThreadMetadataForRun`;
- `tryRebuildLingThreadMetadata`;
- `tryRebuildLingThreadMetadataForTurn`.

The metadata coordinator is not a table store. It reads turns, runs, approvals, run
actions, and artifacts, then writes `ling_threads.metadata_json`.

### Ports

The stores and coordinator must use narrow ports instead of receiving the full
`SqliteRunStore`.

Allowed Ling thread ports:

- `rebuildLingThreadMetadata(threadId, now)`;
- `tryRebuildLingThreadMetadata(threadId, now)`;
- `getRun(runId)`;
- `listRuns(options)`;
- `listLingTurns(options)`;
- `listApprovalRequests(options)`;
- `listArtifacts(runId)`;
- `readLatestRunActionActivityAt(runIds)`.

Allowed Ling turn ports:

- `getLingThread(threadId)`;
- `tryRebuildLingThreadMetadata(threadId, now)`;
- `tryRebuildLingThreadMetadataForTurn(turnId, now)`;
- `getRun(runId)`.

Forbidden ports:

- generic `runStore`;
- generic `database`, unless the module is explicitly a SQLite adapter;
- catch-all callbacks such as `callFacade(method, input)`.

### Invariants

The split must preserve:

- Ling thread metadata is a rebuildable read cache, not source-of-truth state;
- turn status derives from linked run status and preserves `superseded`;
- `waiting_for_approval` has precedence over queued/running linked runs;
- active and last run ids always belong to the same thread;
- turn-run attempt numbers remain monotonically increasing per turn;
- archived threads cannot receive new turns;
- metadata rebuild failure must not corrupt the underlying thread or turn rows;
- search must not expose more secret-adjacent content than current behavior.

### Stop Rule

Stop Slice C when thread persistence, turn persistence, and metadata coordination are
separate modules with narrow ports. Do not keep extracting merely because search or
metadata can be made smaller.

## Candidate Slice D: Channel Workflow Residuals

`channel-workflow-store.ts` already owns workflow and step persistence plus state
transitions. The remaining design issue is cross-domain orchestration around external
workflows and channel-scoped reference assertions.

### Target Modules

```text
packages/core/src/storage/sqlite/
  external-work-workflow-coordinator.ts
  channel-reference-validator.ts
```

Use `SqliteExternalWorkWorkflowCoordinator` only for the external-work import flow. Do
not turn it into a general workflow service.

### Ownership

`SqliteChannelWorkflowStore` should continue to own:

- workflow CRUD;
- workflow step CRUD;
- workflow and step status transitions;
- workflow recovery helpers that are local to workflow rows and step rows.

`SqliteExternalWorkWorkflowCoordinator` should own:

- `createOrReuseExternalWorkWorkflow`;
- idempotency lookup for external work source kind plus key;
- creation of the linked workflow, first workflow step, and external work record;
- duplicate mapping validation when an existing external work record points at workflow
  state.

`SqliteChannelReferenceValidator` should own channel-scoped assertions when the logic is
shared by multiple channel stores:

- source message/task/run references;
- workflow and workflow step references;
- proposal, decision, handoff, context summary, and selector target references;
- workflow-step-to-workflow consistency.

### Ports

The external-work workflow coordinator may use:

- `assertChannelExists(channelId)`;
- `getChannel(channelId)`;
- `getExternalWorkRecordByIdempotency(sourceKind, idempotencyKey)`;
- `createExternalWorkRecord(record, now)`;
- `getChannelWorkflow(workflowId)`;
- `createChannelWorkflow(input, now)`;
- `getChannelWorkflowStep(stepId)`;
- `createChannelWorkflowStep(input, now)`.

The channel reference validator may use read-only lookup ports for the referenced
aggregate. It should not mutate rows.

### Invariants

The split must preserve:

- external work workflow creation remains idempotent;
- duplicate external work mappings fail loudly if workflow state is missing;
- workflow step target defaults still resolve from channel default teammate, workflow
  definition agent teammate, then engineer fallback;
- all channel-scoped references still reject cross-channel links;
- selector targets still belong to the selected workflow when both ids are provided.

## Candidate Slice E: Teammate And Memory Bootstrap

The teammate and memory stores are already split by local persistence concern. The
remaining issue is bootstrap ownership, not another broad memory abstraction.

### Target Module

```text
packages/core/src/storage/sqlite/
  teammate-bootstrap-coordinator.ts
```

Do not merge memory object, review, retrieval, and consolidation stores into a broad
memory coordinator as part of this slice.

### Ownership

`SqliteTeammateBootstrapCoordinator` should own startup seeding and backfill:

- `ensureDefaultAiTeammates`;
- `ensureLingAgentSystemTeammate`;
- `ensureLingAgentChannelMemberships`;
- `backfillTemplateSkillBindings`;
- `ensureDefaultTeammateMemoryScopes`;
- `ensureDefaultTeammateMemoryScopesForAll`;
- template-id to built-in teammate-id migration for channels and tasks.

The teammate stores continue to own:

- teammate CRUD;
- skill bindings;
- channel memberships;
- direct conversation state;
- cleanup/tombstone behavior.

The memory stores continue to own:

- memory object persistence;
- review queues;
- retrieval and recall;
- consolidation records.

### Ports

Allowed bootstrap ports:

- `hasTable(tableName)`;
- `hasRetentionTombstone(entityType, entityId)`;
- `getAiTeammate(id)`;
- `createAiTeammate(input, now)`;
- `listTeammateSkillBindings(teammateId)`;
- `replaceTeammateSkillBindings(teammateId, bindings, now)`;
- `ensureDefaultTeammateMemoryScopes(teammateId, now)`;
- `ensureDefaultTeammateMemoryScopesForAll(now)`;
- focused SQL adapters for channel/task default-id migration if no existing store owns
  those updates.

### Invariants

The split must preserve:

- retained tombstones prevent re-creating removed default teammates;
- Ling Agent protected fields are restored on startup;
- Ling Agent remains a channel member without becoming the channel default teammate;
- default teammate memory scopes are present after teammate creation or backfill;
- template default skill bindings are backfilled without duplicating existing bindings;
- legacy template ids in channels and tasks continue to migrate to built-in teammate ids.

## Implementation Order

Use this order to keep behavior easy to validate:

1. Extract `ling-thread-store.ts` and `ling-turn-store.ts`.
2. Extract `ling-thread-metadata-coordinator.ts`.
3. Reassess `searchLingThreads`; extract `ling-thread-search-store.ts` only if direct
   SQL fan-in still makes the thread store hard to scan.
4. Extract `external-work-workflow-coordinator.ts`.
5. Extract `channel-reference-validator.ts` only after at least two channel stores need
   the same assertion surface.
6. Extract `teammate-bootstrap-coordinator.ts`.
7. Recount `sqlite-run-store.ts` and stop when it is primarily facade and composition
   code.

## Non-Goals

- No `RunStore` public API change.
- No schema migration for pure modularization.
- No ORM introduction.
- No dependency injection container.
- No repository-per-table rewrite.
- No change to Ling thread, turn, workflow, teammate, or memory behavior.
- No memory health/fan-in redesign in this slice.
- No cleanup of unrelated docs, UI files, runtime files, local state, or generated files.

## Validation Gate

For every implementation slice:

```bash
corepack pnpm --filter @ling-stack/core typecheck
corepack pnpm --filter @ling-stack/core test
git diff --check
```

For Slice C, also verify tests or add narrow tests covering:

- thread create/list/update/search behavior;
- archived thread turn rejection;
- turn-run linking and attempt ordering;
- `waiting_for_approval`, active-run, last-run, and terminal turn reconciliation;
- metadata rebuild after turn creation, run terminal transition, approval changes, and
  artifact creation.

For Slice D, verify:

- external work workflow idempotency;
- duplicate external work mappings;
- cross-channel assertion failures;
- workflow selector target validation.

For Slice E, verify:

- default teammate seeding;
- retained tombstone behavior;
- Ling Agent protected field repair;
- Ling Agent channel memberships;
- default memory scope seeding;
- template skill binding backfill.

## Unresolved Decisions

No unresolved ownership decision blocks starting Slice C. The only conditional decision is
whether `searchLingThreads` deserves its own module; decide that after thread and turn
persistence have moved and the remaining search code can be measured in isolation.
