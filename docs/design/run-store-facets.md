# RunStore Facets

## Purpose

This document defines the next storage architecture slice after SQLite domain
logic was extracted from `sqlite-run-store.ts`.

The goal is not to reduce line count for its own sake. The goal is to make storage
dependencies easier to read and safer to change. Today many core and daemon modules
accept the full `RunStore` interface even when they only need a small storage surface.
That makes unrelated storage domains look coupled.

## Current State

Completed SQLite slices moved domain behavior out of `SqliteRunStore`:

- run/session/runtime stores;
- Ling thread, turn, metadata, and search stores;
- external work workflow coordination;
- channel reference validation;
- teammate bootstrap coordination.

The remaining shape is:

```text
RunStore
  -> broad public storage contract

SqliteRunStore
  -> public RunStore implementation
  -> SQLite composition root
  -> mostly delegation plus private helper ports
```

This is acceptable as a compatibility layer, but it is too broad for application
code dependencies.

## Strategy

Use facets as narrow type-level contracts before changing implementation shape.

Initial facets should be aliases over `RunStore` method names. This preserves the
existing public API while letting callers state the storage capabilities they really
need.

After callers move to facets, a later slice may invert `RunStore` into:

```ts
export interface RunStore
  extends RunStorePathsFacet,
    LingThreadStoreFacet,
    RunExecutionStoreFacet,
    RuntimeSupervisorStoreFacet,
    WorkspaceStoreFacet,
    TeammateStoreFacet,
    MemoryStoreFacet,
    ChannelStoreFacet,
    ExternalWorkStoreFacet,
    IntegrationStoreFacet {}
```

Do not start by splitting `SqliteRunStore` into wrapper classes. That would mostly
move delegation around without clarifying consumers.

## Facet Groups

Start with these groups:

- `RunStorePathsFacet`: `paths`;
- `LingThreadStoreFacet`: Ling threads, turns, turn-run links, metadata rebuild, and
  thread search;
- `RunExecutionStoreFacet`: run sessions, run events, run interventions, artifacts,
  and control-plane events;
- `RuntimeSupervisorStoreFacet`: work units, attempts, runtime events, semaphores,
  stale recovery, transitions, and resource leases;
- `WorkspaceStoreFacet`: workspace settings, channels, channel branches, and tasks;
- `TeammateStoreFacet`: AI teammates, memberships, skills, memory scopes, direct
  threads, direct messages, direct reply interventions, private attachments, and
  teammate MCP bindings;
- `MemoryStoreFacet`: memory objects, review policy, review actions, recall,
  used-memory events, self-improving metadata, and consolidation jobs;
- `ChannelStoreFacet`: channel messages, route and intent decisions, execution
  proposals, assets, materialized inputs, briefs, decisions, handoffs, context
  summaries, collaboration protocol records, workflows, and workflow steps;
- `ProviderStoreFacet`: provider presets and provider secrets;
- `ApprovalStoreFacet`: approval requests and approval policy;
- `MediaStoreFacet`: media jobs;
- `ExternalWorkStoreFacet`: external work records, actions, CI triage, scheduler
  state, and external work workflow creation;
- `WorkItemStoreFacet`: durable work item queue operations;
- `McpStoreFacet`: MCP servers, runtime snapshots, tools, and server secrets;
- `AutomationStoreFacet`: automation definitions, drafts, and runs;
- `ManagedPluginStoreFacet`: managed plugin records, contributions, package records,
  health, events, and runtime snapshots;
- `SkillRegistryStoreFacet`: skill registry entries and import drafts.

## Caller Migration Rule

When touching a module, change its accepted store type from `RunStore` to the
smallest facet or facet intersection that covers actual method use.

Good:

```ts
function assertMediaJobProvider(store: ProviderStoreFacet, input: CreateMediaJobInput): ProviderPreset
```

Acceptable for cross-domain coordinators:

```ts
type ExternalActionStore =
  ExternalWorkStoreFacet &
  ApprovalStoreFacet &
  RunExecutionStoreFacet &
  WorkspaceStoreFacet;
```

Avoid:

```ts
function doSmallThing(store: RunStore): void
```

unless the module is genuinely an orchestration root.

## Implementation Order

1. Add facet aliases in `run-types.ts`.
2. Narrow low-risk helper modules first:
   - provider/media helpers;
   - teammate identity/activity helpers;
   - execution action read models.
3. Narrow medium-risk workflow modules next:
   - external work actions;
   - external work CI triage;
   - external work scheduler;
   - direct teammate runtime controls.
4. Keep route handlers and orchestration roots on full `RunStore` until their internal
   helper seams are clearer.
5. Only after caller migration, consider extracting SQLite composition wiring from
   `sqlite-run-store.ts`.

## Remaining Ownership Boundaries

The first facet slices narrowed low-risk helpers and several medium-risk daemon
helpers. The remaining `RunStore` consumers are mostly high-level coordinators, so
future slices must be driven by ownership boundaries instead of mechanical type
replacement.

### Channel Workflow

