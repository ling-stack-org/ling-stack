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

No unresolved decision blocks the first facet slice. The only open sequencing decision
is how aggressively to migrate high-level route handlers. Defer that until helpers and
coordinators have been narrowed.