Channel workflow owns channel-visible workflow state: collaboration protocol records,
workflow graph state, handoffs, fan-in decisions, execution proposals, workflow steps,
packets, and channel context materialization.

Expected stores:

- `ChannelStoreFacet`;
- `RunExecutionStoreFacet` for linked run sessions, events, and artifacts;
- `RuntimeSupervisorStoreFacet` only when workflow code must observe or create durable
  work units;
- `ApprovalStoreFacet` for approval requests attached to workflow actions;
- `TeammateStoreFacet`, `SkillRegistryStoreFacet`, or `ProviderStoreFacet` only where
  the workflow actively resolves those domain objects.

Ownership rule:

- Channel workflow may decide what should happen next in a channel.
- It must not own run runtime transitions, stale completion, resource leases, or
  worker lifecycle recovery. Those remain runtime supervisor concerns.

### Run Runtime And Runtime Supervisor

Run runtime owns durable execution state: work units, attempts, runtime events,
heartbeats, semaphores, stale recovery, resource leases, cancellation, queueing, and
run-control state transitions.

Expected stores:

- `RuntimeSupervisorStoreFacet`;
- `RunExecutionStoreFacet`;
- `WorkspaceStoreFacet` when runtime decisions need workspace config;
- `ApprovalStoreFacet` when execution is blocked on approval;
- `LingThreadStoreFacet` only for syncing thread metadata after run events.

Ownership rule:

- Stale recovery belongs here. Workflow and thread layers may surface recovered state,
  but they should not decide recovery semantics.
- Runtime supervisor code may remain broader than small helpers until cancellation,
  queueing, work-unit APIs, and run-control transitions have clean helper seams.

### Ling Thread And Turn

Ling thread and turn code owns conversation lineage: threads, turns, turn-run links,
turn envelopes, session views, metadata rebuilds, and thread search read models.

Expected stores:

- `LingThreadStoreFacet`;
- `RunExecutionStoreFacet` for run links and run read models attached to turns;
- `ChannelStoreFacet` for channel-originated turns and channel session views;
- `TeammateStoreFacet` where a turn needs teammate identity or direct-message context;
- `RunStorePathsFacet` where a thread view needs workspace-relative paths.

Ownership rule:

- Thread/turn code may describe the conversation and link it to runs.
- It must not own run lifecycle transitions, runtime recovery, provider refresh, or
  workflow graph decisions.

### Media Execution

Media execution owns media job lifecycle: job creation, provider resolution for media,
approval checks, job state transitions, artifacts, and executor-local recovery.

Expected stores:

- `MediaStoreFacet`;
- `ProviderStoreFacet`;
- `ApprovalStoreFacet`;
- `RunExecutionStoreFacet` for linked run artifacts and events;
- `RunStorePathsFacet` for filesystem paths.

Ownership rule:

- Media job state machines remain media-owned.
- Approval policy remains approval-owned; media code should request or observe approval,
  not duplicate approval policy evaluation.

### Composition Roots And Store Locators

Route roots, server setup, store registries, optional warmups, and other composition
layers may continue to accept full `RunStore` while they are wiring broad dependencies.

Expected stores:

- `RunStore` is acceptable at composition roots.
- Extract narrow helper functions when a root starts carrying domain logic.

Ownership rule:

- A full `RunStore` type is acceptable for dependency wiring.
- A full `RunStore` type is not acceptable as a convenience shortcut inside focused
  domain helpers.

## Next Migration Slices

Future code slices should follow this order:

1. Narrow focused thread/session view helpers that already have clear
   `LingThreadStoreFacet` and `ChannelStoreFacet` boundaries.
2. Narrow media execution helpers around `MediaStoreFacet`, `ProviderStoreFacet`, and
   `ApprovalStoreFacet`.
3. Narrow channel workflow helper seams without changing workflow behavior.
4. Narrow runtime supervisor helper seams only after stale recovery and run-control
   ownership are explicit in the touched module.
5. Leave store registries, server roots, and broad route composition on full `RunStore`
   until logic is extracted into smaller helpers.

## Non-Goals

- No `createSqliteRunStore` return type change.
- No nested runtime API such as `store.channels.createChannel`.
- No schema migration.
- No dependency injection container.
- No wrapper-only split of `SqliteRunStore`.
- No unrelated refactor of daemon route handlers.

## Validation Gate

For each slice:

```bash
corepack pnpm --filter @ling-stack/core typecheck
corepack pnpm --filter @ling-stack/core test
git diff --check
```

If daemon callers are changed, also run:

```bash
corepack pnpm --filter @ling-stack/daemon build
```

## Unresolved Decisions

No unresolved decision blocks the next focused facet slices.

The remaining decisions are sequencing decisions, not architecture blockers:

- Channel workflow can be narrowed helper-by-helper, but workflow state transitions
  should not be moved into runtime code.
- Runtime supervisor and stale recovery should be narrowed only within runtime-owned
  modules.
- Ling thread and turn migration can proceed where modules only read or write
  conversation lineage.
- Media execution migration can proceed around job lifecycle helpers.
- Composition roots and store locators should stay on full `RunStore` until narrower
  helper seams exist.
